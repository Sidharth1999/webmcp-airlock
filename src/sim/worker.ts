/// <reference lib="webworker" />
import { Engine } from './engine';
import { runQuery, type QueryRequest } from './queries';
import type { Event, World } from './types';

// Message-driven on purpose: the engine owns sim-time; pacing (real-time
// setInterval) stays on the main thread so the Worker holds zero wall-clock.

export type SimRequest =
  | { type: 'seed'; templateId: string; seed: number; params?: Record<string, unknown> }
  | { type: 'step'; ticks?: number }
  | { type: 'act'; tool: string; input: Record<string, unknown> }
  | { type: 'query'; id: number; query: QueryRequest }
  | { type: 'snapshot' };

export type SimResponse =
  | { type: 'seeded'; templateId: string; seed: number; params: Record<string, unknown> }
  | { type: 'events'; origin: 'step' | 'act'; events: Event[]; world: World }
  | { type: 'snapshot'; events: readonly Event[]; world: World }
  | { type: 'queryResult'; id: number; result: Record<string, unknown> }
  | { type: 'error'; message: string };

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
        self.postMessage({
          type: 'queryResult',
          id: msg.id,
          result: runQuery(engine.events, engine.world, msg.query),
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
    self.postMessage({ type: 'error', message: String(err) } satisfies SimResponse);
  }
};
