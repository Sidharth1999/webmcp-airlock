import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { EventLog } from './log';
import { initialWorld, reduce, replay } from './reducer';
import { mulberry32 } from './rng';
import type { Event, World } from './types';

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === 'object') {
    Object.values(obj as object).forEach(deepFreeze);
    Object.freeze(obj);
  }
  return obj;
}

describe('mulberry32', () => {
  it('same seed → same sequence, in [0,1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('different seeds → different sequences', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(Array.from({ length: 8 }, a)).not.toEqual(Array.from({ length: 8 }, b));
  });
});

describe('EventLog', () => {
  it('assigns monotonic seq from 0', () => {
    const log = new EventLog();
    const e0 = log.append({ t: 0, kind: 'scenario.seeded', actor: 'system', data: {} });
    const e1 = log.append({ t: 1000, kind: 'traffic.tick', actor: 'sim', data: {} });
    expect([e0.seq, e1.seq]).toEqual([0, 1]);
  });

  it('rejects time going backwards', () => {
    const log = new EventLog();
    log.append({ t: 1000, kind: 'traffic.tick', actor: 'sim', data: {} });
    expect(() => log.append({ t: 999, kind: 'traffic.tick', actor: 'sim', data: {} })).toThrow(
      /backwards/
    );
  });

  it('rejects causedBy pointing at self or future', () => {
    const log = new EventLog();
    log.append({ t: 0, kind: 'scenario.seeded', actor: 'system', data: {} });
    expect(() =>
      log.append({ t: 0, kind: 'traffic.tick', actor: 'sim', data: {}, causedBy: 1 })
    ).toThrow(/causedBy/);
    expect(() =>
      log.append({ t: 0, kind: 'traffic.tick', actor: 'sim', data: {}, causedBy: 5 })
    ).toThrow(/causedBy/);
  });

  it('chainOf walks the causality thread root-first', () => {
    const log = new EventLog();
    const a = log.append({ t: 0, kind: 'action.proposed', actor: 'agent', data: {} });
    const b = log.append({
      t: 1000,
      kind: 'action.approved',
      actor: 'human',
      data: {},
      causedBy: a.seq,
    });
    const c = log.append({
      t: 2000,
      kind: 'action.executed',
      actor: 'agent',
      data: {},
      causedBy: b.seq,
    });
    expect(log.chainOf(c.seq).map((e) => e.kind)).toEqual([
      'action.proposed',
      'action.approved',
      'action.executed',
    ]);
  });
});

describe('reducer', () => {
  const run = (seed = 42, ticks = 50) => {
    const engine = new Engine({ templateId: 'baseline', seed });
    engine.step(ticks);
    return engine;
  };

  it('is pure — never mutates the input world', () => {
    const events = run().events;
    let world = deepFreeze(initialWorld());
    for (const e of events) {
      world = deepFreeze(reduce(world, e)); // frozen input: any mutation throws in strict mode
    }
    expect(world.services.length).toBe(3);
  });

  it('is deterministic — same events fold to byte-identical world', () => {
    const events = run().events;
    const w1 = replay(events);
    const w2 = replay(events);
    expect(JSON.stringify(w1)).toBe(JSON.stringify(w2));
  });

  it('incremental fold equals batch replay', () => {
    const engine = run();
    expect(JSON.stringify(engine.world)).toBe(JSON.stringify(replay(engine.events)));
  });

  it('damage counters derive only from user.impact via the visible formula', () => {
    const engine = run();
    const impacts = engine.events.filter((e) => e.kind === 'user.impact');
    expect(impacts.length).toBeGreaterThan(0);
    const expected = impacts.reduce(
      (acc, e) => {
        const d = e.data as {
          usersErrored: number;
          ticketsOpened: number;
          revenueLostFormula: { rps: number; errRate: number; valuePerReq: number };
        };
        const f = d.revenueLostFormula;
        return {
          usersErrored: acc.usersErrored + d.usersErrored,
          ticketsOpened: acc.ticketsOpened + d.ticketsOpened,
          revenueLost: acc.revenueLost + f.rps * f.errRate * f.valuePerReq,
        };
      },
      { usersErrored: 0, ticketsOpened: 0, revenueLost: 0 }
    );
    expect(engine.world.damage).toEqual(expected);
  });

  it('deploy.finished supersedes the previous live deploy and bumps service version', () => {
    const engine = run();
    const api = engine.world.services.find((s) => s.id === 'api')!;
    expect(api.version).toBe('1.4.2');
    const live = engine.world.deploys.filter((d) => d.service === 'api' && d.status === 'live');
    expect(live.length).toBe(1);
    expect(live[0]!.id).toBe('d-101');
  });
});

describe('replay determinism (schema v1: (templateId, seed, params) → byte-identical stream)', () => {
  const stream = (seed: number, ticks = 50): string => {
    const engine = new Engine({ templateId: 'baseline', seed });
    engine.step(ticks);
    return JSON.stringify(engine.events);
  };

  it('same (templateId, seed, params) → byte-identical events and world', () => {
    expect(stream(42)).toBe(stream(42));
    const e1 = new Engine({ templateId: 'baseline', seed: 7 });
    const e2 = new Engine({ templateId: 'baseline', seed: 7 });
    e1.step(50);
    e2.step(50);
    expect(JSON.stringify(e1.world)).toBe(JSON.stringify(e2.world));
  });

  it('step batching does not change the stream (step(50) === 50×step(1))', () => {
    const batch = new Engine({ templateId: 'baseline', seed: 42 });
    batch.step(50);
    const single = new Engine({ templateId: 'baseline', seed: 42 });
    for (let i = 0; i < 50; i++) single.step(1);
    expect(JSON.stringify(single.events)).toBe(JSON.stringify(batch.events));
  });

  it('different seed → different stream', () => {
    expect(stream(42)).not.toBe(stream(43));
  });

  it('params are part of the replay key', () => {
    const a = new Engine({ templateId: 'baseline', seed: 42, params: { deployAtTick: 10 } });
    a.step(50);
    expect(JSON.stringify(a.events)).not.toBe(stream(42));
    expect((a.events[0]!.data as { params: { deployAtTick: number } }).params.deployAtTick).toBe(10);
  });

  it('event 0 is scenario.seeded carrying the full replay key', () => {
    const engine = new Engine({ templateId: 'baseline', seed: 42 });
    const first = engine.events[0]!;
    expect(first.kind).toBe('scenario.seeded');
    expect(first.data).toMatchObject({ templateId: 'baseline', seed: 42 });
  });
});

describe('causedBy chains in the baseline stream', () => {
  it('threads deploy.started → deploy.finished → user.impact', () => {
    const engine = new Engine({ templateId: 'baseline', seed: 42 });
    engine.step(50);
    const impact = engine.events.find((e) => e.kind === 'user.impact')!;
    const chain = engine.chainOf(impact.seq).map((e) => e.kind);
    expect(chain).toEqual(['deploy.started', 'deploy.finished', 'user.impact']);
  });

  it('health flap (degraded and recovery) is caused by the deploy', () => {
    const engine = new Engine({ templateId: 'baseline', seed: 42 });
    engine.step(50);
    const finished = engine.events.find((e) => e.kind === 'deploy.finished')!;
    const health = engine.events.filter(
      (e) => e.kind === 'service.health' && e.causedBy === finished.seq
    );
    expect(health.map((e) => (e.data as { status: string }).status)).toEqual(['degraded', 'ok']);
  });
});

describe('lint-sim (determinism ban is active)', () => {
  const lint = (dir: string) =>
    execFileSync('node', ['tools/lint-sim.mjs', dir], { encoding: 'utf8' });

  it('passes on real sim code', () => {
    expect(lint('src/sim')).toMatch(/ok/);
  });

  it('fails on Date.now / Math.random / new Date', () => {
    const dir = mkdtempSync(join('node_modules', '.lint-sim-fixture-'));
    try {
      writeFileSync(
        join(dir, 'bad.ts'),
        'export const t = Date.now();\nexport const r = Math.random();\nexport const d = new Date();\n'
      );
      expect(() => lint(dir)).toThrow();
      try {
        lint(dir);
      } catch (err) {
        const stderr = (err as { stderr: string }).stderr;
        expect(stderr).toMatch(/Date\.now/);
        expect(stderr).toMatch(/Math\.random/);
        expect(stderr).toMatch(/new Date/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Type-level guard: World shape stays schema v1 (compile-time only).
const _worldShape: World = initialWorld();
void _worldShape;
const _eventShape: Event = {
  seq: 0,
  t: 0,
  kind: 'log.line',
  actor: 'sim',
  data: { service: 'api', level: 'error', msg: 'x', untrusted: true },
};
void _eventShape;
