/**
 * WALKTHROUGH — a scripted caller on the real tool path.
 *
 * The agent half of this console cannot be reached by clicking: to see a
 * refusal, a finding or a plan, something has to BE the agent. A judge with a
 * WebMCP host attached gets that for free; a judge without one sees a console
 * and never sees the ledger fill. This module is the scripted caller that
 * stands in: it drives the page through `window.__airlock`, which is the same
 * execute path a WebMCP host uses, and every gate applies exactly as it would
 * to a live model. What is scripted is WHO is calling, and the dock says so
 * on screen, in machine words, for as long as the walkthrough's work is on
 * the ledger.
 *
 * The scene stops the moment it has something to ask. The viewer approves or
 * rejects with real clicks; the console does whatever those clicks do.
 *
 * This module is in the production bundle. The DEV review harness
 * (`?review=<scene>`, src/review.ts) uses the same runner and the same film
 * scene, and keeps every harness-shaped thing — banner, scene list, the other
 * scenes — to itself.
 */

export interface AirlockLike {
  invoke(name: string, input?: unknown): Promise<string>;
}

export interface Scene {
  id: string;
  /** the scenario this scene needs the console seeded into */
  template: string;
  run(ctx: Ctx): Promise<void>;
}

export interface Ctx {
  air: AirlockLike;
  /** invoke a tool and parse its JSON result */
  call(name: string, input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** run the sim until `pred` holds, then pause it */
  runUntil(pred: () => boolean, label: string): Promise<void>;
  click(testId: string): void;
  /** newest-first log seqs currently on screen */
  logSeqs(): number[];
  /** a pause that ends early if the walkthrough is stopped */
  sleep(ms: number): Promise<void>;
}

export type PlayState = 'running' | 'ready' | 'settled' | 'failed' | 'stopped';

export interface PlayOpts {
  air: AirlockLike;
  isRunning: () => boolean;
  toggleRun: () => void;
  /** the template the page is currently seeded into */
  template: string;
  /** re-seed the console into a different scenario */
  seedTemplate: (id: string) => void;
  /** stop: nothing further is invoked once this fires */
  signal?: AbortSignal;
  /** where the play is, for the one line on screen that says so */
  onState?: (state: PlayState, detail: string) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const isStopped = (err: unknown): boolean =>
  err instanceof DOMException && err.name === 'AbortError';

function stopIf(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('walkthrough stopped', 'AbortError');
}

/** `sleep`, but it returns early and throws if the walkthrough is stopped. */
async function sleepUnless(ms: number, signal: AbortSignal | undefined): Promise<void> {
  stopIf(signal);
  const step = 80;
  for (let left = ms; left > 0; left -= step) {
    await sleep(Math.min(step, left));
    stopIf(signal);
  }
}

export async function waitFor(
  pred: () => boolean,
  label: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const started = Date.now();
  while (!pred()) {
    stopIf(opts.signal);
    if (Date.now() - started > timeoutMs) throw new Error(`walkthrough: timed out waiting for ${label}`);
    await sleep(80);
  }
}

/**
 * THE FILMED ARC.
 *
 * Two outside reviewers, independently, said the same thing about the eight
 * stills: the capability change is DECLARED and never DEMONSTRATED. A sheet
 * that goes from 13 to 27 is a settings modal that got longer unless
 * something is first seen to be impossible.
 *
 * It was already impossible. In Triage `propose_rate_limit` is not published
 * at all — `window.__airlock.list()` does not contain it — and reaching for it
 * writes a `BLOCKED — not-available-in-mode` row into the stream. This scene
 * is the take: the refusal, the unlock, the ordered plan, and the trap armed
 * so the human can walk into it.
 */
export const filmScene: Scene = {
  id: 'film',
  template: 'retry-storm',
  async run(ctx) {
    await ctx.runUntil(() => ctx.logSeqs().length > 6, 'log lines');

    // 1. THE REFUSAL. Still in Triage: the agent reads, concludes, and
    //    reaches for the cap it has just argued for. The page says no.
    for (const t of ['airlock_status', 'list_deploys', 'read_logs', 'traffic_history']) {
      await ctx.call(t);
    }
    const seqs = ctx.logSeqs();
    await ctx.call('record_finding', {
      summary: `Offered rate on /checkout is ~4x its organic share while /browse is flat, and contention already cleared (#${seqs.at(2)}) — the load is retries sustaining themselves.`,
    });
    await ctx.call('propose_rate_limit', { route: 'r-checkout', rps: 150 });
    await ctx.sleep(1400); // let the refusal land on screen before anything else

    // 2. THE UNLOCK. Recovery publishes the writes, and only now can the
    //    plan be assembled at all.
    ctx.click('mode-recovery');
    await ctx.sleep(600);
    await ctx.call('list_changes');

    // 3. THE TRAP, ARMED. `alerts.silence` is free on its own and
    //    catastrophic in front of a rollout, so the agent rules it out
    //    BEFORE the human reaches for it. Counsel, never a block: the
    //    button still works on the second click.
    await ctx.call('record_finding', {
      summary: 'Alert noise is the symptom, not the fault. The rollout in step 2 is guarded by those same alerts.',
      ruledOut:
        'Silencing alerts. On its own it costs nothing, but the rollout you are about to approve aborts on the alerts it would suppress — silence them and the guardrail is disarmed exactly when it is load-bearing.',
      advisesAgainst: 'alerts.silence:true',
    });

    ctx.click('close-panel');
    await ctx.call('propose_plan', {
      reason: `The fleet is at its autoscaler ceiling with no spare instances (#${seqs.at(1)}), so a rolling replacement withdraws capacity this incident cannot spare. Headroom has to exist before the fix ships; the other way round takes api down.`,
      steps: [
        {
          tool: 'propose_rate_limit',
          input: { route: 'r-checkout', rps: 150 },
          because: 'buys headroom now — it rejects real customers and fixes nothing',
        },
        {
          tool: 'propose_rollforward',
          input: { service: 'api' },
          because: '2.4.2 is staged and green: retry attempts 2, full jitter, budget 10%',
        },
      ],
    });
  },
};

/**
 * HOLD STILL WHILE A DECISION IS PENDING; MOVE AGAIN ONCE IT IS MADE.
 *
 * A scene pauses the sim so the viewer can read what is in front of them
 * without the world sliding underneath. But that meant approving both steps
 * of a plan and watching nothing happen — the recovery a correct answer earns
 * needs ticks to arrive in. So once the airlock empties, the sim resumes and
 * the viewer sees what their own decision did.
 */
async function watchForYourDecision(opts: PlayOpts): Promise<void> {
  // NOT the airlock's pending count: a finished plan keeps its receipt on
  // screen, so that number never returns to zero. What matters is whether
  // anything is still WAITING on them — an undecided approval card.
  const awaiting = () => document.querySelector('.approval-card') !== null;
  if (!awaiting()) return; // nothing was put to them; leave the world alone
  try {
    await waitFor(() => !awaiting(), 'your decision', { timeoutMs: 15 * 60_000, signal: opts.signal });
  } catch (err) {
    if (isStopped(err)) return;
    return; // timed out: the world stays paused, as they left it
  }
  if (!opts.isRunning()) opts.toggleRun();
  opts.onState?.('settled', '');
}

/**
 * Play one scene, then stop. `air` is the live tool surface. The sim is
 * left paused, so the world holds still while the viewer reads what is in
 * front of them, and resumes once they have decided.
 */
export async function play(scene: Scene, opts: PlayOpts): Promise<void> {
  const { air, isRunning, toggleRun, signal } = opts;
  opts.onState?.('running', 'setting the scene');

  // Each scene names the scenario it needs. Re-seeding here rather than at
  // boot keeps main.ts from having to know anything about scenes.
  if (opts.template !== scene.template) {
    opts.seedTemplate(scene.template);
    await sleepUnless(400, signal);
  }

  const ctx: Ctx = {
    air,
    async call(name, input = {}) {
      stopIf(signal);
      return JSON.parse(await air.invoke(name, input)) as Record<string, unknown>;
    },
    click(testId) {
      stopIf(signal);
      document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.click();
    },
    logSeqs() {
      return [...document.querySelectorAll<HTMLElement>('#log-stream .log-row')].map((n) =>
        Number(n.dataset.seq)
      );
    },
    sleep: (ms) => sleepUnless(ms, signal),
    async runUntil(pred, label) {
      opts.onState?.('running', `waiting for ${label}`);
      if (!isRunning()) toggleRun();
      try {
        await waitFor(pred, label, { signal });
      } finally {
        if (isRunning()) toggleRun(); // hold the world still for the viewer
      }
    },
  };

  try {
    await scene.run(ctx);
    await sleepUnless(250, signal);
    opts.onState?.('ready', '');
    void watchForYourDecision(opts);
  } catch (err) {
    if (isStopped(err)) {
      opts.onState?.('stopped', '');
      return;
    }
    opts.onState?.('failed', String((err as Error).message ?? err));
    throw err;
  }
}
