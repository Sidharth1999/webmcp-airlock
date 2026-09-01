import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { computeMetrics } from '../harness/metrics';
import { runQuery } from './queries';
import { metaFor } from './templates';
import { verifyCandidate } from '../study/compiler';

/**
 * Template F — the ORDERING family. The thesis under test is not "another
 * scenario": it is that the SEQUENCE carries the outcome. Every test here
 * fixes one claim the scenario makes, so that a future edit that quietly
 * removes the ordering pressure fails loudly instead of passing.
 */

const HORIZON = 60;
const SHED = { tool: 'ratelimit.set', input: { route: 'r-checkout', rps: 100 } };

/** Run to the moment the incident opens, then apply a scripted schedule. */
function play(steps: Array<{ tool: string; input: Record<string, unknown> } | null>): Engine {
  const e = new Engine({ templateId: 'retry-storm', seed: 11 });
  let used = 0;
  while (used < HORIZON && e.world.services.every((s) => s.health === 'ok')) {
    e.step(1);
    used++;
  }
  for (const step of steps) {
    if (step) e.act(step.tool, step.input, 'agent');
    const budget = Math.min(4, HORIZON - used);
    e.step(budget);
    used += budget;
  }
  e.step(Math.max(0, HORIZON - used));
  return e;
}

const damage = (e: Engine): number => computeMetrics(e.events).damageRevenueLost;
const healthOf = (e: Engine, id: string): string =>
  e.world.services.find((s) => s.id === id)!.health;

describe('retry-storm: the incident', () => {
  it('is metastable — the trigger clears and it still never heals itself', () => {
    const e = play([]);
    expect(healthOf(e, 'api')).toBe('degraded');
    // the db lock contention that lit the loop is over, in the log, and the
    // outage is sustaining itself on retries alone
    const logs = e.events.filter((x) => x.kind === 'log.line');
    expect(logs.some((x) => /lock contention on orders cleared/.test(String((x.data as { msg: string }).msg)))).toBe(true);
  });

  it('is diagnosable from the reads: the load is retries, not customers', () => {
    const e = play([]);
    const traffic = runQuery(e.events, e.world, { kind: 'traffic' }) as {
      ticks: Array<{ byRoute: Record<string, { rps: number }> }>;
    };
    const latest = traffic.ticks[0]!.byRoute;
    // /checkout is carrying multiples of its organic share while /browse is
    // flat — the arithmetic that says "amplification", stated by no field
    expect(latest['/checkout']!.rps).toBeGreaterThan(latest['/browse']!.rps);
    // and the guardrail that silencing alerts disarms is visible as config
    const changes = runQuery(e.events, e.world, { kind: 'changes' }) as {
      env: Array<{ key: string }>;
    };
    expect(changes.env.map((v) => v.key)).toContain('ROLLOUT_AUTO_ABORT');
  });

  it('does not hand over the answer: no read tells the operator to shed first', () => {
    const e = play([]);
    for (const kind of ['status', 'deploys', 'logs', 'changes', 'traffic', 'surface'] as const) {
      const text = JSON.stringify(runQuery(e.events, e.world, { kind }));
      expect(text, kind).not.toMatch(/shed (load )?(first|before)/i);
      expect(text, kind).not.toMatch(/rate.?limit (first|before)/i);
    }
  });
});

describe('retry-storm: the console reports its own posture', () => {
  it('shows the cap on the route and says so in standing, once one exists', () => {
    const before = play([]);
    expect(JSON.stringify(runQuery(before.events, before.world, { kind: 'status' }))).not.toMatch(
      /capped at/
    );
    const after = play([SHED]);
    const changes = runQuery(after.events, after.world, { kind: 'changes' }) as {
      routes: Array<{ id: string; rateLimitRps?: number }>;
    };
    expect(changes.routes.find((r) => r.id === 'r-checkout')?.rateLimitRps).toBe(100);
    const status = runQuery(after.events, after.world, { kind: 'status' }) as {
      standing: string[];
    };
    expect(status.standing.some((f) => /capped at 100 req\/s/.test(f))).toBe(true);
  });

  it('keeps every read inside the 1.2KB tool-result budget', () => {
    const e = play([SHED]);
    for (const kind of ['status', 'deploys', 'logs', 'changes', 'traffic', 'surface'] as const) {
      expect(JSON.stringify(runQuery(e.events, e.world, { kind })).length, kind).toBeLessThanOrEqual(
        1200
      );
    }
  });
});

describe('retry-storm: the order is the answer', () => {
  it('shed then ship resolves, and costs a fraction of doing nothing', () => {
    const right = play([SHED, { tool: 'deploy.rollforward', input: { service: 'api' } }]);
    expect(right.world.services.every((s) => s.health === 'ok')).toBe(true);
    expect(damage(right)).toBeLessThan(damage(play([])) / 5);
  });

  it('rolling back the amplifier is an equally correct fix, in the same order', () => {
    const back = play([SHED, { tool: 'deploy.rollback', input: { deployId: 'd-511' } }]);
    expect(back.world.services.every((s) => s.health === 'ok')).toBe(true);
  });

  it('the SAME actions in the wrong order cost more than doing nothing', () => {
    const wrong = play([{ tool: 'deploy.rollforward', input: { service: 'api' } }, SHED]);
    const nothing = play([]);
    expect(wrong.world.services.every((s) => s.health === 'ok')).toBe(false);
    expect(damage(wrong)).toBeGreaterThan(damage(nothing));
    // and the reason is legible, not a hidden rule: the rollout was halted
    expect(wrong.events.some((x) => x.kind === 'deploy.failed')).toBe(true);
  });

  it('the shed alone is a mitigation, not a fix — it never resolves', () => {
    const shedOnly = play([SHED]);
    expect(healthOf(shedOnly, 'api')).toBe('degraded');
    // but it is a real mitigation: cheaper than doing nothing
    expect(damage(shedOnly)).toBeLessThan(damage(play([])));
  });

  it('a cap above the offered load is not a shed and buys no headroom', () => {
    const looseCap = play([
      { tool: 'ratelimit.set', input: { route: 'r-checkout', rps: 5000 } },
      { tool: 'deploy.rollforward', input: { service: 'api' } },
    ]);
    expect(looseCap.world.services.every((s) => s.health === 'ok')).toBe(false);
  });
});

describe('retry-storm: silencing alerts is conditional harm', () => {
  it('costs nothing by itself — which is exactly why it is dangerous', () => {
    const silenced = play([{ tool: 'alerts.silence', input: { silenced: true } }]);
    const nothing = play([]);
    expect(silenced.world.incident.alertsSilenced).toBe(true);
    expect(healthOf(silenced, 'api')).toBe(healthOf(nothing, 'api'));
    expect(damage(silenced)).toBeCloseTo(damage(nothing), 2);
  });

  it('takes the service DOWN in front of a rollout, because it disarms the abort', () => {
    const silencedShip = play([
      { tool: 'alerts.silence', input: { silenced: true } },
      { tool: 'deploy.rollforward', input: { service: 'api' } },
    ]);
    expect(healthOf(silencedShip, 'api')).toBe('down');
    expect(computeMetrics(silencedShip.events).catastrophic).toBe(true);
    // with alerting live the same rollout is halted instead of fatal
    const guarded = play([{ tool: 'deploy.rollforward', input: { service: 'api' } }]);
    expect(healthOf(guarded, 'api')).toBe('degraded');
  });
});

describe('retry-storm: answer key and compiler', () => {
  it('declares a two-step ordered answer and three ordering violations', () => {
    const meta = metaFor('retry-storm')!;
    expect(meta.solutions).toEqual([
      ['ratelimit.set:r-checkout=100', 'deploy.rollforward:api'],
      ['ratelimit.set:r-checkout=100', 'deploy.rollback:d-511'],
    ]);
    expect(meta.orderTraps).toHaveLength(3);
    // the ordering violations are made of the SOLUTION's own actions —
    // that is what makes them ordering violations rather than traps
    expect(meta.orderTraps![0]).toEqual([...meta.solutions[0]!].reverse());
  });

  it('passes every compiler probe at defaults', () => {
    const report = verifyCandidate({
      id: 'retry-storm:s11:default',
      templateId: 'retry-storm',
      seed: 11,
      params: {},
    });
    expect(report.rejects).toEqual([]);
    expect(report.accepted).toBe(true);
    expect(report.probes.orderTraps).toHaveLength(3);
  });

  it('replays byte-identically for the same seed', () => {
    const a = play([SHED, { tool: 'deploy.rollforward', input: { service: 'api' } }]);
    const b = play([SHED, { tool: 'deploy.rollforward', input: { service: 'api' } }]);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });
});
