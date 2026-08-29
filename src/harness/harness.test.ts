import { describe, expect, it } from 'vitest';
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
    expect(naiveGated.transcript.some((l) => l.includes('IRREVERSIBLE migration'))).toBe(true);
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
});
