import './styles/tokens.css';
import './styles/shell.css';
import { Engine } from './sim/engine';
import { MODES, type Mode } from './sim/modes';
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
        <select id="template-pick" data-testid="template-pick" title="scenario template">
          ${templateIds()
            .map((id) => `<option value="${id}">${id}</option>`)
            .join('')}
        </select>
        <button type="button" id="sim-run" data-testid="sim-run" aria-pressed="false">Run sim</button>
      </header>
      <div id="control-deck" data-testid="control-deck">
        <div id="topology" data-testid="topology"></div>
        <div class="deck-head">
          <span class="deck-label">Controls</span>
          <button type="button" id="audit-toggle" data-testid="audit-toggle" aria-pressed="false" title="show only the action/audit trail">audit</button>
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
          <div class="sf-hero">
            <span class="sf-hero-kicker">new for fall</span>
            <span class="sf-hero-line">Field-tested goods, guaranteed for the long trail.</span>
          </div>
          <div class="sf-banner" data-testid="sf-banner" role="status"></div>
          <div class="sf-grid">
            <div class="sf-card"><div class="sf-img sf-img-a"></div><div class="sf-name">field jacket</div><div class="sf-price">$128</div></div>
            <div class="sf-card"><div class="sf-img sf-img-b"></div><div class="sf-name">canvas tote</div><div class="sf-price">$42</div></div>
            <div class="sf-card"><div class="sf-img sf-img-c"></div><div class="sf-name">trail bottle</div><div class="sf-price">$28</div></div>
            <div class="sf-card"><div class="sf-img sf-img-d"></div><div class="sf-name">wool beanie</div><div class="sf-price">$34</div></div>
            <div class="sf-card"><div class="sf-img sf-img-e"></div><div class="sf-name">camp mug</div><div class="sf-price">$22</div></div>
            <div class="sf-card"><div class="sf-img sf-img-f"></div><div class="sf-name">dry sack</div><div class="sf-price">$36</div></div>
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
      <header>
        Tools
        <div class="mode-switch" id="mode-switch" data-testid="mode-switch">
          ${MODES.map(
            (m) =>
              `<button type="button" data-mode="${m}" data-testid="mode-${m}" aria-pressed="${m === 'triage'}">${m}</button>`
          ).join('')}
        </div>
      </header>
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
  for (const { card } of pendingCards.values()) card.remove();
  pendingCards.clear();
  flagControls.innerHTML = '';
  serviceControls.innerHTML = '';
  deployControls.innerHTML = '';
  eventCount = 0;
  tickCount = 0;
  world = null;
  orderNo = ORDER_NO_START;
  resetTele();
  storefront.dataset.state = 'ok';
  sfBanner.textContent = '';
  sfBuy.textContent = 'Checkout — $48.00';
  sfFeed.textContent = '';
  setHealth('ok');
  statusEl.textContent = 'seeded · paused';
  airlockTools.setMode('triage'); // fresh world, fresh ritual
  renderToolRail(airlockTools);
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
  };
  const card = document.createElement('div');
  card.className = 'approval-card';
  card.dataset.proposalSeq = String(e.seq);
  card.dataset.tier = String(d.tier);
  card.dataset.testid = `approval-${e.seq}`;
  const dualKey = d.tier === 4;
  card.innerHTML = `
    <div class="ap-head">
      <span class="ap-actor">agent proposes</span>
      <span class="ap-tier">tier ${d.tier} · ${d.tierName}${dualKey ? ' · dual-key' : ''}</span>
    </div>
    <div class="ap-diff"></div>
    ${
      dualKey
        ? `<label class="ap-key"><input type="checkbox" class="ap-key-toggle" data-testid="key-${e.seq}"><span>engage key — held while the agent executes</span></label>`
        : ''
    }
    <div class="ap-actions">
      <button type="button" class="ctl-btn ap-approve" data-act="approve" data-seq="${e.seq}" data-testid="approve-${e.seq}" ${dualKey ? 'disabled' : ''}>Approve</button>
      <button type="button" class="ctl-btn ap-reject" data-act="reject" data-seq="${e.seq}" data-testid="reject-${e.seq}">Reject</button>
    </div>
  `;
  card.querySelector('.ap-diff')!.textContent = d.diffSummary;
  card.querySelector<HTMLInputElement>('.ap-key-toggle')?.addEventListener('change', (ev) => {
    const engaged = (ev.target as HTMLInputElement).checked;
    card.querySelector<HTMLButtonElement>('.ap-approve')!.disabled = !engaged;
  });
  const anchor = anchorFor(d.tool, d.input);
  if (anchor) {
    anchor.insertAdjacentElement('afterend', card);
    anchor.classList.add('proposal-anchor');
  } else {
    document.querySelector('#control-deck .deck-head')!.insertAdjacentElement('afterend', card);
  }
  pendingCards.set(e.seq, { card, anchor });
}

function resolveApprovalCard(proposalSeq: number): void {
  const entry = pendingCards.get(proposalSeq);
  if (!entry) return;
  entry.card.remove();
  entry.anchor?.classList.remove('proposal-anchor');
  pendingCards.delete(proposalSeq);
}

document.querySelector('#audit-toggle')!.addEventListener('click', () => {
  const btn = document.querySelector<HTMLButtonElement>('#audit-toggle')!;
  const on = btn.getAttribute('aria-pressed') !== 'true';
  btn.setAttribute('aria-pressed', String(on));
  streamEl.classList.toggle('audit', on);
});

document.querySelector('#control-deck')!.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
  if (!btn || btn.disabled || !world) return;
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

function renderTele(): void {
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
  topologyEl.innerHTML = ordered
    .map(
      (s, i) => `
      ${i > 0 ? '<span class="topo-link" aria-hidden="true"></span>' : ''}
      <span class="topo-node" data-health="${s.health}" data-service="${s.id}">
        <span class="topo-dot"></span>
        <span class="topo-id"></span>
        <span class="topo-ver"></span>
      </span>`
    )
    .join('');
  topologyEl.querySelectorAll('.topo-node').forEach((node, i) => {
    node.querySelector('.topo-id')!.textContent = ordered[i]!.id;
    node.querySelector('.topo-ver')!.textContent = ordered[i]!.version;
  });
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

    if (e.kind === 'traffic.tick') {
      pushTele(e.data as { rps: number; errRate: number; p95: number });
    } else if (e.kind === 'action.proposed') addApprovalCard(e);
    else if (e.kind === 'action.approved' || e.kind === 'action.rejected') {
      resolveApprovalCard((e.data as { proposalSeq: number }).proposalSeq);
    }
  }
  while (streamEl.children.length > 200) streamEl.firstElementChild!.remove();
  streamEl.lastElementChild?.scrollIntoView({ block: 'nearest' });

  eventCount += events.length;
  statusEl.textContent = `tick ${tickCount} · ${eventCount} events · seed ${SEED}`;

  renderDeck(w);
  renderSite(w);
  applyHealth(w);
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
      li.querySelector('.tool-badge-tombstone')!.textContent = t.tombstone ?? 'removed';
    }
    list.append(li);
  }
  document.querySelectorAll<HTMLButtonElement>('#mode-switch [data-mode]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.mode === tools.mode()));
  });
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
