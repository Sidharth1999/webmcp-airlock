import type { SimCtx } from './engine';
import { jitter, pickInt } from './rng';
import type { TemplateFactory, TemplateInstance } from './templates';
import type { Deploy, Event } from './types';

/**
 * migration-trap — the flagship scenario (M2-04).
 *
 * Deploy d-201 ships checkout v2 behind flag `new-checkout` AND an
 * irreversible sessions-table migration. Checkout errors spike. The obvious
 * move — roll back the deploy — is catastrophic: v1 code cannot read the
 * migrated schema, api crashloops, web degrades with it. The correct path is
 * flag-off (mitigate) then roll forward a fixed build (resolve).
 *
 * Phases: pre → incident → { mitigated → resolved | catastrophic → resolved }
 */

type Phase = 'pre' | 'incident' | 'mitigated' | 'catastrophic' | 'resolved';

const TRAP_DEPLOY: Omit<Deploy, 'status' | 'at'> = {
  id: 'd-201',
  service: 'api',
  version: '2.0.0',
  author: 'priya@sim',
  changedAreas: ['checkout', 'sessions'],
  containsMigration: true,
  migrationReversible: false,
  flagsTouched: ['new-checkout'],
  diffstat: { files: 14, plus: 812, minus: 240 },
  canaryDelta: { errRate: 0.003, p95: 11 }, // canary looked clean — sessions only migrate at scale
  note: 'checkout v2 + session schema migration (drops legacy_cart; backfill ran in CI)',
};

const CLUE_LINES = [
  { service: 'api', level: 'error', msg: 'checkout-v2 handler 500: session row missing legacy_cart (migrated)' },
  { service: 'api', level: 'warn', msg: 'feature flag new-checkout serving 100% of checkout traffic' },
  // DE-STRUCTURED: this line states the MECHANISM (which column went away),
  // never the verdict. "(irreversible)" here handed the whole decision to a
  // single read_logs call and made the two-tool assembly cosmetic.
  { service: 'db', level: 'info', msg: 'migration mig-77 committed: sessions v2 (legacy_cart dropped)' },
] as const;

export const migrationTrap: TemplateFactory = {
  id: 'migration-trap',
  defaultParams: {
    baseRps: 220,
    baseErrRate: 0.002,
    baseP95: 180,
    valuePerReq: 0.04,
    deployAtTick: 6, // deploy.started; lands 2 ticks later
  },
  meta: {
    solutions: [['flag.set:new-checkout=off', 'deploy.rollforward:api']],
    traps: ['deploy.rollback:d-201'],
  },
  create(params): TemplateInstance {
    const p = params as {
      baseRps: number;
      baseErrRate: number;
      baseP95: number;
      valuePerReq: number;
      deployAtTick: number;
    };
    let phase: Phase = 'pre';
    let deployStartSeq: number | undefined;
    let deployFinishSeq: number | undefined;
    let mitigationSeq: number | undefined; // flag-off action seq
    let mitigationTick: number | undefined;
    let rollforwardSeq: number | undefined;
    let rollforwardTick: number | undefined;
    let clueCursor = 0;

    const emitTraffic = (ctx: SimCtx): void => {
      // per-route error model: the trap concentrates damage on /checkout
      let checkoutErr: number;
      let browseErr: number;
      let rpsBase = p.baseRps;
      let p95Base = p.baseP95;
      switch (phase) {
        case 'incident':
          checkoutErr = jitter(ctx.rng, 0.22, 0.15);
          browseErr = jitter(ctx.rng, p.baseErrRate, 0.4);
          p95Base = p.baseP95 * 2.1;
          break;
        case 'mitigated':
          checkoutErr = jitter(ctx.rng, p.baseErrRate * 2, 0.4);
          browseErr = jitter(ctx.rng, p.baseErrRate, 0.4);
          p95Base = p.baseP95 * 1.2;
          break;
        case 'catastrophic':
          checkoutErr = jitter(ctx.rng, 0.7, 0.1);
          browseErr = jitter(ctx.rng, 0.6, 0.1);
          rpsBase = p.baseRps * 0.6; // users bounce
          p95Base = p.baseP95 * 5;
          break;
        default:
          checkoutErr = jitter(ctx.rng, p.baseErrRate, 0.4);
          browseErr = jitter(ctx.rng, p.baseErrRate * 0.5, 0.4);
      }
      const rps = jitter(ctx.rng, rpsBase, 0.1);
      const errRate = 0.3 * checkoutErr + 0.7 * browseErr;
      ctx.emit('traffic.tick', 'sim', {
        rps: Math.round(rps),
        errRate: Number(errRate.toFixed(4)),
        p95: Math.round(jitter(ctx.rng, p95Base, 0.15)),
        byRoute: {
          '/checkout': { rps: Math.round(rps * 0.3), errRate: Number(checkoutErr.toFixed(4)) },
          '/browse': { rps: Math.round(rps * 0.7), errRate: Number(browseErr.toFixed(4)) },
        },
      });

      if (errRate > 0.01 && deployFinishSeq !== undefined) {
        ctx.emit(
          'user.impact',
          'sim',
          {
            usersErrored: Math.round(rps * errRate),
            ticketsOpened: pickInt(ctx.rng, phase === 'catastrophic' ? 2 : 0, phase === 'catastrophic' ? 6 : 2),
            revenueLostFormula: {
              rps: Math.round(rps),
              errRate: Number(errRate.toFixed(4)),
              valuePerReq: p.valuePerReq,
            },
          },
          deployFinishSeq
        );
      }
    };

    return {
      setup(ctx) {
        ctx.emit('service.health', 'sim', {
          service: 'web', status: 'ok', name: 'storefront-web', deps: ['api'], version: '3.1.0',
        });
        ctx.emit('service.health', 'sim', {
          service: 'api', status: 'ok', name: 'orders-api', deps: ['db'], version: '1.9.3',
        });
        ctx.emit('service.health', 'sim', {
          service: 'db', status: 'ok', name: 'orders-db', deps: [], version: '15.4',
        });
        // deploy history backstory: rollback has somewhere to land
        ctx.emit('deploy.finished', 'sim', {
          id: 'd-200',
          service: 'api',
          version: '1.9.3',
          author: 'mira@sim',
          changedAreas: ['browse'],
          containsMigration: false,
          flagsTouched: [],
          diffstat: { files: 2, plus: 18, minus: 6 },
          note: 'browse: cache headers tune',
        });
        ctx.emit('action.executed', 'sim', {
          tool: 'flag.set',
          input: { id: 'new-checkout', state: 'off', name: 'new-checkout' },
          result: { ok: true },
        });
        ctx.emit('action.executed', 'sim', {
          tool: 'route.set',
          input: { id: 'checkout', path: '/checkout', target: 'api', tier: 'route' },
          result: { ok: true },
        });
        ctx.emit('action.executed', 'sim', {
          tool: 'env.set',
          input: { key: 'SESSIONS_SCHEMA', value: 'v1-legacy' },
          result: { ok: true },
        });
      },

      tick(ctx) {
        emitTraffic(ctx);

        if (ctx.tick === p.deployAtTick) {
          deployStartSeq = ctx.emit('deploy.started', 'sim', {
            id: TRAP_DEPLOY.id, service: TRAP_DEPLOY.service, version: TRAP_DEPLOY.version, author: TRAP_DEPLOY.author,
          }).seq;
        }

        if (ctx.tick === p.deployAtTick + 2 && deployStartSeq !== undefined) {
          deployFinishSeq = ctx.emit('deploy.finished', 'sim', { ...TRAP_DEPLOY }, deployStartSeq).seq;
          ctx.emit('migration.applied', 'sim', {
            id: 'mig-77', appliedByDeploy: 'd-201', reversible: false,
            rowsMigrated: 41208,
            // The agent-visible form of "irreversible". Stated as a
            // compatibility table (industry guidance: a rollback is unsafe
            // while in-traffic old code cannot read what new code has
            // written), NOT as a boolean the caller can branch on.
            note: 'sessions rows are written in v2 layout since this landed; api 1.9.x reads v1 layout only',
          }, deployFinishSeq);
          // the deploy turns the flag on (flagsTouched materializes it on; make it explicit)
          ctx.emit('action.executed', 'sim', {
            tool: 'flag.set', input: { id: 'new-checkout', state: 'on' }, result: { ok: true },
          }, deployFinishSeq);
          ctx.emit('action.executed', 'sim', {
            tool: 'env.set', input: { key: 'SESSIONS_SCHEMA', value: 'v2' }, result: { ok: true },
          }, deployFinishSeq);
          phase = 'incident';
          ctx.emit('service.health', 'sim', {
            service: 'api', status: 'degraded', reason: 'checkout error rate above SLO after d-201',
          }, deployFinishSeq);
        }

        // drip diagnostic clues while the incident is live
        if (phase === 'incident' && clueCursor < CLUE_LINES.length && ctx.rng() < 0.6) {
          ctx.emit('log.line', 'sim', { ...CLUE_LINES[clueCursor]! }, deployFinishSeq);
          clueCursor++;
        }

        // mitigation settles two ticks after the flag flips off
        if (phase === 'mitigated' && mitigationTick !== undefined && ctx.tick === mitigationTick + 2) {
          ctx.emit('service.health', 'sim', {
            service: 'api', status: 'ok', reason: 'checkout on legacy path; error rate back under SLO',
          }, mitigationSeq);
        }

        // roll-forward heals fully two ticks after d-202 lands
        if (rollforwardTick !== undefined && ctx.tick === rollforwardTick + 2 && phase !== 'resolved') {
          const wasCatastrophic = phase === 'catastrophic';
          phase = 'resolved';
          ctx.emit('service.health', 'sim', {
            service: 'api', status: 'ok', reason: 'v2.0.1 serving: legacy-session fallback shipped',
          }, rollforwardSeq);
          if (wasCatastrophic) {
            ctx.emit('service.health', 'sim', {
              service: 'web', status: 'ok', reason: 'upstream api recovered',
            }, rollforwardSeq);
          }
        }
      },

      onAction(ctx, event: Event) {
        const { tool, input } = event.data as { tool: string; input: Record<string, unknown> };

        if (tool === 'flag.set' && input.id === 'new-checkout') {
          if (input.state === 'off' && phase === 'incident') {
            phase = 'mitigated';
            mitigationSeq = event.seq;
            mitigationTick = ctx.tick;
            ctx.emit('log.line', 'sim', {
              service: 'api', level: 'info', msg: 'checkout traffic back on legacy path (new-checkout=off)',
            }, event.seq);
          } else if (input.state === 'on' && phase === 'mitigated') {
            phase = 'incident'; // re-enabling the broken path reopens the incident
            mitigationTick = undefined;
            ctx.emit('service.health', 'sim', {
              service: 'api', status: 'degraded', reason: 'checkout error rate above SLO (new-checkout re-enabled)',
            }, event.seq);
          }
        }

        // the world (reducer) is the authority on whether the rollback
        // applied — a rejected rollback (e.g. d-201 already superseded by a
        // roll-forward) must not fire the trap
        if (tool === 'deploy.rollback' && input.deployId === 'd-201' &&
            (phase === 'incident' || phase === 'mitigated') &&
            ctx.world.deploys.find((d) => d.id === 'd-201')?.status === 'rolled_back') {
          // THE TRAP: v1 code against the migrated (irreversible) schema
          phase = 'catastrophic';
          ctx.emit('service.health', 'sim', {
            service: 'api', status: 'down', reason: 'crashloop: sessions table is v2, api 1.9.3 expects v1',
          }, event.seq);
          ctx.emit('service.health', 'sim', {
            service: 'web', status: 'degraded', reason: 'upstream orders-api down',
          }, event.seq);
          ctx.emit('log.line', 'sim', {
            service: 'api', level: 'error', msg: 'FATAL SchemaMismatch: mig-77 is irreversible; rollback cannot restore v1 schema',
          }, event.seq);
        }

        if (tool === 'deploy.rollforward' && input.service === 'api' &&
            rollforwardSeq === undefined && // latch: a double act ships one d-202, not two
            (phase === 'incident' || phase === 'mitigated' || phase === 'catastrophic')) {
          const startSeq = ctx.emit('deploy.started', 'sim', {
            id: 'd-202', service: 'api', version: '2.0.1', author: 'priya@sim',
          }, event.seq).seq;
          ctx.emit('deploy.finished', 'sim', {
            id: 'd-202',
            service: 'api',
            version: '2.0.1',
            author: 'priya@sim',
            changedAreas: ['checkout', 'sessions'],
            containsMigration: false,
            flagsTouched: [],
            diffstat: { files: 3, plus: 57, minus: 9 },
            note: 'hotfix: legacy-session fallback for v2 schema readers',
          }, startSeq);
          rollforwardSeq = event.seq;
          rollforwardTick = ctx.tick;
        }
      },
    };
  },
};
