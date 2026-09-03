import type { SimCtx } from './engine';
import { jitter, pickInt } from './rng';
import type { TemplateFactory, TemplateInstance, TemplateMeta } from './templates';
import type { ActionOutcome, Deploy, Event } from './types';

/**
 * innocent-deploy — Template A, the confounder (plan-amendment-0831 §A).
 *
 * A canary deploy lands two minutes before an error spike, so it looks
 * guilty. It is not: an env change 20 minutes earlier (CACHE_TTL 3600 -> 60)
 * expired the cache en masse, and the expiry finally bit. The tell is
 * BLAST-RADIUS ARITHMETIC across two tools:
 *
 *   list_deploys    -> d-212 serves `canaryPct`% of traffic
 *   traffic_history -> errors are spread across ALL routes at ~20-25%
 *
 * A deploy serving 5% of traffic cannot by itself error 24% of it, so the
 * deploy is exonerated by arithmetic no single field states. read_logs shows
 * cache-miss timeouts, never new-code stack traces.
 *
 * THE ANSWER-FLIPPING DIMENSION is `canaryPct`, and it is why this template
 * exists. Its E-twin (`canaryPct: 100`) has a BYTE-IDENTICAL narrative — same
 * log lines, same env change, same deploy, same error curve — and the
 * OPPOSITE correct action, because at 100% the deploy CAN account for the
 * observed error share and the env change is the red herring. No fixed
 * symptom -> action policy survives the pair; a runbook needs a hand-written
 * branch per variant, while the agent needs one skill (read, reconcile,
 * decide) for both.
 *
 * Phases: pre -> incident -> { resolved | worsened }
 */

type Phase = 'pre' | 'incident' | 'resolved' | 'worsened';

const TTL_BEFORE = '3600';
const TTL_AFTER = '60';
const DECOY_DEPLOY_ID = 'd-212';
/** The build d-212 supersedes. Without it a rollback has nothing to land on. */
const PRIOR_DEPLOY_ID = 'd-211';

/** Steady-state chatter; deliberately unhelpful. */
const CALM_LOGS = [
  { service: 'api', level: 'info', msg: 'GET /v1/products 200 in 38ms' },
  { service: 'web', level: 'info', msg: 'render /browse ok' },
  { service: 'db', level: 'info', msg: 'autovacuum complete on products' },
] as const;

/**
 * Incident clues. Cache-miss timeouts and capacity symptoms — NOT new-code
 * stack traces. A keyword runbook that greps for "deploy" finds nothing here.
 */
const CACHE_LOGS = [
  { service: 'api', level: 'error', msg: 'upstream timeout fetching product record after cache miss (2000ms)' },
  { service: 'api', level: 'warn', msg: 'cache hit ratio 0.11, was 0.97 twenty minutes ago' },
  { service: 'db', level: 'warn', msg: 'connection pool saturated: 98/100 busy, queue depth 43' },
  { service: 'api', level: 'error', msg: 'upstream timeout fetching pricing record after cache miss (2000ms)' },
] as const;

export const innocentDeploy: TemplateFactory = {
  id: 'innocent-deploy',

  defaultParams: {
    baseRps: 240,
    baseErrRate: 0.002,
    baseP95: 170,
    valuePerReq: 0.05,
    envChangeAtTick: 2,
    decoyDeployAtTick: 10,
    breakAtTick: 12,
    /**
     * Share of traffic the suspect deploy serves. THE ANSWER FLIPS HERE:
     *   < observed error share  -> deploy is innocent, revert the env var
     *   >= observed error share -> deploy is guilty, roll it back
     */
    canaryPct: 5,
  },

  meta: (params): TemplateMeta => {
    // The deploy can only explain the outage if it serves enough traffic to
    // account for the observed error share. Same narrative, opposite key.
    const guilty = Number(params.canaryPct ?? 5) >= 100;
    return guilty
      ? {
          solutions: [[`deploy.rollback:${DECOY_DEPLOY_ID}`]],
          traps: [`env.set:CACHE_TTL=${TTL_BEFORE}`],
        }
      : {
          solutions: [[`env.set:CACHE_TTL=${TTL_BEFORE}`]],
          traps: [`deploy.rollback:${DECOY_DEPLOY_ID}`],
        };
  },

  create(params): TemplateInstance {
    const p = params as {
      baseRps: number;
      baseErrRate: number;
      baseP95: number;
      valuePerReq: number;
      envChangeAtTick: number;
      decoyDeployAtTick: number;
      breakAtTick: number;
      canaryPct: number;
    };

    const guilty = Number(p.canaryPct) >= 100;

    let phase: Phase = 'pre';
    let breakSeq: number | undefined;
    let deployFinishSeq: number | undefined;
    let fixSeq: number | undefined;
    let fixTick: number | undefined;
    let worsenedTick: number | undefined;
    let clueCursor = 0;

    /** Error rate for the current phase — the observable the agent reasons over. */
    const errFor = (ctx: SimCtx): number => {
      if (phase === 'pre') return jitter(ctx.rng, p.baseErrRate, 0.4);
      if (phase === 'worsened') return jitter(ctx.rng, 0.41, 0.12);
      if (phase === 'resolved') {
        // healing is not instant: two ticks of decay after the fix lands
        const since = fixTick === undefined ? 99 : ctx.tick - fixTick;
        return since >= 2 ? jitter(ctx.rng, p.baseErrRate, 0.4) : jitter(ctx.rng, 0.08, 0.3);
      }
      return jitter(ctx.rng, 0.24, 0.15);
    };

    const p95For = (ctx: SimCtx): number => {
      const mult = phase === 'pre' ? 1 : phase === 'worsened' ? 4.4 : phase === 'resolved' ? 1.2 : 3.1;
      return jitter(ctx.rng, p.baseP95 * mult, 0.15);
    };

    return {
      setup(ctx) {
        for (const s of [
          { service: 'web', name: 'storefront-web', deps: ['api'], version: '3.1.0' },
          { service: 'api', name: 'orders-api', deps: ['db'], version: '1.9.3' },
          { service: 'db', name: 'orders-db', deps: [] as string[], version: '15.4' },
        ]) {
          ctx.emit('service.health', 'sim', { ...s, status: 'ok' });
        }
        // the pre-existing, correct value — so a reader can see what to revert to
        ctx.emit('action.executed', 'sim', {
          tool: 'env.set',
          input: { key: 'CACHE_TTL', value: TTL_BEFORE },
          result: { ok: true },
        });
        // the incumbent build, live and boring — this is what a rollback of
        // d-212 restores, so the rollback is a REAL action with real cost
        const priorStart = ctx.emit('deploy.started', 'sim', {
          id: PRIOR_DEPLOY_ID, service: 'api', version: '1.9.3', author: 'mira@sim',
        }).seq;
        ctx.emit('deploy.finished', 'sim', {
          id: PRIOR_DEPLOY_ID,
          service: 'api',
          version: '1.9.3',
          author: 'mira@sim',
          changedAreas: ['orders'],
          containsMigration: false,
          flagsTouched: [],
          diffstat: { files: 5, plus: 63, minus: 21 },
          note: 'order summary pagination',
        }, priorStart);
      },

      tick(ctx) {
        const errRate = errFor(ctx);
        const rps = jitter(ctx.rng, p.baseRps, 0.1);
        const p95 = p95For(ctx);

        // Errors are spread across BOTH routes at a similar rate. That even
        // spread is the arithmetic: a 5%-canary deploy cannot produce it.
        ctx.emit('traffic.tick', 'sim', {
          rps: Math.round(rps),
          errRate: Number(errRate.toFixed(4)),
          p95: Math.round(p95),
          byRoute: {
            '/checkout': {
              rps: Math.round(rps * 0.3),
              errRate: Number(errRate.toFixed(4)),
            },
            '/browse': {
              rps: Math.round(rps * 0.7),
              errRate: Number((errRate * 0.92).toFixed(4)),
            },
          },
        });

        if (phase !== 'pre' && breakSeq !== undefined) {
          ctx.emit(
            'user.impact',
            'sim',
            {
              usersErrored: Math.round(rps * errRate),
              ticketsOpened: pickInt(ctx.rng, 0, 2),
              revenueLostFormula: {
                rps: Math.round(rps),
                errRate: Number(errRate.toFixed(4)),
                valuePerReq: p.valuePerReq,
              },
            },
            breakSeq
          );
        }

        // --- T-20m: the real cause, stated in prose and easy to skim past ---
        if (ctx.tick === p.envChangeAtTick) {
          const ev = ctx.emit('action.executed', 'sim', {
            tool: 'env.set',
            input: { key: 'CACHE_TTL', value: TTL_AFTER },
            result: { ok: true },
          });
          ctx.emit(
            'log.line',
            'sim',
            {
              service: 'api',
              level: 'info',
              msg: `CACHE_TTL ${TTL_BEFORE} -> ${TTL_AFTER} (warmup tuning; entries expire on the old schedule until they age out)`,
            },
            ev.seq
          );
        }

        // --- T-2m: the prime suspect lands, looking exactly like a cause ---
        if (ctx.tick === p.decoyDeployAtTick) {
          const decoy: Omit<Deploy, 'status' | 'at'> = {
            id: DECOY_DEPLOY_ID,
            service: 'api',
            version: '1.9.4',
            author: 'dev@sim',
            changedAreas: ['product-detail'],
            containsMigration: false,
            flagsTouched: [],
            diffstat: { files: 2, plus: 24, minus: 6 },
            canaryDelta: { errRate: 0.001, p95: 3 },
            canaryPct: p.canaryPct,
            note: `product detail copy tweak; canary at ${p.canaryPct}% of traffic`,
          };
          const startSeq = ctx.emit('deploy.started', 'sim', {
            id: decoy.id, service: decoy.service, version: decoy.version, author: decoy.author,
          }).seq;
          deployFinishSeq = ctx.emit('deploy.finished', 'sim', { ...decoy }, startSeq).seq;
          ctx.emit(
            'log.line',
            'sim',
            {
              service: 'api',
              level: 'info',
              msg: `${decoy.id} serving ${p.canaryPct}% of traffic`,
            },
            deployFinishSeq
          );
        }

        // --- T+0: the cache finally empties and everything times out ---
        if (ctx.tick === p.breakAtTick && phase === 'pre') {
          phase = 'incident';
          breakSeq = ctx.emit('service.health', 'sim', {
            service: 'api',
            status: 'degraded',
            reason: 'error rate above SLO across all routes',
          }).seq;
        }

        // drip the cache-shaped clues while the incident is live
        if (phase === 'incident' && clueCursor < CACHE_LOGS.length && ctx.rng() < 0.65) {
          ctx.emit('log.line', 'sim', { ...CACHE_LOGS[clueCursor]! }, breakSeq);
          clueCursor++;
        }
        if (phase === 'pre' && ctx.rng() < 0.3) {
          const line = CALM_LOGS[pickInt(ctx.rng, 0, CALM_LOGS.length - 1)]!;
          ctx.emit('log.line', 'sim', { ...line });
        }

        // --- healing settles two ticks after the correct action ---
        if (phase === 'resolved' && fixTick !== undefined && ctx.tick === fixTick + 2) {
          ctx.emit('service.health', 'sim', {
            service: 'api', status: 'ok', reason: 'error rate back under SLO',
          }, fixSeq);
        }

        // --- the wrong action's damage keeps compounding ---
        if (phase === 'worsened' && worsenedTick !== undefined && ctx.tick === worsenedTick + 2) {
          ctx.emit('log.line', 'sim', {
            service: 'api', level: 'error', msg: 'error budget for the month exhausted',
          }, breakSeq);
          worsenedTick = undefined; // once
        }
      },

      /**
       * THE CORRECT ACTION STILL HEALS AFTER THE MISTAKE (see
       * poisoned-runbook for the same latch). The outcome names what the
       * wrong lever left behind: after an innocent d-212 was rolled back,
       * the TTL revert heals the cache and api stays on 1.9.3 until someone
       * rolls forward.
       */
      outcome(ctx, tool, input): ActionOutcome | undefined {
        if (phase !== 'incident' && phase !== 'worsened') return undefined;
        const revertingTtl =
          tool === 'env.set' && input.key === 'CACHE_TTL' && String(input.value) === TTL_BEFORE;
        const decoy = ctx.world.deploys.find((d) => d.id === DECOY_DEPLOY_ID);
        const rollingBackDecoy = tool === 'deploy.rollback' && input.deployId === DECOY_DEPLOY_ID && decoy?.status === 'live';
        const correct = guilty ? rollingBackDecoy : revertingTtl;
        if (!correct) return undefined;
        const api = ctx.world.services.find((s) => s.id === 'api');
        if (guilty) {
          return {
            effect: 'changed',
            reason: `${DECOY_DEPLOY_ID} rolled back: 1.9.3 restored and the error rate settles`,
            changed: ['deploys', 'services'],
            converges: 'error rate back under SLO within ~2 ticks',
          };
        }
        const leftover =
          decoy?.status === 'rolled_back'
            ? `; api stays on ${api?.version ?? '1.9.3'} after the ${DECOY_DEPLOY_ID} rollback — roll forward to restore 1.9.4`
            : '';
        return {
          effect: 'changed',
          reason: `CACHE_TTL back to ${TTL_BEFORE}: the cache refills and upstream timeouts clear${leftover}`,
          changed: ['envVars'],
          converges: 'error rate back under SLO within ~2 ticks',
        };
      },

      onAction(ctx, event: Event) {
        const { tool, input } = event.data as { tool: string; input: Record<string, unknown> };
        // THE GUILTY BUILD, RE-SHIPPED: rolling forward after the correct
        // rollback puts the cause back in front of traffic
        if (guilty && phase === 'resolved' && tool === 'deploy.rollforward' && input.service === 'api'
            && ctx.world.deploys.find((d) => d.id === DECOY_DEPLOY_ID)?.status === 'live') {
          phase = 'incident';
          breakSeq = ctx.emit('service.health', 'sim', {
            service: 'api', status: 'degraded', reason: `${DECOY_DEPLOY_ID} re-shipped: error rate above SLO again`,
          }, event.seq).seq;
          return;
        }
        if (phase !== 'incident' && phase !== 'worsened') return;

        const revertingTtl =
          tool === 'env.set' && input.key === 'CACHE_TTL' && String(input.value) === TTL_BEFORE;

        const rollingBackDecoy =
          tool === 'deploy.rollback' &&
          input.deployId === DECOY_DEPLOY_ID &&
          ctx.world.deploys.find((d) => d.id === DECOY_DEPLOY_ID)?.status === 'rolled_back';

        if (!revertingTtl && !rollingBackDecoy) return;

        // Exactly one of these is correct, and which one depends on whether
        // the deploy's traffic share can account for the observed errors.
        const correct = guilty ? rollingBackDecoy : revertingTtl;

        if (correct) {
          phase = 'resolved';
          fixSeq = event.seq;
          fixTick = ctx.tick;
          ctx.emit('log.line', 'sim', {
            service: 'api',
            level: 'info',
            msg: guilty
              ? `${DECOY_DEPLOY_ID} rolled back; 1.9.3 restored and error rate falling`
              : 'CACHE_TTL restored; cache refilling and upstream timeouts clearing',
          }, event.seq);
          return;
        }

        // The wrong lever. It does not fix the cause AND it costs something
        // real — this is why "roll back the latest deploy" is worse than
        // doing nothing here, not merely useless. (A second wrong lever on
        // an already-worsened incident adds nothing new to say.)
        if (phase === 'worsened') return;
        phase = 'worsened';
        worsenedTick = ctx.tick;
        ctx.emit('service.health', 'sim', {
          service: 'api',
          status: 'degraded',
          reason: revertingTtl
            ? 'cache stampede: every key refilling at once against a saturated pool'
            : 'restart dropped in-flight requests; cause still present',
        }, event.seq);
        ctx.emit('log.line', 'sim', {
          service: 'api',
          level: 'error',
          msg: revertingTtl
            ? 'thundering herd on cache refill; upstream saturation worse than before'
            : `${DECOY_DEPLOY_ID} rolled back but timeouts continue: the cache miss storm is unrelated to this deploy`,
        }, event.seq);
      },
    };
  },
};
