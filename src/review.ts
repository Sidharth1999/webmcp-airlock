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
 * The runner and the film scene live in src/walkthrough.ts, which IS in the
 * production bundle: the product's own "Watch a walkthrough" plays that one
 * scene. Everything harness-shaped — this banner, the scene list, the other
 * scenes — stays here. Absent the query param this module is never imported.
 */

// its own stylesheet, so the harness's chrome is not in the CSS a judge loads
import './styles/review.css';
import { filmScene, play, type AirlockLike, type PlayState, type Scene as PlayableScene } from './walkthrough';

interface Scene extends PlayableScene {
  /** shown in the banner: what this scene is */
  title: string;
  /** what the reviewer should do — one idea per line, never a paragraph */
  tryThis: string[];
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
    title: 'A seven-step response, in one order, priced',
    tryThis: [
      'Read WHY THIS ORDER before any step.',
      'Approve step 1 — the next is only proposed once it executes.',
      'Rings on the console mark where each step lands.',
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
      await ctx.call('record_finding', {
        summary: `Payments has storefront-web 4.1.0 queued on the shared node pool (#${seqs.at(0)}). It will take capacity api has none of, and nothing is stopping it.`,
      });
      // A plan card is tall and the airlock is pinned above the deck, so at
      // 1350px the rows it numbers sit under the evidence panel. Close the
      // panel for this scene: the point here is the sequence landing on the
      // controls, and the reviewer can reopen it from the left rail.
      ctx.click('close-panel');
      await ctx.call('propose_plan', {
        reason: `The fleet is at its autoscaler ceiling with no spare instances (#${seqs.at(1)}), so a rolling replacement withdraws capacity this incident cannot spare. Headroom has to exist before the fix ships. The freeze has to go on before payments rolls and come off before I ship — and it needs an owner before it will take at all.`,
        steps: [
          {
            tool: 'propose_acknowledge',
            input: { by: 'operator' },
            because: 'nobody owns this yet, and an estate-wide freeze is a commander action',
          },
          {
            tool: 'propose_severity',
            input: { level: 'sev1' },
            because: 'checkout is failing for real customers, and the status page is keyed to a severity',
          },
          {
            tool: 'propose_deploy_freeze',
            input: { frozen: true },
            because: 'payments 4.1.0 is queued on the shared pool and would take capacity api has none of',
          },
          {
            tool: 'propose_status_update',
            input: {
              state: 'identified',
              text: 'Checkout is failing for some customers. We have identified the cause and are working on a fix.',
            },
            because: 'customers are seeing card failures now; every minute unsaid is a support ticket',
          },
          {
            tool: 'propose_rate_limit',
            input: { route: 'r-checkout', rps: 150 },
            because: 'buys headroom now — it rejects real customers and fixes nothing',
          },
          {
            tool: 'propose_deploy_freeze',
            input: { frozen: false },
            because: 'the freeze stops my own rollout too — it has to come off before the fix can ship',
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
    // THE FILMED ARC, and the one scene the product plays for itself. The
    // take, and why it exists, is `filmScene` in src/walkthrough.ts.
    ...filmScene,
    title: 'A cap the page refused, then published',
    tryThis: [
      'Read the event stream: the agent asked for the cap in Triage and was refused.',
      'The plan appears only after Recovery.',
      'Reach for Silence alerts before you approve step 2.',
    ],
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
    // ONE QUIET LINE, AT THE FOOT. Sid: "I don't think we need review plan
    // panel at all". It was a bordered yellow card at the TOP of the dock —
    // the loudest thing in the frame, above the agent's own work, in every
    // screenshot he takes. It cannot be deleted outright: it is the permanent
    // on-screen disclosure that the CALLER here is a script rather than a
    // model, and removing that would let a scene be mistaken for a model
    // reasoning. So it keeps the disclosure and loses the card.
    el.innerHTML = `
      <div class="rv-head">
        <span class="rv-tag">dev scene</span>
        <span class="rv-title"></span>
        <span class="rv-state"></span>
      </div>
    `;
    // ONE reserved area for anything agent- or review-related: this belongs
    // inside the agent dock, at the top of it, not floating in a corner
    // competing with the decision it is describing.
    const host = document.querySelector<HTMLElement>('#tool-rail .dock-body');
    (host ?? document.body).append(el);
  }
  el.dataset.state = state;
  // NO PROSE. Sid, 2026-09-02: the line "sounds like demo narrative", and it
  // did — the scene's own title ("A seven-step response, in one order,
  // priced") is copy written to sell the scene, and "your turn" is a showcase
  // addressing its audience. Neither belongs on a page whose whole rule is
  // that the product never explains itself. What has to survive is the
  // DISCLOSURE: in a ?review= scene the caller is a script, not a model. So
  // the line is now the scene's id and its machine state, and nothing else.
  el.querySelector('.rv-title')!.textContent = scene.id;
  el.querySelector('.rv-state')!.textContent =
    state === 'running' ? 'preparing' : state === 'failed' ? `failed — ${detail}` : '';
  // the reviewer instructions used to render here as a bullet list; the
  // banner is a one-line disclosure now and the scenes' own tryThis copy
  // stays in STATUS.md, which is where a reviewer is actually reading it.
}

/**
 * Play one scene, then stop. The runner is `play` in src/walkthrough.ts —
 * it holds the world still while a decision is pending and moves it again
 * once the decision is made. This is only the banner riding on its state.
 *
 * Once the reviewer has decided, the banner goes QUIET. It used to announce
 * "running — watch the console" and then tell the reviewer the sim was
 * running again — the harness narrating its own showcase, which is the one
 * register that must never appear on this page. The scene is over; the
 * console speaks for itself from here.
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
  const id = new URLSearchParams(location.search).get('review') ?? '';
  const scene = SCENES.find((s) => s.id === id) ?? SCENES[0]!;
  const onState = (state: PlayState, detail: string): void => {
    if (state === 'settled' || state === 'stopped') {
      banner(scene, 'running');
      document.querySelector('#review-banner .rv-state')?.replaceChildren();
      return;
    }
    banner(scene, state, detail);
  };
  await play(scene, { ...opts, onState });
}
