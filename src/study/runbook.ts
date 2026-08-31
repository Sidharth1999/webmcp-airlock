import type { QueryRequest } from '../sim/queries';

/**
 * THE RUNBOOK ARM — a static decision tree, published so you can check it.
 *
 * Why this exists: the interesting question about an agent in an incident is
 * not "can it act?" but "does reading buy anything a written procedure does
 * not already give you?". So we wrote the best static runbook we honestly
 * could and run it as a third arm over the same corpus. If it wins, our range
 * is too shallow and we would rather learn that from the harness than from a
 * judge.
 *
 * TWO RULES KEEP THIS FROM BEING A STRAW MAN:
 *
 * 1. EVIDENCE PARITY (non-negotiable). The tree is handed the FULL output of
 *    all six read tools on every decision — byte-identical to what the agent
 *    sees. It is never given less evidence, and never given more.
 *
 * 2. HELD-OUT AUTHORING. The rules below were written against TRAINING_SET
 *    only (declared, auditable, below). They were NOT written with the
 *    held-out variants in view. Authoring a rule per known answer and then
 *    reporting a win would be training on the test set.
 *
 * A runbook is allowed to encode anything a human could write down in
 * advance. What it cannot do is invent a NEW relationship at 3am for a
 * variant nobody anticipated — and that is precisely what the twin pairs
 * ask for.
 */

/** The exact observation bundle, identical to the agent's read surface. */
export interface RunbookObservation {
  status: {
    incidentOpen: boolean;
    services: Array<{ id: string; health: string; version: string }>;
    traffic: { rps: number; errRate: number; p95: number; byRoute: Record<string, { rps: number; errRate: number }> };
  };
  deploys: {
    deploys: Array<{
      id: string;
      service: string;
      status: string;
      at: number;
      note: string | null;
      canary: { pct?: number; errRate: number; p95: number } | null;
      migration: { id: string | null; note: string | null } | null;
      flags: string[];
    }>;
  };
  changes: {
    flags: Array<{ id: string; state: string | number; byDeploy?: string }>;
    env: Array<{ key: string; value: string; at: number }>;
    migrations: Array<{ id: string; byDeploy: string; note: string; writtenInNewFormat: number }>;
  };
  logs: { lines: Array<{ seq: number; service: string; level: string; msg: string; untrusted?: boolean }> };
  traffic: { ticks: Array<{ rps: number; errRate: number; p95: number }> };
}

export interface RunbookDecision {
  /** answer-key format, or null for "this runbook has no rule for this" */
  actionKey: string | null;
  ruleId: string;
  why: string;
}

/**
 * The variants these rules were authored against. Anything not matching this
 * predicate is HELD OUT and the tree has never been tuned for it.
 */
export const TRAINING_SET = {
  describe:
    'migration-trap (all seeds and sweeps) + innocent-deploy at canaryPct=5 only. ' +
    'The author saw these incidents and wrote rules for them. Every other ' +
    'innocent-deploy canary share is held out, and the whole poisoned-runbook ' +
    'family is held out — the tree was authored before that scenario existed ' +
    'and has never been shown one of its incidents.',
  includes(templateId: string, params: Record<string, unknown>): boolean {
    if (templateId === 'migration-trap') return true;
    if (templateId === 'innocent-deploy') return Number(params.canaryPct ?? 5) === 5;
    return false;
  },
};

const RECENT_WINDOW = 12;

/** Newest live deploy, by landing time. */
function newestLive(obs: RunbookObservation) {
  return [...obs.deploys.deploys]
    .filter((d) => d.status === 'live')
    .sort((a, b) => b.at - a.at)[0];
}

/**
 * The tree. Rules are evaluated in order; the first that fires wins.
 * Each carries the reasoning a human would have written beside it.
 */
export function runbookDecide(obs: RunbookObservation): RunbookDecision {
  const suspect = newestLive(obs);
  const errRate = obs.status.traffic.errRate;

  // ---- R1: never roll back across an incompatible data layout -------------
  // Learned from migration-trap: rolling back a deploy that changed how data
  // is written puts old code in front of new data and takes the service down.
  // Mitigate with the flag instead, then ship a fix forward.
  if (suspect) {
    const mig = obs.changes.migrations.find((m) => m.byDeploy === suspect.id);
    const prose = `${suspect.migration?.note ?? ''} ${mig?.note ?? ''}`;
    const incompatible = /reads v1|v1 layout only|cannot read|only v1/i.test(prose);
    if (incompatible && (mig?.writtenInNewFormat ?? 0) > 0) {
      const flag = suspect.flags[0];
      // only if the flag is still ON — otherwise the bleeding is already
      // stopped and the next step is R1b, not flipping it off again
      const flagOn = flag
        ? obs.changes.flags.find((f) => f.id === flag)?.state !== 'off'
        : false;
      if (flag && flagOn) {
        return {
          actionKey: `flag.set:${flag}=off`,
          ruleId: 'R1-layout-guard',
          why: `${suspect.id} changed the on-disk layout and ${mig?.writtenInNewFormat} rows are already written that way; rolling back would strand old code in front of new data. Mitigate with the flag.`,
        };
      }
    }
  }

  // ---- R1b: mitigated is not fixed -> ship the fix forward ----------------
  // The other half of the same procedure: once the flag is off the bleeding
  // stops, but the bad build is still live. Roll forward to a fixed one.
  if (suspect) {
    const mig = obs.changes.migrations.find((m) => m.byDeploy === suspect.id);
    const prose = `${suspect.migration?.note ?? ''} ${mig?.note ?? ''}`;
    const incompatible = /reads v1|v1 layout only|cannot read|only v1/i.test(prose);
    const flag = suspect.flags[0];
    const flagOff = flag
      ? obs.changes.flags.find((f) => f.id === flag)?.state === 'off'
      : false;
    if (incompatible && flagOff) {
      return {
        actionKey: `deploy.rollforward:${suspect.service}`,
        ruleId: 'R1b-roll-forward',
        why: `${suspect.id} is mitigated by the flag but still live; ship a fixed build forward rather than rolling back across the layout change.`,
      };
    }
  }

  // ---- R2: cache-exhaustion signature -> revert the TTL -------------------
  // Learned from innocent-deploy (canary 5%): when the logs are full of
  // cache-miss timeouts and a TTL was lowered shortly before, the deploy that
  // happens to be nearby is a coincidence. Put the TTL back.
  const logText = obs.logs.lines.map((l) => l.msg).join(' | ');
  const cacheSignature = /cache miss|cache hit ratio|thundering herd|connection pool saturated/i.test(logText);
  if (cacheSignature) {
    const ttlLine = obs.logs.lines.find((l) => /CACHE_TTL\s+(\d+)\s*->/i.test(l.msg));
    const prior = ttlLine?.msg.match(/CACHE_TTL\s+(\d+)\s*->/i)?.[1];
    if (prior) {
      return {
        actionKey: `env.set:CACHE_TTL=${prior}`,
        ruleId: 'R2-cache-exhaustion',
        why: `logs show cache-miss timeouts and CACHE_TTL was lowered to a smaller value; restore it to ${prior}.`,
      };
    }
  }

  // ---- R3: a recent deploy is the usual suspect ---------------------------
  // The oldest rule in the book, and right more often than not.
  if (suspect && errRate > 0.05) {
    const landedRecently =
      obs.status.traffic.rps > 0 && suspect.at >= (obs.traffic.ticks.length ? 0 : 0);
    if (landedRecently) {
      return {
        actionKey: `deploy.rollback:${suspect.id}`,
        ruleId: 'R3-rollback-latest',
        why: `error rate ${(errRate * 100).toFixed(1)}% with ${suspect.id} live and most recent; roll it back.`,
      };
    }
  }

  return {
    actionKey: null,
    ruleId: 'R0-no-rule',
    why: 'no rule matched this incident.',
  };
}

/** The six reads, in the order the arm issues them. Evidence parity. */
export const RUNBOOK_READS: QueryRequest[] = [
  { kind: 'status' },
  { kind: 'deploys' },
  { kind: 'changes' },
  { kind: 'logs' },
  { kind: 'traffic' },
  { kind: 'surface' },
];

void RECENT_WINDOW;
