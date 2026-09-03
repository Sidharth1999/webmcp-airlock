import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { runQuery } from './queries';
import type { ActionOutcome, Event } from './types';

/**
 * Every executed write carries an outcome with a reason (schema amendment
 * 2026-09-02). The claims here are the ones a live host run broke on:
 * an approved roll-forward into a fleet with no headroom, a scale past the
 * autoscaler ceiling, and a second roll-forward while the first was halted
 * — each reported "executed" and nothing else. The paid run's own words:
 * "propose_scale reported 'executed' but also 'nothing in the world moved'".
 */

const SIZE_CAP = 1200;

function stormOpen(): Engine {
  const e = new Engine({ templateId: 'retry-storm', seed: 11 });
  while (e.world.services.every((s) => s.health === 'ok')) e.step(1);
  e.step(2);
  return e;
}

const outcomeOf = (ev: Event): ActionOutcome =>
  (ev.data as { result: { outcome: ActionOutcome } }).result.outcome;

const logsAfter = (e: Engine, seq: number): string[] =>
  e.events
    .filter((x) => x.kind === 'log.line' && x.causedBy === seq)
    .map((x) => String((x.data as { msg: string }).msg));

describe('retry-storm: the three no-ops of the paid run say why', () => {
  it('a roll-forward into a fleet with no headroom is halted, with the ceiling as the reason', () => {
    const e = stormOpen();
    const ev = e.act('deploy.rollforward', { service: 'api' }, 'agent');
    const o = outcomeOf(ev);
    expect(o.effect).toBe('partial');
    expect(o.reason).toMatch(/autoscaler ceiling \(6 of 6 live, headroom 0\)/);
    expect(o.reason).toMatch(/cap \/checkout/);
    // and the fleet the console reports has lost the withdrawn instances
    expect(e.world.services.find((s) => s.id === 'api')!.capacity).toEqual({
      instances: 4,
      ceiling: 6,
      headroom: 0,
    });
  });

  it('a scale past the autoscaler ceiling has no effect, names the ceiling, and leaves the world alone', () => {
    const e = stormOpen();
    const before = e.world;
    const ev = e.act('service.scale', { service: 'api', replicas: 9 }, 'agent');
    const o = outcomeOf(ev);
    expect(o.effect).toBe('none');
    expect(o.reason).toMatch(/scale to 9 has no effect: the autoscaler ceiling for api is 6/);
    // an outcome of none is a world the reducer did not touch
    expect(e.world.services).toBe(before.services);
    expect(e.world.services.find((s) => s.id === 'api')!.replicas).toBeUndefined();
    // and a no-op is never silent: it says so in the service log
    expect(logsAfter(e, ev.seq)).toEqual([o.reason]);
  });

  it('a second roll-forward while the first is halted has no effect and logs a line (it logged nothing before)', () => {
    const e = stormOpen();
    e.act('deploy.rollforward', { service: 'api' }, 'agent');
    e.step(1);
    const ev = e.act('deploy.rollforward', { service: 'api' }, 'agent');
    const o = outcomeOf(ev);
    expect(o.effect).toBe('none');
    expect(o.reason).toMatch(/cannot start: the earlier rollout was halted mid-way/);
    expect(o.reason).toMatch(/4 of 6 live/);
    expect(logsAfter(e, ev.seq)).toEqual([o.reason]);
    // the rollback the paid run tried next is the same no-op, and says so
    const rb = e.act('deploy.rollback', { deployId: 'd-511' }, 'agent');
    expect(outcomeOf(rb).effect).toBe('none');
    expect(outcomeOf(rb).reason).toMatch(/rollback of d-511 cannot start/);
    expect(e.world.deploys.find((d) => d.id === 'd-511')!.status).toBe('live');
  });

  it('the right order carries a changed outcome that says when it converges', () => {
    const e = stormOpen();
    const shed = e.act('ratelimit.set', { route: 'r-checkout', rps: 120 }, 'agent');
    expect(outcomeOf(shed).effect).toBe('changed');
    expect(outcomeOf(shed).changed).toEqual(['routes']);
    const ship = e.act('deploy.rollforward', { service: 'api' }, 'agent');
    expect(outcomeOf(ship).effect).toBe('changed');
    expect(outcomeOf(ship).converges).toMatch(/~2 ticks/);
  });
});

describe('outcomes are generic: every template, every write', () => {
  it('every agent write in every template carries an outcome with a non-empty reason', () => {
    for (const templateId of ['migration-trap', 'innocent-deploy', 'poisoned-runbook', 'retry-storm']) {
      const e = new Engine({ templateId, seed: 7 });
      e.step(30);
      for (const [tool, input] of [
        ['incident.acknowledge', { by: 'operator' }],
        ['cache.flush', { scope: 'session' }],
        ['service.restart', { service: 'api' }],
        ['deploy.rollback', { deployId: 'nope' }],
      ] as const) {
        const ev = e.act(tool, input as Record<string, unknown>, 'agent');
        if (ev.kind !== 'action.executed') continue; // a gate may refuse the write; that is its own reason
        const o = outcomeOf(ev);
        expect(['changed', 'none', 'partial'], `${templateId} ${tool}`).toContain(o.effect);
        expect(o.reason.length, `${templateId} ${tool}`).toBeGreaterThan(10);
        if (o.effect === 'none') expect(logsAfter(e, ev.seq), `${templateId} ${tool}`).toEqual([o.reason]);
      }
    }
  });

  it('a rollback with nothing to restore says so rather than executing silently', () => {
    const e = new Engine({ templateId: 'retry-storm', seed: 3 });
    e.step(2); // before d-511 exists
    const ev = e.act('deploy.rollback', { deployId: 'd-999' }, 'agent');
    expect(outcomeOf(ev)).toEqual({ effect: 'none', reason: 'rollback has no effect: there is no deploy d-999' });
  });
});

describe('airlock_status reads the fleet, admitted traffic and recent outcomes', () => {
  it('reports capacity per service where modelled, and nothing invented elsewhere', () => {
    const e = stormOpen();
    const s = runQuery(e.events, e.world, { kind: 'status' }) as {
      services: { id: string; capacity?: unknown }[];
    };
    expect(s.services.find((x) => x.id === 'api')!.capacity).toEqual({ instances: 6, ceiling: 6, headroom: 0 });
    expect(s.services.find((x) => x.id === 'web')!.capacity).toBeUndefined();
    const other = new Engine({ templateId: 'migration-trap', seed: 3 });
    other.step(5);
    const t = runQuery(other.events, other.world, { kind: 'status' }) as { services: { capacity?: unknown }[] };
    expect(t.services.every((x) => x.capacity === undefined)).toBe(true);
  });

  it('a capped route reports offered rps beside admittedRps and cap, in status and in history', () => {
    const e = stormOpen();
    e.act('ratelimit.set', { route: 'r-checkout', rps: 120 }, 'agent');
    e.step(2);
    const s = runQuery(e.events, e.world, { kind: 'status' }) as {
      traffic: { byRoute: Record<string, { rps: number; admittedRps?: number; cap?: number }> };
    };
    const checkout = s.traffic.byRoute['/checkout']!;
    expect(checkout.rps).toBeGreaterThan(120); // offered: retries keep coming
    expect(checkout.admittedRps).toBe(120);
    expect(checkout.cap).toBe(120);
    expect(s.traffic.byRoute['/browse']!.cap).toBeUndefined();
    const h = runQuery(e.events, e.world, { kind: 'traffic' }) as {
      ticks: { byRoute: Record<string, { admittedRps?: number; cap?: number }> }[];
    };
    // the two ticks after the cap carry it; the ticks before it do not
    expect(h.ticks[0]!.byRoute['/checkout']!.cap).toBe(120);
    expect(h.ticks[1]!.byRoute['/checkout']!.cap).toBe(120);
    expect(h.ticks[2]!.byRoute['/checkout']!.cap).toBeUndefined();
  });

  it('recentOutcomes lists the last three executed writes with effect and reason, newest first', () => {
    const e = stormOpen();
    e.act('deploy.rollforward', { service: 'api' }, 'agent');
    e.step(1);
    e.act('service.scale', { service: 'api', replicas: 9 }, 'agent');
    e.act('deploy.rollforward', { service: 'api' }, 'agent');
    e.act('ratelimit.set', { route: 'r-checkout', rps: 120 }, 'agent');
    const s = runQuery(e.events, e.world, { kind: 'status' }) as {
      recentOutcomes: { tool: string; effect: string; reason: string }[];
    };
    expect(s.recentOutcomes.map((o) => [o.tool, o.effect])).toEqual([
      ['ratelimit.set', 'changed'],
      ['deploy.rollforward', 'none'],
      ['service.scale', 'none'],
    ]);
    expect(s.recentOutcomes[2]!.reason).toMatch(/autoscaler ceiling for api is 6/);
    // scenario setup writes (route.set, env.set by the sim) are not outcomes
    expect(s.recentOutcomes.every((o) => o.tool !== 'route.set' && o.tool !== 'env.set')).toBe(true);
  });

  it('status and traffic pages stay under 1.2KB with capacity, caps and three long outcomes on board', () => {
    const e = stormOpen();
    e.act('deploy.rollforward', { service: 'api' }, 'agent');
    e.step(1);
    e.act('service.scale', { service: 'api', replicas: 9 }, 'agent');
    e.act('ratelimit.set', { route: 'r-checkout', rps: 120 }, 'agent');
    e.act('deploy.rollback', { deployId: 'd-511' }, 'agent');
    e.step(3);
    for (const kind of ['status', 'traffic', 'changes'] as const) {
      expect(JSON.stringify(runQuery(e.events, e.world, { kind })).length, kind).toBeLessThanOrEqual(SIZE_CAP);
    }
  });
});
