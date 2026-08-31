import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { runQuery } from './queries';
import { metaFor } from './templates';
import { verifyCandidate } from '../study/compiler';

/**
 * Template A + its E-twin. The thesis under test is NOT "we have another
 * scenario" — it is ANSWER-KEY VARIANCE PER OBSERVABLE NARRATIVE: the same
 * story, told the same way, with the opposite correct action.
 */

const INNOCENT = { canaryPct: 5 };
const GUILTY = { canaryPct: 100 };

function nullRun(params: Record<string, unknown>, ticks = 40): Engine {
  const e = new Engine({ templateId: 'innocent-deploy', seed: 11, params });
  e.step(ticks);
  return e;
}

describe('innocent-deploy: the confounder', () => {
  it('declares opposite answer keys for the twin pair', () => {
    const innocent = metaFor('innocent-deploy', INNOCENT)!;
    const guilty = metaFor('innocent-deploy', GUILTY)!;

    expect(innocent.solutions).toEqual([['env.set:CACHE_TTL=3600']]);
    expect(innocent.traps).toEqual(['deploy.rollback:d-212']);

    // the twin's solution is the original's trap, and vice versa
    expect(guilty.solutions).toEqual([innocent.traps]);
    expect(guilty.traps).toEqual(innocent.solutions.flat());
  });

  it('both twins pass all four compiler probes', () => {
    for (const [label, params] of [
      ['innocent', INNOCENT],
      ['guilty', GUILTY],
    ] as const) {
      const report = verifyCandidate({
        id: `innocent-deploy:s11:${label}`,
        templateId: 'innocent-deploy',
        seed: 11,
        params,
      });
      expect(report.rejects, label).toEqual([]);
      expect(report.accepted, label).toBe(true);
    }
  });

  it('THE TWIN PROPERTY: the observable narrative is identical but for the canary share', () => {
    const a = nullRun(INNOCENT);
    const b = nullRun(GUILTY);

    // Everything the agent can read, as the agent reads it. The ONLY
    // permitted difference is the traffic share the deploy serves.
    const strip = (s: string): string => s.replace(/\b5%|\b100%/g, '<PCT>');

    const logsOf = (e: Engine): string[] =>
      e.events
        .filter((ev) => ev.kind === 'log.line')
        .map((ev) => strip(String((ev.data as { msg: string }).msg)));
    expect(logsOf(a)).toEqual(logsOf(b));

    const trafficOf = (e: Engine): string =>
      JSON.stringify(
        e.events.filter((ev) => ev.kind === 'traffic.tick').map((ev) => ev.data)
      );
    expect(trafficOf(a)).toEqual(trafficOf(b));

    // deploy metadata matches once the canary share is normalised away
    const deploysOf = (e: Engine): string =>
      strip(JSON.stringify(runQuery(e.events, e.world, { kind: 'deploys' })).replace(/"pct":\d+/g, '"pct":<PCT>'));
    expect(deploysOf(a)).toEqual(deploysOf(b));
  });

  it('exposes the blast-radius arithmetic across two tools, and nothing states the answer', () => {
    const e = nullRun(INNOCENT);
    const deploys = runQuery(e.events, e.world, { kind: 'deploys' }) as {
      deploys: Array<{ id: string; canary: { pct?: number } | null }>;
    };
    const traffic = runQuery(e.events, e.world, { kind: 'traffic' }) as {
      ticks: Array<{ errRate: number }>;
    };

    const decoy = deploys.deploys.find((d) => d.id === 'd-212')!;
    expect(decoy.canary?.pct).toBe(5);

    // observed error share materially exceeds what a 5% canary could cause
    const observed = traffic.ticks[0]!.errRate;
    expect(observed).toBeGreaterThan(0.05);

    // ...and no read surface simply announces the cause
    const all = JSON.stringify([
      runQuery(e.events, e.world, { kind: 'status' }),
      runQuery(e.events, e.world, { kind: 'deploys' }),
      runQuery(e.events, e.world, { kind: 'changes' }),
      runQuery(e.events, e.world, { kind: 'logs' }),
    ]);
    expect(all).not.toMatch(/rootCause|culprit|"innocent"|"guilty"|isTrap/i);
  });

  it('the incident is real: it opens and does not heal itself', () => {
    const e = nullRun(INNOCENT, 50);
    expect(e.world.services.some((s) => s.health !== 'ok')).toBe(true);
  });

  it('logs point at cache exhaustion, never at a new-code stack trace', () => {
    const e = nullRun(INNOCENT);
    const msgs = e.events
      .filter((ev) => ev.kind === 'log.line')
      .map((ev) => String((ev.data as { msg: string }).msg))
      .join(' | ');
    expect(msgs).toMatch(/cache miss|cache hit ratio|connection pool/i);
    expect(msgs).not.toMatch(/stack trace|NullPointer|TypeError|d-212 handler/i);
  });
});
