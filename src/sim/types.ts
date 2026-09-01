// Trace & event schema v1 — docs/schema.md (SIGNED OFF 2026-08-28).
// Changes here require a dated amendment block in docs/schema.md + Sid ping.

export type Actor = 'sim' | 'human' | 'agent' | 'system';

export type EventKind =
  // world
  | 'deploy.started'
  | 'deploy.finished'
  | 'deploy.failed'
  | 'traffic.tick'
  | 'service.health'
  | 'migration.applied'
  | 'cache.state'
  | 'queue.state'
  | 'user.impact'
  | 'log.line'
  // actions (writes — always via tools, always gated)
  | 'action.proposed'
  | 'action.approved'
  | 'action.rejected'
  | 'action.executed'
  | 'action.blocked'
  // agent lifecycle
  | 'tool.called'
  | 'mode.changed'
  | 'selection.changed'
  | 'finding.recorded'
  // meta
  | 'scenario.seeded'
  | 'annotation.added';

export interface Event {
  seq: number; // monotonic, the ordering truth
  t: number; // sim-time ms (deterministic, from seeded clock — never Date.now)
  kind: EventKind;
  actor: Actor;
  data: Record<string, unknown>; // kind-specific payload
  causedBy?: number; // seq of the causing event — the causality thread
}

export type HealthStatus = 'ok' | 'degraded' | 'down';

export interface Service {
  id: string;
  name: string;
  deps: string[];
  health: HealthStatus;
  version: string;
  /** instances serving (service.scale); new ones start cold */
  replicas?: number;
  /** tick of the last restart — in-flight requests were dropped */
  restartedAtTick?: number;
}

export interface Deploy {
  id: string;
  service: string;
  version: string;
  at: number;
  author: string; // sim persona
  changedAreas: string[]; // human-legible: ['checkout', 'session-cache']
  containsMigration: boolean; // THE flagship-scenario bit
  migrationReversible?: boolean;
  flagsTouched: string[];
  diffstat: { files: number; plus: number; minus: number };
  canaryDelta?: { errRate: number; p95: number };
  /**
   * Share of traffic this deploy actually serves (percent). Load-bearing:
   * blast-radius arithmetic (observed error share vs this) is what separates
   * a guilty deploy from an innocent one, and it flips the correct action.
   */
  canaryPct?: number;
  note?: string; // sim persona's commit message — flavor + red herrings
  status: 'live' | 'rolled_back' | 'superseded';
}

export interface Flag {
  id: string;
  name: string;
  state: 'on' | 'off' | number; // number = pct rollout
  touchedByDeploy?: string;
}

export interface EnvVar {
  key: string;
  valueRedacted: string;
  changedAt: number;
}

export interface Route {
  id: string;
  path: string;
  target: string;
  tier: 'dns' | 'route';
  /** share of this route's traffic sent to `target` (traffic.shift) */
  splitPercent?: number;
  /** the route serves nobody while drained (traffic.drain) */
  drained?: boolean;
  /** requests above this are rejected (ratelimit.set) */
  rateLimitRps?: number;
}

export interface Migration {
  id: string;
  appliedByDeploy: string;
  /**
   * INTERNAL ONLY — the engine needs to know this to simulate the outcome.
   * NEVER expose it through a read query: a machine-readable reversibility
   * enum makes the whole range scriptable (see docs/sre-mess-research.md,
   * "de-structuring audit"). The agent-visible form is `note` + the live
   * new-format write count, which must be reconciled across two tools.
   */
  reversible: boolean;
  /** Agent-visible prose: the compatibility-table statement of the same fact. */
  note: string;
  /** Existing rows the migration rewrote on apply (the CI backfill). */
  rowsMigrated: number;
}

export interface TrafficState {
  rps: number;
  errRate: number;
  p95: number;
  byRoute: Record<string, { rps: number; errRate: number }>;
}

export interface DamageState {
  usersErrored: number;
  ticketsOpened: number;
  revenueLost: number; // Σ rps * errRate * valuePerReq — formula visible in user.impact events
}

/** A hostname and where it currently points (dns.cutover). */
export interface DnsRecord {
  hostname: string;
  target: string;
  /** resolvers cache: the cutover is not effective until this tick */
  effectiveAtTick?: number;
}

/**
 * The incident-management half of on-call, which every real tool leads with
 * (incident.io splits its product exactly this way: On-call / Response /
 * Status Pages). Infrastructure levers are only half the job — the other
 * half is who owns it, how bad it is, and what customers are told.
 */
export interface IncidentState {
  acknowledgedBy?: string;
  severity?: 'sev1' | 'sev2' | 'sev3';
  /** customer-facing updates, newest last — these left the building */
  statusPosts: { state: 'investigating' | 'identified' | 'monitoring' | 'resolved'; text: string; at: number }[];
  alertsSilenced?: boolean;
  deploysFrozen?: boolean;
  escalatedTo?: string;
}

export interface World {
  incident: IncidentState;
  services: Service[];
  deploys: Deploy[];
  flags: Flag[];
  envVars: EnvVar[];
  routes: Route[];
  migrations: Migration[];
  traffic: TrafficState;
  damage: DamageState;
  /** which node currently accepts writes (db.failover) */
  dbPrimary?: string;
  dns: DnsRecord[];
}

export interface SeedSpec {
  templateId: string;
  seed: number;
  params: Record<string, unknown>;
}
