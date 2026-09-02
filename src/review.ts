/**
 * REVIEW HARNESS — `?review=<scene>`
 *
 * Not part of the product. It exists because the agent-side half of this
 * console cannot be reached by clicking: to see an evidence strip or a plan
 * you have to be an agent, and the only way to be one in a plain browser was
 * to type into a devtools console. That is not a reviewable state.
 *
 * Each scene puts the console into ONE situation and then STOPS, handing the
 * human half back. The reviewer approves, rejects, filters and clicks for
 * themselves — which is the only way to review an approval surface honestly.
 *
 * It drives the page through `window.__airlock`, the same execute path a real
 * WebMCP host uses. Nothing here is a mock: the events are real events, the
 * proposals are real proposals, and every gate applies exactly as it would to
 * a live model. What is fake is only WHO is calling — a script rather than a
 * model — and the banner says so on screen, permanently, so a scene can never
 * be mistaken for a model doing the reasoning.
 *
 * Absent the query param this module is never imported.
 */

// its own stylesheet, so the harness's chrome is not in the CSS a judge loads
import './styles/review.css';

interface AirlockLike {
  invoke(name: string, input?: unknown): Promise<string>;
}

interface Scene {
  id: string;
  /** shown in the banner: what this scene is */
  title: string;
  /** what the reviewer should do — one idea per line, never a paragraph */
  tryThis: string[];
  template: string;
  run(ctx: Ctx): Promise<void>;
}

interface Ctx {
  air: AirlockLike;
  /** invoke a tool and parse its JSON result */
  call(name: string, input?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** run the sim until `pred` holds, then pause it */
  runUntil(pred: () => boolean, label: string): Promise<void>;
  click(testId: string): void;
  /** newest-first log seqs currently on screen */
  logSeqs(): number[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, label: string, timeoutMs = 45_000): Promise<void> {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > timeoutMs) throw new Error(`review: timed out waiting for ${label}`);
    await sleep(80);
  }
}

const SCENES: Scene[] = [
  {
    id: 'logs',
    title: 'The logs pane',
    tryThis: [
      'Filter by level, then by text.',
      'The count on the right says what is hidden.',
    ],
    template: 'retry-storm',
    async run(ctx) {
      await ctx.runUntil(() => ctx.logSeqs().length > 6, 'log lines');
      ctx.click('tab-logs');
    },
  },
  {
    id: 'evidence',
    title: 'A proposal, with what the agent worked FROM',
    tryThis: [
      'Chips = reads it actually made. The sentence = its claim.',
      'Click a #citation — it lands on that log line.',
    ],
    template: 'retry-storm',
    async run(ctx) {
      await ctx.runUntil(() => ctx.logSeqs().length > 6, 'log lines');
      ctx.click('mode-recovery');
      for (const t of ['airlock_status', 'list_deploys', 'read_logs', 'read_logs', 'traffic_history', 'list_changes']) {
        await ctx.call(t);
      }
      const seqs = ctx.logSeqs();
      await ctx.call('record_finding', {
        summary: `Offered rate on /checkout is ~4x its organic share while /browse is flat, and the db already reported contention cleared (#${seqs.at(2)}) — this load is retries sustaining themselves, not customers.`,
      });
      await ctx.call('propose_rate_limit', { route: 'r-checkout', rps: 150 });
    },
  },
  {
    id: 'bare',
    title: 'A proposal made without reading anything',
    tryThis: [
      'Same proposal, from an agent that read nothing.',
      'Compare with the evidence scene.',
    ],
    template: 'retry-storm',
    async run(ctx) {
      await ctx.runUntil(() => ctx.logSeqs().length > 3, 'the incident opening');
      ctx.click('mode-recovery');
      await ctx.call('propose_rate_limit', { route: 'r-checkout', rps: 150 });
    },
  },
  {
    id: 'plan',
    title: 'A plan: two levers, in one order, priced',
    tryThis: [
      'Read the reason first. That is the point of stating the order.',
      'Approve step 1 — step 2 is only proposed after it executes.',
      'Rings 1 and 2 on the console mark where it lands.',
    ],
    template: 'retry-storm',
    async run(ctx) {
      await ctx.runUntil(() => ctx.logSeqs().length > 6, 'log lines');
      ctx.click('mode-recovery');
      for (const t of ['airlock_status', 'list_deploys', 'read_logs', 'traffic_history', 'list_changes']) {
        await ctx.call(t);
      }
      const seqs = ctx.logSeqs();
      await ctx.call('record_finding', {
        summary: `Offered rate on /checkout is ~4x its organic share while /browse is flat, and contention already cleared (#${seqs.at(2)}) — the load is retries sustaining themselves.`,
      });
      // A plan card is tall and the airlock is pinned above the deck, so at
      // 1350px the rows it numbers sit under the evidence panel. Close the
      // panel for this scene: the point here is the sequence landing on the
      // controls, and the reviewer can reopen it from the left rail.
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
  },
  {
    id: 'film',
    title: 'The take: refused in Triage, then the order, then the trap',
    tryThis: [
      'The agent reached for the cap in Triage and the page refused it — read the stream.',
      'Recovery published the writes; only then could the plan exist.',
      'Reach for Silence alerts before approving step 2.',
    ],
    template: 'retry-storm',
    /**
     * THE FILMED ARC, rehearsable in one link.
     *
     * Two outside reviewers, independently, said the same thing about the
     * eight stills: the capability change is DECLARED and never DEMONSTRATED.
     * A sheet that goes from 13 to 27 is a settings modal that got longer
     * unless something is first seen to be impossible.
     *
     * It was already impossible. In Triage `propose_rate_limit` is not
     * published at all — `window.__airlock.list()` does not contain it — and
     * reaching for it narrates "Agent tried something it cannot reach in this
     * mode" and writes a `BLOCKED — not-available-in-mode` row into the
     * stream. The whole beat existed and had never been in a scene, so it had
     * never been shot and could not have been filmed.
     *
     * This scene is the take: the refusal, the unlock, the ordered plan, and
     * the trap armed so the human can walk into it on camera.
     */
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
      await sleep(1400); // let the refusal land on screen before anything else

      // 2. THE UNLOCK. Recovery publishes the writes, and only now can the
      //    plan be assembled at all.
      ctx.click('mode-recovery');
      await sleep(600);
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
  },
  {
    id: 'abandon',
    title: 'A plan you refuse half way',
    tryThis: [
      'Reject step 1.',
      'The rest is abandoned, not skipped, and the rings clear.',
    ],
    template: 'retry-storm',
    async run(ctx) {
      await ctx.runUntil(() => ctx.logSeqs().length > 4, 'log lines');
      ctx.click('mode-recovery');
      ctx.click('close-panel');
      await ctx.call('propose_plan', {
        reason: 'Headroom first: the fleet has no spare instances, so shipping the fix first withdraws capacity the incident cannot spare.',
        steps: [
          { tool: 'propose_rate_limit', input: { route: 'r-checkout', rps: 150 }, because: 'buys headroom now' },
          { tool: 'propose_rollforward', input: { service: 'api' }, because: 'ships the fix' },
        ],
      });
    },
  },
  {
    id: 'provenance',
    title: 'The page knows where the idea came from',
    tryThis: [
      'Press Approve before the key. It is disarmed.',
      'Engage the key and you can still do it.',
    ],
    template: 'poisoned-runbook',
    async run(ctx) {
      await ctx.runUntil(
        () => /tick (1[5-9]|[2-9]\d)/.test(document.querySelector('[data-testid=sim-status]')?.textContent ?? ''),
        'the poisoned order note'
      );
      ctx.click('mode-recovery');
      const served = (await ctx.call('read_logs')) as { lines?: { msg: string; untrusted?: boolean }[] };
      const line = (served.lines ?? []).find((l) => l.untrusted && /d-\d+/.test(l.msg));
      const target = line ? (line.msg.match(/d-\d+/) ?? [])[0] : undefined;
      if (!target) throw new Error('review: no deploy id inside an untrusted log line');
      await ctx.call('propose_rollback', { deployId: target });
    },
  },
  {
    id: 'counsel',
    title: 'The agent objects before your click',
    tryThis: [
      'Click Roll back on the d-201 card, in the console.',
      'It counsels. Click again and it proceeds.',
    ],
    template: 'migration-trap',
    async run(ctx) {
      await ctx.runUntil(
        () => (document.querySelector('#sit-state')?.textContent ?? '').includes('INCIDENT'),
        'the incident opening'
      );
      await ctx.call('record_finding', {
        summary: 'The failing checkout path is the new session schema, not the build. d-201 shipped an irreversible migration.',
        ruledOut:
          'Rolling d-201 back. api 1.9.3 reads the v1 session layout only, and 43,857 rows have already been written in v2 — the rollback takes the store down rather than healing it.',
        advisesAgainst: 'deploy.rollback:d-201',
      });
    },
  },
];

export function sceneIds(): string[] {
  return SCENES.map((s) => s.id);
}

/** The template a scene needs, so main.ts can boot straight into it. */
export function templateForScene(id: string): string | undefined {
  return SCENES.find((s) => s.id === id)?.template;
}

function banner(scene: Scene, state: 'running' | 'ready' | 'failed', detail = ''): void {
  let el = document.querySelector<HTMLElement>('#review-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'review-banner';
    el.dataset.testid = 'review-banner';
    el.innerHTML = `
      <div class="rv-head">
        <span class="rv-tag">review</span>
        <span class="rv-title"></span>
        <span class="rv-state"></span>
      </div>
      <ul class="rv-try"></ul>
      <nav class="rv-scenes" aria-label="Review scenes">
        <span class="rv-scenes-label">Other things to look at</span>
      </nav>
    `;
    // ONE reserved area for anything agent- or review-related: this belongs
    // inside the agent dock, at the top of it, not floating in a corner
    // competing with the decision it is describing.
    const host = document.querySelector<HTMLElement>('#tool-rail .dock-body');
    (host ?? document.body).prepend(el);
    const nav = el.querySelector<HTMLElement>('.rv-scenes')!;
    for (const sc of SCENES) {
      const a = document.createElement('a');
      a.href = `?review=${sc.id}`;
      a.className = 'rv-scene';
      a.textContent = sc.id;
      a.dataset.testid = `review-scene-${sc.id}`;
      a.title = sc.title;
      a.setAttribute('aria-label', `${sc.id} — ${sc.title}`);
      if (sc.id === scene.id) a.setAttribute('aria-current', 'true');
      nav.append(a);
    }
  }
  el.dataset.state = state;
  el.querySelector('.rv-title')!.textContent = scene.title;
  el.querySelector('.rv-state')!.textContent =
    state === 'running' ? detail : state === 'ready' ? 'your turn' : `failed — ${detail}`;
  const list = el.querySelector<HTMLElement>('.rv-try')!;
  list.innerHTML = '';
  if (state === 'ready') {
    for (const line of scene.tryThis) {
      const li = document.createElement('li');
      li.textContent = line;
      list.append(li);
    }
  }
}

/**
 * HOLD STILL WHILE A DECISION IS PENDING; MOVE AGAIN ONCE IT IS MADE.
 *
 * A scene pauses the sim so the reviewer can read the card in front of them
 * without the world sliding underneath. But that meant approving both steps
 * of a plan and watching nothing happen — the recovery a correct answer earns
 * needs ticks to arrive in. So once the airlock empties, the sim resumes and
 * the reviewer sees what their own decision did.
 */
async function watchForYourDecision(
  scene: Scene,
  isRunning: () => boolean,
  toggleRun: () => void
): Promise<void> {
  // NOT the airlock's pending count: a finished plan keeps its card on screen
  // as the receipt, so that number never returns to zero. What matters is
  // whether anything is still WAITING on them — an undecided approval card.
  const awaiting = () => document.querySelector('.approval-card') !== null;
  if (!awaiting()) return; // nothing was put to them; leave the world alone
  await waitFor(() => !awaiting(), 'your decision', 15 * 60_000).catch(() => undefined);
  if (awaiting()) return;
  if (!isRunning()) toggleRun();
  const el = document.querySelector<HTMLElement>('#review-banner');
  if (!el) return;
  el.dataset.state = 'running';
  el.querySelector('.rv-state')!.textContent = 'running — watch the console';
  const list = el.querySelector<HTMLElement>('.rv-try')!;
  list.innerHTML = '';
  const li = document.createElement('li');
  li.textContent = 'The console is moving again — watch what your decision did.';
  list.append(li);
}

/**
 * Play one scene, then stop. `air` is the live tool surface; `pause` puts the
 * sim back in the state the reviewer expects to find it in — paused, so the
 * world holds still while they read the card in front of them.
 */
export async function run(opts: {
  air: AirlockLike;
  isRunning: () => boolean;
  toggleRun: () => void;
  /** the template main.ts booted into */
  template: string;
  /** re-seed the console into a different scenario */
  seedTemplate: (id: string) => void;
}): Promise<void> {
  const { air, isRunning, toggleRun } = opts;
  const id = new URLSearchParams(location.search).get('review') ?? '';
  const scene = SCENES.find((s) => s.id === id) ?? SCENES[0]!;
  banner(scene, 'running', 'setting the scene');

  // Each scene names the scenario it needs. Re-seeding here rather than at
  // boot keeps main.ts from having to know anything about scenes.
  if (opts.template !== scene.template) {
    opts.seedTemplate(scene.template);
    await sleep(400);
  }

  const ctx: Ctx = {
    air,
    async call(name, input = {}) {
      return JSON.parse(await air.invoke(name, input)) as Record<string, unknown>;
    },
    click(testId) {
      document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.click();
    },
    logSeqs() {
      return [...document.querySelectorAll<HTMLElement>('#log-stream .log-row')].map((n) =>
        Number(n.dataset.seq)
      );
    },
    async runUntil(pred, label) {
      banner(scene, 'running', `waiting for ${label}`);
      if (!isRunning()) toggleRun();
      await waitFor(pred, label);
      if (isRunning()) toggleRun(); // hold the world still for the reviewer
    },
  };

  try {
    await scene.run(ctx);
    await sleep(250);
    banner(scene, 'ready');
    void watchForYourDecision(scene, isRunning, toggleRun);
  } catch (err) {
    banner(scene, 'failed', String((err as Error).message ?? err));
    throw err;
  }
}
