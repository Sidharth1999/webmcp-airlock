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

/** M3-04: proposals are mode-gated in the ENGINE — tests enter a mode first. */
function enterMode(engine: Engine, to: 'diagnosis' | 'recovery', from = 'triage'): void {
  engine.record('mode.changed', 'human', {
    from, to, toolsAdded: [], toolsRemoved: [], reason: 'test setup',
  });
}

describe('proposals carry the vocabulary tier + human diff (M3-02)', () => {
  it('flag proposal describes the state transition', () => {
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    engine.step(12); // flag is on mid-incident
    enterMode(engine, 'recovery');
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
    enterMode(engine, 'recovery');
    const ev = engine.propose('deploy.rollback', { deployId: 'd-201' });
    expect(ev.data.tier).toBe(1);
    expect(ev.data.diffSummary).toContain('2.0.0 → 1.9.3');
    expect(ev.data.diffSummary).toContain('d-200 becomes live');
  });

  it('rollback proposal is honest when there is nothing to revert to', () => {
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    enterMode(engine, 'recovery');
    const ev = engine.propose('deploy.rollback', { deployId: 'd-200' });
    expect(ev.data.diffSummary).toContain('would be rejected');
  });

  it('proposals do not mutate the world', () => {
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    engine.step(12);
    enterMode(engine, 'recovery');
    const before = JSON.stringify(engine.world);
    engine.propose('flag.set', { id: 'new-checkout', state: 'off' });
    expect(JSON.stringify(engine.world)).toBe(before);
  });

  it('off-vocabulary proposals throw; record() rejects non-meta kinds', () => {
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    enterMode(engine, 'recovery');
    expect(() => engine.propose('rm.rf', {})).toThrow(/unknown write tool/);
    expect(() => engine.record('deploy.finished', 'agent', {})).toThrow(/does not accept/);
    expect(writeAction('route.set').tier).toBe(4);
  });
});

describe('approval flow: proposed → approved → executed, causedBy-chained (M3-03)', () => {
  it('approve executes the write as the agent and threads the full chain', () => {
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    engine.step(12);
    enterMode(engine, 'recovery'); // incident live, flag on
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
    enterMode(engine, 'recovery');
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
    enterMode(engine, 'recovery');
    const proposal = engine.propose('deploy.rollback', { deployId: 'd-201' });
    engine.decide(proposal.seq, 'approve');
    expect(engine.world.services.find((s) => s.id === 'api')!.health).toBe('down');
  });
});

describe('co-presence branching: selection scopes the reads (M3-05)', () => {
  function withIncidentAndSelection(target: unknown): Engine {
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    engine.step(16); // clues dripped: api + db log lines exist
    engine.record('selection.changed', 'human', { by: 'human', target });
    return engine;
  }

  it('selecting a service scopes logs to it and stamps scopedTo', () => {
    const engine = withIncidentAndSelection({ type: 'service', id: 'api' });
    const r = runQuery(engine.events, engine.world, { kind: 'logs' }) as {
      scopedTo?: { service: string };
      lines: Array<{ service: string }>;
    };
    expect(r.scopedTo?.service).toBe('api');
    expect(r.lines.length).toBeGreaterThan(0);
    for (const l of r.lines) expect(l.service).toBe('api');
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(1200);
  });

  it('selecting a deploy scopes the deploy list to its service', () => {
    const engine = withIncidentAndSelection({ type: 'deploy', id: 'd-201' });
    const r = runQuery(engine.events, engine.world, { kind: 'deploys' }) as {
      scopedTo?: { service: string };
      deploys: Array<{ service: string }>;
    };
    expect(r.scopedTo?.service).toBe('api');
    for (const d of r.deploys) expect(d.service).toBe('api');
  });

  it('status always carries humanSelection; clearing unscopes', () => {
    const engine = withIncidentAndSelection({ type: 'service', id: 'db' });
    const s1 = runQuery(engine.events, engine.world, { kind: 'status' }) as {
      humanSelection: { type: string; id: string } | null;
    };
    expect(s1.humanSelection).toEqual({ type: 'service', id: 'db' });

    engine.record('selection.changed', 'human', { by: 'human', target: null });
    const s2 = runQuery(engine.events, engine.world, { kind: 'status' }) as {
      humanSelection: unknown;
    };
    expect(s2.humanSelection).toBeNull();
    const logs = runQuery(engine.events, engine.world, { kind: 'logs' }) as {
      scopedTo?: unknown;
      lines: Array<{ service: string }>;
    };
    expect(logs.scopedTo).toBeUndefined();
    expect(new Set(logs.lines.map((l) => l.service)).size).toBeGreaterThan(1);
  });

  it('a flag selection does not scope service-keyed reads', () => {
    const engine = withIncidentAndSelection({ type: 'flag', id: 'new-checkout' });
    const r = runQuery(engine.events, engine.world, { kind: 'deploys' }) as { scopedTo?: unknown };
    expect(r.scopedTo).toBeUndefined();
  });
});

describe('write-escalation ladder + dual key (M3-04)', () => {
  it('any write proposed in triage is blocked with a machine-readable reason', () => {
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    engine.step(12);
    const before = JSON.stringify(engine.world);
    const ev = engine.propose('flag.set', { id: 'new-checkout', state: 'off' });
    expect(ev.kind).toBe('action.blocked');
    expect(ev.data).toMatchObject({ reason: 'not-available-in-mode', mode: 'triage', tier: 3 });
    expect(JSON.stringify(engine.world)).toBe(before);
  });

  it('diagnosis allows only the flag tier (mitigate-first doctrine)', () => {
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    engine.step(12);
    enterMode(engine, 'diagnosis');
    expect(engine.propose('flag.set', { id: 'new-checkout', state: 'off' }).kind).toBe('action.proposed');
    expect(engine.propose('deploy.rollback', { deployId: 'd-201' }).kind).toBe('action.blocked');
    expect(engine.propose('env.set', { key: 'X', value: 'y' }).kind).toBe('action.blocked');
    expect(engine.propose('route.set', { id: 'checkout', target: 'web' }).kind).toBe('action.blocked');
  });

  it('tier-4 approval without the key is blocked; the proposal survives', () => {
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    engine.step(12);
    enterMode(engine, 'recovery');
    const proposal = engine.propose('route.set', { id: 'checkout', target: 'web' });
    const target = () => engine.world.routes.find((r) => r.id === 'checkout')!.target;

    const attempt = engine.decide(proposal.seq, 'approve'); // no key
    expect(attempt.map((e) => e.kind)).toEqual(['action.blocked']);
    expect(attempt[0]!.data).toMatchObject({ reason: 'dual-key-required', proposalSeq: proposal.seq });
    expect(target()).toBe('api'); // untouched

    // the Turn of the Key: same proposal, key held
    const emitted = engine.decide(proposal.seq, 'approve', 'operator');
    const approved = emitted.find((e) => e.kind === 'action.approved')!;
    expect((approved.data as { keyHolder: string }).keyHolder).toBe('operator');
    expect(emitted.some((e) => e.kind === 'action.executed')).toBe(true);
    expect(target()).toBe('web');
  });

  it('lower tiers execute on approval alone; keyHolder is only stamped when given', () => {
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    engine.step(12);
    enterMode(engine, 'recovery');
    const proposal = engine.propose('flag.set', { id: 'new-checkout', state: 'off' });
    const emitted = engine.decide(proposal.seq, 'approve');
    const approved = emitted.find((e) => e.kind === 'action.approved')!;
    expect('keyHolder' in (approved.data as object)).toBe(false);
    expect(emitted.some((e) => e.kind === 'action.executed')).toBe(true);
  });

  it('attempted-vs-blocked is countable straight off the log', () => {
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    engine.step(12);
    engine.propose('deploy.rollback', { deployId: 'd-201' }); // blocked (triage)
    enterMode(engine, 'recovery');
    engine.propose('flag.set', { id: 'new-checkout', state: 'off' }); // proposed
    const blocked = engine.events.filter((e) => e.kind === 'action.blocked');
    const proposed = engine.events.filter((e) => e.kind === 'action.proposed');
    expect(blocked).toHaveLength(1);
    expect(proposed).toHaveLength(1);
  });
});
