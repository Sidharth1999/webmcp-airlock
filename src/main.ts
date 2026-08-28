import './styles/tokens.css';
import './styles/shell.css';
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
      <header>Console</header>
      <div class="body">
        <div class="placeholder">Event stream renders here (M2).<br/>One append-only log; everything derives.</div>
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
