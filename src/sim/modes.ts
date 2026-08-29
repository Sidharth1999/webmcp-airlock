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
  triage: [],
  diagnosis: ['propose_flag_change'],
  recovery: [
    'propose_flag_change',
    'propose_rollback',
    'propose_rollforward',
    'propose_env_change',
    'propose_route_change',
  ],
};

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
