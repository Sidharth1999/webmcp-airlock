import './styles/tokens.css';
import './styles/shell.css';
import { Engine } from './sim/engine';
import { MODES, type Mode } from './sim/modes';
import type { EntityRef, QueryRequest } from './sim/queries';
import { templateIds } from './sim/templates';
import type { SimRequest, SimResponse } from './sim/worker';
import type { Deploy, Event, Flag, World } from './sim/types';
import { hasWebMCP } from './webmcp/shim';
import { createAirlockTools, type AirlockTools } from './webmcp/tools';

type Health = 'ok' | 'degraded' | 'down';
const HEALTH_STATES: Health[] = ['ok', 'degraded', 'down'];
const DEFAULT_TEMPLATE = 'migration-trap';

// ?template= picks the scenario, ?tick= paces the sim (ms/tick, tests run
// fast), ?dev=1 shows the manual health buttons (token demo, M1 leftover).
const params = new URLSearchParams(location.search);
const requestedTemplate = params.get('template') ?? DEFAULT_TEMPLATE;
/**
 * Scenario names as an operator would see them. Deliberately symptom-level:
 * "migration-trap" is internal jargon AND naming the cause would hand over
 * the answer the range exists to test.
 */
const TEMPLATE_LABELS: Record<string, string> = {
  baseline: 'Calm',
  'migration-trap': 'Checkout',
  'innocent-deploy': 'Timeouts',
  'poisoned-runbook': 'Payments',
};
/** the fuller phrasing, on hover — the chip itself must stay one word */
const TEMPLATE_TITLES: Record<string, string> = {
  baseline: 'Calm day — nothing is wrong',
  'migration-trap': 'Checkout is failing',
  'innocent-deploy': 'Timeouts spreading across routes',
  'poisoned-runbook': 'Payments failing at checkout',
};

const TEMPLATE_ID = templateIds().includes(requestedTemplate)
  ? requestedTemplate
  : DEFAULT_TEMPLATE;
const TICK_INTERVAL_MS = Number(params.get('tick')) || 500;
const DEV_MODE = params.get('dev') === '1';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <div class="shell" data-site="off">
    <div class="masthead">
      <span class="health-lamp" aria-hidden="true"></span>
      <span class="wordmark">Release Airlock</span>
      <span class="health-word" id="health-word">Nominal</span>
      <button type="button" id="site-toggle" data-testid="site-toggle" aria-pressed="false"
              title="show what customers are seeing right now">Live site</button>
      <div class="seg" id="template-pick" data-testid="template-pick" role="radiogroup" aria-label="Scenario">
        ${templateIds()
          .map(
            (id) =>
              `<button type="button" role="radio" data-template="${id}" data-testid="template-${id}" aria-checked="${id === TEMPLATE_ID}" title="${TEMPLATE_TITLES[id] ?? id}">${TEMPLATE_LABELS[id] ?? id}</button>`
          )
          .join('')}
      </div>
      <span class="spacer"></span>
      <div class="tele" id="tele" data-testid="tele">
        ${(['rps', 'err', 'p95'] as const)
          .map(
            (m) => `
          <div class="tele-inst" data-metric="${m}" data-state="ok">
            <span class="tele-label">${m}</span>
            <svg class="tele-spark" viewBox="0 0 96 24" preserveAspectRatio="none" aria-hidden="true"><path d="" /></svg>
            <span class="tele-val">—</span>
          </div>`
          )
          .join('')}
        <div class="tele-damage" id="tele-damage" title="mechanically derived: Σ rps × errRate × valuePerReq">
          <span class="tele-label">impact</span>
          <span class="tele-val" id="damage-val">$0.00</span>
        </div>
      </div>
      ${
        DEV_MODE
          ? `<div class="health-demo" id="health-demo" title="dev-only token demo">
              ${HEALTH_STATES.map(
                (s) => `<button type="button" data-health-set="${s}" aria-pressed="${s === 'ok'}">${s}</button>`
              ).join('')}
            </div>`
          : ''
      }
    </div>

    <section class="pane" id="console" aria-label="Console">
      <header>
        Console
        <button type="button" id="sim-run" data-testid="sim-run" aria-pressed="false">Run sim</button>
      </header>
      <div class="body">
        <div id="control-deck" data-testid="control-deck">

          <!-- ZONE 1 — the situation, in a sentence. Everything below is
               evidence for it. Computed from the log, never hardcoded. -->
          <section id="situation" data-testid="situation" data-phase="calm">
            <div class="sit-bar">
              <span class="sit-state" id="sit-state">STANDBY</span>
              <span class="sit-clock" id="sit-clock">T+00:00</span>
            </div>
            <p class="sit-head" id="sit-head">NO SCENARIO RUNNING</p>
            <dl class="sit-fields" id="sit-fields"></dl>
          </section>

          <!-- IMPACT — big numbers with their unit and trend, Vercel-style
               card anatomy: label, value, context. Fills the pane honestly
               because every figure is live. -->
          <section class="stats" id="stats" data-testid="stats"></section>

          <!-- the incident has a SHAPE. A console that only shows "now" hides
               when it started and whether it is recovering. -->
          <section class="chart" id="err-chart" data-testid="err-chart">
            <div class="chart-head">
              <span class="chart-k">Checkout error rate</span>
              <span class="chart-max" id="chart-max">—</span>
            </div>
            <div class="chart-plot">
              <svg viewBox="0 0 300 100" preserveAspectRatio="none" aria-hidden="true">
                <path class="chart-area" d="" />
                <path class="chart-line" d="" vector-effect="non-scaling-stroke" />
              </svg>
              <span class="chart-slo" id="chart-slo" title="1% error budget"></span>
              <p class="chart-empty">Nothing plotted yet — start the scenario and the error rate builds here, so you can see when it began and whether it is recovering.</p>
            </div>
            <div class="chart-axis"><span>60 ticks ago</span><span>now</span></div>
          </section>

          <!-- ZONE 2 — what changed. Open while it matters. -->
          <details class="zone" id="zone-changed" data-testid="zone-changed" open>
            <summary><span class="zone-title">What changed</span><span class="zone-meta" id="zone-changed-meta"></span></summary>
            <div class="zone-body">
              <div id="deploy-controls"></div>
              <p class="empty" id="deploys-empty">No deploys in this scenario yet.</p>
            </div>
          </details>

          <!-- ZONE 3 — the human's own hands. Closed until there's a reason. -->
          <details class="zone" id="zone-controls" data-testid="zone-controls" open>
            <summary><span class="zone-title">Manual controls</span><span class="zone-meta">flags · services · topology</span></summary>
            <div class="zone-body">
              <div id="topology" data-testid="topology"></div>
              <div id="flag-controls"></div>
              <div id="service-controls"></div>
            </div>
          </details>

          <!-- ZONE 4 — the raw trail. Present for the audit story, not in the way. -->
          <details class="zone" id="zone-activity" data-testid="zone-activity" open>
            <summary>
              <span class="zone-title">Activity</span>
              <button type="button" id="audit-toggle" data-testid="audit-toggle" aria-pressed="false" title="filter the stream to who did what">Audit trail</button>
              <span id="sim-status" data-testid="sim-status">seeded · paused</span>
            </summary>
            <div class="zone-body">
              <ol id="event-stream" data-testid="event-stream" aria-live="polite"></ol>
              <p class="empty" id="stream-empty">Nothing has happened yet. Start the scenario to bring the store online.</p>
            </div>
          </details>

        </div>
      </div>
    </section>

    <section class="pane" id="site-pane" aria-label="Site pane">
      <header>Live Site<span class="pane-sub">what customers see</span></header>
      <div class="body">
        <div id="storefront" data-testid="storefront" data-state="ok">
          <div class="sf-chrome">
            <span class="sf-brand">aperture supply co.</span>
            <span class="sf-nav">shop · about · cart (1)</span>
          </div>
          <div class="sf-hero">
            <span class="sf-hero-kicker">new for fall</span>
            <span class="sf-hero-line">Field-tested goods, guaranteed for the long trail.</span>
          </div>
          <div class="sf-banner" data-testid="sf-banner" role="status"></div>
          <div class="sf-grid">
            <div class="sf-card"><div class="sf-img"><svg viewBox="0 0 100 100" aria-hidden="true"><rect x="26" y="18" width="48" height="60" rx="4" fill="#3f6b52"/><path d="M50 18v60" stroke="#2b4c39" stroke-width="2"/><path d="M38 18l12 14 12-14" fill="#31543f"/><rect x="18" y="22" width="10" height="40" rx="4" fill="#3f6b52"/><rect x="72" y="22" width="10" height="40" rx="4" fill="#3f6b52"/><rect x="32" y="52" width="12" height="9" rx="2" fill="#2b4c39"/><rect x="56" y="52" width="12" height="9" rx="2" fill="#2b4c39"/></svg></div><div class="sf-name">field jacket</div><div class="sf-price">$128</div></div>
            <div class="sf-card"><div class="sf-img"><svg viewBox="0 0 100 100" aria-hidden="true"><path d="M28 34h44l-4 46H32z" fill="#c8a173"/><path d="M40 34c0-9 4-14 10-14s10 5 10 14" stroke="#8a6b45" stroke-width="3" fill="none" stroke-linecap="round"/><rect x="40" y="50" width="20" height="14" rx="2" fill="#a8834f"/></svg></div><div class="sf-name">canvas tote</div><div class="sf-price">$42</div></div>
            <div class="sf-card"><div class="sf-img"><svg viewBox="0 0 100 100" aria-hidden="true"><rect x="38" y="26" width="24" height="54" rx="9" fill="#6f8fc4"/><rect x="43" y="14" width="14" height="12" rx="3" fill="#3f5c8d"/><rect x="38" y="44" width="24" height="12" fill="#5679b3"/><path d="M62 32c5 3 5 9 0 12" stroke="#3f5c8d" stroke-width="3" fill="none" stroke-linecap="round"/></svg></div><div class="sf-name">trail bottle</div><div class="sf-price">$28</div></div>
            <div class="sf-card"><div class="sf-img"><svg viewBox="0 0 100 100" aria-hidden="true"><path d="M28 56a22 22 0 0 1 44 0z" fill="#c48f9a"/><rect x="24" y="56" width="52" height="13" rx="6" fill="#a86f7d"/><circle cx="50" cy="26" r="7" fill="#a86f7d"/></svg></div><div class="sf-name">wool beanie</div><div class="sf-price">$34</div></div>
            <div class="sf-card"><div class="sf-img"><svg viewBox="0 0 100 100" aria-hidden="true"><rect x="30" y="32" width="36" height="42" rx="5" fill="#8d9c5c"/><rect x="30" y="32" width="36" height="8" rx="4" fill="#6f7d43"/><path d="M66 44h7a8 8 0 0 1 0 16h-7" stroke="#6f7d43" stroke-width="5" fill="none" stroke-linecap="round"/></svg></div><div class="sf-name">camp mug</div><div class="sf-price">$22</div></div>
            <div class="sf-card"><div class="sf-img"><svg viewBox="0 0 100 100" aria-hidden="true"><path d="M32 40h36v34a6 6 0 0 1-6 6H38a6 6 0 0 1-6-6z" fill="#78889a"/><rect x="30" y="30" width="40" height="11" rx="5" fill="#56657a"/><path d="M36 30c0-5 6-8 14-8s14 3 14 8" stroke="#56657a" stroke-width="3" fill="none"/><rect x="32" y="56" width="36" height="4" fill="#66768a"/></svg></div><div class="sf-name">dry sack</div><div class="sf-price">$36</div></div>
          </div>
          <div class="sf-checkout">
            <button type="button" class="sf-buy" data-testid="sf-buy">Checkout — $48.00</button>
            <div class="sf-feed" data-testid="sf-feed"></div>
          </div>
          <div class="sf-outage" data-testid="sf-outage">
            <div class="sf-outage-code">502</div>
            <div class="sf-outage-msg">We can't reach the store right now.</div>
          </div>
        </div>
      </div>
    </section>

    <div id="agent-cursor" data-testid="agent-cursor" data-state="off" aria-hidden="true">
      <span class="ac-dot"></span><span class="ac-label">agent</span>
    </div>

    <section class="pane" id="tool-rail" aria-label="Agent">
      <header>
        Agent
        <span class="pane-sub" id="rail-sub">standing by</span>
      </header>
      <div class="rail-modes">
        <div class="mode-switch" id="mode-switch" data-testid="mode-switch">
          ${MODES.map(
            (m) =>
              `<button type="button" data-mode="${m}" data-testid="mode-${m}" aria-pressed="${m === 'triage'}">${m}</button>`
          ).join('')}
        </div>
      </div>
      <div class="body">
        <div class="agent-presence" id="agent-presence" data-state="off">
          <span class="ap-dot" aria-hidden="true"></span>
          <span class="ap-text">
            <span id="agent-conn" data-testid="agent-conn" data-state="off">No agent connected</span>
            <span class="ap-sub ap-sub-off">WebMCP on this page: <span id="webmcp-status">…</span></span>
            <span class="ap-sub ap-sub-on">Working through this page's tools — every write still needs your approval.</span>
          </span>
        </div>

        <div class="agent-can" id="agent-can">
          <p class="can-line" id="can-read"></p>
          <p class="can-line" id="can-write"></p>
        </div>

        <details class="tool-surface" id="tool-surface" open>
          <summary><span class="ts-label">Tool surface</span><span class="ts-count" id="tool-count"></span></summary>
          <ul id="tool-list" data-testid="tool-list"></ul>
        </details>

        <p class="rail-foot">Nothing here changes the world on its own. The agent proposes; you decide.</p>

        <div class="agent-empty" id="agent-empty">
          <p class="ae-head">No agent has joined yet</p>
          <p class="ae-body">Open this page in a browser that speaks WebMCP and an assistant will
          discover the checks above on its own — no setup, no keys, no copying context across.</p>
          <p class="ae-body">You stay in the console either way. The page works exactly the same without one.</p>
        </div>
      </div>
    </section>
  </div>
`;

const HEALTH_WORD: Record<Health, string> = {
  ok: 'Nominal',
  degraded: 'Degraded',
  down: 'Down',
};

function setHealth(state: Health): void {
  document.documentElement.dataset.health = state;
  document.querySelector('#health-word')!.textContent = HEALTH_WORD[state];
  document.querySelectorAll<HTMLButtonElement>('[data-health-set]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.healthSet === state));
  });
}

document.querySelector('#health-demo')?.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-health-set]');
  if (btn) setHealth(btn.dataset.healthSet as Health);
});

document.querySelector('#webmcp-status')!.textContent = hasWebMCP()
  ? 'detected'
  : 'not detected (plain browser — page fully usable without an agent)';

// ---- sim worker wiring (M2-02) ------------------------------------------
// Engine lives in the Worker; the main thread only paces it (real time is
// allowed here — sim-time is the Worker's SimClock, so pacing never leaks
// into the event stream).

const SEED = 20260828;

const worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
const send = (msg: SimRequest) => worker.postMessage(msg);

// read-tool RPC: tools ask the worker, the worker's log/world answer —
// no mirrored state on the main thread (schema v1: one source of truth)
let queryId = 0;
const pendingQueries = new Map<number, (r: Record<string, unknown>) => void>();
function runWorkerQuery(q: QueryRequest, viaTool?: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const id = ++queryId;
    pendingQueries.set(id, resolve);
    send({ type: 'query', id, query: q, viaTool });
  });
}

type ProposeOutcome = { seq: number; outcome: 'proposed' | 'blocked'; reason?: string };
let proposeId = 0;
const pendingProposes = new Map<number, (r: ProposeOutcome) => void>();
function proposeToWorker(tool: string, input: Record<string, unknown>): Promise<ProposeOutcome> {
  return new Promise((resolve) => {
    const id = ++proposeId;
    pendingProposes.set(id, resolve);
    send({ type: 'propose', id, tool, input });
  });
}

const streamEl = document.querySelector<HTMLOListElement>('#event-stream')!;
const statusEl = document.querySelector('#sim-status')!;
const runBtn = document.querySelector<HTMLButtonElement>('#sim-run')!;
const templatePick = document.querySelector<HTMLElement>('#template-pick')!;
let running = false;
let pacer: number | undefined;
let eventCount = 0;
let tickCount = 0;
let world: World | null = null;

function markTemplate(id: string): void {
  templatePick.querySelectorAll<HTMLButtonElement>('[data-template]').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.template === id));
  });
}
markTemplate(TEMPLATE_ID);

// One source of truth for pacing: tick while running and the tab is visible.
// A hidden tab pauses (the event log is append-only and unbounded — a
// forgotten background tab must not grind forever); sim-time is unaffected.
function syncPacer(): void {
  const shouldTick = running && !document.hidden;
  if (shouldTick && pacer === undefined) {
    pacer = window.setInterval(() => send({ type: 'step' }), TICK_INTERVAL_MS);
  } else if (!shouldTick && pacer !== undefined) {
    window.clearInterval(pacer);
    pacer = undefined;
  }
  runBtn.textContent = running ? 'Pause sim' : 'Run sim';
  runBtn.setAttribute('aria-pressed', String(running));
}
document.addEventListener('visibilitychange', syncPacer);

// Full reset: a re-seed swaps worlds, so every piece of rendered state from
// the old scenario (pacer, deck rows, header health, storefront) goes too.
function seed(templateId: string): void {
  running = false;
  syncPacer();
  streamEl.innerHTML = '';
  for (const { card } of pendingCards.values()) card.remove();
  pendingCards.clear();
  flagControls.innerHTML = '';
  serviceControls.innerHTML = '';
  deployControls.innerHTML = '';
  topologyEl.innerHTML = '';
  delete topologyEl.dataset.key;
  eventCount = 0;
  tickCount = 0;
  world = null;
  orderNo = ORDER_NO_START;
  selection = null;
  resetTele();
  storefront.dataset.state = 'ok';
  sfBanner.textContent = '';
  sfBuy.textContent = 'Checkout — $48.00';
  sfFeed.textContent = '';
  setHealth('ok');
  statusEl.textContent = 'seeded · paused';
  airlockTools.reset(); // fresh world, fresh ritual — and no ghost tombstones
  renderToolRail(airlockTools);
  send({ type: 'seed', templateId, seed: SEED });
  // setup events aren't streamed by 'seed'; pull them so the deck has state
  send({ type: 'snapshot' });
}

templatePick.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-template]');
  if (!btn) return;
  markTemplate(btn.dataset.template!);
  seed(btn.dataset.template!);
});

const SEVERITY: Record<Health, number> = { ok: 0, degraded: 1, down: 2 };

function summarize(e: Event): string {
  const d = e.data as Record<string, any>;
  switch (e.kind) {
    case 'traffic.tick':
      return `${d.rps} rps · err ${(d.errRate * 100).toFixed(2)}% · p95 ${d.p95}ms`;
    case 'log.line':
      return `[${d.service}] ${d.level}: ${d.msg}`;
    case 'service.health':
      return `${d.service} → ${d.status}${d.reason ? ` (${d.reason})` : ''}`;
    case 'deploy.started':
    case 'deploy.finished':
    case 'deploy.failed':
      return `${d.id} ${d.service}@${d.version}${d.note ? ` — “${d.note}”` : ''}`;
    case 'user.impact':
      return `${d.usersErrored} users errored · ${d.ticketsOpened} tickets`;
    case 'scenario.seeded':
      return `${d.templateId} seed=${d.seed}`;
    case 'action.executed': {
      const input = d.input as Record<string, unknown>;
      switch (d.tool) {
        case 'flag.set':
          return `flag.set ${input.id} → ${input.state}`;
        case 'deploy.rollback':
          return `deploy.rollback ${input.deployId}`;
        case 'deploy.rollforward':
          return `deploy.rollforward ${input.service}`;
        case 'env.set':
          return `env.set ${input.key}`;
        case 'route.set':
          return `route.set ${input.id} → ${input.target}`;
        default:
          return `${d.tool} ${JSON.stringify(input)}`;
      }
    }
    case 'migration.applied':
      return `${d.id} by ${d.appliedByDeploy} · ${d.reversible ? 'reversible' : 'IRREVERSIBLE'}`;
    case 'mode.changed':
      return `${d.from} → ${d.to}${(d.toolsAdded as string[]).length ? ` · +${(d.toolsAdded as string[]).join(', +')}` : ''}${(d.toolsRemoved as string[]).length ? ` · −${(d.toolsRemoved as string[]).join(', −')}` : ''}`;
    case 'action.proposed':
      return `[tier ${d.tier}] ${d.diffSummary}`;
    case 'action.approved':
      return `proposal #${d.proposalSeq} approved by human${d.keyHolder ? ` · key: ${d.keyHolder}` : ''}`;
    case 'action.rejected':
      return `proposal #${d.proposalSeq} REJECTED by human`;
    case 'action.blocked':
      return `${d.tool} BLOCKED — ${d.reason}${d.mode ? ` (mode: ${d.mode})` : ''}`;
    case 'selection.changed': {
      const t = d.target as EntityRef | null;
      return t ? `human points at ${t.type} ${t.id}` : 'selection cleared';
    }
    case 'tool.called':
      return `${d.tool} · ${d.resultBytes}B`;
    default:
      return JSON.stringify(d);
  }
}

// ---- control deck (M2-05): world state → human-playable controls ---------
// Idempotent keyed rendering: rows/cards are created once and updated in
// place, so a Playwright click never lands on a rebuilt node.

const flagControls = document.querySelector<HTMLDivElement>('#flag-controls')!;
const deployControls = document.querySelector<HTMLDivElement>('#deploy-controls')!;
const MAX_DEPLOY_CARDS = 3;

function renderFlagRow(flag: Flag): void {
  let row = flagControls.querySelector<HTMLDivElement>(`[data-flag-id="${flag.id}"]`);
  if (!row) {
    row = document.createElement('div');
    row.className = 'ctl-row';
    row.dataset.flagId = flag.id;
    row.innerHTML = `
      <span class="ctl-kind">flag</span>
      <span class="ctl-name"></span>
      <span class="ctl-state"></span>
      <button type="button" class="ctl-btn" data-act="flag-toggle" data-flag=""></button>
    `;
    row.querySelector('.ctl-name')!.textContent = flag.name;
    (row.querySelector('[data-act="flag-toggle"]') as HTMLButtonElement).dataset.flag = flag.id;
    (row.querySelector('[data-act="flag-toggle"]') as HTMLButtonElement).dataset.testid =
      `flag-toggle-${flag.id}`;
    flagControls.append(row);
  }
  const on = flag.state === 'on' || (typeof flag.state === 'number' && flag.state > 0);
  row.dataset.flagState = on ? 'on' : 'off';
  row.querySelector('.ctl-state')!.textContent = typeof flag.state === 'number' ? `${flag.state}%` : flag.state;
  const btn = row.querySelector<HTMLButtonElement>('[data-act="flag-toggle"]')!;
  btn.textContent = on ? 'Turn off' : 'Turn on';
}

function renderDeployCard(deploy: Deploy, canRollback: boolean): void {
  let card = deployControls.querySelector<HTMLDivElement>(`[data-deploy-id="${deploy.id}"]`);
  if (!card) {
    card = document.createElement('div');
    card.className = 'deploy-card';
    card.dataset.deployId = deploy.id;
    card.dataset.testid = `deploy-card-${deploy.id}`;
    const canary = deploy.canaryDelta
      ? `canary Δerr +${(deploy.canaryDelta.errRate * 100).toFixed(1)}% · Δp95 +${deploy.canaryDelta.p95}ms`
      : 'no canary data';
    card.innerHTML = `
      <div class="dc-title"></div>
      <div class="dc-head">
        <span class="dc-target"></span>
        <span class="dc-id"></span>
        <span class="dc-status"></span>
      </div>
      <div class="dc-meta">
        ${
          deploy.containsMigration
            ? `<span class="dc-badge dc-badge-migration">migration · ${
                deploy.migrationReversible ? 'reversible' : 'irreversible'
              }</span>`
            : ''
        }
        ${deploy.flagsTouched.length ? `<span class="dc-badge">flags: ${deploy.flagsTouched.join(', ')}</span>` : ''}
        <span class="dc-badge">${canary}</span>
        <span class="dc-badge">${deploy.diffstat.files} files +${deploy.diffstat.plus} −${deploy.diffstat.minus}</span>
      </div>
      <div class="dc-actions">
        <button type="button" class="ctl-btn dc-rollback" data-act="rollback" data-deploy="${deploy.id}" data-testid="rollback-${deploy.id}">Roll back</button>
      </div>
    `;
    // the human story first: a stranger should read WHAT SHIPPED, not a key
    card.querySelector('.dc-title')!.textContent =
      deploy.note ?? `${deploy.service} ${deploy.version}`;
    card.querySelector('.dc-target')!.textContent = `${deploy.author} · ${deploy.service} ${deploy.version}`;
    card.querySelector('.dc-id')!.textContent = deploy.id;
    deployControls.prepend(card);
  }
  card.dataset.deployStatus = deploy.status;
  card.querySelector('.dc-status')!.textContent = deploy.status.replace('_', ' ');
  card.querySelector<HTMLButtonElement>('.dc-rollback')!.disabled = !canRollback;
}

const serviceControls = document.querySelector<HTMLDivElement>('#service-controls')!;

function renderServiceRow(svc: World['services'][number]): void {
  let row = serviceControls.querySelector<HTMLDivElement>(`[data-service-id="${svc.id}"]`);
  if (!row) {
    row = document.createElement('div');
    row.className = 'ctl-row';
    row.dataset.serviceId = svc.id;
    row.innerHTML = `
      <span class="ctl-kind">svc</span>
      <span class="ctl-name"></span>
      <span class="ctl-state"></span>
      <button type="button" class="ctl-btn" data-act="rollforward" data-service="${svc.id}" data-testid="rollforward-${svc.id}" title="ship the next build of ${svc.id}">Roll forward</button>
    `;
    row.querySelector('.ctl-name')!.textContent = svc.id;
    serviceControls.append(row);
  }
  row.dataset.serviceHealth = svc.health;
  row.querySelector('.ctl-state')!.textContent = `${svc.version} · ${svc.health}`;
}

function renderDeck(w: World): void {
  renderTopology(w);
  for (const flag of w.flags) renderFlagRow(flag);
  for (const svc of w.services) renderServiceRow(svc);
  for (const deploy of w.deploys.slice(-MAX_DEPLOY_CARDS)) {
    // rollback is only a real affordance when the world can honor it:
    // the deploy is live AND a superseded predecessor exists to revert to
    const canRollback =
      deploy.status === 'live' &&
      w.deploys.some((d) => d.service === deploy.service && d.status === 'superseded');
    renderDeployCard(deploy, canRollback);
  }
  // drop cards that fell out of the window (keeps the deck decision-sized)
  const keep = new Set(w.deploys.slice(-MAX_DEPLOY_CARDS).map((d) => d.id));
  deployControls.querySelectorAll<HTMLDivElement>('[data-deploy-id]').forEach((c) => {
    if (!keep.has(c.dataset.deployId!)) c.remove();
  });
}

// ---- approval diff-cards (M3-03): the airlock's human gate ---------------
// A proposal renders as a card ANCHORED to the node it would mutate; the
// human approves or rejects; the causedBy chain proposed → approved →
// executed is the audit trail (and IS the event log, filtered).

const pendingCards = new Map<number, { card: HTMLElement; anchor: HTMLElement | null }>();

function anchorFor(tool: string, input: Record<string, unknown>): HTMLElement | null {
  switch (tool) {
    case 'flag.set':
      return flagControls.querySelector(`[data-flag-id="${input.id}"]`);
    case 'deploy.rollback':
      return deployControls.querySelector(`[data-deploy-id="${input.deployId}"]`);
    case 'deploy.rollforward':
      return serviceControls.querySelector(`[data-service-id="${input.service}"]`);
    default:
      return null;
  }
}

function addApprovalCard(e: Event): void {
  const d = e.data as {
    tool: string;
    input: Record<string, unknown>;
    tier: number;
    tierName: string;
    diffSummary: string;
    requiresKey?: boolean;
    provenance?: { ref: string; lineSeq: number; excerpt: string; service: string };
  };
  const card = document.createElement('div');
  card.className = 'approval-card';
  card.dataset.proposalSeq = String(e.seq);
  card.dataset.tier = String(d.tier);
  card.dataset.testid = `approval-${e.seq}`;
  // A proposal is on the key rung either because of its tier, or because the
  // page knows where the idea came from (src/sim/provenance.ts).
  const dualKey = d.tier === 4 || d.requiresKey === true;
  card.innerHTML = `
    <div class="ap-head">
      <span class="ap-actor">agent proposes</span>
      <span class="ap-tier">tier ${d.tier} · ${d.tierName}${dualKey ? ' · dual-key' : ''}</span>
    </div>
    <div class="ap-diff"></div>
    ${
      d.provenance
        ? `<div class="ap-prov" data-testid="provenance-${e.seq}">
             <span class="ap-prov-head">evidence check · ${d.provenance.ref} came from untrusted content</span>
             <span class="ap-prov-quote"></span>
             <span class="ap-prov-src">${d.provenance.service} log #${d.provenance.lineSeq} · customer-supplied text, served to the agent by read_logs</span>
           </div>`
        : ''
    }
    ${
      dualKey
        ? `<label class="ap-key"><input type="checkbox" class="ap-key-toggle" data-testid="key-${e.seq}"><span>engage key — held while the agent executes${d.provenance ? ' (required: untrusted evidence)' : ''}</span></label>`
        : ''
    }
    <div class="ap-actions">
      <button type="button" class="ctl-btn primary ap-approve" data-act="approve" data-seq="${e.seq}" data-testid="approve-${e.seq}" ${dualKey ? 'disabled' : ''}>Approve</button>
      <button type="button" class="ctl-btn ap-reject" data-act="reject" data-seq="${e.seq}" data-testid="reject-${e.seq}">Reject</button>
    </div>
  `;
  card.querySelector('.ap-diff')!.textContent = d.diffSummary;
  // textContent, never innerHTML: this string is attacker-controlled
  const quote = card.querySelector('.ap-prov-quote');
  // the line carries its own quoting; wrapping it again collides with it
  if (quote && d.provenance) quote.textContent = d.provenance.excerpt;
  card.querySelector<HTMLInputElement>('.ap-key-toggle')?.addEventListener('change', (ev) => {
    const engaged = (ev.target as HTMLInputElement).checked;
    card.querySelector<HTMLButtonElement>('.ap-approve')!.disabled = !engaged;
  });
  const anchor = anchorFor(d.tool, d.input);
  if (anchor) {
    anchor.insertAdjacentElement('afterend', card);
    anchor.classList.add('proposal-anchor');
  } else {
    document.querySelector('#situation')!.insertAdjacentElement('beforeend', card);
  }
  pendingCards.set(e.seq, { card, anchor });
  // the human owes the agent an answer: put it where they're already looking
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function resolveApprovalCard(proposalSeq: number): void {
  const entry = pendingCards.get(proposalSeq);
  if (!entry) return;
  entry.card.remove();
  entry.anchor?.classList.remove('proposal-anchor');
  pendingCards.delete(proposalSeq);
}

// ---- agent presence layer (M3-06): the agent is SOMEWHERE ---------------
// A labeled cursor glides (agent motion signature: deliberate, legible) to
// whatever the agent last touched; telestrator rings pulse on annotated
// nodes; the conn chip says whether an agent is live. Mechanics only —
// visual language belongs to the UX pass (docs/ux-debt.md).

const agentCursor = document.querySelector<HTMLDivElement>('#agent-cursor')!;
const agentConn = document.querySelector<HTMLElement>('#agent-conn')!;
const agentPresence = document.querySelector<HTMLElement>('#agent-presence')!;
/** keep the presence card and the chip telling the same story */
const setPresence = (state: 'off' | 'idle' | 'live', label: string): void => {
  agentConn.dataset.state = state;
  agentConn.textContent = label;
  agentPresence.dataset.state = state;
};
let agentIdleTimer: number | undefined;

function moveAgentCursor(target: Element | null): void {
  if (!target) return;
  const r = target.getBoundingClientRect();
  if (r.width === 0) return;
  // ride the TOP-LEFT shoulder of the target: landing on the middle put the
  // label straight over the Approve button the human needs to click
  // Sit FULLY above the target, never on top of it. `top - 9` still covered
  // the first ~9px of a full-width row (it was landing on the db service
  // line); clamp so a target near the top of the viewport keeps the label
  // on screen. Caught by screenshot, like the Approve-button overlap before.
  const labelY = Math.max(4, Math.round(r.top - 22));
  agentCursor.style.transform = `translate(${Math.round(r.left - 6)}px, ${labelY}px)`;
  agentCursor.dataset.state = 'active';
  setPresence('live', 'Agent is working');
  window.clearTimeout(agentIdleTimer);
  agentIdleTimer = window.setTimeout(() => {
    agentCursor.dataset.state = 'idle';
    setPresence('idle', 'Agent connected, waiting');
  }, 4000);
}

function agentTargetFor(e: Event): Element | null {
  const d = e.data as Record<string, unknown>;
  switch (e.kind) {
    case 'tool.called':
      return document.querySelector(`#tool-list li[data-tool="${d.tool}"]`);
    case 'action.proposed':
      return document.querySelector(`[data-testid="approval-${e.seq}"]`);
    case 'action.blocked':
      return document.querySelector('#tool-list');
    case 'action.executed':
      return anchorFor(String(d.tool), (d.input ?? {}) as Record<string, unknown>);
    default:
      return null;
  }
}

function telestrate(target: EntityRef): void {
  const sel =
    target.type === 'service'
      ? `.topo-node[data-service="${target.id}"]`
      : target.type === 'deploy'
        ? `.deploy-card[data-deploy-id="${target.id}"]`
        : `.ctl-row[data-flag-id="${target.id}"]`;
  const el = document.querySelector<HTMLElement>(sel);
  if (!el) return;
  el.classList.add('telestrated');
  window.setTimeout(() => el.classList.remove('telestrated'), 2600);
}

// dev/driver hook until an annotate tool earns a slot in the 12-tool budget
declare global {
  interface Window {
    __annotate: (target: EntityRef) => void;
  }
}
window.__annotate = (target) =>
  send({ type: 'record', kind: 'annotation.added', actor: 'agent', data: { target } });

// ---- co-presence selection (M3-05) ---------------------------------------
// Clicking any node is pointing at it: selection.changed enters the log and
// the agent's read tools scope to it. Click again to clear.

let selection: EntityRef | null = null;

function selectableTarget(el: HTMLElement): EntityRef | null {
  const topo = el.closest<HTMLElement>('.topo-node[data-service]');
  if (topo) return { type: 'service', id: topo.dataset.service! };
  const flag = el.closest<HTMLElement>('.ctl-row[data-flag-id]');
  if (flag) return { type: 'flag', id: flag.dataset.flagId! };
  const svc = el.closest<HTMLElement>('.ctl-row[data-service-id]');
  if (svc) return { type: 'service', id: svc.dataset.serviceId! };
  const deploy = el.closest<HTMLElement>('.deploy-card[data-deploy-id]');
  if (deploy) return { type: 'deploy', id: deploy.dataset.deployId! };
  return null;
}

function applySelectionVisual(): void {
  document.querySelectorAll<HTMLElement>('[data-selected]').forEach((el) => {
    delete el.dataset.selected;
  });
  if (!selection) return;
  const sels: string[] = [];
  if (selection.type === 'service') {
    sels.push(
      `.topo-node[data-service="${selection.id}"]`,
      `.ctl-row[data-service-id="${selection.id}"]`
    );
  } else if (selection.type === 'flag') {
    sels.push(`.ctl-row[data-flag-id="${selection.id}"]`);
  } else if (selection.type === 'deploy') {
    sels.push(`.deploy-card[data-deploy-id="${selection.id}"]`);
  }
  for (const s of sels) {
    document.querySelectorAll<HTMLElement>(s).forEach((el) => (el.dataset.selected = 'true'));
  }
}

function setSelection(target: EntityRef | null): void {
  selection = target;
  send({
    type: 'record',
    kind: 'selection.changed',
    actor: 'human',
    data: { by: 'human', target },
  });
  applySelectionVisual();
}

/**
 * The live site is opt-in — the console shouldn't spend half the screen on a
 * shop that is fine. But it REVEALS ITSELF the moment checkout starts
 * failing: the consequence of a change is the one thing that should
 * interrupt you. Once the human closes it, it stays closed (an auto-opening
 * panel that keeps coming back is worse than one that never opens).
 */
let siteAutoRevealed = false;
function setSite(on: boolean): void {
  document.querySelector<HTMLElement>('.shell')!.dataset.site = on ? 'on' : 'off';
  document.querySelector('#site-toggle')!.setAttribute('aria-pressed', String(on));
}
function revealSiteOnTrouble(phase: string): void {
  if (siteAutoRevealed) return;
  if (phase === 'incident' || phase === 'down') {
    siteAutoRevealed = true;
    setSite(true);
  }
}
document.querySelector('#site-toggle')!.addEventListener('click', () => {
  const on = document.querySelector('#site-toggle')!.getAttribute('aria-pressed') !== 'true';
  siteAutoRevealed = true; // an explicit choice ends the automatic behaviour
  setSite(on);
});

document.querySelector('#audit-toggle')!.addEventListener('click', (ev) => {
  ev.preventDefault();  // it sits inside <summary>; don't let it collapse the zone
  ev.stopPropagation();
  const btn = document.querySelector<HTMLButtonElement>('#audit-toggle')!;
  const on = btn.getAttribute('aria-pressed') !== 'true';
  btn.setAttribute('aria-pressed', String(on));
  streamEl.classList.toggle('audit', on);
  // ux-debt #3: an unlabelled toggle with an invisible result was a mystery —
  // say what it does, then say what it did
  const shown = streamEl.querySelectorAll('li:not([hidden])').length;
  btn.textContent = on ? `Showing ${shown} actions · show all` : 'Audit trail';
});

document.querySelector('#control-deck')!.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
  if (!btn) {
    // not a control: a click on a NODE is the human pointing at it. Other
    // interactive elements in the deck (audit toggle, dual-key checkbox) and
    // dead space are NOT selection gestures — they must never clear or move
    // the selection. Click-again on the selected node is the clear gesture.
    if ((e.target as HTMLElement).closest('button, input, label, select, a')) return;
    const target = selectableTarget(e.target as HTMLElement);
    if (target !== null) {
      const same =
        selection !== null && target.type === selection.type && target.id === selection.id;
      setSelection(same ? null : target);
    }
    return;
  }
  if (btn.disabled || !world) return;
  switch (btn.dataset.act) {
    case 'approve':
    case 'reject': {
      const card = btn.closest<HTMLElement>('.approval-card');
      const keyEngaged = card?.querySelector<HTMLInputElement>('.ap-key-toggle')?.checked ?? false;
      send({
        type: 'decide',
        proposalSeq: Number(btn.dataset.seq),
        decision: btn.dataset.act === 'approve' ? 'approve' : 'reject',
        ...(btn.dataset.act === 'approve' && keyEngaged ? { keyHolder: 'operator' } : {}),
      });
      return;
    }
    case 'flag-toggle': {
      const flag = world.flags.find((f) => f.id === btn.dataset.flag);
      if (!flag) return;
      const on = flag.state === 'on' || (typeof flag.state === 'number' && flag.state > 0);
      send({ type: 'act', tool: 'flag.set', input: { id: flag.id, state: on ? 'off' : 'on' } });
      break;
    }
    case 'rollback':
      send({ type: 'act', tool: 'deploy.rollback', input: { deployId: btn.dataset.deploy } });
      break;
    case 'rollforward':
      send({ type: 'act', tool: 'deploy.rollforward', input: { service: btn.dataset.service } });
      break;
  }
});

// ---- telemetry wall (masthead sparklines) --------------------------------
// Live instruments over a rolling window; single-series line marks, status
// color reserved for threshold breaches (dataviz discipline: the stream
// below is the table view; glance instruments carry no hover layer).

const TELE_WINDOW = 60;
const teleBuffers: Record<'rps' | 'err' | 'p95', number[]> = { rps: [], err: [], p95: [] };

function teleState(metric: 'rps' | 'err' | 'p95', v: number): 'ok' | 'warn' | 'bad' {
  if (metric === 'err') return v > 0.08 ? 'bad' : v > 0.01 ? 'warn' : 'ok';
  if (metric === 'p95') return v > 600 ? 'bad' : v > 320 ? 'warn' : 'ok';
  return 'ok'; // rps is magnitude, not status
}

function teleFormat(metric: 'rps' | 'err' | 'p95', v: number): string {
  if (metric === 'err') return `${(v * 100).toFixed(2)}%`;
  if (metric === 'p95') return `${Math.round(v)}ms`;
  return String(Math.round(v));
}

/** The error-rate history as a real plot: area + line, axis, SLO line. */
function renderErrChart(): void {
  const buf = teleBuffers.err;
  const card = document.querySelector<HTMLElement>('#err-chart')!;
  const area = card.querySelector<SVGPathElement>('.chart-area')!;
  const line = card.querySelector<SVGPathElement>('.chart-line')!;
  const maxEl = card.querySelector<HTMLElement>('#chart-max')!;
  if (buf.length < 2) {
    area.setAttribute('d', '');
    line.setAttribute('d', '');
    maxEl.textContent = '—';
    card.dataset.empty = 'true';
    return;
  }
  card.dataset.empty = 'false';
  // scale to the window's own peak, floored at 2% so a calm run isn't all noise
  const peak = Math.max(0.02, ...buf);
  const step = 300 / (TELE_WINDOW - 1);
  const x0 = 300 - (buf.length - 1) * step; // newest pinned to the right edge
  const pts = buf.map((v, i) => [x0 + i * step, 100 - (v / peak) * 92] as const);
  const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  line.setAttribute('d', d);
  area.setAttribute('d', `${d} L300,100 L${x0.toFixed(1)},100 Z`);
  maxEl.textContent = `peak ${(peak * 100).toFixed(1)}%`;
  const latest = buf[buf.length - 1]!;
  card.dataset.tone = latest > 0.08 ? 'bad' : latest > 0.01 ? 'warn' : 'ok';
  // the 1% error budget, drawn where it actually falls
  card.querySelector<HTMLElement>('#chart-slo')!.style.bottom = `${Math.min(96, (0.01 / peak) * 92)}%`;
}

function renderTele(): void {
  renderErrChart();
  for (const metric of ['rps', 'err', 'p95'] as const) {
    const buf = teleBuffers[metric];
    const inst = document.querySelector<HTMLElement>(`.tele-inst[data-metric="${metric}"]`);
    if (!inst || buf.length === 0) continue;
    const latest = buf[buf.length - 1]!;
    inst.dataset.state = teleState(metric, latest);
    inst.querySelector('.tele-val')!.textContent = teleFormat(metric, latest);
    if (buf.length >= 2) {
      const min = Math.min(...buf);
      const max = Math.max(...buf);
      const span = max - min || 1;
      const step = 96 / (TELE_WINDOW - 1);
      const x0 = 96 - (buf.length - 1) * step; // right-aligned: newest at the edge
      const d = buf
        .map((v, i) => {
          const x = (x0 + i * step).toFixed(1);
          const y = (21 - ((v - min) / span) * 18).toFixed(1); // 3px pad top+bottom
          return `${i === 0 ? 'M' : 'L'}${x} ${y}`;
        })
        .join(' ');
      inst.querySelector('path')!.setAttribute('d', d);
    }
  }
}

function pushTele(d: { rps: number; errRate: number; p95: number }): void {
  teleBuffers.rps.push(d.rps);
  teleBuffers.err.push(d.errRate);
  teleBuffers.p95.push(d.p95);
  for (const b of Object.values(teleBuffers)) if (b.length > TELE_WINDOW) b.shift();
  renderTele();
}

function resetTele(): void {
  for (const b of Object.values(teleBuffers)) b.length = 0;
  document.querySelectorAll<HTMLElement>('.tele-inst').forEach((el) => {
    el.dataset.state = 'ok';
    el.querySelector('.tele-val')!.textContent = '—';
    el.querySelector('path')!.setAttribute('d', '');
  });
  document.querySelector('#damage-val')!.textContent = '$0.00';
}

// ---- service topology (the schematic) ------------------------------------

const topologyEl = document.querySelector<HTMLDivElement>('#topology')!;

function renderTopology(w: World): void {
  // order by dependency depth: leaves (db) rightmost, entry (web) leftmost
  const depth = (id: string, seen = new Set<string>()): number => {
    const svc = w.services.find((s) => s.id === id);
    if (!svc || svc.deps.length === 0 || seen.has(id)) return 0;
    seen.add(id);
    return 1 + Math.max(...svc.deps.map((d) => depth(d, seen)));
  };
  const ordered = [...w.services].sort((a, b) => depth(b.id) - depth(a.id));
  // keyed in-place update: rebuilding every tick would wipe telestrator
  // rings and selection state mid-pulse
  const key = ordered.map((s) => s.id).join(',');
  if (topologyEl.dataset.key !== key) {
    topologyEl.dataset.key = key;
    topologyEl.innerHTML = ordered
      .map(
        (s, i) => `
        ${i > 0 ? '<span class="topo-link" aria-hidden="true"></span>' : ''}
        <span class="topo-node" data-service="${s.id}">
          <span class="topo-dot"></span>
          <span class="topo-id"></span>
          <span class="topo-ver"></span>
        </span>`
      )
      .join('');
    topologyEl.querySelectorAll('.topo-node').forEach((node, i) => {
      node.querySelector('.topo-id')!.textContent = ordered[i]!.id;
    });
  }
  for (const s of ordered) {
    const node = topologyEl.querySelector<HTMLElement>(`[data-service="${s.id}"]`)!;
    node.dataset.health = s.health;
    node.querySelector('.topo-ver')!.textContent = s.version;
  }
}

// ---- living site pane (M2-06): the world state, rendered as the product --

const storefront = document.querySelector<HTMLDivElement>('#storefront')!;
const sfBanner = document.querySelector<HTMLDivElement>('.sf-banner')!;
const sfBuy = document.querySelector<HTMLButtonElement>('.sf-buy')!;
const sfFeed = document.querySelector<HTMLDivElement>('.sf-feed')!;
const CHECKOUT_BROKEN_ERR = 0.05;
const ORDER_NO_START = 4021;
let orderNo = ORDER_NO_START;

function renderSite(w: World): void {
  const api = w.services.find((s) => s.id === 'api');
  const checkout = w.traffic.byRoute['/checkout'];
  const state: 'ok' | 'broken' | 'down' =
    api?.health === 'down'
      ? 'down'
      : checkout && checkout.errRate > CHECKOUT_BROKEN_ERR
        ? 'broken'
        : 'ok';
  storefront.dataset.state = state;

  if (state === 'ok') {
    sfBanner.textContent = '';
    sfBuy.textContent = 'Checkout — $48.00';
    if (checkout && checkout.rps > 0) {
      orderNo += 1;
      sfFeed.textContent = `✓ order #${orderNo} confirmed · ${checkout.rps}/s checking out`;
    }
  } else if (state === 'broken') {
    sfBanner.textContent = `Checkout is failing — ${(checkout!.errRate * 100).toFixed(0)}% of payments erroring`;
    sfBuy.textContent = 'Payment failed — try again';
    sfFeed.textContent = `✗ ${Math.round(checkout!.rps * checkout!.errRate)}/s checkouts failing`;
  }
  // 'down' shows the outage overlay via CSS; feed/banner stay as they were
}

// ---- stream rendering ----------------------------------------------------

function applyHealth(w: World): void {
  const worst = w.services.reduce<Health>(
    (acc, s) => (SEVERITY[s.health] > SEVERITY[acc] ? s.health : acc),
    'ok'
  );
  if (document.documentElement.dataset.health !== worst) setHealth(worst);
  renderSituation(w, worst);
  const phase = document.querySelector<HTMLElement>('#situation')!.dataset.phase!;
  discloseFor(phase);
  revealSiteOnTrouble(phase);
}

/**
 * ZONE 1 — the console's status readout.
 *
 * Deliberately NOT prose. An earlier pass wrote this as sentences (borrowed
 * from incident.io's post-hoc incident summaries) and it read as a slide
 * rather than as instrumentation. A control system states the world in
 * LABELLED FIELDS — state, elapsed, magnitude, cause, impact — terse, tabular,
 * machine-tight. Every value is still derived from the event log.
 */
let simNowMs = 0;

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `T+${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * The impact row. Card anatomy borrowed from Vercel's observability cards —
 * label, then a BIG value, then the context line — because a console's
 * headline numbers should be readable across a room, not 11px.
 */
function renderStats(w: World, worst: Health): void {
  const el = document.querySelector<HTMLElement>('#stats')!;
  if (w.services.length === 0) {
    el.innerHTML = '';
    return;
  }
  const checkoutErr = w.traffic.byRoute['/checkout']?.errRate ?? w.traffic.errRate;
  const tone = worst === 'down' ? 'bad' : worst === 'degraded' ? 'warn' : 'ok';
  const cards: Array<{ k: string; v: string; sub: string; tone?: string }> = [
    {
      k: 'Checkout error rate',
      v: `${(checkoutErr * 100).toFixed(1)}%`,
      sub: `${w.traffic.rps} req/s across all routes`,
      tone,
    },
    {
      k: 'Customers affected',
      v: String(w.damage.usersErrored),
      sub: `${w.damage.ticketsOpened} support tickets opened`,
      tone: w.damage.usersErrored > 0 ? tone : undefined,
    },
    {
      k: 'Revenue lost',
      v: `$${w.damage.revenueLost.toFixed(2)}`,
      sub: 'Σ rps × err × value per request',
      tone: w.damage.revenueLost > 0 ? tone : undefined,
    },
    {
      k: 'Elapsed',
      v: clock(simNowMs).replace('T+', ''),
      sub: `p95 ${w.traffic.p95}ms`,
    },
  ];
  el.innerHTML = cards
    .map(
      (c) => `<div class="stat"${c.tone ? ` data-tone="${c.tone}"` : ''}>
        <div class="stat-k">${c.k}</div>
        <div class="stat-v">${c.v}</div>
        <div class="stat-sub">${c.sub}</div>
      </div>`
    )
    .join('');
}

function renderSituation(w: World, worst: Health): void {
  renderStats(w, worst);
  const hasDeploys = w.deploys.length > 0;
  document.querySelector<HTMLElement>('#deploys-empty')!.hidden = hasDeploys;
  document.querySelector<HTMLElement>('#stream-empty')!.hidden =
    (document.querySelector('#event-stream')?.childElementCount ?? 0) > 0;
  const zone = document.querySelector<HTMLElement>('#situation')!;
  const state = document.querySelector<HTMLElement>('#sit-state')!;
  const head = document.querySelector<HTMLElement>('#sit-head')!;
  const fields = document.querySelector<HTMLElement>('#sit-fields')!;
  document.querySelector<HTMLElement>('#sit-clock')!.textContent = clock(simNowMs);

  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const checkoutErr = w.traffic.byRoute['/checkout']?.errRate ?? w.traffic.errRate;
  const live = [...w.deploys].reverse().find((d) => d.status === 'live');
  const bad = w.services.filter((s) => s.health !== 'ok');

  const put = (rows: Array<[string, string, string?]>): void => {
    fields.innerHTML = rows
      .map(
        ([k, v, tone]) =>
          `<div class="sit-f"><dt>${k}</dt><dd${tone ? ` data-tone="${tone}"` : ''}>${v}</dd></div>`
      )
      .join('');
  };

  // an unanswered proposal outranks the world: it is what the console is for
  const pending = [...pendingCards.values()][0];
  if (pending) {
    const diff = pending.card.querySelector('.ap-diff')?.textContent ?? 'pending change';
    const tier = pending.card.querySelector('.ap-tier')?.textContent ?? '';
    zone.dataset.phase = 'decide';
    state.textContent = 'PROPOSAL PENDING';
    head.textContent = 'OPERATOR DECISION REQUIRED';
    put([
      ['ACTION', diff],
      ['TIER', tier.replace(/\s+/g, ' ').trim() || '—'],
      ['APPLIED', 'nothing — airlock holding', 'hold'],
    ]);
    return;
  }

  if (worst === 'down') {
    zone.dataset.phase = 'down';
    state.textContent = 'OUTAGE';
    head.textContent = `${bad.map((s) => s.name.toUpperCase()).join(' / ')} DOWN`;
    put([
      ['ERR', `${pct(checkoutErr)} /checkout`, 'bad'],
      ['SVC', bad.map((s) => `${s.id} ${s.health}`).join(' · '), 'bad'],
      ['CAUSE', live ? `${live.id} ${live.note ?? live.version}` : 'unknown'],
      ['IMPACT', `${w.damage.usersErrored} users · $${w.damage.revenueLost.toFixed(2)}`, 'bad'],
    ]);
    return;
  }

  if (worst === 'degraded') {
    zone.dataset.phase = 'incident';
    state.textContent = 'INCIDENT ACTIVE';
    head.textContent = 'CHECKOUT FAILING';
    put([
      ['ERR', `${pct(checkoutErr)} /checkout`, 'warn'],
      ['SVC', bad.map((s) => `${s.id} ${s.health}`).join(' · ') || '—', 'warn'],
      ['CAUSE', live ? `${live.id} ${live.note ?? live.version}` : 'unknown'],
      ['IMPACT', `${w.damage.usersErrored} users · $${w.damage.revenueLost.toFixed(2)}`, 'warn'],
    ]);
    return;
  }

  zone.dataset.phase = 'calm';
  if (w.services.length === 0) {
    state.textContent = 'STANDBY';
    head.textContent = 'NO SCENARIO RUNNING';
    fields.innerHTML = '';
    return;
  }
  const recovered = w.damage.revenueLost > 0;
  state.textContent = recovered ? 'RECOVERED' : 'NOMINAL';
  head.textContent = recovered ? 'CHECKOUT RESTORED' : 'ALL SYSTEMS RESPONDING';
  put([
    ['ERR', `${pct(checkoutErr)} /checkout`, 'ok'],
    ['SVC', `${w.services.length}/${w.services.length} ok`, 'ok'],
    ['LIVE', live ? `${live.id} ${live.service} ${live.version}` : '—'],
    ...(recovered
      ? ([['COST', `${w.damage.usersErrored} users · $${w.damage.revenueLost.toFixed(2)}`]] as Array<[string, string]>)
      : []),
  ]);
}

/**
 * Progressive disclosure, driven by the phase rather than by the user
 * hunting: a zone opens when it starts mattering, and is never auto-closed
 * (closing is the human's call — a view that collapses under you is worse
 * than one that shows too much).
 */
function discloseFor(phase: string): void {
  const open = (id: string): void => {
    const el = document.querySelector<HTMLDetailsElement>(id);
    if (el && !el.open) el.open = true;
  };
  if (phase === 'incident' || phase === 'down' || phase === 'decide') {
    open('#zone-changed');
    open('#zone-controls');
  }
}

function renderEvents(events: Event[], w: World): void {
  world = w;
  if (events.length) simNowMs = events[events.length - 1]!.t;
  for (const e of events) {
    const li = document.createElement('li');
    li.dataset.kind = e.kind;
    li.dataset.actor = e.actor;
    li.dataset.causedBy = e.causedBy !== undefined ? String(e.causedBy) : '';
    li.innerHTML = `<span class="ev-t">${(e.t / 1000).toFixed(0)}s</span><span class="ev-kind">${e.kind}</span><span class="ev-summary"></span>`;
    li.querySelector('.ev-summary')!.textContent = summarize(e);
    streamEl.append(li);

    if (e.kind === 'traffic.tick') {
      pushTele(e.data as { rps: number; errRate: number; p95: number });
    } else if (e.kind === 'action.proposed') addApprovalCard(e);
    else if (e.kind === 'action.approved' || e.kind === 'action.rejected') {
      resolveApprovalCard((e.data as { proposalSeq: number }).proposalSeq);
    } else if (e.kind === 'annotation.added' && e.actor === 'agent') {
      telestrate((e.data as { target: EntityRef }).target);
    }
    if (e.actor === 'agent') moveAgentCursor(agentTargetFor(e));
  }
  // cap the stream DOM, but never evict the agency trail — the audit view is
  // this same DOM filtered by CSS, and action/mode rows are its whole point
  const AUDIT_KINDS = /^action\.|^tool\.called$|^mode\.changed$/;
  let victim = streamEl.firstElementChild;
  while (streamEl.children.length > 200 && victim) {
    const next = victim.nextElementSibling;
    if (!AUDIT_KINDS.test((victim as HTMLElement).dataset.kind ?? '')) victim.remove();
    victim = next;
  }
  streamEl.scrollTop = streamEl.scrollHeight;

  eventCount += events.length;
  statusEl.textContent = `tick ${tickCount} · ${eventCount} events · seed ${SEED}`;

  renderDeck(w);
  renderSite(w);
  applyHealth(w);
  applySelectionVisual(); // topology re-renders wipe data-selected; restore
  document.querySelector('#damage-val')!.textContent = `$${w.damage.revenueLost.toFixed(2)}`;
}

worker.onmessage = (e: MessageEvent<SimResponse>) => {
  const msg = e.data;
  if (msg.type === 'events') {
    if (msg.origin === 'step') tickCount++;
    renderEvents(msg.events, msg.world);
  } else if (msg.type === 'snapshot') {
    // post-seed pull: fold setup state into the deck without streaming it
    world = msg.world;
    renderDeck(msg.world);
    renderSite(msg.world);
    applyHealth(msg.world);
  } else if (msg.type === 'queryResult') {
    pendingQueries.get(msg.id)?.(msg.result);
    pendingQueries.delete(msg.id);
  } else if (msg.type === 'proposeResult') {
    pendingProposes.get(msg.id)?.({ seq: msg.seq, outcome: msg.outcome, reason: msg.reason });
    pendingProposes.delete(msg.id);
  } else if (msg.type === 'error') {
    // settle any pending tool promise so the agent gets an error instead of
    // an unbounded hang; the id says which request threw
    if (msg.id !== undefined) {
      pendingQueries.get(msg.id)?.({ error: msg.message });
      pendingQueries.delete(msg.id);
      pendingProposes.get(msg.id)?.({ seq: -1, outcome: 'blocked', reason: `sim-error: ${msg.message}` });
      pendingProposes.delete(msg.id);
    }
    console.error('[sim]', msg.message);
    statusEl.textContent = `sim error: ${msg.message}`;
  }
};

runBtn.addEventListener('click', () => {
  running = !running;
  syncPacer();
});

// ---- WebMCP tool surface (M3-01: reads) ----------------------------------

/**
 * What the agent can do RIGHT NOW, said the way an operator would say it.
 * Derived from the live surface, so it can never drift from the real tools —
 * the raw names stay available underneath for anyone who wants them.
 */
const HUMAN_WRITE: Record<string, string> = {
  propose_flag_change: 'turn a feature flag on or off',
  propose_rollback: 'roll a deploy back',
  propose_rollforward: 'ship a fixed build forward',
  propose_env_change: 'change an environment value',
  propose_route_change: 'move traffic to another target',
};

function renderCapability(tools: AirlockTools): void {
  const active = tools.list().filter((t) => t.status === 'active');
  const writes = active.filter((t) => !t.readOnly);
  const readEl = document.querySelector<HTMLElement>('#can-read')!;
  const writeEl = document.querySelector<HTMLElement>('#can-write')!;
  const countEl = document.querySelector<HTMLElement>('#tool-count')!;

  readEl.textContent = `Can look at deploys, logs, traffic and what changed — ${active.length - writes.length} read-only checks.`;

  if (writes.length === 0) {
    writeEl.textContent = 'Cannot change anything in this mode.';
    writeEl.dataset.tone = 'none';
  } else {
    const phrases = writes.map((w) => HUMAN_WRITE[w.name] ?? w.name);
    const last = phrases.pop();
    writeEl.textContent = `Can ask you to ${phrases.length ? `${phrases.join(', ')} or ${last}` : last}. You approve before anything happens.`;
    writeEl.dataset.tone = 'write';
  }
  countEl.textContent = String(active.length);

  const sub = document.querySelector<HTMLElement>('#rail-sub');
  if (sub) sub.textContent = writes.length === 0 ? 'read-only' : `${writes.length} actions need you`;
}

function renderToolRail(tools: AirlockTools): void {
  const list = document.querySelector<HTMLUListElement>('#tool-list')!;
  list.innerHTML = '';
  for (const t of tools.list()) {
    const li = document.createElement('li');
    li.dataset.tool = t.name;
    li.dataset.status = t.status;
    li.innerHTML = `
      <span class="tool-name"></span>
      <span class="tool-badges">
        ${t.status === 'tombstoned' ? '<span class="tool-badge tool-badge-tombstone"></span>' : ''}
        ${t.status === 'active' ? `<span class="tool-badge">${t.readOnly ? 'read' : 'write'}</span>` : ''}
        ${t.untrusted ? '<span class="tool-badge tool-badge-untrusted">untrusted content</span>' : ''}
      </span>
    `;
    li.querySelector('.tool-name')!.textContent = t.name;
    if (t.status === 'tombstoned') {
      // The vanishing is the point, and it has to read in one glance — the
      // full reason ("left with recovery mode") wrapped to two ragged lines.
      // Short label on screen, exact reason on hover; explain_surface carries
      // the long form for anyone who asks the agent.
      const badge = li.querySelector<HTMLElement>('.tool-badge-tombstone')!;
      badge.textContent = 'removed';
      if (t.tombstone) badge.title = t.tombstone;
      li.title = t.tombstone ?? '';
    }
    list.append(li);
  }
  document.querySelectorAll<HTMLButtonElement>('#mode-switch [data-mode]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.mode === tools.mode()));
  });
  renderCapability(tools);
}

const airlockTools = createAirlockTools(runWorkerQuery, proposeToWorker);
renderToolRail(airlockTools);

// mode switching is the operator's ritual: swap the surface, record the
// mode.changed event (with the registration diff) into the same log
document.querySelector('#mode-switch')!.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-mode]');
  if (!btn) return;
  const to = btn.dataset.mode as Mode;
  const { from, added, removed } = airlockTools.setMode(to);
  if (from === to) return;
  send({
    type: 'record',
    kind: 'mode.changed',
    actor: 'human',
    data: { from, to, toolsAdded: added, toolsRemoved: removed, reason: 'operator switched mode in console' },
  });
  renderToolRail(airlockTools);
});

// boot: seed() touches deck + storefront elements, so it runs after every
// element ref above is initialized
seed(TEMPLATE_ID);

// Test hooks (smoke): in-page determinism probe + live stream counters.
declare global {
  interface Window {
    __sim: {
      digest(seed: number, ticks: number): string;
      stats: { events: number; ticks: number };
    };
    /** Tool surface via the same execute path WebMCP uses (Playwright/dev). */
    __airlock: AirlockTools;
  }
}
window.__airlock = airlockTools;
window.__sim = {
  digest(seed, ticks) {
    const engine = new Engine({ templateId: 'baseline', seed });
    engine.step(ticks);
    return JSON.stringify(engine.events);
  },
  get stats() {
    return { events: eventCount, ticks: tickCount };
  },
};
