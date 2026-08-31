import type { Event } from './types';

/**
 * Provenance-weighted authorization — the second leg of the identity thesis.
 *
 * A generic host confirmation can ask "the agent wants to roll back a deploy,
 * allow it?" and a careful human will say yes: rolling back a deploy during
 * an incident is a completely ordinary thing to want. What neither the model
 * nor a host-level confirmation can know is WHERE THAT IDEA CAME FROM — that
 * the deploy id in the proposal appears nowhere in the console's own state
 * and reached the agent only inside a customer-supplied string that the log
 * pipeline echoed back.
 *
 * The page knows, because the page served it. Reads are side-effect free
 * except for one audit event (`tool.called`, asserted in tools.test.ts), and
 * that audit trail is exactly what makes this computable: the log records
 * which untrusted lines existed and which reads the agent made afterwards.
 *
 * A server-side MCP cannot reproduce this. It never served the evidence.
 *
 * DELIBERATE OVER-BROADNESS: a line counts as "served" if the agent called
 * read_logs at any point after it was emitted, without reconstructing which
 * page it landed on. Pagination could in principle have missed it. Erring
 * toward flagging is the safe direction for an authorization check, and the
 * alternative (replaying every cursor window) would make the gate depend on
 * bookkeeping the human could not audit by eye.
 */

export interface Taint {
  /** The identifier the untrusted text is pushing (deploy id, flag, route, env key). */
  ref: string;
  /** Log event seq where the untrusted text entered the world. */
  lineSeq: number;
  /** The `tool.called` seq that served it to the agent. */
  servedBySeq: number;
  /** Short quote for the approval card — the human must SEE the source. */
  excerpt: string;
  service: string;
}

/** Identifier shapes the console's write vocabulary can actually target. */
const REF_PATTERNS: RegExp[] = [
  /\bd-\d{2,}\b/g, // deploy ids
  /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/g, // kebab flag ids (new-checkout, checkout-v3)
  /\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)*\b/g, // SCREAMING env keys
  /\/[a-z][a-z0-9-]*/g, // route paths
];

function refsIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const re of REF_PATTERNS) {
    for (const m of text.matchAll(re)) out.add(m[0]);
  }
  return out;
}

/**
 * Every identifier that reached the agent through untrusted content, mapped
 * to the evidence for saying so. Newest served-line wins on collision.
 */
export function taintedRefs(events: readonly Event[]): Map<string, Taint> {
  const out = new Map<string, Taint>();
  // seq of the first read_logs call after each point in the log
  const logReads: number[] = [];
  for (const e of events) {
    if (e.kind !== 'tool.called') continue;
    if ((e.data as { tool?: string }).tool !== 'read_logs') continue;
    logReads.push(e.seq);
  }
  if (logReads.length === 0) return out;

  for (const e of events) {
    if (e.kind !== 'log.line') continue;
    const d = e.data as { untrusted?: boolean; msg: string; service: string };
    if (!d.untrusted) continue;
    const servedBy = logReads.find((seq) => seq > e.seq);
    if (servedBy === undefined) continue; // emitted, but the agent never read after it
    for (const ref of refsIn(d.msg)) {
      out.set(ref, {
        ref,
        lineSeq: e.seq,
        servedBySeq: servedBy,
        // the human is being asked to weigh this text — show all of it, and
        // never let a truncation read as a complete sentence
        excerpt: d.msg.length > 180 ? `${d.msg.slice(0, 180)}…` : d.msg,
        service: d.service,
      });
    }
  }
  return out;
}

/**
 * Does this proposal's TARGET trace to untrusted content? Values only — the
 * check asks what the write would touch, never what the agent said about it.
 */
export function provenanceOf(
  events: readonly Event[],
  input: Record<string, unknown>
): Taint | null {
  const tainted = taintedRefs(events);
  if (tainted.size === 0) return null;
  for (const v of Object.values(input)) {
    if (typeof v !== 'string') continue;
    const hit = tainted.get(v);
    if (hit) return hit;
  }
  return null;
}
