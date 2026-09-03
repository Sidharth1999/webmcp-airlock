import type { SimCtx } from './engine';
import { innocentDeploy } from './innocent-deploy';
import { migrationTrap } from './migration-trap';
import { poisonedRunbook } from './poisoned-runbook';
import { retryStorm } from './retry-storm';
import { jitter, pickInt } from './rng';
import type { ActionOutcome, Deploy, Event } from './types';

export interface TemplateInstance {
  setup(ctx: SimCtx): void;
  tick(ctx: SimCtx): void;
  /** React to an external action.executed (already folded into world). */
  onAction?(ctx: SimCtx, event: Event): void;
  /**
   * What an external action WOULD do, judged against the world BEFORE it is
   * applied — so the outcome can ride the action.executed event itself.
   * Return undefined to let the engine derive a generic outcome from the
   * world diff and whatever onAction emitted. Must agree with onAction: an
   * `effect: 'none'` here tells the reducer to leave the world alone.
   */
  outcome?(ctx: SimCtx, tool: string, input: Record<string, unknown>): ActionOutcome | undefined;
}

export interface TemplateMeta {
  solutions: string[][];
  traps: string[];
  /**
   * ORDERED sequences that are worse than doing nothing BECAUSE of their
   * order — the same levers a solution uses, run in the wrong sequence, or a
   * harmless-looking action that disarms a guardrail in front of a real one.
   *
   * Separate from `traps` on purpose: a trap is a key that must never be
   * executed, and metrics keys `correctPath` off that. An ordering violation
   * cannot be expressed that way, because the actions in it are the CORRECT
   * actions. The compiler probes these as scripted sequences and requires
   * each to be catastrophic or measurably worse than both doing nothing and
   * doing the same work in the right order.
   */
  orderTraps?: string[][];
  /**
   * THE FULL ORDERED RESPONSE — what a competent on-call engineer actually
   * does, not the minimum set of levers that ends the incident.
   *
   * Separate from `solutions` because it answers a different question.
   * `solutions` is the answer key: the smallest correct path, and what
   * `correctPath` is scored against. `orchestration` is the claim that this
   * console has a SEQUENCE worth an agent at all — and the compiler proves
   * it the hard way, by running the sequence with each step LEFT OUT in turn
   * and requiring every omission to cost something (fail to resolve, burn
   * more revenue, or leave more customers filing tickets).
   *
   * That omission probe is the whole point. Without it a longer answer key is
   * just decoration, which is exactly what nine of the twenty verbs were.
   */
  orchestration?: string[];
}

export interface TemplateFactory {
  id: string;
  defaultParams: Record<string, unknown>;
  /**
   * Declared answer key (schema v1 correctPath metric): each entry in
   * `solutions` is an ordered action sequence (`tool:key=value` strings) that
   * resolves the scenario; `traps` are actions that make it worse.
   *
   * May be a FUNCTION of the merged params. That is what lets a twin pair
   * share an identical observable narrative while carrying opposite answers
   * — the property that defeats any fixed symptom -> action policy.
   */
  meta?: TemplateMeta | ((params: Record<string, unknown>) => TemplateMeta);
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
  [innocentDeploy.id]: innocentDeploy,
  [poisonedRunbook.id]: poisonedRunbook,
  [retryStorm.id]: retryStorm,
};

/** Answer key for a template at a given (already merged) param set. */
export function resolveMeta(
  factory: TemplateFactory,
  params: Record<string, unknown>
): TemplateMeta | undefined {
  return typeof factory.meta === 'function' ? factory.meta(params) : factory.meta;
}

/** Answer key for a template id at the given param overrides (defaults merged). */
export function metaFor(
  templateId: string,
  params: Record<string, unknown> = {}
): TemplateMeta | undefined {
  const f = getTemplate(templateId);
  return resolveMeta(f, { ...f.defaultParams, ...params });
}

export function templateIds(): string[] {
  return Object.keys(registry);
}

export function getTemplate(id: string): TemplateFactory {
  const t = registry[id];
  if (!t) throw new Error(`unknown template: ${id}`);
  return t;
}
