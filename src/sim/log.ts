import type { Actor, Event, EventKind } from './types';

/**
 * Append-only event log — the single source of truth (schema v1).
 * Assigns seq; enforces monotonic time and valid causedBy back-references.
 */
export class EventLog {
  private events: Event[] = [];

  append(input: {
    t: number;
    kind: EventKind;
    actor: Actor;
    data: Record<string, unknown>;
    causedBy?: number;
  }): Event {
    const seq = this.events.length;
    const last = this.events[seq - 1];
    if (last && input.t < last.t) {
      throw new Error(`event time went backwards: ${input.t} < ${last.t} (seq ${seq})`);
    }
    if (input.causedBy !== undefined && (input.causedBy < 0 || input.causedBy >= seq)) {
      throw new Error(`causedBy ${input.causedBy} must reference an earlier event (next seq ${seq})`);
    }
    const event: Event = Object.freeze({ seq, ...input });
    this.events.push(event);
    return event;
  }

  get all(): readonly Event[] {
    return this.events;
  }

  get length(): number {
    return this.events.length;
  }

  at(seq: number): Event | undefined {
    return this.events[seq];
  }

  /** Causality thread: the event at seq plus its causedBy ancestors, root-first. */
  chainOf(seq: number): Event[] {
    const chain: Event[] = [];
    let cur = this.events[seq];
    while (cur) {
      chain.push(cur);
      cur = cur.causedBy !== undefined ? this.events[cur.causedBy] : undefined;
    }
    return chain.reverse();
  }
}
