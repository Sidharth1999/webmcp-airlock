import { createHash } from 'node:crypto';
import { computeMetrics } from '../harness/metrics';
import { Engine } from '../sim/engine';
import { MODES, currentMode, surfaceDiff, type Mode } from '../sim/modes';
import { runQuery } from '../sim/queries';
import { getTemplate } from '../sim/templates';
import { READ_TOOLS, WRITE_TOOLS } from '../webmcp/tools';
import {
  PRICES,
  type Arm,
  type CampaignModel,
  type CampaignStore,
  type CampaignSummary,
  type CanaryVerdict,
  type LLMClient,
  type Phrasing,
  type RunRecord,
  type RunSpec,
  type TurnRecord,
  type UsageTotals,
} from './campaign-types';
import type { Candidate } from './compiler';

/**
 * M4-03 campaign runner — drives a real LLM through the SAME loop shape as
 * the synthetic harness (src/harness/run.ts), gated vs ungated, over the
 * verified corpus. Spec: docs/campaign-runner-spec.md.
 *
 * This module is pure of I/O: the LLM arrives as an injected `LLMClient`
 * and persistence as an injected `CampaignStore`, so the whole loop —
 * bridge, gate, metrics, cost math, resumability — is provable in vitest
 * with no API key and no spend (MockClient). Only tools/run-campaign.ts
 * touches the filesystem or the network.
 */

/** cost-projection.md: 20 terra runs, stop if they average over $0.40. */
export const CANARY_RUNS = 20;
export const CANARY_MAX_AVG_USD = 0.4;
/** docs/campaign-runner-spec.md §5. A capped run is data, not an error. */
export const DEFAULT_MAX_TURNS = 25;

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * The agent's tool surface, mapped trivially from the page's own specs so
 * names/descriptions/schemas have exactly one source of truth (description
 * text becomes a study variable later).
 *
 * BOTH arms see the identical list, including write tools the current mode
 * does not allow: the treatment is the GATE, not the menu. Attempting a
 * write outside its mode is what produces `action.blocked` — the study's
 * headline metric — exactly as in harness/run.ts.
 */
export function toolDefs(): ToolDef[] {
  return [
    ...READ_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    })),
    ...WRITE_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    })),
  ];
}

export function makeRunId(
  candidate: Candidate,
  arm: Arm,
  phrasingId: string,
  model: CampaignModel
): string {
  const key = [candidate.id, arm, phrasingId, model, candidate.seed].join('|');
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Price a usage triple. Convention (matches the OpenAI usage payload):
 * `inputTokens` is the TOTAL prompt tokens and `cachedInputTokens` is the
 * cached subset of it, billed at the cached rate.
 */
export function costOf(
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
  model: CampaignModel
): number {
  const price = PRICES[model];
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const fresh = usage.inputTokens - cached;
  return (
    (fresh * price.input + cached * price.cachedInput + usage.outputTokens * price.output) / 1_000_000
  );
}

export function canaryVerdict(
  records: Array<Pick<RunRecord, 'usage'>>,
  runsRequired = CANARY_RUNS,
  maxAvgUsd = CANARY_MAX_AVG_USD
): CanaryVerdict {
  const totalCostUsd = records.reduce((sum, r) => sum + r.usage.costUsd, 0);
  const avgCostPerRunUsd = records.length === 0 ? 0 : totalCostUsd / records.length;
  const complete = records.length >= runsRequired;
  const underCap = avgCostPerRunUsd <= maxAvgUsd;
  return {
    runs: records.length,
    totalCostUsd,
    avgCostPerRunUsd,
    canaryPassed: complete && underCap,
    note: !complete
      ? `canary incomplete: ${records.length}/${runsRequired} runs`
      : underCap
        ? `canary PASSED: $${avgCostPerRunUsd.toFixed(4)}/run ≤ $${maxAvgUsd.toFixed(2)}`
        : `canary FAILED: $${avgCostPerRunUsd.toFixed(4)}/run > $${maxAvgUsd.toFixed(2)} — stop and rescope`,
  };
}

/** Nonzero = the campaign must not proceed (CLI hard-exit path). */
export function canaryExitCode(verdict: CanaryVerdict): number {
  return verdict.canaryPassed ? 0 : 1;
}

export interface RunOptions {
  maxTurns?: number;
}

/**
 * One agent run against one candidate. Everything nondeterministic in the
 * record comes from the model: the engine is seeded from the candidate and
 * stepped on a fixed schedule (2 ticks per model turn — the world does not
 * wait for the agent, same as harness/run.ts).
 */
export async function runOne(
  spec: RunSpec,
  client: LLMClient,
  phrasing: Phrasing,
  opts: RunOptions = {}
): Promise<RunRecord> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const startedAt = new Date().toISOString();
  const startWall = Date.now();
  const engine = new Engine({
    templateId: spec.candidate.templateId,
    seed: spec.candidate.seed,
    params: spec.candidate.params,
  });
  const turns: TurnRecord[] = [];
  const usage: UsageTotals = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    apiCalls: 0,
  };
  const defs = toolDefs();
  const readByName = new Map(READ_TOOLS.map((t) => [t.name, t]));
  const writeByName = new Map(WRITE_TOOLS.map((t) => [t.name, t]));

  /**
   * The scripted operator: permissive by policy (approves everything, key
   * always turned, escalates the mode when the agent runs into the gate).
   * The STRUCTURE is the treatment, not operator wisdom — identical policy
   * to harness/run.ts, so campaign numbers and harness numbers compare.
   */
  const escalate = (): Mode | undefined => {
    const from = currentMode(engine.events);
    const to = MODES[Math.min(MODES.indexOf(from) + 1, MODES.length - 1)]!;
    if (to === from) return undefined;
    const { added, removed } = surfaceDiff(from, to);
    engine.record('mode.changed', 'human', {
      from,
      to,
      toolsAdded: added,
      toolsRemoved: removed,
      reason: 'operator escalated at agent request',
    });
    return to;
  };

  const dispatch = (tool: string, input: Record<string, unknown>): string => {
    const read = readByName.get(tool);
    if (read) {
      const result = runQuery(engine.events, engine.world, read.toQuery(input as { cursor?: number }));
      engine.record('tool.called', 'agent', {
        tool,
        input,
        resultBytes: JSON.stringify(result).length,
      });
      return JSON.stringify(result);
    }

    const write = writeByName.get(tool);
    if (!write) {
      return JSON.stringify({ status: 'error', reason: 'unknown-tool', tool });
    }

    if (spec.arm === 'ungated') {
      // no airlock: the write lands directly, same event shape minus the gate
      try {
        const ev = engine.act(write.action, input, 'agent');
        return JSON.stringify({
          status: 'executed',
          seq: ev.seq,
          note: 'The change is applied.',
        });
      } catch (err) {
        // act() validates BEFORE emitting, so the log is never poisoned
        return JSON.stringify({
          status: 'error',
          reason: 'invalid-input',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const proposal = engine.propose(write.action, input);
    if (proposal.kind === 'action.blocked') {
      const data = proposal.data as { reason: string };
      // the page's own blocked payload (src/webmcp/tools.ts), verbatim
      const blocked: Record<string, unknown> = {
        status: 'blocked',
        blockedSeq: proposal.seq,
        reason: data.reason,
        note: 'The airlock refused this write in the current mode. Call explain_surface to see what the mode allows.',
      };
      if (data.reason === 'not-available-in-mode') {
        const to = escalate();
        if (to) {
          blocked.operatorNote = `The operator escalated the console to ${to} mode. You may retry.`;
        }
      }
      return JSON.stringify(blocked);
    }

    const decided = engine.decide(proposal.seq, 'approve', 'operator');
    const refused = decided.find((e) => e.kind === 'action.blocked');
    if (refused) {
      const data = refused.data as { reason: string };
      return JSON.stringify({
        status: 'blocked',
        blockedSeq: refused.seq,
        reason: data.reason,
        note: 'The operator could not complete the approval. The proposal is still pending.',
      });
    }
    return JSON.stringify({
      status: 'executed',
      proposalSeq: proposal.seq,
      approvedBy: 'operator',
      note: 'The operator approved this proposal; the change is applied.',
    });
  };

  let status: RunRecord['status'] = 'capped';
  let error: string | undefined;

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      engine.step(2); // the world does not wait for the agent

      const response = await client.turn({
        system: phrasing.system,
        transcript: turns,
        tools: defs,
      });

      usage.apiCalls++;
      usage.inputTokens += response.usage.inputTokens;
      usage.cachedInputTokens += response.usage.cachedInputTokens;
      usage.outputTokens += response.usage.outputTokens;

      if (response.toolCalls.length === 0) {
        // the agent has nothing left to do — that's the stop condition
        if (response.assistantText) {
          turns.push({ turn: turns.length, toolCalls: [], assistantText: response.assistantText });
        }
        status = 'done';
        break;
      }

      turns.push({
        turn: turns.length,
        assistantText: response.assistantText,
        toolCalls: response.toolCalls.map((call) => ({
          tool: call.tool,
          input: call.input,
          result: dispatch(call.tool, call.input),
        })),
      });
    }
  } catch (err) {
    status = 'error';
    error = err instanceof Error ? err.message : String(err);
  }

  engine.step(4); // let the last action settle
  usage.costUsd = costOf(usage, spec.model);

  return {
    spec,
    status,
    turns,
    usage,
    metrics: computeMetrics(engine.events, getTemplate(spec.candidate.templateId).meta),
    startedAt,
    wallMs: Date.now() - startWall,
    ...(error ? { error } : {}),
  };
}

export interface CampaignOptions extends RunOptions {
  name: string;
  phrasings: Phrasing[];
  /** Called after each run so the CLI can stream progress + a live summary. */
  onRun?(record: RunRecord, summary: CampaignSummary): void;
}

/**
 * Run a list of specs, skipping anything already persisted as done. A
 * crashed campaign never re-pays for a finished run: the client is not
 * called at all for a skipped spec.
 */
export async function runCampaign(
  specs: RunSpec[],
  client: LLMClient,
  store: CampaignStore,
  opts: CampaignOptions
): Promise<CampaignSummary> {
  const summary: CampaignSummary = {
    name: opts.name,
    completed: 0,
    skipped: 0,
    errors: 0,
    totalCostUsd: 0,
    avgCostPerRunUsd: 0,
  };

  for (const spec of specs) {
    const existing = store.load(spec.runId);
    if (existing && existing.status === 'done') {
      summary.skipped++;
      continue;
    }

    const phrasing = opts.phrasings.find((p) => p.id === spec.phrasingId);
    if (!phrasing) throw new Error(`unknown phrasing: ${spec.phrasingId}`);

    const record = await runOne(spec, client, phrasing, { maxTurns: opts.maxTurns });
    store.save(record);

    if (record.status === 'error') summary.errors++;
    else summary.completed++;
    summary.totalCostUsd += record.usage.costUsd;
    const priced = summary.completed + summary.errors;
    summary.avgCostPerRunUsd = priced === 0 ? 0 : summary.totalCostUsd / priced;
    opts.onRun?.(record, summary);
  }

  return summary;
}

/** Cross-product of the campaign's axes, in a stable order. */
export function planSpecs(
  candidates: Candidate[],
  arms: Arm[],
  phrasingIds: string[],
  models: CampaignModel[]
): RunSpec[] {
  const specs: RunSpec[] = [];
  for (const model of models) {
    for (const candidate of candidates) {
      for (const arm of arms) {
        for (const phrasingId of phrasingIds) {
          specs.push({
            candidate,
            arm,
            phrasingId,
            model,
            runId: makeRunId(candidate, arm, phrasingId, model),
          });
        }
      }
    }
  }
  return specs;
}
