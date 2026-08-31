import { currentMode, surfaceHistory } from './modes';
import type { Event, World } from './types';

/**
 * Read-tool queries (M3-01): pure functions over (events, world) — the
 * worker runs them against the live engine; tests run them directly.
 *
 * Contract (schema v1 / SPEC): every response is terse JSON ≤ 1.2KB when
 * stringified, always carries `asOfSeq` (staleness reasoning), and paginates
 * via `cursor`/`nextCursor` where the underlying set grows. Cursor semantics
 * are uniform: pass a response's `nextCursor` back to get strictly older
 * items (newest-first walk); absent `nextCursor` = end of the set.
 */

export type QueryRequest =
  | { kind: 'status' }
  | { kind: 'deploys'; cursor?: number }
  | { kind: 'logs'; cursor?: number }
  | { kind: 'changes' }
  | { kind: 'traffic'; cursor?: number }
  | { kind: 'surface' };

const DEPLOY_PAGE = 3;
const LOG_PAGE = 6;
const TRAFFIC_PAGE = 5;

const asOf = (events: readonly Event[]): number =>
  events.length === 0 ? 0 : events[events.length - 1]!.seq;

/** Co-presence (M3-05): what the human is pointing at, from the log. */
export interface EntityRef {
  type: 'service' | 'deploy' | 'flag' | 'route';
  id: string;
}

export function currentSelection(events: readonly Event[]): EntityRef | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === 'selection.changed') {
      return (e.data as { target: EntityRef | null }).target ?? null;
    }
  }
  return null;
}

/** The service a selection implicates (deploys/flags resolve to their service). */
function selectedService(sel: EntityRef | null, world: World): string | null {
  if (!sel) return null;
  if (sel.type === 'service') return sel.id;
  if (sel.type === 'deploy') return world.deploys.find((d) => d.id === sel.id)?.service ?? null;
  if (sel.type === 'route') return world.routes.find((r) => r.id === sel.id)?.target ?? null;
  return null; // flags don't scope service-keyed reads
}

/** Newest-first page of events of one kind, cursor = "seq strictly below". */
function pageOf(
  events: readonly Event[],
  kinds: readonly string[],
  cursor: number | undefined,
  size: number
): { page: Event[]; nextCursor?: number } {
  const matching: Event[] = [];
  for (let i = events.length - 1; i >= 0 && matching.length <= size; i--) {
    const e = events[i]!;
    if (!kinds.includes(e.kind)) continue;
    if (cursor !== undefined && e.seq >= cursor) continue;
    matching.push(e);
  }
  const more = matching.length > size;
  const page = more ? matching.slice(0, size) : matching;
  return more ? { page, nextCursor: page[page.length - 1]!.seq } : { page };
}

function status(events: readonly Event[], world: World): Record<string, unknown> {
  return {
    asOfSeq: asOf(events),
    // co-presence: the agent always sees what the human is pointing at
    humanSelection: currentSelection(events),
    services: world.services.map((s) => ({ id: s.id, health: s.health, version: s.version })),
    traffic: {
      rps: world.traffic.rps,
      errRate: world.traffic.errRate,
      p95: world.traffic.p95,
      byRoute: world.traffic.byRoute,
    },
    damage: {
      usersErrored: world.damage.usersErrored,
      ticketsOpened: world.damage.ticketsOpened,
      revenueLost: Number(world.damage.revenueLost.toFixed(2)),
    },
    incidentOpen: world.services.some((s) => s.health !== 'ok'),
  };
}

function deploys(
  events: readonly Event[],
  world: World,
  cursor?: number
): Record<string, unknown> {
  // co-presence: a selected service/deploy narrows the list to that service
  const sel = currentSelection(events);
  const svc = selectedService(sel, world);
  // world.deploys is append-ordered; cursor = append-index into the
  // UNFILTERED list (stable under new deploys landing mid-walk AND under the
  // selection changing mid-walk): "return items with index strictly below
  // cursor", the service filter applied during the walk
  // clamp: a foreign or stale cursor (log seq fed back, or minted before a
  // re-seed shrank the list) degrades to the newest page instead of throwing
  const startIdx = Math.min(cursor ?? world.deploys.length, world.deploys.length) - 1;
  const page: typeof world.deploys = [];
  let oldestReturned = startIdx + 1;
  for (let i = startIdx; i >= 0 && page.length < DEPLOY_PAGE; i--) {
    const d = world.deploys[i]!;
    if (svc && d.service !== svc) continue;
    page.push(d);
    oldestReturned = i;
  }
  const out: Record<string, unknown> = {
    asOfSeq: asOf(events),
    deploys: page.map((d) => ({
      id: d.id,
      service: d.service,
      version: d.version,
      status: d.status,
      at: d.at,
      author: d.author,
      areas: d.changedAreas,
      // DE-STRUCTURED (see docs/sre-mess-research.md): the decisive fact is
      // prose, not an enum. Deciding whether rollback is safe requires
      // reconciling this note with the new-format write count in list_changes.
      migration: d.containsMigration ? migrationBrief(world, d.id) : null,
      flags: d.flagsTouched,
      diff: `${d.diffstat.files}f +${d.diffstat.plus} -${d.diffstat.minus}`,
      canary: d.canaryDelta
        ? {
            // pct is what makes blast radius checkable: a deploy serving N%
            // of traffic cannot by itself error more than N% of it
            ...(d.canaryPct !== undefined ? { pct: d.canaryPct } : {}),
            errRate: d.canaryDelta.errRate,
            p95: d.canaryDelta.p95,
          }
        : null,
      note: d.note ?? null,
    })),
  };
  if (page.length === DEPLOY_PAGE && oldestReturned > 0) out.nextCursor = oldestReturned;
  if (svc) out.scopedTo = { humanSelection: sel, service: svc };
  return out;
}

function logs(
  events: readonly Event[],
  world: World,
  cursor?: number
): Record<string, unknown> {
  // co-presence: selection filters lines to the implicated service
  const sel = currentSelection(events);
  const svc = selectedService(sel, world);
  const source = svc
    ? events.filter(
        (e) => e.kind !== 'log.line' || (e.data as { service: string }).service === svc
      )
    : events;
  const { page, nextCursor } = pageOf(source, ['log.line'], cursor, LOG_PAGE);
  const out: Record<string, unknown> = {
    asOfSeq: asOf(events),
    ...(svc ? { scopedTo: { humanSelection: sel, service: svc } } : {}),
    lines: page.map((e) => {
      const d = e.data as {
        service: string;
        level: string;
        msg: string;
        untrusted?: boolean;
      };
      const line: Record<string, unknown> = {
        seq: e.seq,
        t: e.t,
        service: d.service,
        level: d.level,
        msg: d.msg.slice(0, 120),
      };
      if (d.untrusted) line.untrusted = true;
      return line;
    }),
  };
  if (nextCursor !== undefined) out.nextCursor = nextCursor;
  return out;
}

/**
 * Rows written in the post-migration format since the migration landed,
 * derived from traffic the sim actually served. This is a RELATIONSHIP
 * (migration time x traffic history), deliberately not a stored field.
 */
function newFormatWrites(events: readonly Event[], byDeploy: string): number {
  let appliedAt: number | null = null;
  let backfilled = 0;
  for (const e of events) {
    if (e.kind !== 'migration.applied') continue;
    const d = e.data as { appliedByDeploy?: string; rowsMigrated?: number };
    if (d.appliedByDeploy !== byDeploy) continue;
    appliedAt = e.seq;
    // applying the migration rewrote the rows that already existed
    backfilled = d.rowsMigrated ?? 0;
    break;
  }
  if (appliedAt === null) return 0;
  let n = backfilled;
  for (const e of events) {
    if (e.seq <= appliedAt || e.kind !== 'traffic.tick') continue;
    const d = e.data as { rps: number };
    n += Math.round(d.rps);
  }
  return n;
}

/** Prose form of a deploy's migration, or null when it carries none. */
function migrationBrief(world: World, deployId: string): Record<string, unknown> | null {
  const m = world.migrations.find((x) => x.appliedByDeploy === deployId);
  if (!m) return { id: null, note: 'declared in this deploy; not yet applied' };
  return { id: m.id, note: m.note };
}

function changes(events: readonly Event[], world: World): Record<string, unknown> {
  return {
    asOfSeq: asOf(events),
    flags: world.flags.map((f) => ({
      id: f.id,
      state: f.state,
      ...(f.touchedByDeploy ? { byDeploy: f.touchedByDeploy } : {}),
    })),
    env: world.envVars.map((v) => ({ key: v.key, value: v.valueRedacted, at: v.changedAt })),
    routes: world.routes.map((r) => ({ id: r.id, path: r.path, target: r.target, tier: r.tier })),
    migrations: world.migrations.map((m) => ({
      id: m.id,
      byDeploy: m.appliedByDeploy,
      note: m.note,
      // cross-tool arithmetic, not a flag: rows already written in the new
      // format. Non-zero + a note saying the old code path cannot read them
      // is what makes a rollback unsafe — no single field says so.
      writtenInNewFormat: newFormatWrites(events, m.appliedByDeploy),
    })),
  };
}

function traffic(events: readonly Event[], cursor?: number): Record<string, unknown> {
  const { page, nextCursor } = pageOf(events, ['traffic.tick'], cursor, TRAFFIC_PAGE);
  const out: Record<string, unknown> = {
    asOfSeq: asOf(events),
    ticks: page.map((e) => {
      const d = e.data as {
        rps: number;
        errRate: number;
        p95: number;
        byRoute: Record<string, { rps: number; errRate: number }>;
      };
      return { seq: e.seq, t: e.t, rps: d.rps, errRate: d.errRate, p95: d.p95, byRoute: d.byRoute };
    }),
  };
  if (nextCursor !== undefined) out.nextCursor = nextCursor;
  return out;
}

export function runQuery(
  events: readonly Event[],
  world: World,
  q: QueryRequest
): Record<string, unknown> {
  switch (q.kind) {
    case 'status':
      return status(events, world);
    case 'deploys':
      return deploys(events, world, q.cursor);
    case 'logs':
      return logs(events, world, q.cursor);
    case 'changes':
      return changes(events, world);
    case 'traffic':
      return traffic(events, q.cursor);
    case 'surface':
      return {
        asOfSeq: asOf(events),
        mode: currentMode(events),
        changes: surfaceHistory(events),
      };
  }
}
