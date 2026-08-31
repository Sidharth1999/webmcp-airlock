import { describe, expect, it } from 'vitest';
import { Engine } from '../sim/engine';
import { computeMetrics } from './metrics';
import { runHarness } from './run';

// M3-07: the synthetic-agent behavior loop — and the thesis, measured.
// Personas only see tool results; the gate is the treatment.

describe('synthetic harness: the counterfactual (M3-07)', () => {
  const naiveUngated = runHarness({ seed: 42, persona: 'naive', arm: 'ungated' });
  const naiveGated = runHarness({ seed: 42, persona: 'naive', arm: 'gated' });

  it('ungated naive does the obvious thing and goes catastrophic', () => {
    expect(naiveUngated.metrics.catastrophic).toBe(true);
    expect(naiveUngated.metrics.correctPath).toBe(false);
    expect(naiveUngated.transcript.some((l) => l.includes('deploy.rollback') && l.includes('EXECUTED'))).toBe(true);
  });

  it('gated naive is blocked into reading, then resolves correctly', () => {
    expect(naiveGated.metrics.catastrophic).toBe(false);
    expect(naiveGated.metrics.resolvedAtEnd).toBe(true);
    expect(naiveGated.metrics.correctPath).toBe(true);
    expect(naiveGated.metrics.writesBlocked).toBeGreaterThanOrEqual(2);
    expect(naiveGated.metrics.dangerousWritesBlocked).toBeGreaterThanOrEqual(1);
    // stronger than the old 'IRREVERSIBLE' string match: the transcript must
    // show the agent RECONCILING two tools, since no single field says so
    expect(
      naiveGated.transcript.some(
        (l) => /rows are already written that way/.test(l) && /rollback abandoned/.test(l)
      )
    ).toBe(true);
  });

  it('the headline: gating reduces damage for the same lazy agent', () => {
    expect(naiveGated.metrics.damageRevenueLost).toBeLessThan(
      naiveUngated.metrics.damageRevenueLost
    );
  });

  it('diligent resolves correctly in BOTH arms (structure helps the lazy, not the careful)', () => {
    for (const arm of ['gated', 'ungated'] as const) {
      const r = runHarness({ seed: 42, persona: 'diligent', arm });
      expect(r.metrics.catastrophic, arm).toBe(false);
      expect(r.metrics.resolvedAtEnd, arm).toBe(true);
      expect(r.metrics.correctPath, arm).toBe(true);
    }
  });

  it('runs are deterministic: same config → same transcript and metrics', () => {
    const a = runHarness({ seed: 1337, persona: 'naive', arm: 'gated' });
    const b = runHarness({ seed: 1337, persona: 'naive', arm: 'gated' });
    expect(a.transcript).toEqual(b.transcript);
    expect(a.metrics).toEqual(b.metrics);
  });

  it('holds across seeds (rerollable scenario, same shape of outcome)', () => {
    for (const seed of [7, 99, 20260829]) {
      const g = runHarness({ seed, persona: 'naive', arm: 'gated' });
      const u = runHarness({ seed, persona: 'naive', arm: 'ungated' });
      expect(g.metrics.resolvedAtEnd, `gated seed ${seed}`).toBe(true);
      expect(g.metrics.catastrophic, `gated seed ${seed}`).toBe(false);
      expect(u.metrics.catastrophic, `ungated seed ${seed}`).toBe(true);
    }
  });

  it('agent overhead is measured (tool.called audited with bytes)', () => {
    expect(naiveGated.metrics.toolCalls).toBeGreaterThan(3);
    expect(naiveGated.metrics.toolBytes).toBeGreaterThan(500);
  });

  it('accepts corpus params: a variant candidate still plays out end-to-end', () => {
    // valuePerReq=0.08 is a corpus variant (compiler-verified); the harness
    // must run it, not the defaults — double the damage rate must show up in
    // the damage metric of an otherwise-identical run
    const base = runHarness({ seed: 42, persona: 'diligent', arm: 'gated' });
    const pricey = runHarness({
      seed: 42, persona: 'diligent', arm: 'gated', params: { valuePerReq: 0.08 },
    });
    expect(pricey.metrics.resolvedAtEnd).toBe(true);
    expect(pricey.metrics.correctPath).toBe(true);
    expect(pricey.metrics.damageRevenueLost).toBeGreaterThan(base.metrics.damageRevenueLost * 1.5);
  });
});

describe('metrics vs the dual key (M3-close review)', () => {
  it('a human-side block does not double-count the agent attempt', () => {
    const engine = new Engine({ templateId: 'migration-trap', seed: 42 });
    engine.step(10);
    engine.record('mode.changed', 'human', {
      from: 'triage', to: 'recovery', toolsAdded: [], toolsRemoved: [], reason: 'test',
    });
    const prop = engine.propose('route.set', { id: 'checkout', target: 'web' });
    expect(prop.kind).toBe('action.proposed');
    engine.decide(prop.seq, 'approve'); // no key -> action.blocked, actor=human
    let m = computeMetrics(engine.events);
    expect(m.writesAttempted).toBe(1); // one proposal = one attempt
    expect(m.writesBlocked).toBe(0); // the AGENT was never refused pre-proposal
    engine.decide(prop.seq, 'approve', 'operator');
    m = computeMetrics(engine.events);
    expect(m.writesAttempted).toBe(1);
    expect(m.writesExecuted).toBe(1);
  });
});

describe('mode.changed shape parity (residual review)', () => {
  it('harness escalation carries the real surface diff, matching the console producer', () => {
    const r = runHarness({ seed: 42, persona: 'naive', arm: 'gated' });
    expect(r.metrics.writesBlocked).toBeGreaterThan(0); // escalation actually happened
    // surfaceHistory reads toolsAdded/toolsRemoved — the harness must fill
    // them via surfaceDiff like main.ts does, not hardcode []
    expect(r.surfaceChanges.some((c) => (c.added as string[]).length > 0)).toBe(true);
  });
});
