import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { runQuery, type QueryRequest } from './queries';

// M3-01 gate: "tool I/O contract tests: size cap, asOfSeq present,
// pagination works". Contract: ≤1.2KB stringified, asOfSeq on every
// response, cursors walk the full set newest-first without gaps or dupes.

const SIZE_CAP = 1200;

/** The noisiest reachable state: long catastrophic run, then dig out. */
function longRun(): Engine {
  const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
  engine.step(12);
  engine.act('deploy.rollback', { deployId: 'd-201' });
  engine.step(30);
  engine.act('deploy.rollforward', { service: 'api' });
  engine.step(30);
  return engine;
}

function query(engine: Engine, q: QueryRequest): Record<string, unknown> {
  return runQuery(engine.events, engine.world, q);
}

/** Walk a cursored query to exhaustion; returns every page. */
function walk(
  engine: Engine,
  kind: 'deploys' | 'logs' | 'traffic'
): Record<string, unknown>[] {
  const pages: Record<string, unknown>[] = [];
  let cursor: number | undefined;
  for (let i = 0; i < 100; i++) {
    const page = query(engine, { kind, cursor } as QueryRequest);
    pages.push(page);
    if (page.nextCursor === undefined) return pages;
    cursor = page.nextCursor as number;
  }
  throw new Error(`${kind}: pagination never terminated`);
}

describe('read-tool query contract (M3-01)', () => {
  const engine = longRun();
  const ALL: QueryRequest[] = [
    { kind: 'status' },
    { kind: 'deploys' },
    { kind: 'logs' },
    { kind: 'changes' },
    { kind: 'traffic' },
  ];

  it('every response carries asOfSeq = latest event seq', () => {
    const last = engine.events[engine.events.length - 1]!.seq;
    for (const q of ALL) {
      expect(query(engine, q).asOfSeq, q.kind).toBe(last);
    }
  });

  it('every response of every page stays under the 1.2KB cap', () => {
    for (const q of ALL) expect(JSON.stringify(query(engine, q)).length).toBeLessThanOrEqual(SIZE_CAP);
    for (const kind of ['deploys', 'logs', 'traffic'] as const) {
      for (const page of walk(engine, kind)) {
        expect(JSON.stringify(page).length, kind).toBeLessThanOrEqual(SIZE_CAP);
      }
    }
  });

  it('log pagination covers every log.line exactly once, newest-first', () => {
    const expected = engine.events.filter((e) => e.kind === 'log.line').map((e) => e.seq);
    const walked = walk(engine, 'logs').flatMap((p) =>
      (p.lines as { seq: number }[]).map((l) => l.seq)
    );
    expect(walked).toEqual([...expected].reverse());
  });

  it('traffic pagination covers every traffic.tick exactly once, newest-first', () => {
    const expected = engine.events.filter((e) => e.kind === 'traffic.tick').map((e) => e.seq);
    const walked = walk(engine, 'traffic').flatMap((p) =>
      (p.ticks as { seq: number }[]).map((t) => t.seq)
    );
    expect(walked).toEqual([...expected].reverse());
  });

  it('deploy pagination covers every deploy exactly once, newest-first', () => {
    const expected = engine.world.deploys.map((d) => d.id);
    const walked = walk(engine, 'deploys').flatMap((p) =>
      (p.deploys as { id: string }[]).map((d) => d.id)
    );
    expect(walked).toEqual([...expected].reverse());
  });

  it('deploy cursor stays valid when a new deploy lands mid-walk', () => {
    const e = new Engine({ templateId: 'migration-trap', seed: 7 });
    e.step(12); // d-200 + d-201 down
    const first = query(e, { kind: 'deploys' }) as { deploys: { id: string }[]; nextCursor?: number };
    e.act('flag.set', { id: 'new-checkout', state: 'off' });
    e.act('deploy.rollforward', { service: 'api' }); // d-202 lands mid-walk
    e.step(1);
    // no nextCursor at 2 deploys (page is 3) — but the shape must hold:
    // re-query newest-first now includes d-202 without disturbing older items
    const again = query(e, { kind: 'deploys' }) as { deploys: { id: string }[] };
    expect(first.deploys.map((d) => d.id)).toEqual(['d-201', 'd-200']);
    expect(again.deploys.map((d) => d.id)).toEqual(['d-202', 'd-201', 'd-200']);
  });

  it('deploys carry the decision-grade fields', () => {
    const page = query(engine, { kind: 'deploys' }) as { deploys: Record<string, unknown>[] };
    const d201 = page.deploys.find((d) => d.id === 'd-201')!;
    expect(d201.migration).toEqual({ reversible: false });
    expect(d201.note).toContain('migration');
    expect(d201.canary).toBeTruthy();
  });

  it('status reflects incident state and mechanically-derived damage', () => {
    const mid = new Engine({ templateId: 'migration-trap', seed: 42 });
    mid.step(12);
    const s = query(mid, { kind: 'status' }) as Record<string, any>;
    expect(s.incidentOpen).toBe(true);
    expect(s.damage.revenueLost).toBeGreaterThan(0);
    expect(s.services.find((x: any) => x.id === 'api').health).toBe('degraded');
  });

  it('changes exposes redacted env values only', () => {
    const c = query(engine, { kind: 'changes' }) as { env: { value: string }[] };
    expect(c.env.length).toBeGreaterThan(0);
    for (const v of c.env) expect(v.value).toContain('•');
  });

  it('empty log page on a fresh engine has no nextCursor and asOfSeq 0-based world', () => {
    const fresh = new Engine({ templateId: 'baseline', seed: 1 });
    const l = query(fresh, { kind: 'logs' }) as Record<string, unknown>;
    expect(l.lines).toEqual([]);
    expect(l.nextCursor).toBeUndefined();
    expect(l.asOfSeq).toBeGreaterThan(0); // setup events exist
  });
});

describe('cursor vs co-presence (M3-close review)', () => {
  it('a deploys cursor minted before a selection change never repeats items', () => {
    const e = new Engine({ templateId: 'migration-trap', seed: 7 });
    e.step(12); // d-200 + d-201 live
    // doctor a mixed-service history so the selection filter bites:
    // append-order [a0(api), a1(api), w2(web), w3(web), w4(web)]
    const proto = e.world.deploys[0]!;
    const mk = (id: string, service: string) => ({ ...proto, id, service });
    const world = {
      ...e.world,
      deploys: [mk('a0', 'api'), mk('a1', 'api'), mk('w2', 'web'), mk('w3', 'web'), mk('w4', 'web')],
    };
    const first = runQuery(e.events, world, { kind: 'deploys' }) as {
      deploys: Array<{ id: string }>;
      nextCursor?: number;
    };
    expect(first.deploys.map((d) => d.id)).toEqual(['w4', 'w3', 'w2']);
    expect(first.nextCursor).toBeDefined();

    // the human points at web mid-walk
    const withSelection = [
      ...e.events,
      {
        seq: e.events.length + 1000, t: 0, kind: 'selection.changed' as const,
        actor: 'human' as const, data: { by: 'human', target: { type: 'service', id: 'web' } },
      },
    ];
    const cont = runQuery(withSelection, world, { kind: 'deploys', cursor: first.nextCursor }) as {
      deploys: Array<{ id: string }>;
    };
    const seen = new Set(first.deploys.map((d) => d.id));
    // continuation must contain no repeats and nothing undefined
    expect(cont.deploys.every((d) => d && !seen.has(d.id))).toBe(true);
  });
});

describe('foreign/out-of-range cursors (residual review)', () => {
  it('list_deploys tolerates a cursor beyond the deploy count (no throw, newest page)', () => {
    const e = new Engine({ templateId: 'migration-trap', seed: 7 });
    e.step(12); // 2 deploys, but log seqs run far higher
    for (const cursor of [3, 4, 22, 9999]) {
      const page = query(e, { kind: 'deploys', cursor }) as { deploys: Array<{ id: string }> };
      expect(page.deploys.map((d) => d.id), `cursor ${cursor}`).toEqual(['d-201', 'd-200']);
    }
  });
});
