import { computeMetrics, type RunMetrics } from '../harness/metrics';
import { Engine } from '../sim/engine';
import { runQuery } from '../sim/queries';
import { metaFor } from '../sim/templates';
import { parseActionKey, type Candidate } from './compiler';
import {
  RUNBOOK_READS,
  TRAINING_SET,
  runbookDecide,
  type RunbookDecision,
  type RunbookObservation,
} from './runbook';

/**
 * Runs the published static runbook (src/study/runbook.ts) as a third eval
 * arm over the verified corpus, with EVIDENCE PARITY: the tree is handed the
 * full output of the same six read tools the agent gets, through the same
 * query path, and every read is recorded as a tool.called so the two arms are
 * counted the same way.
 *
 * Token-free — no model is involved on this arm, which is exactly why it is
 * the cheapest honest baseline we have.
 */

/** How many log pages the arm may walk (the agent's realistic budget). */
const LOG_PAGES = 5;
/** How many actions the runbook may take before we call it done. */
const MAX_ACTIONS = 4;
/** Observation rounds; an operator keeps watching while clues arrive. */
const MAX_ROUNDS = 14;

export interface RunbookArmResult {
  candidate: Candidate;
  /** false = this variant was in the set the tree was authored against */
  heldOut: boolean;
  decision: RunbookDecision;
  /** every rule that fired, in order */
  rules: string[];
  /** every action actually taken */
  actions: string[];
  metrics: RunMetrics;
  /** ran a declared solution and tripped no declared trap */
  correct: boolean;
  /** executed an action the template declares as a trap */
  trapped: boolean;
}

export function runRunbookArm(
  candidate: Candidate,
  opts: { horizonTicks?: number; settleTicks?: number } = {}
): RunbookArmResult {
  const horizon = opts.horizonTicks ?? 60;
  const settle = opts.settleTicks ?? 4;
  const meta = metaFor(candidate.templateId, candidate.params);

  const engine = new Engine({
    templateId: candidate.templateId,
    seed: candidate.seed,
    params: candidate.params,
  });

  // wait for the incident, exactly like the other arms
  let used = 0;
  for (let tick = 0; tick < horizon; tick++) {
    if (engine.world.services.some((s) => s.health !== 'ok')) break;
    engine.step(1);
    used++;
  }

  // --- evidence parity: the same six reads, recorded the same way ---
  // Logs are PAGINATED, exactly as the agent may page them. Reading only the
  // first page would hand the runbook less evidence than the agent and make
  // this arm a straw man.
  const observe = (): RunbookObservation => {
    const bundle: Record<string, unknown> = {};
    for (const q of RUNBOOK_READS) {
      const result = runQuery(engine.events, engine.world, q);
      engine.record('tool.called', 'agent', {
        tool: q.kind,
        input: {},
        resultBytes: JSON.stringify(result).length,
      });
      bundle[q.kind] = result;
    }
    const lines = [
      ...((bundle.logs as { lines: unknown[] }).lines ?? []),
    ] as Array<Record<string, unknown>>;
    let cursor = (bundle.logs as { nextCursor?: number }).nextCursor;
    for (let page = 0; page < LOG_PAGES && cursor !== undefined; page++) {
      const next = runQuery(engine.events, engine.world, { kind: 'logs', cursor }) as {
        lines: Array<Record<string, unknown>>;
        nextCursor?: number;
      };
      engine.record('tool.called', 'agent', {
        tool: 'logs',
        input: { cursor },
        resultBytes: JSON.stringify(next).length,
      });
      lines.push(...next.lines);
      cursor = next.nextCursor;
    }
    bundle.logs = { lines };
    return bundle as unknown as RunbookObservation;
  };

  // --- ACTION PARITY: the runbook gets to keep working, like the agent -----
  // A single-shot runbook would be scored a failure on any answer that takes
  // more than one step (the flagship's answer is mitigate THEN roll forward).
  // An operator working from a runbook does not walk away the instant no
  // rule matches -- at the moment an incident opens the diagnostic clues have
  // not arrived yet. So: keep observing, and act whenever a rule fires.
  const decisions: RunbookDecision[] = [];
  const takenKeys = new Set<string>();
  let acted = 0;
  for (let round = 0; round < MAX_ROUNDS && used < horizon && acted < MAX_ACTIONS; round++) {
    const decision = runbookDecide(observe());
    decisions.push(decision);

    if (!decision.actionKey || takenKeys.has(decision.actionKey)) {
      // nothing to do yet (or nothing new) -- let the incident develop
      const wait = Math.min(2, Math.max(0, horizon - used));
      if (wait === 0) break;
      engine.step(wait);
      used += wait;
      continue;
    }

    const parsed = parseActionKey(decision.actionKey);
    if (!parsed) break;
    takenKeys.add(decision.actionKey);
    engine.act(parsed.tool, parsed.input, 'agent');
    acted++;
    const budget = Math.min(settle, Math.max(0, horizon - used));
    engine.step(budget);
    used += budget;
  }
  engine.step(Math.max(0, horizon - used));

  // report the first rule that actually produced an action (or the last one)
  const decision =
    decisions.find((d) => d.actionKey !== null) ?? decisions[decisions.length - 1]!;

  const metrics = computeMetrics(engine.events, meta);
  const trapped = [...takenKeys].some((k) => meta?.traps.includes(k) ?? false);

  return {
    candidate,
    heldOut: !TRAINING_SET.includes(candidate.templateId, {
      ...candidate.params,
    }),
    decision,
    rules: decisions.map((d) => d.ruleId),
    actions: [...takenKeys],
    metrics,
    correct: metrics.correctPath && metrics.resolvedAtEnd && !trapped,
    trapped,
  };
}

export interface ArmSummary {
  total: number;
  correct: number;
  trapped: number;
  noRule: number;
  meanDamage: number;
}

export function summarize(results: RunbookArmResult[]): ArmSummary {
  const total = results.length;
  const damage = results.reduce((a, r) => a + r.metrics.damageRevenueLost, 0);
  return {
    total,
    correct: results.filter((r) => r.correct).length,
    trapped: results.filter((r) => r.trapped).length,
    noRule: results.filter((r) => r.decision.actionKey === null).length,
    meanDamage: total === 0 ? 0 : Number((damage / total).toFixed(2)),
  };
}
