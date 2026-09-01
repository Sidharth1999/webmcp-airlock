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

/**
 * EVERY CONTROL COSTS SOMETHING. That is the whole point of a control
 * surface: an incident is not "find the button", it is "which lever, in
 * which order, and what does each one break on the way". A console with
 * three verbs has no ordering problem and therefore nothing to reason about.
 *
 * `cost` is shown to the human on the control and to the agent in the
 * proposal, so neither can pick a lever without seeing its price.
 */

export interface WriteAction {
  /** The action.executed `tool` string — the vocabulary key. */
  tool: string;
  tier: WriteTier;
  tierName: 'deploy' | 'env' | 'flag' | 'route';
  /** One-line human diff for proposals/audit ("what would change"). */
  describe(input: Record<string, unknown>, world: World): string;
  /** What this lever costs when you pull it. Never omitted. */
  cost: string;
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
    cost:
      "Puts the previous build back in front of live traffic. If data has moved on since, old code meets new data.",
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
    cost:
      "Ships a new build mid-incident. Fixes forward, but it is unproven code under load.",
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
    cost:
      "Takes effect on the next read, not retroactively. Anything already cached keeps the old value.",
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
    cost:
      "Turns a code path on or off for everyone at once. The fastest lever, and the bluntest.",
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
    cost:
      "Repoints live traffic. Everything downstream of the old target stops receiving it.",
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

// ---- traffic ---------------------------------------------------------
WRITE_ACTIONS['traffic.shift'] = {
  tool: 'traffic.shift',
  tier: 4,
  tierName: 'route',
  cost: 'Moves live customers between targets. Wrong target moves the outage rather than ending it.',
  validate: (i) =>
    needString(i, 'route') ??
    (typeof i.percent === 'number' && i.percent >= 0 && i.percent <= 100
      ? null
      : 'percent (0-100) is required'),
  describe: (i) => `send ${String(i.percent)}% of ${String(i.route)} to ${String(i.target ?? 'the secondary')}`,
};

WRITE_ACTIONS['traffic.drain'] = {
  tool: 'traffic.drain',
  tier: 4,
  tierName: 'route',
  cost: 'Stops the bleeding by serving nobody on that path. Availability goes to zero for those customers.',
  validate: (i) => needString(i, 'route'),
  describe: (i) => `drain ${String(i.route)} — it stops serving traffic`,
};

WRITE_ACTIONS['ratelimit.set'] = {
  tool: 'ratelimit.set',
  tier: 3,
  tierName: 'flag',
  cost: 'Sheds load by rejecting real customers. Buys time; does not fix a cause.',
  validate: (i) =>
    needString(i, 'route') ?? (typeof i.rps === 'number' && i.rps >= 0 ? null : 'rps (number) is required'),
  describe: (i) => `cap ${String(i.route)} at ${String(i.rps)} req/s — excess is rejected`,
};

WRITE_ACTIONS['canary.set'] = {
  tool: 'canary.set',
  tier: 1,
  tierName: 'deploy',
  cost: 'Changes how much traffic a build sees. Raising it widens the blast radius of a bad build.',
  validate: (i) =>
    needString(i, 'deployId') ??
    (typeof i.percent === 'number' && i.percent >= 0 && i.percent <= 100
      ? null
      : 'percent (0-100) is required'),
  describe: (i) => `put ${String(i.deployId)} in front of ${String(i.percent)}% of traffic`,
};

// ---- compute ---------------------------------------------------------
WRITE_ACTIONS['service.restart'] = {
  tool: 'service.restart',
  tier: 2,
  tierName: 'env',
  cost: 'Drops every in-flight request and empties warm caches and pools. Brief spike before it settles.',
  validate: (i) => needString(i, 'service'),
  describe: (i) => `restart ${String(i.service)} — in-flight requests are lost`,
};

WRITE_ACTIONS['service.scale'] = {
  tool: 'service.scale',
  tier: 2,
  tierName: 'env',
  cost: 'New instances start cold. Capacity arrives after they warm, not immediately.',
  validate: (i) =>
    needString(i, 'service') ??
    (typeof i.replicas === 'number' && i.replicas > 0 ? null : 'replicas (number > 0) is required'),
  describe: (i) => `scale ${String(i.service)} to ${String(i.replicas)} replicas`,
};

// ---- data ------------------------------------------------------------
WRITE_ACTIONS['db.failover'] = {
  tool: 'db.failover',
  tier: 4,
  tierName: 'route',
  cost: 'Writes are refused during promotion, and any replica lag is lost. Not reversible in the moment.',
  validate: (i) => needString(i, 'service'),
  describe: (i) => `promote the ${String(i.service)} replica to primary`,
};

WRITE_ACTIONS['cache.flush'] = {
  tool: 'cache.flush',
  tier: 2,
  tierName: 'env',
  cost: 'Every key refills at once. On a saturated backend this is a thundering herd and makes things worse.',
  validate: (i) => needString(i, 'scope'),
  describe: (i) => `flush the ${String(i.scope)} cache`,
};

// ---- dns -------------------------------------------------------------
WRITE_ACTIONS['dns.cutover'] = {
  tool: 'dns.cutover',
  tier: 4,
  tierName: 'route',
  cost: 'Propagation takes minutes and resolvers cache. Wrong tool for an incident you are trying to end now.',
  validate: (i) => needString(i, 'hostname') ?? needString(i, 'target'),
  describe: (i) => `point ${String(i.hostname)} at ${String(i.target)}`,
};
