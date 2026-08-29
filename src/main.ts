import './styles/tokens.css';
import './styles/shell.css';
import { Engine } from './sim/engine';
import type { QueryRequest } from './sim/queries';
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
const TEMPLATE_ID = templateIds().includes(requestedTemplate)
  ? requestedTemplate
  : DEFAULT_TEMPLATE;
const TICK_INTERVAL_MS = Number(params.get('tick')) || 500;
const DEV_MODE = params.get('dev') === '1';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <div class="shell">
    <div class="masthead">
      <span class="health-lamp" aria-hidden="true"></span>
      <span class="wordmark">Release Airlock</span>
      <span class="health-word" id="health-word">Nominal</span>
      <span class="spacer"></span>
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
        <select id="template-pick" data-testid="template-pick" title="scenario template">
          ${templateIds()
            .map((id) => `<option value="${id}">${id}</option>`)
            .join('')}
        </select>
        <button type="button" id="sim-run" data-testid="sim-run" aria-pressed="false">Run sim</button>
      </header>
      <div id="control-deck" data-testid="control-deck">
        <div class="deck-head">
          <span class="deck-label">Controls</span>
          <span id="sim-status" data-testid="sim-status">seeded · paused</span>
        </div>
        <div id="flag-controls"></div>
        <div id="service-controls"></div>
        <div id="deploy-controls"></div>
      </div>
      <div class="body">
        <ol id="event-stream" data-testid="event-stream" aria-live="polite"></ol>
      </div>
    </section>

    <section class="pane" id="site-pane" aria-label="Site pane">
      <header>Live Site</header>
      <div class="body">
        <div id="storefront" data-testid="storefront" data-state="ok">
          <div class="sf-chrome">
            <span class="sf-brand">aperture supply co.</span>
            <span class="sf-nav">shop · about · cart (1)</span>
          </div>
          <div class="sf-banner" data-testid="sf-banner" role="status"></div>
          <div class="sf-grid">
            <div class="sf-card"><div class="sf-img sf-img-a"></div><div class="sf-name">field jacket</div><div class="sf-price">$128</div></div>
            <div class="sf-card"><div class="sf-img sf-img-b"></div><div class="sf-name">canvas tote</div><div class="sf-price">$42</div></div>
            <div class="sf-card"><div class="sf-img sf-img-c"></div><div class="sf-name">trail bottle</div><div class="sf-price">$28</div></div>
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

    <section class="pane" id="tool-rail" aria-label="Tool rail">
      <header>Tool Surface</header>
      <div class="body">
        <div class="rail-status">WebMCP on this page: <span id="webmcp-status">…</span></div>
        <ul id="tool-list" data-testid="tool-list"></ul>
        <div class="placeholder rail-note">Write tools are mode-gated: they appear here only as the incident unlocks them, behind approval (M3-02+). Tombstones will narrate every change to this surface.</div>
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
function runWorkerQuery(q: QueryRequest): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const id = ++queryId;
    pendingQueries.set(id, resolve);
    send({ type: 'query', id, query: q });
  });
}

const streamEl = document.querySelector<HTMLOListElement>('#event-stream')!;
const statusEl = document.querySelector('#sim-status')!;
const runBtn = document.querySelector<HTMLButtonElement>('#sim-run')!;
const templatePick = document.querySelector<HTMLSelectElement>('#template-pick')!;
let running = false;
let pacer: number | undefined;
let eventCount = 0;
let tickCount = 0;
let world: World | null = null;

templatePick.value = TEMPLATE_ID;

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
  flagControls.innerHTML = '';
  serviceControls.innerHTML = '';
  deployControls.innerHTML = '';
  eventCount = 0;
  tickCount = 0;
  world = null;
  orderNo = ORDER_NO_START;
  storefront.dataset.state = 'ok';
  sfBanner.textContent = '';
  sfBuy.textContent = 'Checkout — $48.00';
  sfFeed.textContent = '';
  setHealth('ok');
  statusEl.textContent = 'seeded · paused';
  send({ type: 'seed', templateId, seed: SEED });
  // setup events aren't streamed by 'seed'; pull them so the deck has state
  send({ type: 'snapshot' });
}

templatePick.addEventListener('change', () => seed(templatePick.value));

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
      <div class="dc-head">
        <span class="dc-id"></span>
        <span class="dc-target"></span>
        <span class="dc-status"></span>
      </div>
      <div class="dc-note"></div>
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
    card.querySelector('.dc-id')!.textContent = deploy.id;
    card.querySelector('.dc-target')!.textContent = `${deploy.service}@${deploy.version} · ${deploy.author}`;
    card.querySelector('.dc-note')!.textContent = deploy.note ? `“${deploy.note}”` : '';
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

document.querySelector('#control-deck')!.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
  if (!btn || btn.disabled || !world) return;
  switch (btn.dataset.act) {
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
}

function renderEvents(events: Event[], w: World): void {
  world = w;
  for (const e of events) {
    const li = document.createElement('li');
    li.dataset.kind = e.kind;
    li.dataset.actor = e.actor;
    li.dataset.causedBy = e.causedBy !== undefined ? String(e.causedBy) : '';
    li.innerHTML = `<span class="ev-t">${(e.t / 1000).toFixed(0)}s</span><span class="ev-kind">${e.kind}</span><span class="ev-summary"></span>`;
    li.querySelector('.ev-summary')!.textContent = summarize(e);
    streamEl.append(li);
  }
  while (streamEl.children.length > 200) streamEl.firstElementChild!.remove();
  streamEl.lastElementChild?.scrollIntoView({ block: 'nearest' });

  eventCount += events.length;
  statusEl.textContent = `tick ${tickCount} · ${eventCount} events · seed ${SEED}`;

  renderDeck(w);
  renderSite(w);
  applyHealth(w);
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
  } else if (msg.type === 'error') {
    statusEl.textContent = `sim error: ${msg.message}`;
  }
};

runBtn.addEventListener('click', () => {
  running = !running;
  syncPacer();
});

// ---- WebMCP tool surface (M3-01: reads) ----------------------------------

function renderToolRail(tools: AirlockTools): void {
  const list = document.querySelector<HTMLUListElement>('#tool-list')!;
  list.innerHTML = '';
  for (const t of tools.list()) {
    const li = document.createElement('li');
    li.dataset.tool = t.name;
    li.innerHTML = `
      <span class="tool-name"></span>
      <span class="tool-badges">
        ${t.readOnly ? '<span class="tool-badge">read</span>' : ''}
        ${t.untrusted ? '<span class="tool-badge tool-badge-untrusted">untrusted content</span>' : ''}
      </span>
    `;
    li.querySelector('.tool-name')!.textContent = t.name;
    list.append(li);
  }
}

const airlockTools = createAirlockTools(runWorkerQuery);
renderToolRail(airlockTools);

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
