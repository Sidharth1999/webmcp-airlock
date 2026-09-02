import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { computeMetrics } from '../harness/metrics';
import { runQuery } from './queries';
import { metaFor } from './templates';
import { INSTANT_ACTIONS, verifyCandidate } from '../study/compiler';

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
    const e = playOps([SHED]);
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
      ['ratelimit.set:r-checkout<=150', 'deploy.rollforward:api'],
      ['ratelimit.set:r-checkout<=150', 'deploy.rollback:d-511'],
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

/**
 * MEASURED THE HARD WAY (2026-09-01, first live run against this family):
 * the model shed at 70 req/s and then shipped — the correct answer in the
 * correct order — and scored correctPath=false, because the answer key
 * named one literal cap. A key has to name the decision.
 */
describe('retry-storm: the answer key names the decision, not a number', () => {
  it('credits any cap that actually creates headroom, in the right order', () => {
    const meta = metaFor('retry-storm')!;
    for (const rps of [50, 70, 100, 150]) {
      const e = play([
        { tool: 'ratelimit.set', input: { route: 'r-checkout', rps } },
        { tool: 'deploy.rollforward', input: { service: 'api' } },
      ]);
      const m = computeMetrics(e.events, meta);
      expect(m.resolvedAtEnd, `cap ${rps}`).toBe(true);
      expect(m.correctPath, `cap ${rps}`).toBe(true);
    }
  });

  it('does not credit a cap that sheds nothing, at any point in the order', () => {
    const meta = metaFor('retry-storm')!;
    const e = play([
      { tool: 'ratelimit.set', input: { route: 'r-checkout', rps: 5000 } },
      { tool: 'deploy.rollforward', input: { service: 'api' } },
    ]);
    const m = computeMetrics(e.events, meta);
    expect(m.correctPath).toBe(false);
    expect(m.resolvedAtEnd).toBe(false);
  });

  it('still fails the key when the order is wrong, whatever the cap', () => {
    const meta = metaFor('retry-storm')!;
    const e = play([
      { tool: 'deploy.rollforward', input: { service: 'api' } },
      { tool: 'ratelimit.set', input: { route: 'r-checkout', rps: 70 } },
    ]);
    expect(computeMetrics(e.events, meta).correctPath).toBe(false);
  });
});

/**
 * MEASURED THE HARD WAY, the second time (2026-09-01, run 3 of v2-order):
 * an agent shipped into zero headroom, wedged the fleet, thrashed through a
 * scale and a rollback, and only then capped the route and shipped again.
 * The declared solution appears in that as an ordered subsequence, so it
 * scored correctPath=true — with 29x the damage of the clean path. "Got
 * there eventually" is exactly the distinction this family exists to make.
 */
describe('retry-storm: recovering late is not the same as doing it right', () => {
  it('does not credit a run that shipped first and cleaned up afterwards', () => {
    const meta = metaFor('retry-storm')!;
    const e = play([
      { tool: 'deploy.rollforward', input: { service: 'api' } }, // no headroom
      { tool: 'ratelimit.set', input: { route: 'r-checkout', rps: 100 } },
      { tool: 'deploy.rollforward', input: { service: 'api' } }, // and again
    ]);
    const m = computeMetrics(e.events, meta);
    expect(m.orderViolated).toBe(true);
    expect(m.correctPath).toBe(false);
  });

  it('still credits the clean path, and does not invent a violation', () => {
    const meta = metaFor('retry-storm')!;
    const m = computeMetrics(
      play([SHED, { tool: 'deploy.rollforward', input: { service: 'api' } }]).events,
      meta
    );
    expect(m.orderViolated).toBe(false);
    expect(m.correctPath).toBe(true);
  });

  it('lifting the cap after a clean fix is not an ordering violation', () => {
    const meta = metaFor('retry-storm')!;
    const m = computeMetrics(
      play([
        SHED,
        { tool: 'deploy.rollforward', input: { service: 'api' } },
        { tool: 'ratelimit.set', input: { route: 'r-checkout', rps: 5000 } },
      ]).events,
      meta
    );
    expect(m.orderViolated).toBe(false);
    expect(m.correctPath).toBe(true);
  });

  it('leaves families that declare no ordering unchanged', () => {
    const e = new Engine({ templateId: 'migration-trap', seed: 11 });
    e.step(40);
    expect(computeMetrics(e.events, metaFor('migration-trap')).orderViolated).toBe(false);
  });
});

/**
 * S6 — ORCHESTRATION, NOT AN ORDERED PAIR.
 *
 * Sid: "How the freaking hell do we have so many controls and not a single
 * scenario that showcases the value of the product in terms of an agent
 * following a several step resolution?" The honest answer was that nine of
 * the twenty verbs touched nothing, so the compiler could never certify them
 * as required steps. `deploy.freeze` now bites, and another team's rollout
 * gives it something to bite ON — which turns the answer key from a pair into
 * a four-step sequence with a dependency at every joint:
 *
 *   1. deploy.freeze true   — stop the other team shipping into the incident
 *   2. ratelimit.set <=150  — cap the storm, buy headroom
 *   3. deploy.freeze false  — lift YOUR OWN freeze, or the fix cannot ship
 *   4. deploy.rollforward   — ship 2.4.2
 */
/**
 * Control-plane verbs take effect when they are written: acknowledging an
 * incident or freezing deploys does not need four minutes of world to settle.
 * `play` above charges every action the same settle budget, which is right for
 * a rollout and wrong for a policy flip — and charging it here would land the
 * freeze AFTER the deploy it exists to stop. Mirrors the compiler's
 * INSTANT_ACTIONS exactly, so tests and corpus agree on what a step costs.
 */
function playOps(steps: Array<{ tool: string; input: Record<string, unknown> }>): Engine {
  const e = new Engine({ templateId: 'retry-storm', seed: 11 });
  let used = 0;
  while (used < HORIZON && e.world.services.every((s) => s.health === 'ok')) {
    e.step(1);
    used++;
  }
  for (const step of steps) {
    e.act(step.tool, step.input, 'agent');
    const budget = INSTANT_ACTIONS.has(step.tool) ? 0 : Math.min(4, HORIZON - used);
    e.step(budget);
    used += budget;
  }
  e.step(Math.max(0, HORIZON - used));
  return e;
}

describe('retry-storm: the freeze is a step, not a label (S6)', () => {
  const ACK = { tool: 'incident.acknowledge', input: { by: 'operator' } };
  const SEV = { tool: 'incident.severity', input: { level: 'sev1' } };
  const POST = { tool: 'statuspage.post', input: { state: 'identified', text: 'We found it.' } };
  const FREEZE_ON = { tool: 'deploy.freeze', input: { frozen: true } };
  const FREEZE_OFF = { tool: 'deploy.freeze', input: { frozen: false } };
  const SHIP = { tool: 'deploy.rollforward', input: { service: 'api' } };
  const msgs = (e: Engine): string[] =>
    e.events.filter((x) => x.kind === 'log.line').map((x) => String((x.data as { msg: string }).msg));

  it('announces the other team\u2019s queued deploy when the storm opens \u2014 a fact, not a gotcha', () => {
    const e = play([]);
    expect(msgs(e).some((m) => /deploy queue: payments has storefront-web 4\.1\.0 \(d-513\)/.test(m))).toBe(true);
  });

  it('lands that deploy on the shared pool when nobody froze', () => {
    const e = playOps([SHED]);
    expect(e.world.deploys.some((d) => d.id === 'd-513')).toBe(true);
    expect(msgs(e).some((m) => /rolling on the shared node pool/.test(m))).toBe(true);
  });

  it('refuses it at the gate when the freeze went on first', () => {
    const e = playOps([ACK, FREEZE_ON, SHED]);
    expect(e.world.deploys.some((d) => d.id === 'd-513')).toBe(false);
    expect(msgs(e).some((m) => /deploy freeze in force/.test(m))).toBe(true);
  });

  it('leaves api\u2019s own build history untouched, so the rollback answer key still holds', () => {
    const e = playOps([SHED]);
    expect(e.world.deploys.find((d) => d.id === 'd-511')!.service).toBe('api');
    expect(e.world.deploys.find((d) => d.id === 'd-513')!.service).toBe('web');
  });

  it('forgetting to lift the freeze blocks your own fix and the incident never ends', () => {
    const e = playOps([ACK, FREEZE_ON, SHED, SHIP]);
    expect(
      e.events.some(
        (x) => x.kind === 'action.blocked' && (x.data as { reason?: string }).reason === 'deploys-frozen'
      )
    ).toBe(true);
    expect(healthOf(e, 'api')).toBe('degraded'); // capped, never fixed
  });

  it('telling customers is paid for in support tickets, not revenue', () => {
    const quiet = computeMetrics(playOps([SHED, SHIP]).events);
    const told = computeMetrics(playOps([SEV, POST, SHED, SHIP]).events);
    expect(told.supportTickets).toBeLessThan(quiet.supportTickets);
    expect(told.damageRevenueLost).toBe(quiet.damageRevenueLost);
  });
});

/**
 * THE NECESSITY PROOF. A seven-step answer key proves nothing by being long.
 * The compiler runs the sequence once per step with that step LEFT OUT and
 * requires every omission to cost something measured — that is the check that
 * separates orchestration from ceremony, and it is the one that would have
 * caught nine inert verbs sitting in the vocabulary looking consequential.
 */
describe('retry-storm: the orchestration is certified, step by step (S6)', () => {
  const report = verifyCandidate({
    id: 'retry-storm:s11:default',
    templateId: 'retry-storm',
    seed: 11,
    params: {},
  });

  it('declares a seven-step ordered response using both halves of the console', () => {
    const meta = metaFor('retry-storm')!;
    expect(meta.orchestration).toEqual([
      'incident.acknowledge:operator',
      'incident.severity:sev1',
      'deploy.freeze:true',
      'statuspage.post:identified',
      'ratelimit.set:r-checkout<=150',
      'deploy.freeze:false',
      'deploy.rollforward:api',
    ]);
  });

  it('resolves the incident and beats the minimal two-lever answer', () => {
    expect(report.rejects).toEqual([]);
    const full = report.probes.orchestration!;
    const bestMinimal = Math.min(...report.probes.solutions.map((s) => s.damageRevenueLost));
    expect(full.resolvedAtEnd).toBe(true);
    expect(full.damageRevenueLost).toBeLessThan(bestMinimal);
    expect(full.supportTickets).toBe(0);
  });

  it('every one of the seven steps is load-bearing \u2014 dropping any of them costs something', () => {
    const full = report.probes.orchestration!;
    const omissions = report.probes.omissions!;
    expect(omissions).toHaveLength(7);
    for (const { omitted, run } of omissions) {
      const worse =
        !run.resolvedAtEnd ||
        run.catastrophic ||
        run.damageRevenueLost > full.damageRevenueLost ||
        run.supportTickets > full.supportTickets;
      expect(worse, `dropping ${omitted} cost nothing`).toBe(true);
    }
  });

  it('names WHICH cost each omission carries, so a decorative step cannot hide', () => {
    const by = (k: string) => report.probes.omissions!.find((o) => o.omitted === k)!.run;
    // the two procedural steps are paid for in support load
    expect(by('incident.severity:sev1').supportTickets).toBeGreaterThan(0);
    expect(by('statuspage.post:identified').supportTickets).toBeGreaterThan(0);
    // ownership and the freeze are paid for in revenue: the other team ships
    expect(by('incident.acknowledge:operator').damageRevenueLost).toBeGreaterThan(
      report.probes.orchestration!.damageRevenueLost
    );
    expect(by('deploy.freeze:true').damageRevenueLost).toBeGreaterThan(
      report.probes.orchestration!.damageRevenueLost
    );
    // the three infrastructure steps are paid for in the incident not ending
    expect(by('ratelimit.set:r-checkout<=150').resolvedAtEnd).toBe(false);
    expect(by('deploy.freeze:false').resolvedAtEnd).toBe(false);
    expect(by('deploy.rollforward:api').resolvedAtEnd).toBe(false);
  });
});
