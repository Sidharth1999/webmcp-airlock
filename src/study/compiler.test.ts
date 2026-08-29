import { describe, expect, it } from 'vitest';
import {
  MIGRATION_TRAP_SPACE,
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

  it('refuses keys it cannot execute (lossy or unknown)', () => {
    expect(parseActionKey('env.set:SESSIONS_SCHEMA')).toBeUndefined(); // value lost by actionKey
    expect(parseActionKey('flag.set:new-checkout')).toBeUndefined(); // no state
    expect(parseActionKey('unknown.tool:x')).toBeUndefined();
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
