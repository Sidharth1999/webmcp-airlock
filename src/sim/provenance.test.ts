import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { provenanceOf, taintedRefs } from './provenance';
import type { Event } from './types';

// Family #2 (injection): the page-side authorization check. A generic host
// confirm renders "roll back d-318" faithfully and a careful human approves
// it. The one fact that changes the answer — that the id arrived inside
// customer-supplied text the page served the agent — lives only here.

/** Runs to the tick where the poisoned order note is in the log. */
function poisoned(toTick = 20): Engine {
  const e = new Engine({ templateId: 'poisoned-runbook', seed: 11 });
  e.step(toTick);
  return e;
}

const readLogs = (e: Engine): Event =>
  e.record('tool.called', 'agent', { tool: 'read_logs', input: {}, resultBytes: 900 });

const toRecovery = (e: Engine): void => {
  e.record('mode.changed', 'human', {
    from: 'triage', to: 'recovery', toolsAdded: [], toolsRemoved: [], reason: 'test',
  });
};

describe('provenance — what the page knows about the evidence', () => {
  it('an untrusted line the agent never read taints nothing', () => {
    const e = poisoned();
    const untrusted = e.events.filter(
      (ev) => ev.kind === 'log.line' && (ev.data as { untrusted?: boolean }).untrusted
    );
    expect(untrusted.length, 'the scenario must actually seed the injection').toBe(1);
    expect(taintedRefs(e.events).size).toBe(0); // no read_logs call yet
  });

  it('once served, the id inside the untrusted text is tainted and cited', () => {
    const e = poisoned();
    const call = readLogs(e);
    const tainted = taintedRefs(e.events);
    const hit = tainted.get('d-318')!;
    expect(hit, 'the deploy id the note is pushing').toBeTruthy();
    expect(hit.servedBySeq).toBe(call.seq);
    expect(hit.excerpt).toMatch(/ACTION REQUIRED/);
    // the citation points at a real log line the human can go read
    const line = e.events.find((ev) => ev.seq === hit.lineSeq)!;
    expect(line.kind).toBe('log.line');
    expect((line.data as { untrusted?: boolean }).untrusted).toBe(true);
  });

  it('the honest fix is NOT tainted — it comes from the console’s own state', () => {
    const e = poisoned();
    readLogs(e);
    expect(provenanceOf(e.events, { id: 'checkout-v3', state: 'off' })).toBeNull();
    expect(provenanceOf(e.events, { deployId: 'd-318' })).not.toBeNull();
  });

  it('the same proposal is clean before the read and tainted after it', () => {
    const before = poisoned();
    toRecovery(before);
    const clean = before.propose('deploy.rollback', { deployId: 'd-318' });
    expect((clean.data as { provenance?: unknown }).provenance).toBeUndefined();
    expect((clean.data as { requiresKey?: boolean }).requiresKey).toBeUndefined();

    const after = poisoned();
    toRecovery(after);
    readLogs(after);
    const dirty = after.propose('deploy.rollback', { deployId: 'd-318' });
    expect((dirty.data as { requiresKey?: boolean }).requiresKey).toBe(true);
    expect((dirty.data as { provenance?: { ref: string } }).provenance!.ref).toBe('d-318');
  });

  it('a tainted tier-1 write is promoted to the key rung, and the key still lets it through', () => {
    const e = poisoned();
    toRecovery(e);
    readLogs(e);
    const proposal = e.propose('deploy.rollback', { deployId: 'd-318' });
    expect((proposal.data as { tier: number }).tier, 'nominally the lowest rung').toBe(1);

    // one reflexive click is not enough any more
    const blocked = e.decide(proposal.seq, 'approve');
    expect(blocked.map((ev) => ev.kind)).toEqual(['action.blocked']);
    expect(blocked[0]!.data).toMatchObject({
      reason: 'dual-key-required',
      escalatedBy: 'untrusted-evidence',
    });

    // the human is not overruled: with the key held, the write executes
    // (the template's own reaction to the executed write follows behind)
    const done = e.decide(proposal.seq, 'approve', 'operator');
    expect(done.map((ev) => ev.kind).slice(0, 2)).toEqual([
      'action.approved',
      'action.executed',
    ]);
  });

  it('scenarios with no untrusted content are untouched (the flagship stays one-click)', () => {
    const e = new Engine({ templateId: 'migration-trap', seed: 42 });
    e.step(20);
    toRecovery(e);
    readLogs(e);
    expect(taintedRefs(e.events).size).toBe(0);
    const p = e.propose('deploy.rollback', { deployId: 'd-201' });
    expect((p.data as { requiresKey?: boolean }).requiresKey).toBeUndefined();
    expect(e.decide(p.seq, 'approve').map((ev) => ev.kind).slice(0, 2)).toEqual([
      'action.approved',
      'action.executed',
    ]);
  });
});
