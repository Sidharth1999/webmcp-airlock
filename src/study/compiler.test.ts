import { describe, expect, it } from 'vitest';
import {
  MIGRATION_TRAP_SPACE,
  RETRY_STORM_SPACE,
  compileCorpus,
  generateCandidates,
  parseActionKey,
  verifyCandidate,
} from './compiler';

describe('parseActionKey (inverse of metrics.actionKey)', () => {
  it('parses every executable vocabulary form', () => {
    expect(parseActionKey('flag.set:new-checkout=off')).toEqual({
      tool: 'flag.set',
      input: { id: 'new-checkout', state: 'off' },
    });
    expect(parseActionKey('deploy.rollback:d-201')).toEqual({
      tool: 'deploy.rollback',
      input: { deployId: 'd-201' },
    });
    expect(parseActionKey('deploy.rollforward:api')).toEqual({
      tool: 'deploy.rollforward',
      input: { service: 'api' },
    });
    expect(parseActionKey('route.set:checkout=api-canary')).toEqual({
      tool: 'route.set',
      input: { id: 'checkout', target: 'api-canary' },
    });
  });

  it('parses the ordering family\u2019s vocabulary', () => {
    expect(parseActionKey('ratelimit.set:r-checkout=100')).toEqual({
      tool: 'ratelimit.set',
      input: { route: 'r-checkout', rps: 100 },
    });
    expect(parseActionKey('traffic.drain:r-checkout')).toEqual({
      tool: 'traffic.drain',
      input: { route: 'r-checkout' },
    });
    expect(parseActionKey('alerts.silence:true')).toEqual({
      tool: 'alerts.silence',
      input: { silenced: true },
    });
    expect(parseActionKey('service.restart:api')).toEqual({
      tool: 'service.restart',
      input: { service: 'api' },
    });
  });

  it('refuses keys it cannot execute (lossy or unknown)', () => {
    expect(parseActionKey('env.set:SESSIONS_SCHEMA')).toBeUndefined(); // value lost by actionKey
    expect(parseActionKey('flag.set:new-checkout')).toBeUndefined(); // no state
    expect(parseActionKey('unknown.tool:x')).toBeUndefined();
    expect(parseActionKey('ratelimit.set:r-checkout')).toBeUndefined(); // a cap with no number
    expect(parseActionKey('ratelimit.set:r-checkout=lots')).toBeUndefined();
    expect(parseActionKey('alerts.silence:maybe')).toBeUndefined(); // names no world state
  });
});

describe('verifyCandidate', () => {
  const trapDefault = {
    id: 'migration-trap:s1:default',
    templateId: 'migration-trap',
    seed: 1,
    params: {},
  };

  it('accepts the flagship scenario at defaults', () => {
    const report = verifyCandidate(trapDefault);
    expect(report.rejects).toEqual([]);
    expect(report.accepted).toBe(true);
    // probe evidence is attached: null run breaks and stays broken,
    // solution run resolves along the declared path
    expect(report.probes.null.resolvedAtEnd).toBe(false);
    expect(report.probes.solutions[0]!.resolvedAtEnd).toBe(true);
    expect(report.probes.solutions[0]!.correctPath).toBe(true);
    expect(report.probes.traps[0]!.catastrophic).toBe(true);
  });

  it('rejects a template with no answer key', () => {
    const report = verifyCandidate({
      id: 'baseline:s1:default',
      templateId: 'baseline',
      seed: 1,
      params: {},
    });
    expect(report.accepted).toBe(false);
    expect(report.rejects).toContain('no-answer-key');
  });

  it('rejects a candidate whose incident never opens inside the horizon', () => {
    const report = verifyCandidate({
      id: 'migration-trap:s1:late',
      templateId: 'migration-trap',
      seed: 1,
      params: { deployAtTick: 500 },
    });
    expect(report.accepted).toBe(false);
    expect(report.rejects).toContain('no-incident');
  });

  it('rejects an answer key whose "solution" is actually the trap', () => {
    const report = verifyCandidate(trapDefault, {
      meta: {
        solutions: [['deploy.rollback:d-201']],
        traps: ['deploy.rollback:d-201'],
      },
    });
    expect(report.accepted).toBe(false);
    expect(report.rejects.some((r) => r.startsWith('solution-fails:'))).toBe(true);
  });

  it('rejects an answer key with an unexecutable action', () => {
    const report = verifyCandidate(trapDefault, {
      meta: {
        solutions: [['env.set:SESSIONS_SCHEMA', 'deploy.rollforward:api']],
        traps: ['deploy.rollback:d-201'],
      },
    });
    expect(report.accepted).toBe(false);
    expect(report.rejects).toContain('unparseable-action:env.set:SESSIONS_SCHEMA');
  });

  it('is deterministic: same candidate, same report', () => {
    const a = verifyCandidate(trapDefault);
    const b = verifyCandidate(trapDefault);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('generateCandidates', () => {
  it('emits default + one-factor variants, crossed with seeds, unique ids', () => {
    const candidates = generateCandidates({
      templateId: 'migration-trap',
      seeds: [1, 2],
      variations: { deployAtTick: [4, 9], baseRps: [140] },
    });
    // (1 default + 3 variants) x 2 seeds
    expect(candidates).toHaveLength(8);
    expect(new Set(candidates.map((c) => c.id)).size).toBe(8);
    const variant = candidates.find((c) => c.id === 'migration-trap:s2:deployAtTick=9');
    expect(variant?.params).toEqual({ deployAtTick: 9 });
  });
});

describe('compileCorpus', () => {
  it('verifies the built-in migration-trap space: accepted corpus + logged rejects', () => {
    const result = compileCorpus(MIGRATION_TRAP_SPACE);
    expect(result.generated).toBe(result.accepted.length + result.rejects.length);
    // the space is designed to be verifiable — the corpus must be non-trivial
    expect(result.accepted.length).toBeGreaterThanOrEqual(20);
    for (const r of result.rejects) {
      expect(r.reasons.length).toBeGreaterThan(0);
    }
    // every accepted entry carries the evidence the campaign needs
    for (const a of result.accepted) {
      expect(a.probes.solutions.every((s) => s.resolvedAtEnd && s.correctPath)).toBe(true);
    }
  });
});

/**
 * ORDERING PROBES (retry-storm). A single-lever trap is judged against doing
 * nothing; an ordering violation has to beat that AND the same work done in
 * the right order, because the actions in it are the correct actions.
 */
describe('verifyCandidate: ordering violations', () => {
  const stormDefault = {
    id: 'retry-storm:s11:default',
    templateId: 'retry-storm',
    seed: 11,
    params: {},
  };

  it('accepts the ordering family and attaches an ordering probe per violation', () => {
    const report = verifyCandidate(stormDefault);
    expect(report.rejects).toEqual([]);
    expect(report.accepted).toBe(true);
    expect(report.probes.orderTraps).toHaveLength(3);
    // the declared order resolves; every violation of it fails to
    expect(report.probes.solutions.every((s) => s.resolvedAtEnd)).toBe(true);
    expect(report.probes.orderTraps.every((o) => !o.resolvedAtEnd)).toBe(true);
    // and each violation costs more than doing nothing at all
    for (const o of report.probes.orderTraps) {
      expect(o.catastrophic || o.damageRevenueLost > report.probes.null.damageRevenueLost).toBe(true);
    }
  });

  it('REJECTS an ordering claim the world does not actually enforce', () => {
    // the shed on its own is a mitigation, not a violation: declaring it one
    // is exactly the rigged-scenario failure this gate exists to catch
    const report = verifyCandidate(stormDefault, {
      meta: {
        solutions: [['ratelimit.set:r-checkout=100', 'deploy.rollforward:api']],
        traps: ['traffic.drain:r-checkout'],
        orderTraps: [['ratelimit.set:r-checkout=100']],
      },
    });
    expect(report.accepted).toBe(false);
    expect(report.rejects).toContain('order-trap-not-punishing:ratelimit.set:r-checkout=100');
  });

  it('rejects an ordering claim with an unexecutable action', () => {
    const report = verifyCandidate(stormDefault, {
      meta: {
        solutions: [['ratelimit.set:r-checkout=100', 'deploy.rollforward:api']],
        traps: ['traffic.drain:r-checkout'],
        orderTraps: [['alerts.silence:maybe', 'deploy.rollforward:api']],
      },
    });
    expect(report.accepted).toBe(false);
    expect(report.rejects).toContain('unparseable-action:alerts.silence:maybe');
  });
});

describe('compileCorpus: the ordering space', () => {
  it('verifies every retry-storm variant independently', () => {
    const result = compileCorpus(RETRY_STORM_SPACE);
    expect(result.rejects).toEqual([]);
    expect(result.accepted.length).toBe(result.generated);
    expect(result.accepted.length).toBeGreaterThanOrEqual(20);
    // the claim under test, held per variant: right order cheap, wrong order
    // more expensive than never touching it
    for (const a of result.accepted) {
      const best = Math.min(...a.probes.solutions.map((s) => s.damageRevenueLost));
      expect(best).toBeLessThan(a.probes.null.damageRevenueLost);
      for (const o of a.probes.orderTraps) {
        expect(o.catastrophic || o.damageRevenueLost > best).toBe(true);
      }
    }
  });
});
