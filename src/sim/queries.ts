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

/**
 * PAID-RUN FINDING (2026-09-01): a live model opens paginated reads with
 * `cursor: 0`, meaning "start at the beginning", and every one of them
 * answered with a silently empty page — so it reasoned about an incident
 * having seen no deploys, no logs and no traffic.
 *
 * Sequence numbers start at 1, so 0 (or anything below it) names no
 * position. Treat it as absent rather than as "nothing older than nothing".
 * A cursor that IS a position is left alone, so walking to the end of a set
 * still terminates instead of looping back to the newest page.
 */
const atPosition = (cursor?: number): number | undefined =>
  cursor === undefined || !Number.isFinite(cursor) || cursor <= 0 ? undefined : cursor;

/** An empty page must still say how to get un-stuck. */
const EMPTY_PAGE_NOTE = 'nothing older than that cursor; omit cursor for the newest page';

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
    services: world.services.map((s) => ({
      id: s.id,
      health: s.health,
      version: s.version,
      // THE FLEET, where the template models one: instances serving, the
      // autoscaler's ceiling, and how many more it can add. A rollout is a
      // rolling replacement, so headroom 0 is the fact that decides whether
      // one can start — the paid run had to infer it from a log line.
      ...(s.capacity ? { capacity: s.capacity } : {}),
    })),
    traffic: {
      rps: world.traffic.rps,
      errRate: world.traffic.errRate,
      p95: world.traffic.p95,
      byRoute: admitted(world.traffic.byRoute, capsNow(world)),
    },
    damage: {
      usersErrored: world.damage.usersErrored,
      ticketsOpened: world.damage.ticketsOpened,
      revenueLost: Number(world.damage.revenueLost.toFixed(2)),
    },
    incidentOpen: world.services.some((s) => s.health !== 'ok'),
    // POSTURE. `incidentOpen: false` is true but incomplete: a mitigation
    // stops the bleeding without fixing the cause, and a console that reports
    // only service health invites "incident resolved" when the bad build is
    // still live. These are FACTS a real release console shows, never a
    // verdict — no `mitigated: true` enum to branch on. The reader has to
    // conclude that standing down would be premature.
    standing: standingFacts(world),
    // WHAT THE LAST WRITES ACTUALLY DID. "executed" is not an outcome: a
    // roll-forward into a fleet with no headroom executes and is halted, a
    // scale past the autoscaler ceiling executes and changes nothing. The
    // effect and its reason are what an agent needs before proposing again.
    recentOutcomes: recentOutcomes(events),
  };
}

const OUTCOME_PAGE = 3;
const OUTCOME_REASON_CHARS = 120;

interface ExecutedData {
  tool: string;
  result?: { outcome?: { effect: string; reason: string } };
}

/** The last few executed writes (human or agent — never scenario setup) with their outcome. */
function recentOutcomes(events: readonly Event[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < OUTCOME_PAGE; i--) {
    const e = events[i]!;
    if (e.kind !== 'action.executed' || e.actor === 'sim') continue;
    const d = e.data as unknown as ExecutedData;
    const o = d.result?.outcome;
    if (!o) continue;
    const reason =
      o.reason.length > OUTCOME_REASON_CHARS ? `${o.reason.slice(0, OUTCOME_REASON_CHARS - 1)}…` : o.reason;
    out.push({ seq: e.seq, tool: d.tool, effect: o.effect, reason });
  }
  return out;
}

/** Route path → admission cap in force right now. */
function capsNow(world: World): Record<string, number> {
  const caps: Record<string, number> = {};
  for (const r of world.routes) if (r.rateLimitRps !== undefined) caps[r.path] = r.rateLimitRps;
  return caps;
}

/**
 * OFFERED vs ADMITTED. `rps` is what the edge sees — under a retry storm it
 * keeps climbing after a cap because a cap protects the pool, it does not
 * stop clients retrying. The paid run read "/checkout capped at 120" beside
 * "rps 380" and had to guess which one the pool was serving. Where a cap is
 * in force the route also says what it admits and what the cap is.
 */
function admitted(
  byRoute: Record<string, { rps: number; errRate: number }>,
  caps: Record<string, number>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, r] of Object.entries(byRoute)) {
    const cap = caps[path];
    out[path] = cap === undefined ? r : { ...r, admittedRps: Math.min(r.rps, cap), cap };
  }
  return out;
}

/**
 * Admission caps as they stood at each point in the log: the ratelimit.set
 * writes that took (an outcome of `none` never touched the world), in order.
 */
function capHistory(events: readonly Event[], world: World): { seq: number; path: string; rps: number }[] {
  const pathOf = new Map(world.routes.map((r) => [r.id, r.path] as const));
  const out: { seq: number; path: string; rps: number }[] = [];
  for (const e of events) {
    if (e.kind !== 'action.executed') continue;
    const d = e.data as unknown as ExecutedData & { input: { route?: string; rps?: number } };
    if (d.tool !== 'ratelimit.set' || d.result?.outcome?.effect === 'none') continue;
    const path = pathOf.get(String(d.input.route));
    if (path && typeof d.input.rps === 'number') out.push({ seq: e.seq, path, rps: d.input.rps });
  }
  return out;
}

function capsAt(history: { seq: number; path: string; rps: number }[], seq: number): Record<string, number> {
  const caps: Record<string, number> = {};
  for (const h of history) {
    if (h.seq >= seq) break;
    caps[h.path] = h.rps;
  }
  return caps;
}

/**
 * Facts about the current posture that service health alone does not carry.
 * Measured consequence: without these, a live model mitigates the flagship
 * and stops, because everything it can see says the incident is over.
 */
function standingFacts(world: World): string[] {
  const facts: string[] = [];
  for (const f of world.flags) {
    if (f.state !== 'off' || !f.touchedByDeploy) continue;
    const d = world.deploys.find((x) => x.id === f.touchedByDeploy);
    if (!d || d.status !== 'live') continue;
    facts.push(
      `flag ${f.id} is off, so the code path it guards is not serving traffic; ` +
        `${d.id} (${d.service} ${d.version}), the deploy that introduced it, is still the live build`
    );
  }
  for (const r of world.routes) {
    // A mitigation the operator applied is still in force. Reported as a
    // fact, never as a verdict: whether it is still doing harm depends on
    // the offered load, which is in traffic_history.
    if (r.drained) facts.push(`${r.path} is drained: it is serving nobody`);
    else if (r.rateLimitRps !== undefined) {
      facts.push(`${r.path} is capped at ${r.rateLimitRps} req/s: requests above that are rejected`);
    }
  }
  for (const s of world.services) {
    const live = world.deploys.filter((d) => d.service === s.id && d.status === 'live');
    const rolled = world.deploys.filter((d) => d.service === s.id && d.status === 'rolled_back');
    if (rolled.length > 0 && live.length > 0) {
      facts.push(`${s.id} is serving ${live[live.length - 1]!.version} after a rollback`);
    }
  }
  return facts;
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
  if (page.length === 0 && cursor !== undefined) out.note = EMPTY_PAGE_NOTE;
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
  if (page.length === 0 && cursor !== undefined) out.note = EMPTY_PAGE_NOTE;
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
    routes: world.routes.map((r) => ({
      id: r.id,
      path: r.path,
      target: r.target,
      tier: r.tier,
      // Admission state, emitted ONLY when someone has changed it. A cap or a
      // drain is a live change to what customers get, so it belongs on the
      // list of changes — and an agent that just proposed one has to be able
      // to see whether it took.
      ...(r.rateLimitRps !== undefined ? { rateLimitRps: r.rateLimitRps } : {}),
      ...(r.drained ? { drained: true } : {}),
    })),
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

function traffic(events: readonly Event[], world: World, cursor?: number): Record<string, unknown> {
  const { page, nextCursor } = pageOf(events, ['traffic.tick'], cursor, TRAFFIC_PAGE);
  const caps = capHistory(events, world);
  const out: Record<string, unknown> = {
    asOfSeq: asOf(events),
    ticks: page.map((e) => {
      const d = e.data as {
        rps: number;
        errRate: number;
        p95: number;
        byRoute: Record<string, { rps: number; errRate: number }>;
      };
      return {
        seq: e.seq,
        t: e.t,
        rps: d.rps,
        errRate: d.errRate,
        p95: d.p95,
        byRoute: admitted(d.byRoute, capsAt(caps, e.seq)),
      };
    }),
  };
  if (nextCursor !== undefined) out.nextCursor = nextCursor;
  if (page.length === 0 && cursor !== undefined) out.note = EMPTY_PAGE_NOTE;
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
      return deploys(events, world, atPosition(q.cursor));
    case 'logs':
      return logs(events, world, atPosition(q.cursor));
    case 'changes':
      return changes(events, world);
    case 'traffic':
      return traffic(events, world, atPosition(q.cursor));
    case 'surface':
      return {
        asOfSeq: asOf(events),
        mode: currentMode(events),
        changes: surfaceHistory(events),
      };
  }
}
