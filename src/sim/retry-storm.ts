import type { SimCtx } from './engine';
import { jitter, pickInt } from './rng';
import type { TemplateFactory, TemplateInstance } from './templates';
import type { ActionOutcome, Deploy, Event, ServiceCapacity } from './types';

/**
 * retry-storm — Template F, the ORDERING scenario (2026-09-01).
 *
 * WHY THIS TEMPLATE EXISTS. Every earlier family asks "which lever?" and is
 * answered by one action. `vocabulary.ts` registers 20 levers and the answer
 * keys used four, so the corpus measured discrimination and never measured
 * SEQUENCE — which is where a console with consequential controls earns an
 * agent at all. Here the levers are individually obvious and the ORDER is the
 * whole difficulty: the same two actions resolve the incident or take the
 * service down depending on which one goes first.
 *
 * THE MESS (metastable failure — docs/sre-mess-research.md, and the standard
 * pattern: Bronson et al., "Metastable Failures in Distributed Systems"):
 * d-511 shipped a checkout client whose retry policy went 2 -> 6 attempts
 * with no jitter and no budget. A brief db lock contention at T+0 pushed
 * enough requests past their deadline that clients began retrying; the
 * retries alone now keep the pool saturated. THE TRIGGER IS ALREADY GONE and
 * the outage sustains itself on its own feedback loop. Doing nothing never
 * recovers.
 *
 * THE CORRECT PATH IS AN ORDER, NOT A LEVER:
 *   1. ratelimit.set on /checkout  — shed load, buy headroom. Rejects real
 *      customers (its stated cost) and fixes nothing.
 *   2. deploy.rollforward api      — ship 2.4.2, whose retry policy is sane.
 *      (deploy.rollback:d-511 is an equally correct fix: it also removes the
 *      amplifier. Both are deploy operations and both need the headroom.)
 *
 * WRONG ORDER IS WORSE THAN DOING NOTHING, and honestly so: the fleet is at
 * its autoscaler ceiling with zero spare capacity, so a rolling replacement
 * withdraws instances the incident cannot spare. The platform guardrail
 * (ROLLOUT_AUTO_ABORT, visible in list_changes) halts the rollout partway —
 * leaving a mixed fleet with LESS capacity than before and the amplifier
 * still serving.
 *
 * AND THE GUARDRAIL CAN BE DISARMED. `alerts.silence` is not harmful on its
 * own — that is exactly why it is dangerous. It disarms the automated abort
 * that keys on alerting, so silence-then-ship replaces healthy instances
 * under saturation with nothing watching, and api goes DOWN. The cost of
 * silencing is conditional on what you do next, which is the kind of thing a
 * static runbook cannot encode.
 *
 * Diagnosable from the six reads, no privileged field:
 *   traffic_history — offered rps on /checkout is ~4x its organic share while
 *                     browse is flat: the load is retries, not customers
 *   read_logs       — pool 100/100 with a 4k queue; "lock contention cleared"
 *                     (the trigger is gone); "6/6 instances, no spare
 *                     capacity"; 2.4.2 staged and green
 *   list_deploys    — d-511 changed the http-client retry policy, in prose
 *   list_changes    — ROLLOUT_AUTO_ABORT=on_alert, and the route to cap
 */

const CAUSE_DEPLOY_ID = 'd-511';
/** The build d-511 supersedes — a rollback needs somewhere to land. */
const PRIOR_DEPLOY_ID = 'd-510';
const FIX_DEPLOY_ID = 'd-512';
/**
 * ANOTHER TEAM'S DEPLOY. A real incident does not happen on a quiet estate:
 * other teams keep shipping unless somebody stops them, which is the entire
 * reason `deploy.freeze` exists as a lever. It is announced in the log the
 * moment the storm opens — a queued deploy is a fact an on-call engineer can
 * read, not a gotcha — and it lands into the saturated pool, wedging the
 * fleet exactly as the operator's own unshed rollout would.
 */
const INTERFERING_DEPLOY_ID = 'd-513';
const STORM_ROUTE = 'r-checkout';

/**
 * The ceiling for a cap that actually creates headroom. The console's own
 * route control offers "Cap at 100 req/s", and the answer key is written as
 * the CONSTRAINT (`<=150`) rather than that literal, because any cap under
 * the ceiling is the same decision — measured the hard way: a live run that
 * shed at 70 and then shipped scored correctPath=false against a literal key.
 */
const SHED_CEILING = 150;

/** The api fleet: at its autoscaler ceiling, with nothing left to add. */
const FLEET_FULL: ServiceCapacity = { instances: 6, ceiling: 6, headroom: 0 };
/** After a halted rollout: two instances withdrawn, and they do not come back. */
const FLEET_WEDGED: ServiceCapacity = { instances: 4, ceiling: 6, headroom: 0 };
/**
 * THE WAY OUT OF A WEDGE. Four instances cannot spare one while the offered
 * load is 4x organic; once /checkout is capped at or under the shed ceiling
 * they can — the admitted load fits on three, so one can be replaced. This
 * is what makes the halted state recoverable rather than terminal: the real
 * ChatGPT run capped after its halted ship and was refused forever.
 */
const FLEET_WEDGED_SHED: ServiceCapacity = { instances: 4, ceiling: 6, headroom: 1 };
const WAY_OUT = 'cap /checkout to ≤150 req/s, then roll again';

/** Steady state before the storm. Deliberately unhelpful. */
const CALM_LOGS = [
  { service: 'api', level: 'info', msg: 'POST /v1/orders 201 in 61ms' },
  { service: 'web', level: 'info', msg: 'render /checkout ok' },
  { service: 'db', level: 'info', msg: 'checkpoint complete' },
] as const;

/**
 * The diagnostic set. Every fact needed to work out both the cause and the
 * ORDER is here; none of them states the answer.
 */
const STORM_LOGS = [
  {
    service: 'api',
    level: 'error',
    msg: 'checkout POST /v1/orders attempt 6/6 abandoned after 5 retries (no jitter)',
  },
  {
    service: 'api',
    level: 'warn',
    msg: 'connection pool 100/100 busy, queue depth 4182, oldest waiter 38s',
  },
  // THE TRIGGER IS GONE. What is left is the loop.
  { service: 'db', level: 'info', msg: 'lock contention on orders cleared; query latency back to 4ms' },
  { service: 'api', level: 'warn', msg: 'offered request rate 4.0x active sessions on /checkout' },
  // There is zero headroom to roll an instance into. Stated as a fact, not
  // as advice — working out what that forbids is the reader's job.
  { service: 'api', level: 'warn', msg: 'autoscaler at ceiling: 6/6 instances live, no spare capacity' },
  {
    service: 'api',
    level: 'info',
    msg: 'build 2.4.2 staged, green in CI: retry attempts 2, full jitter, budget 10%',
  },
] as const;

export const retryStorm: TemplateFactory = {
  id: 'retry-storm',

  defaultParams: {
    baseRps: 260,
    baseErrRate: 0.002,
    baseP95: 165,
    valuePerReq: 0.05,
    /** share of organic traffic on the storm route */
    checkoutShare: 0.35,
    /** retry amplification factor while the loop runs */
    amplification: 4,
    causeDeployAtTick: 3,
    breakAtTick: 12,
    /** when another team's queued deploy lands, unless deploys are frozen */
    /**
     * Ticks AFTER the storm opens, never an absolute tick. Written absolute
     * first, which silently disabled the whole mechanism on every variant
     * whose storm starts later than it (breakAtTick=16 never saw the deploy,
     * so freezing became decoration and the compiler said so).
     */
    interferingDeployAfterTicks: 1,
    /** how long another team's rollout holds capacity before it completes */
    foreignRolloutTicks: 10,
  },

  meta: {
    // Both fixes remove the amplifier; both are deploy operations; both need
    // the headroom first. The lever is not the question — the order is.
    // The cap is stated as the CONSTRAINT that defines the decision, not as
    // one literal number: any cap at or under the ceiling genuinely creates
    // headroom, and a live agent that shed at 70 has made the same call as
    // one that clicked the console's 100 preset.
    solutions: [
      [`ratelimit.set:${STORM_ROUTE}<=${SHED_CEILING}`, 'deploy.rollforward:api'],
      [`ratelimit.set:${STORM_ROUTE}<=${SHED_CEILING}`, `deploy.rollback:${CAUSE_DEPLOY_ID}`],
    ],
    // Single levers that are worse than doing nothing, each for the reason
    // its own cost copy in vocabulary.ts already states.
    traps: [
      `traffic.drain:${STORM_ROUTE}`,
      'cache.flush:api',
      'service.restart:api',
      'db.failover:db',
    ],
    /**
     * THE FULL ORDERED RESPONSE (S6). `solutions` above is the minimum set of
     * levers that ends the incident; this is what an on-call engineer actually
     * does, and every step is load-bearing — the compiler proves it by running
     * this sequence seven more times with one step removed each time and
     * requiring every omission to cost something:
     *
     *   1. acknowledge  — somebody owns it. An org-wide freeze is a commander
     *                     action, so without this step 2 is refused.
     *   2. SEV1         — the status page is keyed to a severity, so without
     *                     this step 4 is refused.
     *   3. freeze       — payments 2.4.1 is queued for api and will roll into
     *                     a fleet with no spare capacity. This is what stops it.
     *   4. tell customers — paid for in support tickets, not revenue.
     *   5. cap /checkout — buy headroom. Rejects real customers; fixes nothing.
     *   6. LIFT the freeze — it stops your own fix too. Skip it and the ship
     *                     in step 7 is blocked and the incident never ends.
     *   7. ship 2.4.2   — the retry policy that removes the amplifier.
     */
    orchestration: [
      'incident.acknowledge:operator',
      'incident.severity:sev1',
      'deploy.freeze:true',
      'statuspage.post:identified',
      `ratelimit.set:${STORM_ROUTE}<=${SHED_CEILING}`,
      'deploy.freeze:false',
      'deploy.rollforward:api',
    ],
    // Sequences. The actions are right; the order is not.
    orderTraps: [
      // ship into zero headroom: the guardrail halts it, capacity drops
      ['deploy.rollforward:api', `ratelimit.set:${STORM_ROUTE}<=${SHED_CEILING}`],
      [`deploy.rollback:${CAUSE_DEPLOY_ID}`, `ratelimit.set:${STORM_ROUTE}<=${SHED_CEILING}`],
      // silence is harmless alone and catastrophic in front of a rollout:
      // it disarms the abort that would otherwise have caught this
      ['alerts.silence:true', 'deploy.rollforward:api'],
    ],
  },

  create(params): TemplateInstance {
    const p = params as {
      baseRps: number;
      baseErrRate: number;
      baseP95: number;
      valuePerReq: number;
      checkoutShare: number;
      amplification: number;
      causeDeployAtTick: number;
      breakAtTick: number;
      interferingDeployAfterTicks: number;
      foreignRolloutTicks: number;
    };

    let storm = false;
    /** an effective admission cap is on the storm route */
    let shed = false;
    /** the amplifying build is no longer serving */
    let fixed = false;
    /** a rollout was halted partway: mixed fleet, capacity below baseline */
    let wedged = false;
    let collapsed = false;
    let drained = false;
    let herd = false;
    /** another team's rollout landed into the saturated pool */
    let interfered = false;
    /** the foreign rollout is cycling instances: capacity dips, then returns */
    let crowded = false;
    let crowdedTick: number | undefined;
    let restartTick: number | undefined;
    let failoverTick: number | undefined;
    let fixTick: number | undefined;
    let deployLatched = false;
    let stormSeq: number | undefined;
    let clueCursor = 0;

    /** Error share on the storm route — every branch is a modelled cause. */
    const checkoutErr = (ctx: SimCtx): number => {
      if (collapsed) return jitter(ctx.rng, 0.97, 0.02);
      if (drained) return 1; // serving nobody: every request fails, by design
      if (!storm) return jitter(ctx.rng, p.baseErrRate, 0.4);
      if (fixed) {
        const since = fixTick === undefined ? 99 : ctx.tick - fixTick;
        return since >= 2 ? jitter(ctx.rng, p.baseErrRate, 0.4) : jitter(ctx.rng, 0.18, 0.2);
      }
      if (failoverTick !== undefined && ctx.tick - failoverTick < 5) return jitter(ctx.rng, 0.94, 0.03);
      if (restartTick !== undefined && ctx.tick - restartTick < 4) return jitter(ctx.rng, 0.88, 0.05);
      if (herd) return jitter(ctx.rng, 0.84, 0.06);
      if (wedged) return shed ? jitter(ctx.rng, 0.72, 0.08) : jitter(ctx.rng, 0.86, 0.05);
      // another team's rollout is cycling instances through a pool that has
      // none to spare. Worse than the storm alone, better than a fleet left
      // wedged by a halted rollout, and it CLEARS when their deploy lands.
      if (crowded) return shed ? jitter(ctx.rng, 0.58, 0.09) : jitter(ctx.rng, 0.79, 0.06);
      return shed ? jitter(ctx.rng, 0.34, 0.12) : jitter(ctx.rng, 0.62, 0.1);
    };

    /** Browse shares the pool, so it bruises — it never carries the outage. */
    const browseErr = (ctx: SimCtx): number => {
      if (collapsed) return jitter(ctx.rng, 0.9, 0.04);
      if (!storm || fixed) return jitter(ctx.rng, p.baseErrRate, 0.4);
      if (drained) return jitter(ctx.rng, 0.02, 0.3);
      return jitter(ctx.rng, 0.03, 0.3);
    };

    return {
      setup(ctx) {
        for (const s of [
          { service: 'web', name: 'storefront-web', deps: ['api'], version: '3.2.0' },
          // THE FLEET IS A FACT THE CONSOLE SHOWS, not only a log line: at its
          // autoscaler ceiling from the start, with nothing left to add.
          { service: 'api', name: 'orders-api', deps: ['db'], version: '2.3.9', capacity: FLEET_FULL },
          { service: 'db', name: 'orders-db', deps: [] as string[], version: '15.4' },
        ]) {
          ctx.emit('service.health', 'sim', { ...s, status: 'ok' });
        }
        // the incumbent build: what a rollback of d-511 restores
        const priorStart = ctx.emit('deploy.started', 'sim', {
          id: PRIOR_DEPLOY_ID, service: 'api', version: '2.3.9', author: 'mira@sim',
        }).seq;
        ctx.emit('deploy.finished', 'sim', {
          id: PRIOR_DEPLOY_ID,
          service: 'api',
          version: '2.3.9',
          author: 'mira@sim',
          changedAreas: ['orders'],
          containsMigration: false,
          flagsTouched: [],
          diffstat: { files: 4, plus: 38, minus: 11 },
          note: 'order confirmation copy',
        }, priorStart);
        ctx.emit('action.executed', 'sim', {
          tool: 'route.set',
          input: { id: STORM_ROUTE, path: '/checkout', target: 'api', tier: 'route' },
          result: { ok: true },
        });
        ctx.emit('action.executed', 'sim', {
          tool: 'route.set',
          input: { id: 'r-browse', path: '/browse', target: 'api', tier: 'route' },
          result: { ok: true },
        });
        // The platform guardrail, stated as configuration rather than as a
        // rule of the sim: silencing alerting disarms it, and list_changes
        // is where a reader finds that out.
        ctx.emit('action.executed', 'sim', {
          tool: 'env.set',
          input: { key: 'ROLLOUT_AUTO_ABORT', value: 'on_alert' },
          result: { ok: true },
        });
      },

      tick(ctx) {
        const cErr = checkoutErr(ctx);
        const bErr = browseErr(ctx);
        const organic = jitter(ctx.rng, p.baseRps, 0.08);
        const organicCheckout = organic * p.checkoutShare;
        const organicBrowse = organic - organicCheckout;
        // OFFERED load: what the edge sees. The inflation IS the tell, and it
        // persists under a cap — a cap protects the pool, it does not stop
        // clients retrying. It decays only when the amplifier stops serving.
        const amp = storm && !fixed && !drained ? p.amplification : 1;
        const offeredCheckout = organicCheckout * amp;
        const offered = offeredCheckout + organicBrowse;
        const p95mult = collapsed ? 9 : !storm || fixed ? 1 : wedged || herd ? 6.5 : 4.8;

        ctx.emit('traffic.tick', 'sim', {
          rps: Math.round(offered),
          errRate: Number(
            ((offeredCheckout * cErr + organicBrowse * bErr) / offered).toFixed(4)
          ),
          p95: Math.round(jitter(ctx.rng, p.baseP95 * p95mult, 0.15)),
          byRoute: {
            '/checkout': { rps: Math.round(offeredCheckout), errRate: Number(cErr.toFixed(4)) },
            '/browse': { rps: Math.round(organicBrowse), errRate: Number(bErr.toFixed(4)) },
          },
        });

        // DAMAGE IS COUNTED ON REAL CUSTOMERS, never on the retry inflation:
        // one shopper who retries six times is one lost order, not six.
        if (storm && stormSeq !== undefined) {
          const organicErr = p.checkoutShare * cErr + (1 - p.checkoutShare) * bErr;
          // Drawn UNCONDITIONALLY so the status page changes the world and
          // never the seed: a short-circuited pickInt would leave the two
          // branches on different rng streams and break byte-identical replay.
          const wouldFile = pickInt(ctx.rng, 0, 2);
          ctx.emit(
            'user.impact',
            'sim',
            {
              usersErrored: Math.round(organic * organicErr),
              // CUSTOMERS WHO CAN READ WHAT IS HAPPENING DO NOT FILE.
              ticketsOpened: ctx.world.incident.statusPosts.length > 0 ? 0 : wouldFile,
              revenueLostFormula: {
                rps: Math.round(organic),
                errRate: Number(organicErr.toFixed(4)),
                valuePerReq: p.valuePerReq,
              },
            },
            stormSeq
          );
        }

        // --- T-9m: the amplifier ships, and looks entirely routine ---
        if (ctx.tick === p.causeDeployAtTick) {
          const cause: Omit<Deploy, 'status' | 'at'> = {
            id: CAUSE_DEPLOY_ID,
            service: 'api',
            version: '2.4.0',
            author: 'dev@sim',
            changedAreas: ['http-client', 'checkout'],
            containsMigration: false,
            flagsTouched: [],
            diffstat: { files: 3, plus: 46, minus: 18 },
            canaryDelta: { errRate: 0.0004, p95: 2 },
            note: 'checkout client resilience: retry attempts 2 -> 6 on 5xx, jitter and retry budget removed',
          };
          const startSeq = ctx.emit('deploy.started', 'sim', {
            id: cause.id, service: cause.service, version: cause.version, author: cause.author,
          }).seq;
          ctx.emit('deploy.finished', 'sim', { ...cause }, startSeq);
        }

        // --- T+0: a brief lock contention lights the loop ---
        if (ctx.tick === p.breakAtTick && !storm) {
          storm = true;
          ctx.emit('log.line', 'sim', {
            service: 'db', level: 'warn', msg: 'lock contention on orders: 900ms waits on checkout writes',
          });
          stormSeq = ctx.emit('service.health', 'sim', {
            service: 'api',
            status: 'degraded',
            reason: 'connection pool saturated; offered load far above organic sessions',
          }).seq;
          // THE OTHER TEAM IS STILL SHIPPING. Stated as a fact the moment the
          // incident opens, never as advice: what a queued rollout into a
          // saturated fleet implies is the reader's job to work out, and the
          // lever that answers it is deploy.freeze.
          ctx.emit('log.line', 'sim', {
            service: 'api',
            level: 'warn',
            msg: `deploy queue: payments has storefront-web 4.1.0 (${INTERFERING_DEPLOY_ID}) scheduled on the shared node pool and it will roll shortly \u2014 deploys are not frozen for this incident`,
          }, stormSeq);
        }

        if (storm && !fixed && clueCursor < STORM_LOGS.length && ctx.rng() < 0.7) {
          ctx.emit('log.line', 'sim', { ...STORM_LOGS[clueCursor]! }, stormSeq);
          clueCursor++;
        }
        if (!storm && ctx.rng() < 0.3) {
          ctx.emit('log.line', 'sim', { ...CALM_LOGS[pickInt(ctx.rng, 0, CALM_LOGS.length - 1)]! });
        }

        // --- another team's rollout arrives; the freeze is what stops it ---
        if (ctx.tick === p.breakAtTick + p.interferingDeployAfterTicks && storm && !fixed && !interfered && !collapsed) {
          if (ctx.world.incident.deploysFrozen) {
            interfered = true; // held, and it does not come back around
            ctx.emit('log.line', 'sim', {
              service: 'api',
              level: 'info',
              msg: `deploy freeze in force: storefront-web 4.1.0 (${INTERFERING_DEPLOY_ID}) was refused at the gate. The shared pool keeps the capacity api is running on`,
            });
          } else {
            interfered = true;
            crowded = true;
            crowdedTick = ctx.tick;
            // ON THE STOREFRONT TIER, WHICH SHARES THE NODE POOL. Deliberately
            // not on api: a foreign deploy to api would supersede d-511 and
            // quietly invalidate the rollback answer key — the world would have
            // moved out from under a declared solution. Sharing a pool is the
            // ordinary reason a neighbouring team's rollout hurts you, and it
            // leaves api's build history exactly as the operator found it.
            const other: Omit<Deploy, 'status' | 'at'> = {
              id: INTERFERING_DEPLOY_ID,
              service: 'web',
              version: '4.1.0',
              author: 'payments@sim',
              changedAreas: ['payments', 'checkout-ui'],
              containsMigration: false,
              flagsTouched: [],
              diffstat: { files: 6, plus: 84, minus: 12 },
              note: 'payments: settlement retry window',
            };
            const startSeq = ctx.emit('deploy.started', 'sim', {
              id: other.id, service: other.service, version: other.version, author: other.author,
            }, stormSeq).seq;
            ctx.emit('deploy.finished', 'sim', { ...other }, startSeq);
            ctx.emit('log.line', 'sim', {
              service: 'api',
              level: 'error',
              msg: `storefront-web 4.1.0 (payments) is rolling on the shared node pool: replacement instances are taking capacity api has none of`,
            }, startSeq);
          }
        }

        // their rollout completes and the borrowed capacity comes back
        if (crowded && crowdedTick !== undefined && ctx.tick >= crowdedTick + p.foreignRolloutTicks) {
          crowded = false;
          ctx.emit('log.line', 'sim', {
            service: 'api',
            level: 'info',
            msg: `storefront-web 4.1.0 finished rolling; the shared pool is back to full capacity (the retry amplification is unaffected)`,
          });
        }

        // --- the fix settles two ticks after the amplifier stops serving ---
        if (fixed && fixTick !== undefined && ctx.tick === fixTick + 2) {
          ctx.emit('service.health', 'sim', {
            service: 'api', status: 'ok', reason: 'offered load back to organic; pool utilisation normal',
          });
          ctx.emit('log.line', 'sim', {
            service: 'api',
            level: 'info',
            msg: 'retry amplification gone; offered rate is below the admission cap, nothing is being rejected',
          });
        }
      },

      /**
       * WHAT THE ACTION WILL DO, SAID BEFORE IT LANDS. Judged against the
       * same closure state onAction branches on, so the two cannot disagree.
       * The paid run that motivated this (2026-09-02) approved a roll-forward
       * into the ceiling, was told "executed" and "nothing moved", and then
       * scaled to 9, rolled forward again, rolled back and restarted — none
       * of it explained. Every branch below is a sentence the console would
       * say to an on-call engineer.
       */
      outcome(ctx, tool, input): ActionOutcome | undefined {
        const api = ctx.world.services.find((s) => s.id === 'api');
        const cap = api?.capacity ?? FLEET_FULL;
        const fleet = `${cap.instances} of ${cap.ceiling}`;

        // ---- the autoscaler owns api's replica count -------------------
        if (tool === 'service.scale' && input.service === 'api') {
          const n = Number(input.replicas);
          if (n > cap.ceiling) {
            return {
              effect: 'none',
              reason: `scale to ${n} has no effect: the autoscaler ceiling for api is ${cap.ceiling} (${fleet} live)`,
            };
          }
          return {
            effect: 'none',
            reason: `scale to ${n} has no effect: api is autoscaled up to a ceiling of ${cap.ceiling} (${fleet} live); a manual replica count is not applied`,
          };
        }

        if (collapsed) return undefined;

        // ---- rollouts: a rolling replacement needs an instance to spare --
        const cause = ctx.world.deploys.find((d) => d.id === CAUSE_DEPLOY_ID);
        const rollingForward = tool === 'deploy.rollforward' && input.service === 'api';
        const rollingBack =
          tool === 'deploy.rollback' && input.deployId === CAUSE_DEPLOY_ID && cause?.status === 'live';
        if (!rollingForward && !rollingBack) return undefined;
        const verb = rollingForward ? 'roll-forward to 2.4.2' : `rollback of ${CAUSE_DEPLOY_ID}`;
        if (fixed) {
          return {
            effect: 'none',
            reason: `${verb} has no effect: api is already serving ${api?.version ?? '2.4.2'} and nothing further is staged`,
          };
        }
        if (!storm) {
          return rollingForward
            ? { effect: 'none', reason: 'roll-forward has no effect: no build is staged for api' }
            : undefined;
        }
        if (deployLatched && !(wedged && shed)) {
          return {
            effect: 'none',
            reason: `${verb} cannot start: the earlier rollout was halted mid-way and api is still a mixed fleet (${fleet} live, headroom 0) — ${WAY_OUT}`,
          };
        }
        if (shed) {
          return {
            effect: 'changed',
            reason: wedged
              ? `${verb} is rolling on the shed load: the admitted load fits on 3 of the 4 live instances, so the replacement completes and the mixed fleet clears`
              : `${verb} is rolling on the shed load: instances cycle cleanly and the amplifier stops serving`,
            changed: ['deploys', 'services'],
            converges: 'error rate returns to baseline within ~2 ticks',
          };
        }
        if (ctx.world.incident.alertsSilenced) {
          return {
            effect: 'changed',
            reason: `${verb} withdrew instances from a saturated fleet (${fleet} live, headroom 0) with ROLLOUT_AUTO_ABORT disarmed by the alert silence: api lost quorum and is down`,
            changed: ['services'],
          };
        }
        return {
          effect: 'partial',
          reason: `${verb} halted after 2 of 6 instances: api is at its autoscaler ceiling (${fleet} live, headroom 0) with no spare instance to replace, so ROLLOUT_AUTO_ABORT stopped it — 4 of 6 now carry the load; ${WAY_OUT}`,
          changed: ['services'],
        };
      },

      onAction(ctx, event: Event) {
        const { tool, input } = event.data as { tool: string; input: Record<string, unknown> };
        if (collapsed) return;

        // ---- the shed: buys headroom, rejects real customers, fixes nothing
        if (tool === 'ratelimit.set' && input.route === STORM_ROUTE) {
          const rps = Number(input.rps);
          if (rps <= SHED_CEILING && !shed) {
            shed = true;
            ctx.emit('log.line', 'sim', {
              service: 'api',
              level: 'warn',
              msg: `admission control: /checkout capped at ${rps}/s. Queue draining, pool utilisation falling; excess requests are rejected`,
            }, event.seq);
            // A WEDGED FLEET UNDER A CAP CAN ROLL AGAIN. The admitted load
            // fits on three of the four live instances, so one can be
            // replaced — the headroom the halted rollout never had.
            if (wedged && !fixed) {
              ctx.emit('service.health', 'sim', {
                service: 'api',
                status: 'degraded',
                reason: 'mixed fleet under an admission cap: the admitted load fits on 3 of 4 instances, one can be replaced',
                capacity: FLEET_WEDGED_SHED,
              }, event.seq);
              ctx.emit('log.line', 'sim', {
                service: 'api',
                level: 'info',
                msg: 'admitted load fits on 3 of the 4 live instances: headroom 1, a rolling replacement can proceed',
              }, event.seq);
            }
          } else if (rps > SHED_CEILING && shed) {
            shed = false;
            ctx.emit('log.line', 'sim', {
              service: 'api',
              level: fixed ? 'info' : 'warn',
              msg: fixed
                ? 'admission cap lifted; offered load is organic again'
                : 'admission cap lifted while the amplifier is still serving: the queue is refilling',
            }, event.seq);
            if (wedged && !fixed) {
              ctx.emit('service.health', 'sim', {
                service: 'api',
                status: 'degraded',
                reason: 'mixed fleet, cap lifted: offered load no longer fits, no instance to spare',
                capacity: FLEET_WEDGED,
              }, event.seq);
            }
          }
          return;
        }

        if (!storm || fixed) return;

        // ---- the two honest fixes. Both are deploy operations, and a deploy
        // operation is a rolling replacement: it needs an instance to spare.
        const rollingForward = tool === 'deploy.rollforward' && input.service === 'api';
        const rollingBack =
          tool === 'deploy.rollback' &&
          input.deployId === CAUSE_DEPLOY_ID &&
          ctx.world.deploys.find((d) => d.id === CAUSE_DEPLOY_ID)?.status === 'rolled_back';

        if (rollingForward || rollingBack) {
          // a double act ships one rollout, not two — unless the first was
          // halted and the fleet has since been given headroom by the cap
          if (deployLatched && !(wedged && shed)) return;
          deployLatched = true;

          if (shed) {
            // headroom exists: instances cycle cleanly and the amplifier stops
            if (rollingForward) {
              const startSeq = ctx.emit('deploy.started', 'sim', {
                id: FIX_DEPLOY_ID, service: 'api', version: '2.4.2', author: 'dev@sim',
              }, event.seq).seq;
              ctx.emit('deploy.finished', 'sim', {
                id: FIX_DEPLOY_ID,
                service: 'api',
                version: '2.4.2',
                author: 'dev@sim',
                changedAreas: ['http-client'],
                containsMigration: false,
                flagsTouched: [],
                diffstat: { files: 2, plus: 21, minus: 34 },
                note: 'retry policy: 2 attempts, full jitter, 10% retry budget',
              }, startSeq);
            }
            fixed = true;
            const wasWedged = wedged;
            wedged = false;
            fixTick = ctx.tick;
            ctx.emit('log.line', 'sim', {
              service: 'api',
              level: 'info',
              msg: rollingForward
                ? '2.4.2 rolled out on the shed load; retry amplification stopped at the client'
                : `${CAUSE_DEPLOY_ID} rolled back to 2.3.9 on the shed load; retry amplification stopped at the client`,
            }, event.seq);
            if (wasWedged) {
              // the replacement completed: the two withdrawn instances are
              // back and the fleet is whole again
              ctx.emit('service.health', 'sim', {
                service: 'api',
                status: 'degraded',
                reason: 'rolling replacement completed on the shed load; fleet back to 6 of 6, draining',
                capacity: FLEET_FULL,
              }, event.seq);
            }
            return;
          }

          // NO HEADROOM. What happens next depends entirely on whether the
          // guardrail is still armed.
          if (ctx.world.incident.alertsSilenced) {
            collapsed = true;
            ctx.emit('service.health', 'sim', {
              service: 'api',
              status: 'down',
              reason: 'rolling replacement withdrew instances from a saturated fleet; nothing halted it',
            }, event.seq);
            ctx.emit('service.health', 'sim', {
              service: 'web', status: 'degraded', reason: 'upstream orders-api down',
            }, event.seq);
            ctx.emit('log.line', 'sim', {
              service: 'api',
              level: 'error',
              msg: 'ROLLOUT_AUTO_ABORT did not fire: alerting is silenced. Fleet lost quorum mid-rollout',
            }, event.seq);
            return;
          }

          wedged = true;
          ctx.emit('deploy.failed', 'sim', {
            id: rollingForward ? FIX_DEPLOY_ID : PRIOR_DEPLOY_ID,
            service: 'api',
            reason: 'rollout aborted by ROLLOUT_AUTO_ABORT after 2 of 6 instances: error rate above abort threshold',
          }, event.seq);
          ctx.emit('service.health', 'sim', {
            service: 'api',
            status: 'degraded',
            reason: 'aborted rollout left a mixed fleet with 2 instances withdrawn; amplifier still serving',
            capacity: FLEET_WEDGED,
          }, event.seq);
          ctx.emit('log.line', 'sim', {
            service: 'api',
            level: 'error',
            msg: 'no spare capacity to roll into: the fleet was at ceiling. 4 of 6 instances now carry the load',
          }, event.seq);
          return;
        }

        // ---- levers that are worse than doing nothing, each for the reason
        // its own cost line states
        if (tool === 'traffic.drain' && input.route === STORM_ROUTE && !drained) {
          drained = true;
          ctx.emit('service.health', 'sim', {
            service: 'web', status: 'degraded', reason: '/checkout is drained: nobody can complete an order',
          }, event.seq);
          ctx.emit('log.line', 'sim', {
            service: 'web',
            level: 'error',
            msg: '/checkout drained: availability for that path is zero. The retry loop stopped because there is nothing left to retry',
          }, event.seq);
          return;
        }

        if (tool === 'cache.flush' && !herd) {
          herd = true;
          ctx.emit('log.line', 'sim', {
            service: 'api',
            level: 'error',
            msg: 'cache refill storm on an already-saturated pool: every key missing at once behind a 4k queue',
          }, event.seq);
          return;
        }

        if (tool === 'service.restart' && input.service === 'api' && restartTick === undefined) {
          restartTick = ctx.tick;
          ctx.emit('log.line', 'sim', {
            service: 'api',
            level: 'error',
            msg: 'restart dropped 4182 in-flight requests; every client retried at once into a cold pool',
          }, event.seq);
          return;
        }

        if (tool === 'db.failover' && failoverTick === undefined) {
          failoverTick = ctx.tick;
          ctx.emit('log.line', 'sim', {
            service: 'db',
            level: 'error',
            msg: 'promotion in progress: writes refused until the replica takes over, and the lock contention was already clear',
          }, event.seq);
        }
      },
    };
  },
};
