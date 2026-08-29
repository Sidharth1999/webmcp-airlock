import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { currentMode, surfaceDiff, surfaceHistory } from './modes';
import { runQuery } from './queries';
import { writeAction } from './vocabulary';

// M3-02 engine-side: mode derivation from the log, proposal events with
// vocabulary tiers + diff summaries, record() whitelist.

describe('mode derivation and surface diff (M3-02)', () => {
  it('mode defaults to triage and follows the last mode.changed event', () => {
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    expect(currentMode(engine.events)).toBe('triage');
    engine.record('mode.changed', 'human', {
      from: 'triage', to: 'diagnosis', toolsAdded: ['propose_flag_change'], toolsRemoved: [], reason: 'test',
    });
    engine.record('mode.changed', 'human', {
      from: 'diagnosis', to: 'recovery', toolsAdded: ['propose_rollback'], toolsRemoved: [], reason: 'test',
    });
    expect(currentMode(engine.events)).toBe('recovery');
  });

  it('surfaceDiff computes the registration delta between modes', () => {
    expect(surfaceDiff('triage', 'diagnosis')).toEqual({
      added: ['propose_flag_change'],
      removed: [],
    });
    const toTriage = surfaceDiff('recovery', 'triage');
    expect(toTriage.added).toEqual([]);
    expect(toTriage.removed).toHaveLength(5);
  });

  it('surface query narrates history newest-first within the size cap', () => {
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    engine.record('mode.changed', 'human', {
      from: 'triage', to: 'diagnosis', toolsAdded: ['propose_flag_change'], toolsRemoved: [], reason: 'operator switched mode in console',
    });
    const r = runQuery(engine.events, engine.world, { kind: 'surface' });
    expect(r.mode).toBe('diagnosis');
    const changes = r.changes as Array<Record<string, unknown>>;
    expect(changes[0]!.added).toEqual(['propose_flag_change']);
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(1200);
    expect(surfaceHistory(engine.events)[0]!.reason).toBe('operator switched mode in console');
  });
});

describe('proposals carry the vocabulary tier + human diff (M3-02)', () => {
  it('flag proposal describes the state transition', () => {
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    engine.step(12); // flag is on mid-incident
    const ev = engine.propose('flag.set', { id: 'new-checkout', state: 'off' });
    expect(ev.kind).toBe('action.proposed');
    expect(ev.actor).toBe('agent');
    expect(ev.data.tier).toBe(3);
    expect(ev.data.tierName).toBe('flag');
    expect(ev.data.diffSummary).toBe('flag new-checkout: on → off');
  });

  it('rollback proposal names the predecessor that would go live', () => {
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    engine.step(12);
    const ev = engine.propose('deploy.rollback', { deployId: 'd-201' });
    expect(ev.data.tier).toBe(1);
    expect(ev.data.diffSummary).toContain('2.0.0 → 1.9.3');
    expect(ev.data.diffSummary).toContain('d-200 becomes live');
  });

  it('rollback proposal is honest when there is nothing to revert to', () => {
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    const ev = engine.propose('deploy.rollback', { deployId: 'd-200' });
    expect(ev.data.diffSummary).toContain('would be rejected');
  });

  it('proposals do not mutate the world', () => {
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    engine.step(12);
    const before = JSON.stringify(engine.world);
    engine.propose('flag.set', { id: 'new-checkout', state: 'off' });
    expect(JSON.stringify(engine.world)).toBe(before);
  });

  it('off-vocabulary proposals throw; record() rejects non-meta kinds', () => {
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    expect(() => engine.propose('rm.rf', {})).toThrow(/unknown write tool/);
    expect(() => engine.record('deploy.finished', 'agent', {})).toThrow(/does not accept/);
    expect(writeAction('route.set').tier).toBe(4);
  });
});
