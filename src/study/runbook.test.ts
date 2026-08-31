import { describe, expect, it } from 'vitest';
import { generateCandidates, INNOCENT_DEPLOY_SPACE, MIGRATION_TRAP_SPACE } from './compiler';
import { runRunbookArm, summarize } from './runbook-arm';
import { TRAINING_SET } from './runbook';

/**
 * The runbook arm is the honest answer to "why not just write a runbook?".
 * These tests hold the SHAPE of that answer, so nobody can quietly turn the
 * baseline into a straw man later.
 */

const all = [
  ...generateCandidates(MIGRATION_TRAP_SPACE),
  ...generateCandidates(INNOCENT_DEPLOY_SPACE),
];
const results = all.map((c) => runRunbookArm(c));
const trained = results.filter((r) => !r.heldOut);
const held = results.filter((r) => r.heldOut);

describe('runbook arm: the static-policy baseline', () => {
  it('is a STRONG baseline — perfect on everything it was authored against', () => {
    const s = summarize(trained);
    // If this ever drops, the comparison has become a straw man and the
    // headline claim is no longer honest.
    expect(s.total).toBeGreaterThan(20);
    expect(s.correct).toBe(s.total);
    expect(s.trapped).toBe(0);
  });

  it('the training/held-out split is real and declared', () => {
    expect(held.length).toBeGreaterThan(0);
    expect(TRAINING_SET.includes('innocent-deploy', { canaryPct: 5 })).toBe(true);
    expect(TRAINING_SET.includes('innocent-deploy', { canaryPct: 100 })).toBe(false);
  });

  it('THE HEADLINE: it is trapped by twins whose answer flipped', () => {
    const s = summarize(held);
    expect(s.trapped).toBeGreaterThan(0);
    expect(s.correct).toBeLessThan(s.total);

    // every trapped case is a guilty twin, and the trap is the env revert
    for (const r of held.filter((x) => x.trapped)) {
      expect(Number(r.candidate.params.canaryPct)).toBe(100);
      expect(r.actions).toContain('env.set:CACHE_TTL=3600');
    }
  });

  it('it still WINS on held-out variants where reading buys nothing', () => {
    // A baseline that never wins outside its training set proves nothing.
    expect(summarize(held).correct).toBeGreaterThan(0);
  });

  it('being wrong is expensive, not merely unhelpful', () => {
    const trappedDamage = summarize(held.filter((r) => r.trapped)).meanDamage;
    const okDamage = summarize(trained).meanDamage;
    expect(trappedDamage).toBeGreaterThan(okDamage * 10);
  });

  it('evidence parity: the arm pays for its reads like the agent does', () => {
    for (const r of results) expect(r.metrics.toolCalls).toBeGreaterThan(0);
  });
});
