import type { World } from './types';

/**
 * The write-tool vocabulary — single registry for every layer that speaks it
 * (reducer applies it, templates react to it, the console offers it, WebMCP
 * proposals cite it). Pays down the 2026-08-28 review deferral: no more
 * string-matching the same tool names independently per layer.
 *
 * Tiers are the SPEC write-escalation ladder: deploy < env < flag < route.
 * (Deploys are routine ops; touching routing/DNS is the top rung and will
 * require the dual key — M3-04.)
 */

export type WriteTier = 1 | 2 | 3 | 4;

export interface WriteAction {
  /** The action.executed `tool` string — the vocabulary key. */
  tool: string;
  tier: WriteTier;
  tierName: 'deploy' | 'env' | 'flag' | 'route';
  /** One-line human diff for proposals/audit ("what would change"). */
  describe(input: Record<string, unknown>, world: World): string;
  /**
   * Shape check BEFORE anything enters the log (residual-review fix: an
   * LLM omitting a required field, or Chrome-151's unparseable-string →
   * `{}` coercion, must never poison the event log or the world).
   * Returns a human-readable problem, or null when the input is sound.
   */
  validate(input: Record<string, unknown>): string | null;
}

const needString = (input: Record<string, unknown>, key: string): string | null =>
  typeof input[key] === 'string' && (input[key] as string).length > 0
    ? null
    : `${key} (string) is required`;

export const WRITE_ACTIONS: Record<string, WriteAction> = {
  'deploy.rollback': {
    tool: 'deploy.rollback',
    validate: (i) => needString(i, 'deployId'),
    tier: 1,
    tierName: 'deploy',
    describe(input, world) {
      const id = String(input.deployId ?? '?');
      const target = world.deploys.find((d) => d.id === id);
      const prev = target
        ? [...world.deploys]
            .reverse()
            .find((d) => d.service === target.service && d.status === 'superseded')
        : undefined;
      return prev
        ? `roll back ${id}: ${target!.service} ${target!.version} → ${prev.version} (${prev.id} becomes live)`
        : `roll back ${id}: no superseded predecessor — would be rejected`;
    },
  },
  'deploy.rollforward': {
    tool: 'deploy.rollforward',
    validate: (i) => needString(i, 'service'),
    tier: 1,
    tierName: 'deploy',
    describe(input, world) {
      const svc = String(input.service ?? '?');
      const cur = world.services.find((s) => s.id === svc);
      return `roll forward ${svc}: ship the next build${cur ? ` (currently ${cur.version})` : ''}`;
    },
  },
  'env.set': {
    tool: 'env.set',
    validate: (i) => needString(i, 'key') ?? needString(i, 'value'),
    tier: 2,
    tierName: 'env',
    describe(input, world) {
      const key = String(input.key ?? '?');
      const exists = world.envVars.some((v) => v.key === key);
      return `${exists ? 'change' : 'set'} env ${key} (value will be stored redacted)`;
    },
  },
  'flag.set': {
    tool: 'flag.set',
    validate: (i) =>
      needString(i, 'id') ?? (i.state === 'on' || i.state === 'off' ? null : "state must be 'on' or 'off'"),
    tier: 3,
    tierName: 'flag',
    describe(input, world) {
      const id = String(input.id ?? '?');
      const cur = world.flags.find((f) => f.id === id);
      return `flag ${id}: ${cur ? String(cur.state) : 'unset'} → ${String(input.state)}`;
    },
  },
  'route.set': {
    tool: 'route.set',
    validate: (i) => needString(i, 'id') ?? needString(i, 'target'),
    tier: 4,
    tierName: 'route',
    describe(input, world) {
      const id = String(input.id ?? '?');
      const cur = world.routes.find((r) => r.id === id);
      return `route ${id}: target ${cur ? cur.target : 'unset'} → ${String(input.target)} (top-tier: dual-key)`;
    },
  },
};

export function writeAction(tool: string): WriteAction {
  const a = WRITE_ACTIONS[tool];
  if (!a) throw new Error(`unknown write tool: ${tool}`);
  return a;
}
