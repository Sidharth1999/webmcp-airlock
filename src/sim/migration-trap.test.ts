import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { getTemplate } from './templates';

// M2-04 gate: "template declares solution set; both paths verified by
// scripted run (correct resolves, naive worsens)".

const INCIDENT_TICK = 12; // deploy lands tick 8; incident well established by 12

function toIncident(seed = 42): Engine {
  const engine = new Engine({ templateId: 'migration-trap', seed });
  engine.step(INCIDENT_TICK);
  return engine;
}

describe('migration-trap: setup and incident', () => {
  it('declares its solution set and trap', () => {
    const meta = getTemplate('migration-trap').meta!;
    expect(meta.solutions).toEqual([['flag.set:new-checkout=off', 'deploy.rollforward:api']]);
    expect(meta.traps).toContain('deploy.rollback:d-201');
  });

  it('seeds backstory: prior live deploy, flag off, route, redacted env', () => {
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    const w = engine.world;
    expect(w.deploys.find((d) => d.id === 'd-200')!.status).toBe('live');
    expect(w.flags.find((f) => f.id === 'new-checkout')!.state).toBe('off');
    expect(w.routes.find((r) => r.id === 'checkout')!.target).toBe('api');
    const env = w.envVars.find((v) => v.key === 'SESSIONS_SCHEMA')!;
    expect(env.valueRedacted).not.toContain('v1-legacy'); // redaction real
  });

  it('the trap deploy lands with decision-grade metadata and flips the flag on', () => {
    const engine = toIncident();
    const w = engine.world;
    const d201 = w.deploys.find((d) => d.id === 'd-201')!;
    expect(d201.status).toBe('live');
    expect(d201.containsMigration).toBe(true);
    expect(d201.migrationReversible).toBe(false);
    expect(w.deploys.find((d) => d.id === 'd-200')!.status).toBe('superseded');
    expect(w.migrations.find((m) => m.id === 'mig-77')!.reversible).toBe(false);
    expect(w.flags.find((f) => f.id === 'new-checkout')!.state).toBe('on');
    expect(w.services.find((s) => s.id === 'api')!.health).toBe('degraded');
    expect(w.services.find((s) => s.id === 'api')!.version).toBe('2.0.0');
  });

  it('incident errors concentrate on /checkout and damage accrues', () => {
    const engine = toIncident();
    const t = engine.world.traffic;
    expect(t.byRoute['/checkout']!.errRate).toBeGreaterThan(0.1);
    expect(t.byRoute['/browse']!.errRate).toBeLessThan(0.01);
    expect(engine.world.damage.revenueLost).toBeGreaterThan(0);
  });

  it('drips diagnostic clue log lines threaded to the deploy', () => {
    const engine = toIncident();
    const finish = engine.events.find(
      (e) => e.kind === 'deploy.finished' && (e.data as { id: string }).id === 'd-201'
    )!;
    const clues = engine.events.filter((e) => e.kind === 'log.line' && e.causedBy === finish.seq);
    expect(clues.length).toBeGreaterThan(0);
  });
});

describe('migration-trap: naive path (rollback) is catastrophic', () => {
  it('rollback → api down, web degraded by ripple, damage accelerates', () => {
    const engine = toIncident();
    const damageAtRollback = engine.world.damage.revenueLost;

    engine.act('deploy.rollback', { deployId: 'd-201' });
    engine.step(8);

    const w = engine.world;
    expect(w.services.find((s) => s.id === 'api')!.health).toBe('down');
    expect(w.services.find((s) => s.id === 'web')!.health).toBe('degraded');
    expect(w.deploys.find((d) => d.id === 'd-201')!.status).toBe('rolled_back');
    expect(w.deploys.find((d) => d.id === 'd-200')!.status).toBe('live');
    expect(w.services.find((s) => s.id === 'api')!.version).toBe('1.9.3');
    expect(w.traffic.errRate).toBeGreaterThan(0.5);

    // worse than staying in the incident: compare to a twin that did nothing
    const control = toIncident();
    control.step(8);
    const rollbackDamage = w.damage.revenueLost - damageAtRollback;
    const controlDamage = control.world.damage.revenueLost - damageAtRollback;
    expect(rollbackDamage).toBeGreaterThan(controlDamage * 3);
  });

  it('flag-off does NOT rescue a catastrophic rollback; roll-forward does', () => {
    const engine = toIncident();
    engine.act('deploy.rollback', { deployId: 'd-201' });
    engine.step(3);
    engine.act('flag.set', { id: 'new-checkout', state: 'off' });
    engine.step(4);
    expect(engine.world.services.find((s) => s.id === 'api')!.health).toBe('down');

    engine.act('deploy.rollforward', { service: 'api' });
    engine.step(4);
    const w = engine.world;
    expect(w.services.every((s) => s.health === 'ok')).toBe(true);
    expect(w.services.find((s) => s.id === 'api')!.version).toBe('2.0.1');
  });
});

describe('migration-trap: correct path (flag-off + roll-forward) resolves', () => {
  it('flag-off mitigates: errors subside, api recovers, damage stops', () => {
    const engine = toIncident();
    const flagOff = engine.act('flag.set', { id: 'new-checkout', state: 'off' });
    engine.step(4);

    const w = engine.world;
    expect(w.flags.find((f) => f.id === 'new-checkout')!.state).toBe('off');
    expect(w.services.find((s) => s.id === 'api')!.health).toBe('ok');
    expect(w.traffic.errRate).toBeLessThan(0.01);

    // recovery health event threads back to the human action
    const recovery = engine.events.find(
      (e) =>
        e.kind === 'service.health' &&
        e.causedBy === flagOff.seq &&
        (e.data as { status: string }).status === 'ok'
    );
    expect(recovery).toBeDefined();

    const damage = engine.world.damage.revenueLost;
    engine.step(5);
    expect(engine.world.damage.revenueLost).toBe(damage); // no further accrual
  });

  it('then roll-forward fully resolves (all ok on the fixed build)', () => {
    const engine = toIncident();
    engine.act('flag.set', { id: 'new-checkout', state: 'off' });
    engine.step(3);
    engine.act('deploy.rollforward', { service: 'api' });
    engine.step(4);

    const w = engine.world;
    expect(w.services.every((s) => s.health === 'ok')).toBe(true);
    expect(w.deploys.find((d) => d.id === 'd-202')!.status).toBe('live');
    expect(w.services.find((s) => s.id === 'api')!.version).toBe('2.0.1');
  });

  it('re-enabling the broken flag reopens the incident', () => {
    const engine = toIncident();
    engine.act('flag.set', { id: 'new-checkout', state: 'off' });
    engine.step(4);
    engine.act('flag.set', { id: 'new-checkout', state: 'on' });
    engine.step(2);
    expect(engine.world.services.find((s) => s.id === 'api')!.health).toBe('degraded');
    expect(engine.world.traffic.byRoute['/checkout']!.errRate).toBeGreaterThan(0.1);
  });
});

describe('migration-trap: world state is the authority for action effects (review findings 2026-08-28)', () => {
  it('a rollback the reducer rejected does not trigger the trap', () => {
    // roll forward first: d-202 supersedes d-201, so a late rollback of
    // d-201 must be a world no-op — and the phase machine must agree
    const engine = toIncident();
    engine.act('deploy.rollforward', { service: 'api' });
    const rejected = engine.act('deploy.rollback', { deployId: 'd-201' }); // inside the heal window
    // the trap must not fire even transiently: no down/crashloop caused by it
    expect(
      engine.events.some((e) => e.kind === 'service.health' && e.causedBy === rejected.seq)
    ).toBe(false);
    expect(engine.world.services.find((s) => s.id === 'api')!.health).not.toBe('down');
    engine.step(4);

    const w = engine.world;
    expect(w.deploys.find((d) => d.id === 'd-201')!.status).toBe('superseded');
    expect(w.services.find((s) => s.id === 'api')!.health).toBe('ok');
    expect(w.services.find((s) => s.id === 'api')!.version).toBe('2.0.1');
    expect(w.services.find((s) => s.id === 'web')!.health).toBe('ok');
  });

  it('rollback with no superseded predecessor is rejected outright', () => {
    // at seed time d-200 is the only api deploy: nothing to revert to
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    const before = engine.world;
    engine.act('deploy.rollback', { deployId: 'd-200' });
    const w = engine.world;
    expect(w.deploys.find((d) => d.id === 'd-200')!.status).toBe('live');
    expect(w.services.find((s) => s.id === 'api')!.version).toBe(
      before.services.find((s) => s.id === 'api')!.version
    );
  });

  it('roll-forward is not re-entrant: a double act ships exactly one d-202', () => {
    const engine = toIncident();
    engine.act('flag.set', { id: 'new-checkout', state: 'off' });
    engine.act('deploy.rollforward', { service: 'api' });
    engine.act('deploy.rollforward', { service: 'api' });
    engine.step(4);

    const w = engine.world;
    expect(w.deploys.filter((d) => d.id === 'd-202')).toHaveLength(1);
    expect(w.deploys.find((d) => d.id === 'd-202')!.status).toBe('live');
    expect(w.services.every((s) => s.health === 'ok')).toBe(true);
  });
});

describe('migration-trap: determinism with an action schedule', () => {
  const scripted = (seed: number): string => {
    const engine = new Engine({ templateId: 'migration-trap', seed });
    engine.step(INCIDENT_TICK);
    engine.act('flag.set', { id: 'new-checkout', state: 'off' });
    engine.step(3);
    engine.act('deploy.rollforward', { service: 'api' });
    engine.step(5);
    return JSON.stringify(engine.events);
  };

  it('same seed + same act() schedule → byte-identical stream', () => {
    expect(scripted(42)).toBe(scripted(42));
  });

  it('different seed → different stream, same shape of resolution', () => {
    expect(scripted(42)).not.toBe(scripted(1337));
    for (const seed of [42, 1337, 7]) {
      const engine = new Engine({ templateId: 'migration-trap', seed });
      engine.step(INCIDENT_TICK);
      engine.act('flag.set', { id: 'new-checkout', state: 'off' });
      engine.step(3);
      engine.act('deploy.rollforward', { service: 'api' });
      engine.step(5);
      expect(engine.world.services.every((s) => s.health === 'ok')).toBe(true);
    }
  });
});
