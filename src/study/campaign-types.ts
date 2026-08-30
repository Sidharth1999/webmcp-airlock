import type { RunMetrics } from '../harness/metrics';
import type { Candidate } from './compiler';

/**
 * M4-03 campaign runner contracts — designed at M3 close so implementation
 * is mechanical. See docs/campaign-runner-spec.md for the loop, the
 * persistence rules, and the tests to write first. Do not weaken these
 * types to make an implementation easier; that's an architecture change
 * and belongs in PLAN.md.
 */

export type Arm = 'gated' | 'ungated';
export type CampaignModel = 'gpt-5.6-luna' | 'gpt-5.6-terra' | 'gpt-5.6-sol';

/** $/1M tokens. ONE place to correct at key unlock (see cost-projection.md). */
export const PRICES: Record<CampaignModel, { input: number; cachedInput: number; output: number }> = {
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, output: 1.2 },
  'gpt-5.6-terra': { input: 2.0, cachedInput: 0.2, output: 12.0 },
  'gpt-5.6-sol': { input: 5.0, cachedInput: 0.5, output: 30.0 },
};

export interface Phrasing {
  id: string;
  /** Full system prompt variant. Varies tone/verbosity/urgency, never facts. */
  system: string;
}

export interface RunSpec {
  candidate: Candidate;
  arm: Arm;
  phrasingId: string;
  model: CampaignModel;
  /** sha256(candidateId|arm|phrasingId|model|seed).slice(0,16) */
  runId: string;
}

export interface UsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Computed from PRICES — cached tokens billed at cachedInput rate. */
  costUsd: number;
  apiCalls: number;
}

/** One agent-visible exchange, persisted verbatim for the failure taxonomy. */
export interface TurnRecord {
  turn: number;
  toolCalls: Array<{ tool: string; input: Record<string, unknown>; result: string }>;
  assistantText?: string;
}

export interface RunRecord {
  spec: RunSpec;
  status: 'done' | 'capped' | 'error';
  turns: TurnRecord[];
  usage: UsageTotals;
  metrics: RunMetrics;
  startedAt: string; // ISO, wall-clock is fine here (not sim code)
  wallMs: number;
  error?: string;
}

/**
 * The ONLY seam to the LLM. openai-client.ts implements it over the
 * Responses API; mock-client.ts implements it as a scripted policy so the
 * entire loop is provable in vitest with no key and no spend.
 */
export interface LLMClient {
  /** One model turn: given the transcript so far + tool defs, return the
   * model's tool calls (or none = the agent is done) and token usage. */
  turn(req: {
    system: string;
    transcript: TurnRecord[];
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  }): Promise<{
    toolCalls: Array<{ tool: string; input: Record<string, unknown> }>;
    assistantText?: string;
    usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
  }>;
}

export interface CampaignSummary {
  name: string;
  completed: number;
  skipped: number;
  errors: number;
  totalCostUsd: number;
  avgCostPerRunUsd: number;
  /** Canary verdict per cost-projection.md: 20 terra runs, ≤$0.40 avg. */
  canaryPassed?: boolean;
}

/**
 * Persistence seam (added at implementation, M4-03). The spec keeps
 * campaign.ts "pure of I/O except via the injected client"; resumability
 * still has to be a unit test, so the store is injected the same way the
 * client is: in-memory in vitest, one JSON file per run under
 * study/campaign/<name>/ in tools/run-campaign.ts.
 */
export interface CampaignStore {
  load(runId: string): RunRecord | undefined;
  save(record: RunRecord): void;
}

/** Result of the pre-campaign canary gate (cost-projection.md). */
export interface CanaryVerdict {
  runs: number;
  totalCostUsd: number;
  avgCostPerRunUsd: number;
  canaryPassed: boolean;
  /** Human-readable verdict for the CLI + STATUS. */
  note: string;
}
