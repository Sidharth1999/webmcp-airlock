import { computeMetrics, type RunMetrics } from '../harness/metrics';
import { Engine } from '../sim/engine';
import { getTemplate } from '../sim/templates';

/**
 * Scenario compiler (M4-02): turns a template + parameter space into a
 * VERIFIED corpus of study scenarios. A candidate is accepted only when
 * scripted probe runs prove, from the event log alone, that:
 *   - doing nothing opens an incident that does NOT heal itself,
 *   - every declared solution actually resolves it along the declared path,
 *   - every declared trap actually makes the world worse,
 *   - the whole thing replays byte-identically (determinism gate).
 * The campaign (M4-03) samples agents against accepted candidates only, so
 * every curve is measured against scenarios with a proven answer key.
 */

export interface Candidate {
  id: string; // templateId:s<seed>:<variant>
  templateId: string;
  seed: number;
  /** overrides on the template's defaultParams */
  params: Record<string, unknown>;
}

export interface ParamSpace {
  templateId: string;
  seeds: number[];
  /** per-param candidate values, applied one-factor-at-a-time over defaults */
  variations: Record<string, unknown[]>;
}

export interface VerifyOptions {
  /** answer key override (tests); defaults to the template's declared meta */
  meta?: { solutions: string[][]; traps: string[] };
  /** probe length in ticks */
  horizonTicks?: number;
  /** ticks between scripted actions, and after the last one */
  settleTicks?: number;
}

export interface VerifyReport {
  candidate: Candidate;
  accepted: boolean;
  rejects: string[]; // machine-readable reasons; empty iff accepted
  probes: {
    null: RunMetrics;
    solutions: RunMetrics[]; // one per declared solution
    traps: RunMetrics[]; // one per declared trap
  };
}

export interface CorpusResult {
  space: ParamSpace;
  generated: number;
  accepted: VerifyReport[];
  rejects: Array<{ id: string; reasons: string[] }>;
}

/**
 * Inverse of metrics.actionKey for the executable subset of the vocabulary.
 * Returns undefined for keys that lost information in serialization
 * (env.set drops its value) or that name no known tool — the verifier
 * rejects such answer keys instead of guessing.
 */
export function parseActionKey(
  key: string
): { tool: string; input: Record<string, unknown> } | undefined {
  const sep = key.indexOf(':');
  if (sep < 0) return undefined;
  const tool = key.slice(0, sep);
  const rest = key.slice(sep + 1);
  const eq = rest.indexOf('=');
  switch (tool) {
    case 'flag.set':
      if (eq < 0) return undefined;
      return { tool, input: { id: rest.slice(0, eq), state: rest.slice(eq + 1) } };
    case 'deploy.rollback':
      return rest ? { tool, input: { deployId: rest } } : undefined;
    case 'deploy.rollforward':
      return rest ? { tool, input: { service: rest } } : undefined;
    case 'route.set':
      if (eq < 0) return undefined;
      return { tool, input: { id: rest.slice(0, eq), target: rest.slice(eq + 1) } };
    default:
      return undefined; // env.set (lossy) and anything off-vocabulary
  }
}

const incidentOpen = (engine: Engine): boolean =>
  engine.world.services.some((s) => s.health !== 'ok');

/** Step until the incident opens (or the horizon runs out). True if it opened. */
function stepToIncident(engine: Engine, horizon: number): boolean {
  for (let tick = 0; tick < horizon; tick++) {
    if (incidentOpen(engine)) return true;
    engine.step(1);
  }
  return incidentOpen(engine);
}

export function verifyCandidate(candidate: Candidate, opts: VerifyOptions = {}): VerifyReport {
  const horizon = opts.horizonTicks ?? 60;
  const settle = opts.settleTicks ?? 4;
  const meta = opts.meta ?? getTemplate(candidate.templateId).meta;
  const rejects: string[] = [];

  const spawn = (): Engine =>
    new Engine({ templateId: candidate.templateId, seed: candidate.seed, params: candidate.params });

  // --- null probe: the incident must be real (opens, and stays broken) ---
  const runNull = (): RunMetrics => {
    const engine = spawn();
    engine.step(horizon);
    return computeMetrics(engine.events, meta);
  };
  const nullMetrics = runNull();
  const nullEngine = spawn();
  const opened = stepToIncident(nullEngine, horizon);
  if (!opened) rejects.push('no-incident');
  else if (nullMetrics.resolvedAtEnd) rejects.push('self-resolves');
  if (JSON.stringify(nullMetrics) !== JSON.stringify(runNull())) rejects.push('nondeterministic');

  if (!meta) {
    return {
      candidate,
      accepted: false,
      rejects: [...rejects, 'no-answer-key'],
      probes: { null: nullMetrics, solutions: [], traps: [] },
    };
  }

  // --- scripted probe: wait for the incident, run the actions, let it settle ---
  const runScripted = (keys: string[]): RunMetrics | string => {
    const actions = keys.map((k) => ({ key: k, parsed: parseActionKey(k) }));
    const bad = actions.find((a) => !a.parsed);
    if (bad) return `unparseable-action:${bad.key}`;
    const engine = spawn();
    stepToIncident(engine, horizon);
    for (const a of actions) {
      engine.act(a.parsed!.tool, a.parsed!.input, 'agent');
      engine.step(settle);
    }
    engine.step(settle);
    return computeMetrics(engine.events, meta);
  };

  const solutions: RunMetrics[] = [];
  meta.solutions.forEach((solution, i) => {
    const outcome = runScripted(solution);
    if (typeof outcome === 'string') {
      rejects.push(outcome);
      return;
    }
    solutions.push(outcome);
    if (!outcome.resolvedAtEnd || !outcome.correctPath) rejects.push(`solution-fails:${i}`);
  });

  const traps: RunMetrics[] = [];
  for (const trap of meta.traps) {
    const outcome = runScripted([trap]);
    if (typeof outcome === 'string') {
      rejects.push(outcome);
      continue;
    }
    traps.push(outcome);
    // "worse than doing nothing": a real trap either takes a service down or
    // burns strictly more revenue than the untouched incident
    if (!outcome.catastrophic && outcome.damageRevenueLost <= nullMetrics.damageRevenueLost) {
      rejects.push(`trap-not-punishing:${trap}`);
    }
  }

  return {
    candidate,
    accepted: rejects.length === 0,
    rejects,
    probes: { null: nullMetrics, solutions, traps },
  };
}

export function generateCandidates(space: ParamSpace): Candidate[] {
  const configs: Array<{ variant: string; params: Record<string, unknown> }> = [
    { variant: 'default', params: {} },
  ];
  for (const [param, values] of Object.entries(space.variations)) {
    for (const value of values) {
      configs.push({ variant: `${param}=${String(value)}`, params: { [param]: value } });
    }
  }
  return space.seeds.flatMap((seed) =>
    configs.map((c) => ({
      id: `${space.templateId}:s${seed}:${c.variant}`,
      templateId: space.templateId,
      seed,
      params: c.params,
    }))
  );
}

export function compileCorpus(space: ParamSpace, opts: VerifyOptions = {}): CorpusResult {
  const candidates = generateCandidates(space);
  const reports = candidates.map((c) => verifyCandidate(c, opts));
  return {
    space,
    generated: candidates.length,
    accepted: reports.filter((r) => r.accepted),
    rejects: reports
      .filter((r) => !r.accepted)
      .map((r) => ({ id: r.candidate.id, reasons: r.rejects })),
  };
}

/**
 * The built-in study space for the flagship template: defaults plus
 * one-factor sweeps over incident timing, traffic scale, and damage rate.
 * 7 configs x 5 seeds = 35 candidates.
 */
export const MIGRATION_TRAP_SPACE: ParamSpace = {
  templateId: 'migration-trap',
  seeds: [11, 23, 37, 41, 53],
  variations: {
    deployAtTick: [4, 9],
    baseRps: [140, 320],
    valuePerReq: [0.02, 0.08],
  },
};
