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
  /** shown in the banner: what the reviewer should do with it */
  tryThis: string;
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
    tryThis:
      'These are the same lines read_logs serves an agent. Try the level floor and the text filter — the count on the right tells you what is hidden.',
    template: 'retry-storm',
    async run(ctx) {
      await ctx.runUntil(() => ctx.logSeqs().length > 6, 'log lines');
      ctx.click('tab-logs');
    },
  },
  {
    id: 'evidence',
    title: 'A proposal, with what the agent worked FROM',
    tryThis:
      'The chip row is read off the audit trail — the agent cannot claim a read it did not make. The sentence below is its own words, so it is a claim. Click a #citation: it lands you on that exact log line.',
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
    tryThis:
      'The same tool call, from an agent that looked at nothing first. This is the case the strip exists for — compare it with the evidence scene.',
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
    tryThis:
      'Read the reason BEFORE you approve anything — that is the point of the order being stated first. Then approve step 1 and watch: step 2 is only proposed once step 1 has actually executed. The numbered rings below show WHERE the sequence lands: 1 on the /checkout route, 2 on the api service. (The evidence panel is closed so the whole deck fits — reopen it from the left rail.)',
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
    id: 'abandon',
    title: 'A plan you refuse half way',
    tryThis:
      'Reject step 1. The rest of the sequence is ABANDONED rather than skipped — a sequence with a hole in it is not the plan anyone agreed to, and the numbers on the controls clear with it.',
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
    tryThis:
      'An ordinary tier-1 rollback, on the two-key rung — because the deploy id reached the agent only inside a customer-supplied log line this page served. Approve is disarmed until you engage the key. You are informed, never overruled.',
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
    tryThis:
      'The agent has ruled out rolling d-201 back. Click "Roll back" on the d-201 card below and its reasoning appears beside the control. It counsels; it never blocks — click again and you do it anyway.',
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
    el = document.createElement('aside');
    el.id = 'review-banner';
    el.dataset.testid = 'review-banner';
    el.innerHTML = `
      <div class="rv-head">
        <span class="rv-tag">review harness</span>
        <span class="rv-title"></span>
        <span class="rv-state"></span>
      </div>
      <p class="rv-try"></p>
      <nav class="rv-scenes" aria-label="Review scenes"></nav>
      <p class="rv-foot">A script is calling the tools, not a model — the events, proposals and gates are real. Drop <code>?review=</code> for the product.</p>
    `;
    document.body.append(el);
    const nav = el.querySelector<HTMLElement>('.rv-scenes')!;
    for (const s of SCENES) {
      const a = document.createElement('a');
      a.href = `?review=${s.id}`;
      a.className = 'rv-scene';
      a.textContent = s.id;
      a.dataset.testid = `review-scene-${s.id}`;
      if (s.id === scene.id) a.setAttribute('aria-current', 'true');
      nav.append(a);
    }
  }
  el.dataset.state = state;
  el.querySelector('.rv-title')!.textContent = scene.title;
  el.querySelector('.rv-state')!.textContent =
    state === 'running' ? `setting up — ${detail}` : state === 'ready' ? 'your turn' : `failed: ${detail}`;
  el.querySelector('.rv-try')!.textContent = state === 'ready' ? scene.tryThis : '';
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
  banner(scene, 'running', 'starting the sim');

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
  } catch (err) {
    banner(scene, 'failed', String((err as Error).message ?? err));
    throw err;
  }
}
