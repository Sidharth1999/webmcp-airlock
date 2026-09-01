import type { Event } from './types';

/**
 * Airlock modes (M3-02): triage → diagnosis → recovery. The mode governs
 * which WRITE tools are registered on the WebMCP surface; reads are never
 * gated (the airlock gates consequence, not observability).
 *
 * Mode is derived from the log (last mode.changed event), never stored
 * separately — same single-source rule as everything else. Transitions are
 * human-ritual in M3-02; evidence gates (diagnosis-before-writes) deepen
 * in M3-04 with the tier ladder.
 */

export type Mode = 'triage' | 'diagnosis' | 'recovery';

export const MODES: Mode[] = ['triage', 'diagnosis', 'recovery'];

/** Which PROPOSAL tools each mode adds to the always-on read surface. */
export const MODE_WRITE_TOOLS: Record<Mode, string[]> = {
  // TRIAGE — organise and communicate. A page can safely let an agent help
  // run the incident long before it lets one touch production, which is how
  // real orgs work and what makes triage a useful stage rather than a
  // read-only waiting room.
  triage: [
    'propose_acknowledge',
    'propose_severity',
    'propose_escalate',
    'propose_silence_alerts',
    'propose_status_update',
  ],
  // DIAGNOSIS — reversible production levers: stop the bleeding and narrow
  // blast radius, without changing what is deployed.
  diagnosis: [
    'propose_acknowledge',
    'propose_severity',
    'propose_escalate',
    'propose_silence_alerts',
    'propose_status_update',
    'propose_flag_change',
    'propose_deploy_freeze',
    'propose_canary',
    'propose_rate_limit',
  ],
  // RECOVERY — everything, including levers that move data, move customers,
  // or cannot be undone in the moment.
  recovery: [
    'propose_acknowledge',
    'propose_severity',
    'propose_escalate',
    'propose_silence_alerts',
    'propose_status_update',
    'propose_flag_change',
    'propose_deploy_freeze',
    'propose_canary',
    'propose_rate_limit',
    'propose_rollback',
    'propose_rollforward',
    'propose_env_change',
    'propose_route_change',
    'propose_traffic_change',
    'propose_drain',
    'propose_restart',
    'propose_scale',
    'propose_cache_flush',
    'propose_failover',
  ],
};

/**
 * Write-tier policy per mode (M3-04): which rungs of the escalation ladder
 * (1 deploy < 2 env < 3 flag < 4 route) are proposable at all. Mirrors
 * MODE_WRITE_TOOLS — diagnosis unlocks only the flag tier (mitigate-first
 * doctrine), recovery opens the ladder (tier 4 still needs the dual key
 * at approval time).
 */
/**
 * WHICH ACTIONS EACH STAGE ALLOWS — the engine's own copy.
 *
 * MODE_WRITE_TOOLS decides what the agent can SEE; this decides what the
 * engine will EXECUTE. Deliberately separate: the engine must never trust
 * that a tool was unregistered, or a client ignoring the surface could act
 * anyway. Defense in depth is the thesis, so the check lives on both sides
 * and a test asserts they agree. Keyed by vocabulary action.
 */
export const MODE_ACTIONS: Record<Mode, ReadonlySet<string>> = {
  triage: new Set([
    'incident.acknowledge',
    'incident.severity',
    'incident.escalate',
    'alerts.silence',
    'statuspage.post',
  ]),
  diagnosis: new Set([
    'incident.acknowledge',
    'incident.severity',
    'incident.escalate',
    'alerts.silence',
    'statuspage.post',
    'flag.set',
    'deploy.freeze',
    'canary.set',
    'ratelimit.set',
  ]),
  recovery: new Set([
    'incident.acknowledge',
    'incident.severity',
    'incident.escalate',
    'alerts.silence',
    'statuspage.post',
    'flag.set',
    'deploy.freeze',
    'canary.set',
    'ratelimit.set',
    'deploy.rollback',
    'deploy.rollforward',
    'env.set',
    'route.set',
    'traffic.shift',
    'traffic.drain',
    'service.restart',
    'service.scale',
    'cache.flush',
    'db.failover',
    'dns.cutover',
  ]),
};

/**
 * Tier now governs ONE thing: whether the human must hold the key while the
 * write executes. Availability is MODE_ACTIONS. Keeping tier as a second
 * availability gate made it contradict the stage grants the moment a tier-4
 * action (a status-page post) became appropriate during triage.
 */
export const DUAL_KEY_TIER = 4;

export function currentMode(events: readonly Event[]): Mode {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === 'mode.changed') return (e.data as { to: Mode }).to;
  }
  return 'triage';
}

/** The registration diff a switch implies (feeds mode.changed + tombstones). */
export function surfaceDiff(from: Mode, to: Mode): { added: string[]; removed: string[] } {
  const a = new Set(MODE_WRITE_TOOLS[from]);
  const b = new Set(MODE_WRITE_TOOLS[to]);
  return {
    added: [...b].filter((t) => !a.has(t)),
    removed: [...a].filter((t) => !b.has(t)),
  };
}

/** Recent surface narration entries, newest first (explain_surface tool). */
export function surfaceHistory(
  events: readonly Event[],
  limit = 5
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
    const e = events[i]!;
    if (e.kind !== 'mode.changed') continue;
    const d = e.data as {
      from: Mode;
      to: Mode;
      toolsAdded: string[];
      toolsRemoved: string[];
      reason: string;
    };
    out.push({
      seq: e.seq,
      t: e.t,
      from: d.from,
      to: d.to,
      added: d.toolsAdded,
      removed: d.toolsRemoved,
      reason: d.reason,
    });
  }
  return out;
}
