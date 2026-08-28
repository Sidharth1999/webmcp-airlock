import type { SimCtx } from './engine';
import { migrationTrap } from './migration-trap';
import { jitter, pickInt } from './rng';
import type { Deploy, Event } from './types';

export interface TemplateInstance {
  setup(ctx: SimCtx): void;
  tick(ctx: SimCtx): void;
  /** React to an external action.executed (already folded into world). */
  onAction?(ctx: SimCtx, event: Event): void;
}

export interface TemplateFactory {
  id: string;
  defaultParams: Record<string, unknown>;
  /**
   * Declared answer key (schema v1 correctPath metric): each entry in
   * `solutions` is an ordered action sequence (`tool:key=value` strings) that
   * resolves the scenario; `traps` are actions that make it worse.
   */
  meta?: { solutions: string[][]; traps: string[] };
  create(params: Record<string, unknown>): TemplateInstance;
}

const LOG_POOL = [
  { service: 'api', level: 'info', msg: 'GET /v1/orders 200 in 42ms' },
  { service: 'web', level: 'info', msg: 'render /checkout ok' },
  { service: 'api', level: 'debug', msg: 'session-cache hit ratio 0.97' },
  { service: 'db', level: 'info', msg: 'checkpoint complete' },
  { service: 'api', level: 'warn', msg: 'slow query on orders_by_user (312ms)' },
] as const;

/**
 * baseline — benign steady state with one scripted, self-healing deploy blip.
 * Exists so M2-01/02 have a real deterministic stream with causedBy chains
 * (deploy.started → deploy.finished → user.impact / service.health) before
 * the flagship migration-trap template lands in M2-04.
 */
const baseline: TemplateFactory = {
  id: 'baseline',
  defaultParams: {
    baseRps: 220,
    baseErrRate: 0.002,
    baseP95: 180,
    valuePerReq: 0.04,
    deployAtTick: 5,
    incidentTicks: 3, // elevated errors for this many ticks after the deploy lands
  },
  create(params) {
    const p = params as {
      baseRps: number;
      baseErrRate: number;
      baseP95: number;
      valuePerReq: number;
      deployAtTick: number;
      incidentTicks: number;
    };
    let deployStartSeq: number | undefined;
    let deployFinishSeq: number | undefined;
    let deployLandedTick: number | undefined;

    const inIncident = (tick: number): boolean =>
      deployLandedTick !== undefined &&
      tick > deployLandedTick &&
      tick <= deployLandedTick + p.incidentTicks;

    return {
      setup(ctx) {
        ctx.emit('service.health', 'sim', {
          service: 'web',
          status: 'ok',
          name: 'storefront-web',
          deps: ['api'],
          version: '3.1.0',
        });
        ctx.emit('service.health', 'sim', {
          service: 'api',
          status: 'ok',
          name: 'orders-api',
          deps: ['db'],
          version: '1.4.1',
        });
        ctx.emit('service.health', 'sim', {
          service: 'db',
          status: 'ok',
          name: 'orders-db',
          deps: [],
          version: '15.4',
        });
      },

      tick(ctx) {
        const incident = inIncident(ctx.tick);
        const errRate = incident
          ? jitter(ctx.rng, 0.06, 0.2)
          : jitter(ctx.rng, p.baseErrRate, 0.4);
        const rps = jitter(ctx.rng, p.baseRps, 0.1);
        const p95 = jitter(ctx.rng, incident ? p.baseP95 * 2.2 : p.baseP95, 0.15);
        const trafficEv = ctx.emit('traffic.tick', 'sim', {
          rps: Math.round(rps),
          errRate: Number(errRate.toFixed(4)),
          p95: Math.round(p95),
          byRoute: {
            '/checkout': { rps: Math.round(rps * 0.3), errRate: Number(errRate.toFixed(4)) },
            '/browse': { rps: Math.round(rps * 0.7), errRate: Number((errRate * 0.5).toFixed(4)) },
          },
        });

        if (ctx.rng() < 0.3) {
          const line = LOG_POOL[pickInt(ctx.rng, 0, LOG_POOL.length - 1)]!;
          ctx.emit('log.line', 'sim', { ...line });
        }

        if (ctx.tick === p.deployAtTick) {
          deployStartSeq = ctx.emit('deploy.started', 'sim', {
            id: 'd-101',
            service: 'api',
            version: '1.4.2',
            author: 'mira@sim',
          }).seq;
        }

        if (ctx.tick === p.deployAtTick + 2 && deployStartSeq !== undefined) {
          const deploy: Omit<Deploy, 'status' | 'at'> = {
            id: 'd-101',
            service: 'api',
            version: '1.4.2',
            author: 'mira@sim',
            changedAreas: ['session-cache'],
            containsMigration: false,
            flagsTouched: [],
            diffstat: { files: 3, plus: 41, minus: 12 },
            canaryDelta: { errRate: 0.001, p95: 4 },
            note: 'bump session-cache TTL; drop legacy warmup path',
          };
          deployFinishSeq = ctx.emit('deploy.finished', 'sim', { ...deploy }, deployStartSeq).seq;
          deployLandedTick = ctx.tick;
          ctx.emit(
            'service.health',
            'sim',
            { service: 'api', status: 'degraded', reason: 'error rate above SLO after d-101' },
            deployFinishSeq
          );
        }

        if (incident && deployFinishSeq !== undefined) {
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
            deployFinishSeq
          );
        }

        if (
          deployLandedTick !== undefined &&
          ctx.tick === deployLandedTick + p.incidentTicks + 1 &&
          deployFinishSeq !== undefined
        ) {
          ctx.emit(
            'service.health',
            'sim',
            { service: 'api', status: 'ok', reason: 'error rate back under SLO' },
            deployFinishSeq
          );
        }
      },
    };
  },
};

const registry: Record<string, TemplateFactory> = {
  [baseline.id]: baseline,
  [migrationTrap.id]: migrationTrap,
};

export function getTemplate(id: string): TemplateFactory {
  const t = registry[id];
  if (!t) throw new Error(`unknown template: ${id}`);
  return t;
}
