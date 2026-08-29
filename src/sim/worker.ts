/// <reference lib="webworker" />
import { Engine } from './engine';
import { runQuery, type QueryRequest } from './queries';
import type { Actor, Event, EventKind, World } from './types';

// Message-driven on purpose: the engine owns sim-time; pacing (real-time
// setInterval) stays on the main thread so the Worker holds zero wall-clock.

export type SimRequest =
  | { type: 'seed'; templateId: string; seed: number; params?: Record<string, unknown> }
  | { type: 'step'; ticks?: number }
  | { type: 'act'; tool: string; input: Record<string, unknown> }
  | { type: 'query'; id: number; query: QueryRequest; viaTool?: string }
  | { type: 'record'; kind: EventKind; actor: Actor; data: Record<string, unknown> }
  | { type: 'propose'; id: number; tool: string; input: Record<string, unknown> }
  | { type: 'decide'; proposalSeq: number; decision: 'approve' | 'reject'; keyHolder?: string }
  | { type: 'snapshot' };

export type SimResponse =
  | { type: 'seeded'; templateId: string; seed: number; params: Record<string, unknown> }
  | { type: 'events'; origin: 'step' | 'act'; events: Event[]; world: World }
  | { type: 'snapshot'; events: readonly Event[]; world: World }
  | { type: 'queryResult'; id: number; result: Record<string, unknown> }
  | { type: 'proposeResult'; id: number; seq: number; outcome: 'proposed' | 'blocked'; reason?: string }
  | { type: 'error'; message: string; id?: number };

let engine: Engine | null = null;

self.onmessage = (e: MessageEvent<SimRequest>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'seed': {
        engine = new Engine(msg);
        self.postMessage({ type: 'seeded', ...engine.spec } satisfies SimResponse);
        break;
      }
      case 'step': {
        if (!engine) throw new Error('step before seed');
        const events = engine.step(msg.ticks ?? 1);
        self.postMessage({ type: 'events', origin: 'step', events, world: engine.world } satisfies SimResponse);
        break;
      }
      case 'act': {
        if (!engine) throw new Error('act before seed');
        // act() emits the action event plus whatever the template reacts with;
        // slice the log so the response carries all of them, not just the first
        const before = engine.events.length;
        engine.act(msg.tool, msg.input, 'human');
        const events = engine.events.slice(before) as Event[];
        self.postMessage({ type: 'events', origin: 'act', events, world: engine.world } satisfies SimResponse);
        break;
      }
      case 'query': {
        if (!engine) throw new Error('query before seed');
        // read tools query HERE — the worker's log/world stay the single
        // source of truth (schema v1 core principle); no mirror on main
        const result = runQuery(engine.events, engine.world, msg.query);
        self.postMessage({ type: 'queryResult', id: msg.id, result } satisfies SimResponse);
        if (msg.viaTool) {
          // audit every WebMCP tool invocation into the same log (schema
          // tool.called; durationMs joins with the agent-overhead pane, M4)
          const ev = engine.record('tool.called', 'agent', {
            tool: msg.viaTool,
            input: 'cursor' in msg.query ? { cursor: msg.query.cursor } : {},
            resultBytes: JSON.stringify(result).length,
          });
          self.postMessage({
            type: 'events',
            origin: 'act',
            events: [ev],
            world: engine.world,
          } satisfies SimResponse);
        }
        break;
      }
      case 'record': {
        if (!engine) throw new Error('record before seed');
        const ev = engine.record(msg.kind, msg.actor, msg.data);
        self.postMessage({
          type: 'events',
          origin: 'act',
          events: [ev],
          world: engine.world,
        } satisfies SimResponse);
        break;
      }
      case 'propose': {
        if (!engine) throw new Error('propose before seed');
        const ev = engine.propose(msg.tool, msg.input);
        self.postMessage({
          type: 'proposeResult',
          id: msg.id,
          seq: ev.seq,
          outcome: ev.kind === 'action.blocked' ? 'blocked' : 'proposed',
          ...(ev.kind === 'action.blocked' ? { reason: String((ev.data as { reason: string }).reason) } : {}),
        } satisfies SimResponse);
        self.postMessage({
          type: 'events',
          origin: 'act',
          events: [ev],
          world: engine.world,
        } satisfies SimResponse);
        break;
      }
      case 'decide': {
        if (!engine) throw new Error('decide before seed');
        const events = engine.decide(msg.proposalSeq, msg.decision, msg.keyHolder);
        self.postMessage({
          type: 'events',
          origin: 'act',
          events,
          world: engine.world,
        } satisfies SimResponse);
        break;
      }
      case 'snapshot': {
        if (!engine) throw new Error('snapshot before seed');
        self.postMessage({
          type: 'snapshot',
          events: engine.events,
          world: engine.world,
        } satisfies SimResponse);
        break;
      }
    }
  } catch (err) {
    // correlate: a failed query/propose must settle its pending promise on
    // the main thread — an uncorrelated error would leave the agent's tool
    // call hanging forever (residual-review fix)
    const id = 'id' in msg ? msg.id : undefined;
    self.postMessage({ type: 'error', message: String(err), id } satisfies SimResponse);
  }
};
