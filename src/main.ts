import './styles/tokens.css';
import './styles/shell.css';
import { Engine } from './sim/engine';
import type { SimRequest, SimResponse } from './sim/worker';
import type { Event, World } from './sim/types';
import { hasWebMCP } from './webmcp/shim';

type Health = 'ok' | 'degraded' | 'down';
const HEALTH_STATES: Health[] = ['ok', 'degraded', 'down'];

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <div class="shell">
    <div class="masthead">
      <span class="health-lamp" aria-hidden="true"></span>
      <span class="wordmark">Release Airlock</span>
      <span class="health-word" id="health-word">Nominal</span>
      <span class="spacer"></span>
      <div class="health-demo" id="health-demo" title="token demo — sim drives this from M2">
        ${HEALTH_STATES.map(
          (s) => `<button type="button" data-health-set="${s}" aria-pressed="${s === 'ok'}">${s}</button>`
        ).join('')}
      </div>
    </div>

    <section class="pane" id="console" aria-label="Console">
      <header>
        Console
        <button type="button" id="sim-run" data-testid="sim-run" aria-pressed="false">Run sim</button>
        <span id="sim-status" data-testid="sim-status">seeded · paused</span>
      </header>
      <div class="body">
        <ol id="event-stream" data-testid="event-stream" aria-live="polite"></ol>
      </div>
    </section>

    <section class="pane" id="site-pane" aria-label="Site pane">
      <header>Live Site</header>
      <div class="body">
        <div class="placeholder">The living product renders here (M2).<br/>The bad deploy breaks it; recovery heals it — visibly.</div>
      </div>
    </section>

    <section class="pane" id="tool-rail" aria-label="Tool rail">
      <header>Tool Surface</header>
      <div class="body">
        <div class="placeholder">Mode-gated tools + tombstones render here (M3).<br/>WebMCP on this page: <span id="webmcp-status">…</span></div>
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

document.querySelector('#health-demo')!.addEventListener('click', (e) => {
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
const TICK_INTERVAL_MS = 500;

const worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
const send = (msg: SimRequest) => worker.postMessage(msg);
send({ type: 'seed', templateId: 'baseline', seed: SEED });

const streamEl = document.querySelector<HTMLOListElement>('#event-stream')!;
const statusEl = document.querySelector('#sim-status')!;
const runBtn = document.querySelector<HTMLButtonElement>('#sim-run')!;
let pacer: number | undefined;
let eventCount = 0;
let tickCount = 0;

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
    default:
      return JSON.stringify(d);
  }
}

function renderEvents(events: Event[], world: World): void {
  for (const e of events) {
    const li = document.createElement('li');
    li.dataset.kind = e.kind;
    li.dataset.causedBy = e.causedBy !== undefined ? String(e.causedBy) : '';
    li.innerHTML = `<span class="ev-t">${(e.t / 1000).toFixed(0)}s</span><span class="ev-kind">${e.kind}</span><span class="ev-summary"></span>`;
    li.querySelector('.ev-summary')!.textContent = summarize(e);
    streamEl.append(li);
  }
  while (streamEl.children.length > 200) streamEl.firstElementChild!.remove();
  streamEl.lastElementChild?.scrollIntoView({ block: 'nearest' });

  eventCount += events.length;
  statusEl.textContent = `seed ${SEED} · tick ${tickCount} · ${eventCount} events`;

  const worst = world.services.reduce<Health>(
    (acc, s) => (SEVERITY[s.health] > SEVERITY[acc] ? s.health : acc),
    'ok'
  );
  if (document.documentElement.dataset.health !== worst) setHealth(worst);
}

worker.onmessage = (e: MessageEvent<SimResponse>) => {
  const msg = e.data;
  if (msg.type === 'events') {
    tickCount++;
    renderEvents(msg.events, msg.world);
  } else if (msg.type === 'error') {
    statusEl.textContent = `sim error: ${msg.message}`;
  }
};

runBtn.addEventListener('click', () => {
  if (pacer === undefined) {
    pacer = window.setInterval(() => send({ type: 'step' }), TICK_INTERVAL_MS);
    runBtn.textContent = 'Pause sim';
    runBtn.setAttribute('aria-pressed', 'true');
  } else {
    window.clearInterval(pacer);
    pacer = undefined;
    runBtn.textContent = 'Run sim';
    runBtn.setAttribute('aria-pressed', 'false');
  }
});

// Test hooks (smoke): in-page determinism probe + live stream counters.
declare global {
  interface Window {
    __sim: {
      digest(seed: number, ticks: number): string;
      stats: { events: number; ticks: number };
    };
  }
}
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
