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

describe('approval flow: proposed → approved → executed, causedBy-chained (M3-03)', () => {
  it('approve executes the write as the agent and threads the full chain', () => {
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    engine.step(12); // incident live, flag on
    const proposal = engine.propose('flag.set', { id: 'new-checkout', state: 'off' });
    const emitted = engine.decide(proposal.seq, 'approve');

    const approved = emitted.find((e) => e.kind === 'action.approved')!;
    const executed = emitted.find((e) => e.kind === 'action.executed')!;
    expect(approved.causedBy).toBe(proposal.seq);
    expect((approved.data as { proposalSeq: number }).proposalSeq).toBe(proposal.seq);
    expect(executed.causedBy).toBe(approved.seq);
    expect(executed.actor).toBe('agent');

    // the write really happened and the template reacted (mitigation path)
    expect(engine.world.flags.find((f) => f.id === 'new-checkout')!.state).toBe('off');
    engine.step(3);
    expect(engine.world.services.find((s) => s.id === 'api')!.health).toBe('ok');

    // chainOf walks executed → approved → proposed
    const chain = engine.chainOf(executed.seq).map((e) => e.kind);
    expect(chain).toContain('action.approved');
    expect(chain).toContain('action.proposed');
  });

  it('reject leaves the world untouched and closes the proposal', () => {
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    engine.step(12);
    const proposal = engine.propose('deploy.rollback', { deployId: 'd-201' });
    const before = JSON.stringify(engine.world);
    const emitted = engine.decide(proposal.seq, 'reject');

    expect(emitted.map((e) => e.kind)).toEqual(['action.rejected']);
    expect(emitted[0]!.causedBy).toBe(proposal.seq);
    expect(JSON.stringify(engine.world)).toBe(before);
    // the Refusal survives: deciding again is refused
    expect(() => engine.decide(proposal.seq, 'approve')).toThrow(/already decided/);
  });

  it('decide validates its target', () => {
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    engine.step(2);
    expect(() => engine.decide(1, 'approve')).toThrow(/no proposal/);
    expect(() => engine.decide(9999, 'approve')).toThrow(/no proposal/);
  });

  it('an approved rollback proposal still hits the trap — the gate is the human, not magic', () => {
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    engine.step(12);
    const proposal = engine.propose('deploy.rollback', { deployId: 'd-201' });
    engine.decide(proposal.seq, 'approve');
    expect(engine.world.services.find((s) => s.id === 'api')!.health).toBe('down');
  });
});
