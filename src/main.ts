import './styles/tokens.css';
import './styles/shell.css';
import { actionKey } from './harness/metrics';
import { WRITE_ACTIONS } from './sim/vocabulary';
import { Engine } from './sim/engine';
import { MODES, MODE_WRITE_TOOLS, type Mode } from './sim/modes';
import type { EntityRef, QueryRequest } from './sim/queries';
import { templateIds } from './sim/templates';
import type { SimRequest, SimResponse } from './sim/worker';
import type { Actor, Deploy, Event, Flag, World } from './sim/types';
import { hasWebMCP } from './webmcp/shim';
import { createAirlockTools, type AirlockTools } from './webmcp/tools';
import { filmScene, play, type PlayState } from './walkthrough';

type Health = 'ok' | 'degraded' | 'down';
const HEALTH_STATES: Health[] = ['ok', 'degraded', 'down'];
const DEFAULT_TEMPLATE = 'migration-trap';

// ?template= picks the scenario, ?tick= paces the sim (ms/tick, tests run
// fast), ?dev=1 shows the manual health buttons (token demo, M1 leftover).
// ?run=1 presses Run sim on load and ?site=1 opens the storefront on load:
// together they are the landing URL for someone arriving cold, who should
// find themselves inside the incident rather than in front of a nominal
// console and a button. Absent, nothing changes.
const params = new URLSearchParams(location.search);
const requestedTemplate = params.get('template') ?? DEFAULT_TEMPLATE;
const AUTO_RUN = params.get('run') === '1';
// ?host=1 (DEV ONLY): stand in for an attached WebMCP host so the held
// approval can be driven by Playwright on a build with no host. Production
// detects the host itself (`hasWebMCP`) and ignores the param.
const HOST_FORCED = import.meta.env.DEV && params.get('host') === '1';
/** A client is on the other end of the tool surface — the same test the status bar prints. */
function hostAttached(): boolean {
  return HOST_FORCED || hasWebMCP();
}
// ?mode=<stage>: boot with the response stage already moved. Composes with
// every other boot param; an unknown or absent value leaves the default.
const BOOT_MODE = (MODES as readonly string[]).includes(params.get('mode') ?? '')
  ? (params.get('mode') as Mode)
  : null;
const OPEN_SITE = params.get('site') === '1';
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
  'retry-storm': 'Backlog',
};
/** the fuller phrasing, on hover — the chip itself must stay one word */
const TEMPLATE_TITLES: Record<string, string> = {
  baseline: 'Calm day — nothing is wrong',
  'migration-trap': 'Checkout is failing',
  'innocent-deploy': 'Timeouts spreading across routes',
  'poisoned-runbook': 'Payments failing at checkout',
  'retry-storm': 'Orders backing up — queue growing, latency climbing',
};

const TEMPLATE_ID = templateIds().includes(requestedTemplate)
  ? requestedTemplate
  : DEFAULT_TEMPLATE;
/** the scenario the console is seeded into right now; seed() keeps it */
let currentTemplate = TEMPLATE_ID;

/** the copy affordance beside a prompt: a glyph, not a button with a word */
const COPY_BTN = (testId: string): string =>
  `<button type="button" class="te-copy" data-testid="${testId}" aria-label="Copy" title="Copy">` +
  `<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.2"/><path d="M8 4V2.2A1.2 1.2 0 0 0 6.8 1H2.2A1.2 1.2 0 0 0 1 2.2v4.6A1.2 1.2 0 0 0 2.2 8H4"/></svg>` +
  `</button>`;
const TICK_INTERVAL_MS = Number(params.get('tick')) || 500;
const DEV_MODE = params.get('dev') === '1';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <div class="palette" id="palette" role="dialog" aria-modal="true" aria-label="Run a command" hidden>
    <div class="palette-box">
      <!-- The palette and the agent surface are two projections of the SAME
           twenty verbs, so a pending ask belongs here too. This is where the
           operator reaches for a lever; it is therefore where they should
           find out the agent has already reached for one. Read-only by
           design — the decision itself stays at the gate, in the dock. -->
      <div class="palette-asks" id="palette-asks" data-testid="palette-asks" hidden>
        <p class="pa-head">The agent is asking for</p>
        <div class="pa-list" id="palette-asks-list"></div>
      </div>
      <input id="palette-input" type="text" autocomplete="off" spellcheck="false"
             placeholder="Run a command — try &quot;drain&quot;, &quot;restart&quot;, &quot;status page&quot;"
             aria-label="Search commands" data-testid="palette-input" />
      <div class="palette-list" id="palette-list" role="listbox" data-testid="palette-list"></div>
      <div class="palette-foot"><kbd>↑</kbd><kbd>↓</kbd> to move · <kbd>enter</kbd> to run · <kbd>esc</kbd> to close</div>
    </div>
  </div>

  <div class="sheet" id="surface" role="dialog" aria-modal="true"
       aria-label="What this page lets the agent do" hidden>
    <div class="sheet-box">
      <header class="sheet-head">
        <span class="sheet-title">What this page lets the agent do</span>
        <span class="sheet-sub" id="surface-stage"></span>
        <button type="button" class="dock-close" id="surface-close"
                data-testid="surface-close" aria-label="Close" title="Close  esc">&times;</button>
      </header>
      <ul id="tool-list" data-testid="tool-list"></ul>
      <p class="ladder-foot" id="ladder-foot"></p>
    </div>
  </div>

  <!-- WORKBENCH (2026-09-01). A fixed-viewport app shell, not a document:
       title bar / activity bar / centre / bottom panel group / docks /
       status bar, divided by hairlines and sashes. Nothing scrolls but the
       inside of one region. Replaces a three-column scrolling layout in
       which the controls — the product — sat below the fold. -->
  <div class="shell wb" data-site="off" data-rail="on" data-panel="on">

    <header class="wb-title">
      <span class="health-lamp" aria-hidden="true"></span>
      <span class="wordmark">Release Airlock</span>
      <span class="health-word" id="health-word">Nominal</span>
      <span class="title-div" aria-hidden="true"></span>
      <details class="scenario" id="scenario-pick">
        <summary><span class="sc-k">Scenario</span><span class="sc-v" id="scenario-current"></span></summary>
        <div class="sc-menu" id="template-pick" data-testid="template-pick" role="radiogroup" aria-label="Scenario">
          ${templateIds()
            .map(
              (id) =>
                `<button type="button" role="radio" data-template="${id}" data-testid="template-${id}" aria-checked="${id === TEMPLATE_ID}">
                   <span class="sc-name">${TEMPLATE_LABELS[id] ?? id}</span>
                   <span class="sc-desc">${TEMPLATE_TITLES[id] ?? ''}</span>
                 </button>`
            )
            .join('')}
        </div>
      </details>
      <button type="button" id="sim-run" data-testid="sim-run" aria-pressed="false">Run sim</button>
      <button type="button" class="cmdk" id="cmdk-open" data-testid="cmdk-open"
              aria-label="Run a command">
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5"/><path d="M13 13l4 4"/></svg>
        <span class="cmdk-text">Run a command…</span>
        <kbd>⌘K</kbd>
      </button>
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
    </header>

    <!-- ACTIVITY BAR. Every dock's visibility lives here and nowhere else, so
         a closed dock always has one obvious, permanent way back — the defect
         the masthead toggles never fixed. -->
    <nav class="wb-act" aria-label="Regions">
      <button type="button" class="act-btn" data-testid="act-palette" id="act-palette"
              aria-label="Run a command" title="Run a command  ⌘K">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6.5 7.5 4 10l2.5 2.5M13.5 7.5 16 10l-2.5 2.5M11.5 6l-3 8"/></svg>
      </button>
      <span class="act-div" aria-hidden="true"></span>
      <button type="button" class="act-btn" data-toggle="panel" data-testid="restore-panel"
              aria-pressed="true" aria-label="Evidence panel" title="Evidence — what changed, activity, error rate">
        <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3.5" width="14" height="13" rx="1.5"/><path d="M3 11.5h14"/></svg>
      </button>
      <button type="button" class="act-btn" data-toggle="rail" data-restore="rail" data-testid="restore-rail"
              aria-pressed="true" aria-label="Agent panel" title="Agent">
        <!-- THE AGENT MARK. It was a cartoon robot head — two eyes and an
             antenna — which is the reflexive "AI" pictogram and the one
             thing in this activity bar that was not drawn in the same
             language as the rest of it. It is the diamond the ledger
             already uses for the agent's own claims, so the button that
             opens the agent's column wears the agent's own silhouette. -->
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3.2 16.8 10 10 16.8 3.2 10Z"/><circle cx="10" cy="10" r="2.1" fill="currentColor" stroke="none"/></svg>
      </button>
      <button type="button" class="act-btn" data-toggle="site" data-testid="site-toggle"
              aria-pressed="false" aria-label="Storefront" title="Storefront — what customers see">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 7.5h13v9h-13z"/><path d="M3 7.5 5 3.5h10l2 4"/><path d="M8 16.5v-4h4v4"/></svg>
      </button>
    </nav>

    <!-- CENTRE. Readout and airlock are pinned; only the control grid scrolls,
         and at desk widths it does not need to. -->
    <!-- The console is the document's MAIN landmark. It was a plain
         <section>, which left the page with no <main> at all — an agent or
         a screen reader had no way to skip the chrome to the thing itself.
         <main> and <section> both lay out as blocks; nothing moves. -->
    <main class="wb-centre" id="console" aria-label="Console">
      <div class="readout" id="situation" data-testid="situation" data-phase="calm">
        <div class="ro-state">
          <span class="sit-state" id="sit-state">STANDBY</span>
          <span class="sit-clock" id="sit-clock">T+00:00</span>
        </div>
        <p class="sit-head" id="sit-head">NO SCENARIO RUNNING</p>
        <dl class="sit-fields" id="sit-fields"></dl>
        <section class="stats" id="stats" data-testid="stats"></section>
      </div>

      <div class="cmdbar" id="zone-command-bar">
        <span class="cmdbar-label">Incident command</span>
        <div class="cmd-row" id="cmd-row"></div>
      </div>

      <div class="wb-centre-body">
        <div id="control-deck" data-testid="control-deck">
          <section class="zone" id="zone-controls" data-testid="zone-controls">
            <div class="zone-head">
              <h2 class="zone-title">Response controls</h2>
              <div id="topology" data-testid="topology"></div>
            </div>
            <div class="ctl-groups">
              <section class="ctl-group">
                <h3 class="ctl-group-label">Release</h3>
                <div id="flag-controls"></div>
                <div id="service-controls"></div>
              </section>
              <section class="ctl-group">
                <h3 class="ctl-group-label">Data &amp; DNS</h3>
                <div id="ops-controls"></div>
              </section>
              <section class="ctl-group">
                <h3 class="ctl-group-label">Traffic</h3>
                <div id="route-controls"></div>
              </section>
            </div>
          </section>

          <section class="zone" id="zone-command" data-testid="zone-command">
            <div class="zone-head">
              <h2 class="zone-title">Status page</h2>
              <span class="zone-meta">customers can read this</span>
            </div>
            <div class="statuspage" id="statuspage">
              <div class="sp-posts" id="sp-posts"></div>
              <p class="empty" id="sp-empty">Nothing published. Customers have not been told anything.</p>
            </div>
          </section>

          <section class="zone" id="zone-holding" data-testid="zone-holding">
            <div class="zone-head">
              <h2 class="zone-title">Holding the incident</h2>
              <span class="zone-meta" id="holding-meta"></span>
            </div>
            <div id="holding-list"></div>
            <p class="empty" id="holding-empty">Nothing is being held. No mitigations are in force.</p>
          </section>
        </div>
      </div>

      <div class="wb-sash" data-sash="panel" role="separator" tabindex="0"
           aria-orientation="horizontal" aria-label="Resize the evidence panel"
           aria-controls="wb-panel" aria-valuemin="0" aria-valuemax="100" aria-valuenow="26"></div>

      <!-- EVIDENCE. Three views of one thing, so they are TABS, not three
           stacked panels that each lengthened the scroll. -->
      <section class="wb-panel" id="wb-panel" aria-label="Evidence">
        <div class="panel-tabs">
          <!-- role=tablist may only contain tabs (aria-required-children), and
               this strip also carries the audit toggle and the close button.
               The tabs get their own tablist element inside the strip; the two
               plain buttons are siblings of it, in the same flex row, so the
               strip looks exactly as it did and the tree is legal. -->
          <div class="ptabs" role="tablist" aria-label="Evidence">
            <button type="button" role="tab" class="ptab" data-tab="changed" data-testid="tab-changed"
                    id="tab-changed" aria-controls="zone-changed" aria-selected="true" tabindex="0">
              Deploys<span class="ptab-count" id="tab-changed-count"></span>
            </button>
            <button type="button" role="tab" class="ptab" data-tab="activity" data-testid="tab-activity"
                    id="tab-activity" aria-controls="zone-activity" aria-selected="false" tabindex="-1">
              Activity<span class="ptab-count" id="tab-activity-count"></span>
            </button>
            <button type="button" role="tab" class="ptab" data-tab="logs" data-testid="tab-logs"
                    id="tab-logs" aria-controls="zone-logs" aria-selected="false" tabindex="-1">
              Logs<span class="ptab-count" id="tab-logs-count"></span>
            </button>
            <button type="button" role="tab" class="ptab" data-tab="chart" data-testid="tab-chart"
                    id="tab-chart" aria-controls="err-chart" aria-selected="false" tabindex="-1">
              Error rate
            </button>
          </div>
          <span class="spacer"></span>
          <button type="button" id="audit-toggle" data-testid="audit-toggle" aria-pressed="false"
                  title="filter the stream to who did what">Audit trail</button>
          <button type="button" class="panel-close" data-toggle="panel" data-testid="close-panel" aria-label="Close the evidence panel" title="Close">&times;</button>
        </div>

        <div class="panel-body">
          <div class="tabpane" id="zone-changed" data-testid="zone-changed" role="tabpanel"
               aria-labelledby="tab-changed" tabindex="0">
            <div id="deploy-controls"></div>
            <p class="empty" id="deploys-empty">No deploys in this scenario yet.</p>
          </div>

          <div class="tabpane" id="zone-activity" data-testid="zone-activity" role="tabpanel"
               aria-labelledby="tab-activity" tabindex="0" hidden>
            <ol id="event-stream" data-testid="event-stream" aria-live="polite"></ol>
            <p class="empty" id="stream-empty">Nothing has happened yet.</p>
          </div>

          <div class="tabpane" id="zone-logs" data-testid="zone-logs" role="tabpanel"
               aria-labelledby="tab-logs" tabindex="0" hidden>
            <div class="log-bar">
              <input type="search" id="log-filter" data-testid="log-filter" class="log-find"
                     placeholder="filter lines" aria-label="Filter log lines by text" autocomplete="off" />
              <div class="log-levels" role="group" aria-label="Minimum level">
                <button type="button" class="log-lvl" data-level="all" data-testid="log-lvl-all" aria-pressed="true">all</button>
                <button type="button" class="log-lvl" data-level="warn" data-testid="log-lvl-warn" aria-pressed="false">warn+</button>
                <button type="button" class="log-lvl" data-level="error" data-testid="log-lvl-error" aria-pressed="false">error</button>
              </div>
              <span class="log-shown" id="log-shown" data-testid="log-shown"></span>
            </div>
            <ol id="log-stream" data-testid="log-stream" aria-label="Application logs"></ol>
            <p class="empty" id="logs-empty">No application logs yet.</p>
          </div>

          <section class="tabpane chart" id="err-chart" data-testid="err-chart" role="tabpanel"
                   aria-labelledby="tab-chart" tabindex="0" hidden>
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
              <p class="chart-empty">Nothing plotted yet — the error rate builds here once the scenario runs.</p>
            </div>
            <div class="chart-axis"><span>60 ticks ago</span><span>now</span></div>
          </section>
        </div>
      </section>
    </main>

    <div class="wb-sash" data-sash="site" role="separator" tabindex="0"
         aria-orientation="vertical" aria-label="Resize the storefront"
         aria-controls="site-pane" aria-valuemin="0" aria-valuemax="100" aria-valuenow="40"></div>

    <section class="wb-dock" id="site-pane" aria-label="Storefront">
      <header class="dock-head">
        <span class="dock-title">Storefront</span>
        <span class="pane-sub">aperture supply co.</span>
        <button type="button" class="dock-close" data-toggle="site" data-min="site" data-testid="min-site"
                aria-label="Close the storefront" title="Close">&times;</button>
      </header>
      <div class="dock-body">
        <div id="storefront" data-testid="storefront" data-state="ok">
          <div class="sf-chrome">
            <span class="sf-brand">Aperture Supply Co.</span>
            <nav class="sf-nav" aria-label="Store">
              <a href="#" class="sf-nav-link" aria-current="page">Shop</a>
              <a href="#" class="sf-nav-link">Journal</a>
              <a href="#" class="sf-nav-link">About</a>
              <a href="#" class="sf-cart" aria-label="Cart, 1 item"><span class="sf-cart-count">1</span> Cart</a>
            </nav>
          </div>
          <div class="sf-hero">
            <span class="sf-hero-kicker">New for fall</span>
            <span class="sf-hero-line">Field-tested goods, guaranteed for the long trail.</span>
          </div>
          <div class="sf-banner" data-testid="sf-banner" role="status"></div>
          <!-- THE STATUS PAGE, WHERE CUSTOMERS ACTUALLY READ IT. Approving
               "tell customers" moved a panel in the operator's console and
               nothing at all on the shop, so the one step of the seven whose
               entire purpose is the customer was invisible to them. This
               quotes the published post verbatim — it is the same string that
               left the building, not a second copy written for the shop. -->
          <a class="sf-status" data-testid="sf-status" href="#" hidden>
            <span class="sf-status-k"></span>
            <span class="sf-status-t"></span>
          </a>
          <div class="sf-grid">
<article class="sf-card"><div class="sf-img"><svg viewBox="0 0 100 100" aria-hidden="true"><path d="M21 27 34 20v54H21z" fill="#3d5c47"/><path d="M79 27 66 20v54h13z" fill="#3d5c47"/><path d="M34 20 50 27 66 20l2 63H32z" fill="#4a6b52"/><path d="M34 20 50 27 44 45z" fill="#5e7f66"/><path d="M66 20 50 27 56 45z" fill="#5e7f66"/><path d="M50 27v56" stroke="#314d3a" stroke-width="1.4"/><rect x="34" y="55" width="13" height="11" rx="1.5" fill="#3d5c47"/><rect x="53" y="55" width="13" height="11" rx="1.5" fill="#3d5c47"/><path d="M21 69h13v6H21zM66 69h13v6H66z" fill="#314d3a"/><circle cx="50" cy="50" r="1.5" fill="#cbb68c"/><circle cx="50" cy="62" r="1.5" fill="#cbb68c"/><circle cx="50" cy="74" r="1.5" fill="#cbb68c"/></svg></div><div class="sf-name">Field Jacket</div><div class="sf-meta"><span class="sf-price">$128.00</span><span class="sf-rate" aria-label="4.8 out of 5, 212 reviews"><svg class="sf-star" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 .8l1.6 3.3 3.6.5-2.6 2.5.6 3.6L6 9l-3.2 1.7.6-3.6L.8 4.6l3.6-.5z"/></svg>4.8 <span class="sf-rate-n">(212)</span></span></div></article><article class="sf-card"><div class="sf-img"><span class="sf-badge" data-kind="sale">Sale</span><svg viewBox="0 0 100 100" aria-hidden="true"><path d="M34 31c0-15 7-22 16-22s16 7 16 22" stroke="#8a6b45" stroke-width="4.5" fill="none" stroke-linecap="round"/><path d="M22 31h56l-5 60H27z" fill="#c9a274"/><path d="M22 31h56l-1.2 13H23.2z" fill="#b58d5c"/><rect x="39" y="55" width="22" height="17" rx="2" fill="#a8834f"/><path d="M39 63.5h22" stroke="#8a6b45" stroke-width="1.2"/><path d="M30 44l-2 47M70 44l2 47" stroke="#b58d5c" stroke-width="1.1"/></svg></div><div class="sf-name">Canvas Tote</div><div class="sf-meta"><span class="sf-price"><span class="sf-was">$42.00</span>$38.00</span><span class="sf-rate" aria-label="4.6 out of 5, 486 reviews"><svg class="sf-star" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 .8l1.6 3.3 3.6.5-2.6 2.5.6 3.6L6 9l-3.2 1.7.6-3.6L.8 4.6l3.6-.5z"/></svg>4.6 <span class="sf-rate-n">(486)</span></span></div></article><article class="sf-card"><div class="sf-img"><svg viewBox="0 0 100 100" aria-hidden="true"><rect x="41" y="6" width="18" height="13" rx="3.5" fill="#31456b"/><rect x="36" y="17" width="28" height="77" rx="11" fill="#5b7fb8"/><rect x="36" y="41" width="28" height="15" fill="#3f5c8d"/><rect x="41" y="25" width="4.5" height="58" rx="2.2" fill="#8fadda" opacity=".5"/><path d="M64 26c8 4 8 13 0 17" stroke="#31456b" stroke-width="4" fill="none" stroke-linecap="round"/><path d="M36 66h28" stroke="#4a6ea6" stroke-width="1.2"/></svg></div><div class="sf-name">Trail Bottle</div><div class="sf-meta"><span class="sf-price">$28.00</span><span class="sf-rate" aria-label="4.9 out of 5, 1,043 reviews"><svg class="sf-star" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 .8l1.6 3.3 3.6.5-2.6 2.5.6 3.6L6 9l-3.2 1.7.6-3.6L.8 4.6l3.6-.5z"/></svg>4.9 <span class="sf-rate-n">(1,043)</span></span></div></article><article class="sf-card"><div class="sf-img"><svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="15" r="9" fill="#a2687a"/><path d="M19 66a31 33 0 0 1 62 0z" fill="#c08a99"/><path d="M29 45q21-16 42 0" stroke="#d7a6b2" stroke-width="2.2" fill="none"/><path d="M35 34q15-9 30 0" stroke="#d7a6b2" stroke-width="1.8" fill="none"/><rect x="16" y="66" width="68" height="20" rx="9" fill="#a2687a"/><path d="M27 68v16M39 68v16M51 68v16M63 68v16M74 68v16" stroke="#8d5567" stroke-width="1.5"/></svg></div><div class="sf-name">Wool Beanie</div><div class="sf-meta"><span class="sf-price">$34.00</span><span class="sf-rate" aria-label="4.7 out of 5, 318 reviews"><svg class="sf-star" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 .8l1.6 3.3 3.6.5-2.6 2.5.6 3.6L6 9l-3.2 1.7.6-3.6L.8 4.6l3.6-.5z"/></svg>4.7 <span class="sf-rate-n">(318)</span></span></div></article><article class="sf-card"><div class="sf-img"><span class="sf-badge" data-kind="low">Low stock</span><svg viewBox="0 0 100 100" aria-hidden="true"><path d="M65 36h9a14 14 0 0 1 0 28h-9" stroke="#6f7d43" stroke-width="7.5" fill="none" stroke-linecap="round"/><path d="M20 25h46v52a9 9 0 0 1-9 9H29a9 9 0 0 1-9-9z" fill="#8d9c5c"/><path d="M20 25h46v10H20z" fill="#ece7da"/><path d="M20 35h46v3.5H20z" fill="#6f7d43"/><circle cx="32" cy="55" r="1.7" fill="#ece7da" opacity=".45"/><circle cx="52" cy="66" r="1.4" fill="#ece7da" opacity=".4"/><circle cx="42" cy="46" r="1.1" fill="#ece7da" opacity=".38"/><circle cx="57" cy="52" r="1" fill="#ece7da" opacity=".3"/></svg></div><div class="sf-name">Camp Mug</div><div class="sf-meta"><span class="sf-price">$22.00</span><span class="sf-rate" aria-label="4.5 out of 5, 627 reviews"><svg class="sf-star" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 .8l1.6 3.3 3.6.5-2.6 2.5.6 3.6L6 9l-3.2 1.7.6-3.6L.8 4.6l3.6-.5z"/></svg>4.5 <span class="sf-rate-n">(627)</span></span></div></article><article class="sf-card"><div class="sf-img"><svg viewBox="0 0 100 100" aria-hidden="true"><path d="M25 11h50v15H25z" fill="#4e5d70"/><path d="M25 11q25 9 50 0v4q-25 9-50 0z" fill="#3e4b5c"/><path d="M27 24h46v58a11 11 0 0 1-11 11H38a11 11 0 0 1-11-11z" fill="#6b7c90"/><rect x="23" y="23" width="54" height="6" rx="3" fill="#2f3a47"/><rect x="43" y="19" width="14" height="10" rx="2.5" fill="#c8b06a"/><path d="M27 47h46M27 62h46" stroke="#5c6d81" stroke-width="1.5"/></svg></div><div class="sf-name">Dry Sack</div><div class="sf-meta"><span class="sf-price">$36.00</span><span class="sf-rate" aria-label="4.8 out of 5, 154 reviews"><svg class="sf-star" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 .8l1.6 3.3 3.6.5-2.6 2.5.6 3.6L6 9l-3.2 1.7.6-3.6L.8 4.6l3.6-.5z"/></svg>4.8 <span class="sf-rate-n">(154)</span></span></div></article>
          </div>
          <ul class="sf-trust">
            <li>Free shipping over $75</li>
            <li>30-day returns</li>
            <li>Repairs for life</li>
          </ul>
          <div class="sf-checkout">
            <div class="sf-cart-line">
              <span class="sf-cart-items">1 item · Field Jacket</span>
              <span class="sf-cart-total">$48.00</span>
            </div>
            <button type="button" class="sf-buy" data-testid="sf-buy">Checkout · $48.00</button>
            <div class="sf-feed" data-testid="sf-feed"></div>
          </div>
          <footer class="sf-foot">
            <span class="sf-foot-links"><a href="#">Help</a><a href="#">Shipping</a><a href="#">Returns</a><a href="#">Contact</a></span>
            <span class="sf-foot-c">© Aperture Supply Co.</span>
          </footer>
          <div class="sf-outage" data-testid="sf-outage">
            <div class="sf-outage-code">502</div>
            <div class="sf-outage-msg">We can't reach the store right now.</div>
          </div>
        </div>
      </div>
    </section>

    <div id="agent-cursor" data-testid="agent-cursor" data-state="off" aria-hidden="true">
      <svg class="ac-dot" viewBox="0 0 12 12"><path d="M6 .9 11.1 6 6 11.1.9 6Z"/></svg><span class="ac-label">agent</span>
    </div>

    <div class="wb-sash" data-sash="rail" role="separator" tabindex="0"
         aria-orientation="vertical" aria-label="Resize the agent panel"
         aria-controls="tool-rail" aria-valuemin="0" aria-valuemax="100" aria-valuenow="18"></div>

    <section class="wb-dock" id="tool-rail" aria-label="Agent">
      <header class="dock-head">
        <span class="dock-title">Agent</span>
        <!-- The presence CARD used to be a section of its own in the dock —
             a dot, a line, and a sentence, for one bit of information. It is
             a status marker, so it lives on the heading (Sid, 2026-09-01:
             "just be like a status marker next to the Agent heading ... will
             save a lot of real estate"). -->
        <span class="agent-presence" id="agent-presence" data-state="off">
          <span class="ap-dot" aria-hidden="true"></span>
          <span id="agent-conn" data-testid="agent-conn" data-state="off">not connected</span>
        </span>
        <kbd class="dock-kbd">⌘J</kbd>
        <button type="button" class="dock-close" data-toggle="rail" data-min="rail" data-testid="min-rail"
                aria-label="Hide the agent panel" title="Hide  ⌘J">&times;</button>
      </header>
      <!-- THE DISCLOSURE. While a walkthrough's work is on the ledger, the
           heading says the caller is a script, in machine words, and offers
           the one way out. Hidden otherwise; it is chrome, not content. -->
      <div class="walk-line" id="walk-line" data-testid="walk-line" data-state="off" hidden>
        <span class="wl-say"><span class="wl-tag">walkthrough</span> · scripted caller, not a model · same tool path a host uses</span>
        <span class="wl-end">
          <span class="wl-state" data-testid="walk-state"></span>
          <button type="button" class="wl-stop" data-testid="walk-stop">Stop</button>
        </span>
      </div>
      <div class="rail-modes">
        <span class="rail-modes-label">Response stage</span>
        <div class="mode-switch" id="mode-switch" data-testid="mode-switch">
          ${MODES.map(
            (m) =>
              `<button type="button" data-mode="${m}" data-testid="mode-${m}" aria-pressed="${m === 'triage'}">${m}</button>`
          ).join('')}
        </div>
      </div>
      <div class="dock-body">
        <!-- ONE THREAD, NOT THREE CARDS (Sid, 2026-09-02: "it's too ugly with
             how it's cramming text and juxtaposing 3 different panels and it's
             not fluid at all", and "it should look linear but not be so
             disconnected"). The dock used to be a stack of separately bordered
             regions — a review banner, an airlock box, a findings box — each
             with its own frame, which is what read as card-inside-card. It is
             now a single chronological thread hanging off one spine: what the
             agent worked out, then what it proposes, in the order those things
             happened. The live decision is pinned to the bottom of the thread
             so it can never fall below the fold, which is the whole of S3. -->
        <div class="agent-thread" id="agent-thread">
        <!-- THE AGENT LOOP AS A TYPED EVENT TIMELINE (Sid, 2026-09-02:
             "the linear flow should be I wake up the agent, I see it run
             tools, I see it learn a hypothesis, it proposes a plan, we
             execute steps of the plan, it reports intermediate state, we
             continue executing steps, and final observation is incident
             closure ... I want every single type of element ... to be
             uniquely rendered/distinguishable").

             One ordered list, one spine, SIX KINDS, each with its own marker
             silhouette so you can tell them apart without reading:

               connect   a ring        the agent attached to this page
               reads     a square      it called read tools
               finding   a diamond     it concluded something
               plan      three bars    it proposed an ordered response
               state     a chevron     what a step DID TO THE WORLD
               resolved  a filled tick the incident ended

             Two of those did not exist before this pass. "connect" was a dot
             in the header and never an event; "state" did not exist at all —
             you approved a step and the plan silently advanced, so nothing
             ever said what the approval changed. That is the "how that
             changed state" in his message and it is the beat the whole
             argument for an airlock rests on.

             Colour carries the other half of the type: VIOLET is the agent
             thinking, GREEN is the world actually moving. A state report and
             a resolution are green because they are the only two entries on
             this list that are not the agent's claim about anything.

             The live tail — what it is doing now, and what is waiting on you
             — is the LAST entry, so "the present" is a position on the
             timeline rather than a separate region. -->
        <ol class="tl" id="agent-timeline" aria-label="What the agent has done">
          <li class="tl-ev" data-kind="live" data-live="0" id="tl-tail">
            <p class="agent-doing" id="agent-doing" aria-live="polite" hidden></p>
            <div class="airlock" id="airlock" data-pending="0">
              <div class="al-label" data-state="settled"><span class="al-text">Waiting on you</span></div>
              <div class="al-cards" id="airlock-cards"></div>
            </div>
          </li>
        </ol>
        <!-- BEAT 0. The ledger starts empty and says so, and says what will
             fill it, in the order it will fill it. Sid's sequence begins
             here: *"Empty panel, agent not connected"*. -->
        <div class="tl-empty" id="findings-empty" data-testid="findings-empty">
          <p class="te-p">
            No agent is connected. When one attaches, this becomes the record
            of what it did: every tool call and what came back, what it
            concluded, the order it proposes, and what each step you approve
            does to the world.
          </p>
          <p class="te-k">To attach one</p>
          <ul class="te-list">
            <li class="te-row"><span class="te-host">ChatGPT</span><span class="te-t">open this URL in its in-app browser, then ask it to look at the page</span></li>
            <li class="te-row"><span class="te-host">Chrome 151+</span><span class="te-t">enable WebMCP in chrome://flags, then open this URL</span></li>
          </ul>
          <p class="te-k">Things to ask it</p>
          <ul class="te-list te-asks">
            <li class="te-row"><span class="te-q">What can you do on this page, and what can't you?</span>${COPY_BTN('copy-ask-1')}</li>
            <li class="te-row"><span class="te-q">Work out what is wrong here, but don't change anything yet.</span>${COPY_BTN('copy-ask-2')}</li>
            <li class="te-row"><span class="te-q">Move the stage to Recovery, propose the fix, and don't click anything in the console — I decide.</span>${COPY_BTN('copy-ask-3')}</li>
          </ul>
          <p class="te-note te-held" data-testid="held-note">Approvals are a held gesture while an agent is attached.</p>
          <p class="te-note">Run sim first — the incident has to be underway.</p>
          <div class="te-walk">
            <button type="button" class="ctl-btn" id="walk-start" data-testid="walk-start">Watch a walkthrough</button>
            <span class="te-note">scripted caller, not a model</span>
          </div>
        </div>
        </div>
      </div>
      <!-- CAPABILITY IS REFERENCE, so it lives at the EDGE and opens on
           demand. Collapsed inline it was still at the bottom of a scrolling
           column, which is the same as hidden (Sid, 2026-09-01: "what does
           page lets the agent do is hidden ... should be an opt-in UI that you
           can pop-up"). The pinned line carries the one number that matters
           per stage; the rungs themselves are one click away. -->
      <button type="button" class="rail-foot" id="tool-surface" data-testid="tool-surface"
              aria-haspopup="dialog" aria-expanded="false">
        <span class="rf-count" id="tool-count"></span>
        <span class="rf-label">tools available</span>
        <span class="rf-more" aria-hidden="true">view</span>
      </button>
    </section>

    <!-- STATUS BAR. Machine state that used to be scattered through the
         console's chrome: it is reference, and reference belongs at the edge. -->
    <footer class="wb-status">
      <span class="wbs-item wbs-mode" id="wbs-mode">triage</span>
      <span class="wbs-item" id="sim-status" data-testid="sim-status">seeded · paused</span>
      <span class="spacer"></span>
      <span class="wbs-item wbs-hint"><kbd>⌘K</kbd> commands</span>
      <span class="wbs-item wbs-hint"><kbd>⌘J</kbd> agent</span>
      <span class="wbs-item" id="wbs-webmcp">WebMCP …</span>
    </footer>
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

/**
 * WHAT THE STATUS BAR SAYS ABOUT WebMCP.
 *
 * It used to be a ONE-SHOT read at boot that said `WebMCP not detected` when
 * `navigator.modelContext` was absent — which is most of the time, including
 * in every screenshot and in any browser where the host attaches after load.
 * Two things were wrong with it. It never updated, so a host that arrived a
 * second later was never acknowledged. And it reported the wrong subject: the
 * page's job here is to PUBLISH a tool surface, and it does that whether or
 * not a client has attached yet. "Not detected" described the visitor and
 * read as "this feature is broken".
 *
 * So: say what the page did, then say whether anyone is on the other end.
 * Both halves are true in every state, and it is re-read on every render.
 */
function renderWebMCPStatus(active: number): void {
  const el = document.querySelector<HTMLElement>('#wbs-webmcp');
  if (!el) return;
  el.dataset.host = hostAttached() ? 'on' : 'off';
  el.textContent = hostAttached()
    ? `WebMCP · ${active} published · host attached`
    : `WebMCP · ${active} published`;
  syncHoldMode();
}

// ---- sim worker wiring (M2-02) ------------------------------------------
// Engine lives in the Worker; the main thread only paces it (real time is
// allowed here — sim-time is the Worker's SimClock, so pacing never leaks
// into the event stream).

const SEED = 20260828;

const worker = new Worker(new URL('./sim/worker.ts', import.meta.url), { type: 'module' });
const send = (msg: SimRequest) => worker.postMessage(msg);
// a worker that never boots must not leave a blank page: show the shell anyway
worker.addEventListener('error', () => revealShell());
// and no host may ever be left looking at nothing: reveal regardless after 1.5s
setTimeout(() => revealShell(), 1500);

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

/**
 * WHAT THE AGENT ACTUALLY GOT BACK.
 *
 * The ledger could always say a tool was CALLED. It could never say what the
 * call returned, so "read 5 sources" was a claim the console asked the
 * operator to take on trust — the one thing this whole surface exists not to
 * do. Sid, four times: *"we are able to see the tool call outputs by some
 * expansion"*.
 *
 * The result exists here and nowhere else: the worker answers `queryResult`
 * before it appends `tool.called`, and the tool's own `execute` stringifies
 * exactly this object for the agent. So it is captured HERE, on the way past,
 * and it is the same bytes the agent received — not a re-derivation, not a
 * narration, not a second read of the world at render time (which would drift
 * the moment the world moved).
 *
 * It is deliberately NOT put in the event log: pages are capped at 1.2KB and
 * the schema is signed off. The log records that the call happened and how
 * many bytes came back; this map holds the bytes for the row to open.
 *
 * One queue per tool, drained in call order. `queryResult` resolves this
 * promise in a microtask, and the `tool.called` event that builds the row
 * arrives in the next message task, so the payload is always queued before
 * the row that wants it exists.
 */
const toolResults = new Map<string, Record<string, unknown>[]>();

function captureToolResult(tool: string, result: Record<string, unknown>): void {
  const q = toolResults.get(tool);
  if (q) q.push(result);
  else toolResults.set(tool, [result]);
}

/** The oldest un-rendered result for this tool, or null if we never saw it. */
function takeToolResult(tool: string): Record<string, unknown> | null {
  return toolResults.get(tool)?.shift() ?? null;
}

/** The tool path the agent uses — the read runner, with the answer kept. */
function runToolQuery(q: QueryRequest, viaTool?: string): Promise<Record<string, unknown>> {
  return runWorkerQuery(q, viaTool).then((r) => {
    if (viaTool) captureToolResult(viaTool, r);
    return r;
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

function resetHoldings(): void {
  executedLog.length = 0;
  renderHoldings(executedLog, { deploys: [] } as unknown as World);
}

function markTemplate(id: string): void {
  templatePick.querySelectorAll<HTMLButtonElement>('[data-template]').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.template === id));
  });
  const cur = document.querySelector<HTMLElement>('#scenario-current');
  if (cur) cur.textContent = TEMPLATE_LABELS[id] ?? id;
  // picking one is the end of the interaction: put the menu away
  document.querySelector<HTMLDetailsElement>('#scenario-pick')?.removeAttribute('open');
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
  // the chip is part of the reset, not part of the click that caused it —
  // it only ever updated from the picker's handler, so any programmatic
  // re-seed left the masthead naming the previous scenario
  markTemplate(templateId);
  currentTemplate = templateId;
  endWalk(); // a new world is not the walkthrough's world
  running = false;
  syncPacer();
  streamEl.innerHTML = '';
  logStream.innerHTML = '';
  logFilterEl.value = '';
  logQuery = '';
  logMinLevel = 0;
  for (const b of document.querySelectorAll<HTMLElement>('.log-lvl')) {
    b.setAttribute('aria-pressed', String(b.dataset.level === 'all'));
  }
  applyLogFilter();
  resetEvidence(); // a new world, and the old world's reads are not evidence for it
  resetPlans();
  resetTimeline(); // and the old world's story is not this world's story
  for (const { card } of pendingCards.values()) card.remove();
  pendingCards.clear();
  flagControls.innerHTML = '';
  serviceControls.innerHTML = '';
  // routes were NOT cleared here, so switching scenario left the previous
  // world's routes on the console beside the new one's — ghost controls,
  // which is exactly what the tombstone discipline exists to prevent
  routeControls.innerHTML = '';
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
  resetHoldings(); // a new scenario holds nothing
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
      const input = (d.input ?? {}) as Record<string, unknown>;
      // one registry: the same describe() the approval card and the agent's
      // proposal use. The old hand-written switch fell through to raw JSON
      // for anything new, which is how `traffic.drain {"route":"checkout"}`
      // ended up on the surface.
      const spec = WRITE_ACTIONS[String(d.tool)];
      if (spec && world) return spec.describe(input, world);
      return `${d.tool} ${JSON.stringify(input)}`;
    }
    case 'migration.applied':
      return `${d.id} by ${d.appliedByDeploy} · ${d.reversible ? 'reversible' : 'IRREVERSIBLE'}`;
    case 'mode.changed':
      return `${d.from} → ${d.to}${(d.toolsAdded as string[]).length ? ` · +${(d.toolsAdded as string[]).join(', +')}` : ''}${(d.toolsRemoved as string[]).length ? ` · −${(d.toolsRemoved as string[]).join(', −')}` : ''}`;
    case 'action.proposed':
      return `[tier ${d.tier}] ${d.diffSummary}`;
    case 'action.approved':
      return `proposal #${d.proposalSeq} approved by human${d.keyHolder ? ` · key: ${d.keyHolder}` : ''}${d.via ? ` · ${d.via}` : ''}`;
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
    case 'finding.recorded':
      return `agent recorded a finding: ${String(d.summary).slice(0, 80)}`;
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
    // ONE ROW SHAPE FOR EVERY DEPLOY.
    //
    // These used to render two ways: the live build as a tall card and the
    // rest as a compact strip, on the reasoning that eight equal cards are a
    // wall of history. What that actually produced was a list you cannot read
    // as a list — the eye has no column to run down, and "which of these
    // could I roll back to" becomes a shape-matching exercise. Every deploy
    // is the same row now; the live one is MARKED, not re-shaped, and the
    // detail every row carries is behind the same disclosure on all of them.
    card.innerHTML = `
      <span class="dc-status"></span>
      <span class="dc-main">
        <span class="dc-title"></span>
        ${
          deploy.containsMigration
            ? `<span class="dc-badge dc-badge-migration">${
                deploy.migrationReversible ? 'reversible' : 'irreversible'
              } migration</span>`
            : ''
        }
      </span>
      <span class="dc-target"></span>
      <span class="dc-id"></span>
      <span class="dc-actions">
        <button type="button" class="ctl-btn dc-rollback" data-act="rollback" data-deploy="${deploy.id}" data-testid="rollback-${deploy.id}">Roll back</button>
      </span>
      <details class="dc-details">
        <summary data-testid="details-${deploy.id}">Details</summary>
        <div class="dc-meta">
          ${deploy.flagsTouched.length ? `<span class="dc-badge">flags: ${deploy.flagsTouched.join(', ')}</span>` : ''}
          <span class="dc-badge">${canary}</span>
          <span class="dc-badge">${deploy.diffstat.files} files +${deploy.diffstat.plus} −${deploy.diffstat.minus}</span>
          <span class="dc-badge">${deploy.author}</span>
        </div>
      </details>
    `;
    // the human story first: a stranger should read WHAT SHIPPED, not a key
    card.querySelector('.dc-title')!.textContent =
      deploy.note ?? `${deploy.service} ${deploy.version}`;
    card.querySelector('.dc-target')!.textContent = `${deploy.service} ${deploy.version}`;
    card.querySelector('.dc-id')!.textContent = deploy.id;
    deployControls.prepend(card);
  }
  card.dataset.deployStatus = deploy.status;
  card.querySelector('.dc-status')!.textContent = deploy.status.replace('_', ' ');
  card.querySelector<HTMLButtonElement>('.dc-rollback')!.disabled = !canRollback;
}

/**
 * One control, with its price on it.
 *
 * A lever whose cost you cannot see is a trap, and a console full of
 * consequence-free buttons is why the old three-verb deck had no ordering
 * problem for anyone — human or agent — to solve. The cost text is the same
 * string the agent receives in a proposal, from src/sim/vocabulary.ts, so
 * both sides of the airlock are told the same thing.
 */
function lever(
  tool: string,
  input: Record<string, unknown>,
  label: string,
  testid: string,
  full?: string
): string {
  const spec = WRITE_ACTIONS[tool];
  const cost = spec ? spec.cost : '';
  // `full` is the unabbreviated wording. The incident-command strip shortens
  // its labels to hold ONE line, and a screen reader must still hear the whole
  // verb — "Freeze" on screen, "Freeze deploys" to the accessibility tree.
  const aria = full ?? label;
  return `<button type="button" class="ctl-btn lever" data-act="lever" data-tool="${tool}"
    data-input='${JSON.stringify(input)}' data-testid="${testid}"
    aria-label="${aria.replace(/"/g, '&quot;')}"
    title="${`${aria} — ${cost}`.replace(/"/g, '&quot;')}">${label}<span class="lever-cost">${cost}</span></button>`;
}

/**
 * Incident command — the half of on-call that is not infrastructure.
 * incident.io splits its product exactly this way (On-call / Response /
 * Status Pages), and a console with only infra levers is missing the part
 * an on-call engineer actually spends the first five minutes on.
 */
function renderCommand(w: World): void {
  const row = document.querySelector<HTMLElement>('#cmd-row');
  if (!row) return;
  const inc = w.incident;

  // A STATE STRIP, NOT A BUTTON WALL (#13's other half, Sid 2026-09-01).
  // Six equal-weight buttons cost a fixed 115px row — at his 1512px window
  // the storefront opens during an incident and the centre falls to its
  // 560px floor, where the six wrap onto two lines and the posture caption
  // takes a third. That is 115px of the console's 881px, spent on moves that
  // are mostly ONE-SHOT: you acknowledge, set a severity and page a team
  // once, and after that those buttons are inert furniture.
  //
  // So a taken move stops being a button and becomes posture. What stays are
  // the three STANDING levers — silence, freeze, post — which are toggles or
  // repeatable and which the agent actually argues with you about.
  // `alerts.silence` in particular never leaves the strip: it is free on its
  // own and catastrophic in front of a rollout, and the counsel scene only
  // works if a human can reach for it in one visible click.
  const posture = [
    inc.severity ? inc.severity.toUpperCase() : null,
    inc.acknowledgedBy ? `owned by ${inc.acknowledgedBy}` : null,
    inc.escalatedTo ? `${inc.escalatedTo} paged` : null,
  ].filter(Boolean);

  row.innerHTML = `
    ${
      inc.acknowledgedBy
        ? ''
        : lever('incident.acknowledge', { by: 'you' }, 'Acknowledge', 'ack-incident')
    }
    ${inc.severity ? '' : lever('incident.severity', { level: 'sev1' }, 'SEV1', 'sev1', 'Declare SEV1')}
    ${
      inc.escalatedTo
        ? ''
        : lever('incident.escalate', { team: 'database on-call' }, 'Page on-call', 'escalate', 'Page on-call: database')
    }
    ${
      inc.alertsSilenced
        ? lever('alerts.silence', { silenced: false }, 'Unsilence', 'silence', 'Unsilence alerts')
        : lever('alerts.silence', { silenced: true }, 'Silence', 'silence', 'Silence alerts')
    }
    ${
      inc.deploysFrozen
        ? lever('deploy.freeze', { frozen: false }, 'Lift freeze', 'freeze', 'Lift freeze on deploys')
        : lever('deploy.freeze', { frozen: true }, 'Freeze', 'freeze', 'Freeze deploys')
    }
    ${lever(
      'statuspage.post',
      { state: 'investigating', text: 'We are investigating elevated checkout failures.' },
      'Update',
      'statuspage-post',
      'Post a status page update'
    )}
    <span class="cmdbar-meta" id="command-meta">${
      posture.length ? posture.join(' · ') : 'not acknowledged'
    }</span>
  `;

  const posts = document.querySelector<HTMLElement>('#sp-posts');
  const empty = document.querySelector<HTMLElement>('#sp-empty');
  if (!posts || !empty) return;
  empty.hidden = inc.statusPosts.length > 0;
  posts.innerHTML = '';
  for (const post of inc.statusPosts) {
    const el = document.createElement('div');
    el.className = 'sp-post';
    el.dataset.state = post.state;
    const st = document.createElement('span');
    st.className = 'sp-state';
    st.textContent = post.state;
    const tx = document.createElement('p');
    tx.className = 'sp-text';
    tx.textContent = post.text;
    el.append(st, tx);
    posts.append(el);
  }
}

const routeControls = document.querySelector<HTMLDivElement>('#route-controls')!;
const opsControls = document.querySelector<HTMLDivElement>('#ops-controls')!;

/**
 * ROW ACTIONS COLLAPSE INTO ONE MENU.
 *
 * Rule taken from Grafana Alerting, read in-browser: every row carries a
 * single right-aligned `Actions v`, never a scattered set of buttons. That is
 * why our control rows looked misaligned — three buttons of different widths
 * per row cannot align, and no real ops tool asks them to.
 *
 * The cost of each lever rides inside the menu, where there is room to read
 * it, instead of as a hover tooltip on a cramped button.
 */
function actionsMenu(
  items: Array<{ tool: string; input: Record<string, unknown>; label: string; testid: string }>,
  menuId: string
): string {
  const rows = items
    .map((it) => {
      const spec = WRITE_ACTIONS[it.tool];
      const cost = (spec?.cost ?? '').replace(/"/g, '&quot;');
      return `<button type="button" role="menuitem" class="am-item" data-act="lever"
        data-tool="${it.tool}" data-input='${JSON.stringify(it.input)}' data-testid="${it.testid}">
        <span class="am-label">${it.label}</span>
        <span class="am-cost">${cost}</span>
      </button>`;
    })
    .join('');
  return `<details class="actions-menu" id="${menuId}">
    <summary data-testid="${menuId}-open">Actions</summary>
    <div class="am-list" role="menu">${rows}</div>
  </details>`;
}

function renderRouteRow(r: World['routes'][number]): void {
  let row = routeControls.querySelector<HTMLDivElement>(`[data-route-id="${r.id}"]`);
  if (!row) {
    row = document.createElement('div');
    row.className = 'ctl-row';
    row.dataset.routeId = r.id;
    row.innerHTML = `
      <span class="ctl-kind">route</span>
      <span class="ctl-name"></span>
      <span class="ctl-state"></span>
      ${actionsMenu(
        [
          { tool: 'traffic.shift', input: { route: r.id, percent: 50, target: 'secondary' }, label: 'Shift 50% to secondary', testid: `shift-${r.id}` },
          { tool: 'traffic.drain', input: { route: r.id }, label: 'Drain this route', testid: `drain-${r.id}` },
          { tool: 'ratelimit.set', input: { route: r.id, rps: 100 }, label: 'Cap at 100 req/s', testid: `limit-${r.id}` },
        ],
        `route-actions-${r.id}`
      )}
    `;
    row.querySelector('.ctl-name')!.textContent = r.path;
    routeControls.append(row);
  }
  const bits = [`→ ${r.target}`];
  if (r.splitPercent !== undefined) bits.push(`${r.splitPercent}% split`);
  if (r.rateLimitRps !== undefined) bits.push(`≤${r.rateLimitRps}/s`);
  if (r.drained) bits.push('drained');
  row.querySelector('.ctl-state')!.textContent = bits.join(' · ');
  row.dataset.drained = String(Boolean(r.drained));
}

function renderOpsRows(w: World): void {
  if (opsControls.childElementCount > 0) {
    const dbState = opsControls.querySelector('[data-ops="db"] .ctl-state');
    if (dbState) dbState.textContent = w.dbPrimary ? `primary: ${w.dbPrimary}` : 'primary: db';
    const dnsState = opsControls.querySelector('[data-ops="dns"] .ctl-state');
    if (dnsState) {
      dnsState.textContent = w.dns.length
        ? w.dns.map((d) => `${d.hostname} → ${d.target}`).join(' · ')
        : 'shop.example → edge';
    }
    return;
  }
  opsControls.innerHTML = `
    <div class="ctl-row" data-ops="cache">
      <span class="ctl-kind">cache</span><span class="ctl-name">session cache</span>
      <span class="ctl-state">warm</span>
      ${lever('cache.flush', { scope: 'session' }, 'Flush', 'flush-session')}
    </div>
    <div class="ctl-row" data-ops="db">
      <span class="ctl-kind">db</span><span class="ctl-name">orders-db</span>
      <span class="ctl-state">primary: db</span>
      ${lever('db.failover', { service: 'db' }, 'Fail over', 'failover-db')}
    </div>
    <div class="ctl-row" data-ops="dns">
      <span class="ctl-kind">dns</span><span class="ctl-name">shop.example</span>
      <span class="ctl-state">shop.example → edge</span>
      ${lever('dns.cutover', { hostname: 'shop.example', target: 'edge-secondary' }, 'Cut over', 'dns-cutover')}
    </div>
  `;
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
      <button type="button" class="ctl-btn primary-row" data-act="rollforward" data-service="${svc.id}" data-testid="rollforward-${svc.id}" title="ship the next build of ${svc.id}">Roll forward</button>
      ${actionsMenu(
        [
          { tool: 'service.restart', input: { service: svc.id }, label: 'Restart the service', testid: `restart-${svc.id}` },
          { tool: 'service.scale', input: { service: svc.id, replicas: 4 }, label: 'Scale to 4 replicas', testid: `scale-${svc.id}` },
        ],
        `svc-actions-${svc.id}`
      )}
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
  for (const r of w.routes) renderRouteRow(r);
  renderCommand(w);
  renderOpsRows(w);
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
  // GHOST CONTROLS. Rows are created per entity and nothing ever removed
  // them, so anything the previous world had and this one does not stayed on
  // the deck — after a scenario switch the console showed a route that no
  // longer exists, with working buttons on it. The deploy cards above already
  // prune; every other row type now does too, on the same rule. Found by the
  // review harness re-seeding faster than a human can click.
  prune(flagControls, 'data-flag-id', w.flags.map((f) => f.id));
  prune(serviceControls, 'data-service-id', w.services.map((svc) => svc.id));
  prune(routeControls, 'data-route-id', w.routes.map((r) => r.id));
}

/** Remove rows in `host` whose id attribute names something the world lost. */
function prune(host: HTMLElement, attr: string, ids: readonly string[]): void {
  const alive = new Set(ids);
  host.querySelectorAll<HTMLElement>(`[${attr}]`).forEach((row) => {
    if (!alive.has(row.getAttribute(attr)!)) row.remove();
  });
}

// ---- approval diff-cards (M3-03): the airlock's human gate ---------------
// A proposal renders as a card ANCHORED to the node it would mutate; the
// human approves or rejects; the causedBy chain proposed → approved →
// executed is the audit trail (and IS the event log, filtered).

/** What the palette needs to show an ask without reaching into the card DOM. */
interface Ask {
  seq: number;
  summary: string; // the sentence the card leads with, verbatim
  touches: string;
  dualKey: boolean;
  scope: string; // the lever it lands on, for marking the command list
}

const pendingCards = new Map<
  number,
  { card: HTMLElement; anchor: HTMLElement | null; ask: Ask }
>();

/**
 * The LEVER a proposal lands on, with its magnitude taken off.
 *
 * `actionKey` is the answer-key vocabulary and deliberately keeps the
 * parameter that carries the decision (`ratelimit.set:r-checkout=150`),
 * which is right for grading and wrong for marking a menu: the palette's
 * canned row caps that same route at 100 and would never match. Marking
 * answers a coarser question — has the agent asked for something HERE — so
 * the number comes out and the entity stays.
 */
function proposalScope(tool: string, input: Record<string, unknown>): string {
  const entity =
    input.route ??
    input.service ??
    input.deployId ??
    input.id ??
    input.key ??
    input.hostname ??
    input.scope;
  return entity === undefined ? tool : `${tool}:${String(entity)}`;
}

/**
 * The row on the console that a write would land on.
 *
 * This used to cover three of the twenty actions, so seventeen proposals
 * anchored to nothing and the operator was told WHAT the agent wanted
 * without being shown WHERE. The mapping is just the input key that names
 * the entity, per action; the vocabulary already fixes those names.
 */
function anchorFor(tool: string, input: Record<string, unknown>): HTMLElement | null {
  switch (tool) {
    case 'flag.set':
      return flagControls.querySelector(`[data-flag-id="${input.id}"]`);
    case 'deploy.rollback':
    case 'canary.set':
      return deployControls.querySelector(`[data-deploy-id="${input.deployId}"]`);
    case 'deploy.rollforward':
    case 'service.restart':
    case 'service.scale':
    case 'db.failover':
      return serviceControls.querySelector(`[data-service-id="${input.service}"]`);
    case 'route.set':
      return routeControls.querySelector(`[data-route-id="${input.id}"]`);
    case 'ratelimit.set':
    case 'traffic.shift':
    case 'traffic.drain':
      return routeControls.querySelector(`[data-route-id="${input.route}"]`);
    default:
      return null;
  }
}

// ---- evidence assembly: what the agent actually worked from -------------
// A proposal card that says only WHAT the agent wants to do asks the human to
// take the reasoning on faith, which is the thing that makes approving agent
// writes feel like a coin flip. The console can do better than faith, because
// every read is audited (`tool.called`) into the same log the page renders:
// it knows which reads the agent made, how many times, and in what order.
//
// So the card carries two things that come from DIFFERENT places on purpose:
//   · WORKED FROM — page-derived, uncounterfeitable. The agent cannot claim a
//     read it did not make, because this is read off the audit trail.
//   · WHAT IT CONCLUDED — the agent's own words, from record_finding. A claim,
//     not a fact, and shown as one.
// The human reads the claim against the reads that back it, which is exactly
// the review a good reviewer does and exactly what no chat transcript affords.
//
// The zero-read case is not an empty state, it is the finding: an agent that
// proposes a write having looked at nothing is the single most useful thing
// this strip can tell an operator.

interface ReadTally {
  count: number;
  lastSeq: number;
}
const agentReads = new Map<string, ReadTally>();
let latestFinding: { summary: string; seq: number } | null = null;

function noteAgentRead(tool: string, seq: number): void {
  if (!(tool in READ_NARRATION)) return; // writes and proposals are not evidence
  const t = agentReads.get(tool);
  if (t) {
    t.count += 1;
    t.lastSeq = seq;
  } else {
    agentReads.set(tool, { count: 1, lastSeq: seq });
  }
}

function resetEvidence(): void {
  agentReads.clear();
  latestFinding = null;
}

/**
 * Take the human to the surface a read looked at, so a row is a place.
 *
 * A DEAD LINK IS WORSE THAN NO LINK. Four of the six reads point at a tab
 * inside the evidence panel, and the panel is a region the operator can
 * close — with it shut, the pane is not `hidden` (its whole region is), so
 * the old code found nothing to switch to and did nothing at all. Ask for the
 * tab by name instead: `selectTab` opens the region as part of selecting.
 */
const READ_TAB: Record<string, TabName> = {
  list_deploys: 'changed',
  read_logs: 'logs',
  traffic_history: 'chart',
};

function focusRead(tool: string): void {
  const region = READ_NARRATION[tool]?.region;
  if (!region) return;
  const tab = READ_TAB[tool];
  if (tab) selectTab(tab);
  const el = document.querySelector<HTMLElement>(region);
  if (!el) return;
  el.scrollIntoView({ block: 'nearest' });
  touchRegion(region);
}

// "#104" and "seq 104" are how a model writes a citation in prose. Both are
// recognised; nothing else is, because guessing at looser shapes would turn
// ordinary numbers ("6/6 instances") into dead links.
const CITE_RE = /#(\d{1,6})\b|\bseq\.?\s*(\d{1,6})\b/gi;

/**
 * Render the agent's prose with its log citations made clickable — but ONLY
 * where the citation lands. A seq the pane cannot show stays plain text: a
 * link that goes nowhere is a worse promise than no link.
 */
function renderCitedText(host: HTMLElement, text: string): void {
  let last = 0;
  for (const m of text.matchAll(CITE_RE)) {
    const seq = Number(m[1] ?? m[2]);
    const at = m.index ?? 0;
    const landable = !!logStream.querySelector(`li[data-seq="${seq}"]`);
    if (!landable) continue;
    if (at > last) host.append(document.createTextNode(text.slice(last, at)));
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ap-cite';
    b.dataset.seq = String(seq);
    b.textContent = m[0];
    b.title = `Show log line #${seq}`;
    b.addEventListener('click', () => focusLogSeq(seq));
    host.append(b);
    last = at + m[0].length;
  }
  if (last < text.length) host.append(document.createTextNode(text.slice(last)));
}

/** The provenance strip for one proposal, built fresh so it snapshots NOW. */
/**
 * PROGRESSIVE DISCLOSURE, and which way round it goes.
 *
 * At the moment of decision a person needs three things: what will happen,
 * what it costs, and the two buttons. Everything that EXPLAINS the agent —
 * which reads it made, what it concluded — is what you reach for when the
 * first three do not settle it, so it collapses behind a summary that still
 * carries the number ("Worked from 5 reads · 7 calls"). The count is the
 * part you glance at; the chips are the part you audit.
 *
 * The zero-read case NEVER collapses. It is not detail, it is the finding.
 */
function buildEvidence(proposalSeq: number): HTMLElement {
  const bare = agentReads.size === 0;
  const box = document.createElement(bare ? 'div' : 'details');
  box.className = 'ap-evidence';
  box.dataset.testid = `evidence-${proposalSeq}`;

  const head = document.createElement(bare ? 'span' : 'summary');
  head.className = 'ap-ev-head';
  const calls = [...agentReads.values()].reduce((n, t) => n + t.count, 0);
  head.textContent = bare
    ? 'Worked from nothing'
    : `Worked from ${agentReads.size} read${agentReads.size === 1 ? '' : 's'} · ${calls} call${calls === 1 ? '' : 's'}`;
  box.append(head);

  if (agentReads.size === 0) {
    const none = document.createElement('p');
    none.className = 'ap-ev-none';
    none.dataset.testid = `evidence-none-${proposalSeq}`;
    none.textContent = 'This agent proposed a change without reading anything in this console.';
    box.append(none);
  } else {
    const chips = document.createElement('div');
    chips.className = 'ap-ev-reads';
    // ordered by when the agent last used them: the freshest look first
    const order = [...agentReads.entries()].sort((a, b) => b[1].lastSeq - a[1].lastSeq);
    for (const [tool, tally] of order) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ap-ev-chip';
      chip.dataset.tool = tool;
      chip.title = `${READ_NARRATION[tool]?.says ?? tool} — last at #${tally.lastSeq}. Show what it looked at.`;
      const name = document.createElement('span');
      name.className = 'ap-ev-tool';
      name.textContent = tool;
      chip.append(name);
      if (tally.count > 1) {
        const n = document.createElement('span');
        n.className = 'ap-ev-n';
        n.textContent = `×${tally.count}`;
        chip.append(n);
      }
      chip.addEventListener('click', () => focusRead(tool));
      chips.append(chip);
    }
    box.append(chips);
  }

  if (latestFinding) {
    const said = document.createElement('p');
    said.className = 'ap-ev-said';
    said.dataset.testid = `evidence-said-${proposalSeq}`;
    const k = document.createElement('span');
    k.className = 'ap-ev-k';
    k.textContent = 'It concluded';
    said.append(k);
    // the agent's own words, and its citations turned into somewhere to go
    renderCitedText(said, latestFinding.summary);
    box.append(said);
  }
  return box;
}

// ---- the plan as a first-class object ------------------------------------
// Three of the four scenario families have a one-action answer. `retry-storm`
// does not: its answer is two levers in one ORDER, and the same two levers
// backwards cost more than doing nothing. An approval surface that can only
// ever show one action at a time cannot show the operator the thing they are
// actually deciding, which is the sequence.
//
// So a plan is an object here, and it is deliberately NOT a batch approval:
//
//   · The reason the ORDER matters is stated before anything is committed.
//     That claim is the first thing on the card, above the steps.
//   · Every step still arrives as its own action.proposed, through the same
//     airlock, with its own tier, dual-key and provenance checks applied at
//     decision time. A plan grants nothing.
//   · Step N+1 is not even PROPOSED until step N has executed. The operator
//     therefore always approves against the world as it actually is, never
//     against the world the plan predicted — which is the failure mode of
//     every "approve all" affordance.
//   · Rejecting a step abandons the remainder rather than skipping it. A
//     sequence with a hole in it is not the plan anyone agreed to.
//   · Each step carries its own COST, from the same vocabulary string the
//     manual control shows, because the price of step 2 is exactly what the
//     operator is being asked to pre-read while deciding step 1.

interface PlanStep {
  tool: string;
  input: Record<string, unknown>;
  because?: string;
}
interface LivePlan {
  id: string;
  reason: string;
  steps: PlanStep[];
  index: number;
  el: HTMLElement;
  stepEls: HTMLElement[];
  /** one pip per step in the head rail, mirroring that step's state */
  pips: HTMLElement[];
  /** the console row each step would land on, numbered in place */
  anchors: (HTMLElement | null)[];
  state: 'running' | 'complete' | 'abandoned';
  currentProposalSeq?: number;
}
const plans = new Map<string, LivePlan>();
/** approval seq → proposalSeq: action.executed only names its approval. */
const approvalToProposal = new Map<number, number>();
/** proposalSeq → planId, so a step's card lands inside its own step slot. */
const planForProposal = new Map<number, string>();

/**
 * THE RUN LIST — the whole response as one ordered list that never scrolls.
 *
 * This replaced a plan CARD containing steps containing state reports, which
 * is the shape Sid rejected four times: *"I want an ACTION to be followed by
 * an OBSERVATION/reporting of state"*, *"too much scrolling as you walk
 * through actions"*, *"we need to hide old content better"*. Nesting the
 * alternation two levels down meant the rhythm was there and unreadable, and
 * a card that grew by two rows per approval overflowed the dock by step 5.
 *
 * The pattern is the one every engineer already knows from a CI run view:
 * ONE ordered list of all seven steps, all of them on screen from the moment
 * the plan arrives. State decides density and nothing else moves:
 *
 *   queued  one dim line               "cap r-checkout at 150 req/s"
 *   live    the same line, expanded in place — reason, price, evidence, keys,
 *           and the only two buttons on the surface
 *   done    back to one line, now carrying what it DID to the world on the
 *           right of the same row: "deploys  open -> frozen"
 *
 * Three things fall out of that which the card could not give:
 *   · the alternation is top-level and spatial — read the column and it is
 *     action, observation, action, observation, seven times
 *   · the live step's POSITION down the list is the progress bar, so no pips
 *     and no "4 of 7" label are needed
 *   · nothing ever teleports. The step you just approved is the line directly
 *     above the one you are being asked about now, in the same DOM node it
 *     was in a second ago.
 *
 * Budget at 660x780 with step 4 live: 6 collapsed lines at 32px = 192, the
 * live step ~250, the investigation line and two findings ~90, the reason for
 * the order ~26 folded. It fits with room, and it fits at every step.
 */

function stepDescription(step: PlanStep): string {
  const spec = WRITE_ACTIONS[step.tool];
  if (!spec) return actionKey(step.tool, step.input);
  try {
    return world ? spec.describe(step.input, world) : actionKey(step.tool, step.input);
  } catch {
    return actionKey(step.tool, step.input);
  }
}

function setStepState(plan: LivePlan, i: number, state: string, note: string): void {
  const el = plan.stepEls[i];
  if (!el) return;
  el.dataset.state = state;
  el.querySelector<HTMLElement>('.pl-note')!.textContent = note;
  // STATE DECIDES DENSITY. The step being decided is open; everything else on
  // the list is a line. A person can still open any of them by hand, and once
  // they have, `data-pin` keeps their choice — the list must not re-fold a row
  // out from under someone reading it.
  if (el.dataset.pin !== 'open') el.dataset.fold = state === 'live' ? 'false' : 'true';
  // A REFUSAL IS AN OBSERVATION TOO, and it takes the observation's row: what
  // happened to the world is that nothing did, because a person said no.
  if (state === 'skipped' || state === 'blocked') landRefusal(el, note);
  // the console row wears the same state, so the plan is legible from the
  // controls as well as from the list
  const anchor = plan.anchors[i];
  if (anchor) anchor.dataset.planState = state;
}

/** Numbers are only true while the plan is live; a settled plan drops them. */
function clearPlanAnchors(plan: LivePlan): void {
  for (const a of plan.anchors) {
    if (!a) continue;
    a.classList.remove('plan-anchor');
    delete a.dataset.planStep;
    delete a.dataset.planState;
  }
}


/**
 * A PLAN THAT STOPS SAYS SO IN ONE WORD, and says why in its own expansion.
 * The whole sentence in the row's machine-value slot squeezed the title into
 * three wrapped lines — a row that reflows when it fails is a row that failed
 * twice.
 */
function planStopped(plan: LivePlan, word: string, why: string): void {
  plan.el.querySelector<HTMLElement>('.pl-state')!.textContent = word;
  const p = document.createElement('p');
  p.className = 'tl-line pl-stopped';
  p.textContent = why;
  tlBody(plan.el).append(p);
  plan.el.dataset.pin = 'open';
  plan.el.dataset.fold = 'false';
}

/** Put the next step through the airlock. Nothing else advances a plan. */
function advancePlan(plan: LivePlan): void {
  const step = plan.steps[plan.index];
  if (!step) {
    plan.state = 'complete';
    plan.el.dataset.state = 'complete';
    plan.el.querySelector<HTMLElement>('.pl-state')!.textContent = '';
    // THE RECEIPT IS THE LIST. A finished plan used to fold to a one-line
    // summary, which threw away the only record of what the approvals bought.
    // Nothing folds: the seven lines each carry their own observation, and
    // with the live step gone they all fit at once. The footer states the
    // thing the whole airlock exists to be able to say.
    showReceipt(plan);
    clearPlanAnchors(plan);
    syncAirlock();
    return;
  }
  setStepState(plan, plan.index, 'live', 'waiting on your decision');
  void proposeToWorker(step.tool, step.input).then((res) => {
    if (res.outcome === 'blocked') {
      setStepState(plan, plan.index, 'blocked', res.reason ?? 'refused by the airlock');
      plan.state = 'abandoned';
      plan.el.dataset.state = 'abandoned';
      planStopped(plan, 'stopped', 'The airlock refused this step, so the rest of the order was never proposed.');
      clearPlanAnchors(plan);
      return;
    }
    plan.currentProposalSeq = res.seq;
    planForProposal.set(res.seq, plan.id);
  });
}

/**
 * THE ONE NUMBER THE AIRLOCK EXISTS TO BE ABLE TO PRINT.
 *
 * Not "every step executed" — that is a report on the clicking. Seven writes
 * reached this world and a human passed every one of them, which is either
 * true or it is not, and the console can count it off the log rather than
 * assert it. `metrics` already tallies agent writes that never got through.
 */
function showReceipt(plan: LivePlan): void {
  const foot = plan.el.querySelector<HTMLElement>('.pl-receipt');
  if (!foot) return;
  const n = plan.steps.length;
  foot.hidden = false;
  // ONLY THE GESTURE THAT HAPPENED. A held gesture, or any gesture with no
  // host attached, is yours. A plain click or chord while a host was on the
  // line is reported as what it was, because the page cannot tell whose.
  const tally = { you: 0, click: 0, keyboard: 0 };
  for (const [seq, id] of planForProposal) if (id === plan.id) tally[approvedBy(seq)]++;
  const parts = (['you', 'click', 'keyboard'] as const).filter((k) => tally[k] > 0);
  foot.querySelector<HTMLElement>('.plr-count')!.textContent =
    parts.length <= 1
      ? `${n} of ${n} approved by ${parts[0] ?? 'you'}`
      : `${n} of ${n} approved · ${parts.map((k) => `${tally[k]} by ${k}`).join(' · ')}`;
  foot.querySelector<HTMLElement>('.plr-bypass')!.textContent = '0 writes went round you';
}

/** The slot a proposal's approval card belongs in, if it belongs to a plan. */
function planHostFor(proposalSeq: number): HTMLElement | null {
  const id = planForProposal.get(proposalSeq);
  if (!id) return null;
  const plan = plans.get(id);
  if (!plan) return null;
  return plan.stepEls[plan.index]?.querySelector<HTMLElement>('.pl-slot') ?? null;
}

/** A decision landed on a plan's live step: advance, or abandon the rest. */
function planDecided(proposalSeq: number, executed: boolean): void {
  const id = planForProposal.get(proposalSeq);
  if (!id) return;
  const plan = plans.get(id);
  if (!plan || plan.state !== 'running') return;
  if (executed) {
    // THE ARGUMENT FOR THE ORDER IS PRE-DECISION READING. Once the first step
    // is approved it folds to its heading and opens again on click.
    plan.el.dataset.advanced = 'true';
    if (plan.el.dataset.pin === 'open') {
      delete plan.el.dataset.pin;
      plan.el.dataset.fold = 'true';
    }
    setStepState(plan, plan.index, 'done', 'executed');
    // BEAT 6 — what this approval did to the world, landing on the SAME LINE
    // as the action that caused it. This is the alternation, and putting it
    // anywhere else is what made it unreadable before.
    const host = plan.stepEls[plan.index];
    if (host) landObservation(host, diffFacts(prevFacts, snapshotFacts(world ?? undefined)));
    plan.index += 1;
    advancePlan(plan);
    return;
  }
  setStepState(plan, plan.index, 'skipped', 'you rejected this step');
  for (let i = plan.index + 1; i < plan.steps.length; i++) {
    setStepState(plan, i, 'dropped', 'not proposed — the plan was abandoned');
  }
  plan.state = 'abandoned';
  plan.el.dataset.state = 'abandoned';
  planStopped(plan, 'abandoned', 'A sequence with a hole in it is not the plan that was agreed, so the remaining steps were dropped rather than skipped.');
  clearPlanAnchors(plan);
}

function renderPlan(e: Event): void {
  const d = e.data as { planId?: string; reason?: string; steps?: PlanStep[] };
  const steps = Array.isArray(d.steps) ? d.steps : [];
  if (!d.planId || steps.length < 2) return;
  threadConnected(); // beat 1 first, whatever order the events arrived in

  // THE PLAN IS A ROW, NOT A CARD. It is the beat where the agent stops
  // reading and proposes; that is one event, and it files like every other
  // event on this ledger. What used to be a bordered card mounted inside the
  // timeline's tail — a second row grammar stacked on the first — is now the
  // ledger continuing: one row saying an order was proposed, opening onto
  // the reason the ORDER is load-bearing, and then the steps themselves as
  // rows directly beneath it on the same spine.
  const el = tlAdd('plan', `Proposed a ${steps.length}-step response, in one order`);
  el.classList.add('plan-card');
  el.dataset.state = 'running';
  el.dataset.testid = `plan-${d.planId}`;
  el.dataset.planId = d.planId;
  // the reason is PRE-DECISION READING, so it is open when the plan lands and
  // folds itself away once the first step has actually run
  el.dataset.pin = 'open';
  tlMeta(el).className = 'tl-meta pl-state';

  const why = document.createElement('p');
  why.className = 'pl-why-t';
  renderCitedText(why, String(d.reason ?? ''));
  tlBody(el).append(why);

  const list = document.createElement('ol');
  list.className = 'tl pl-steps';
  const stepEls: HTMLElement[] = [];
  const anchors: (HTMLElement | null)[] = [];
  steps.forEach((step, i) => {
    const li = tlRow('step', stepDescription(step), '', i + 1);
    li.classList.add('pl-step');
    li.dataset.state = 'pending';
    // STATE DECIDES DENSITY, from the first frame: a queued step is one line.
    // Built open, seven of them filled the dock before anyone was asked
    // anything, which is the plan card's old problem in a new node.
    li.dataset.fold = 'true';
    li.dataset.testid = `plan-step-${d.planId}-${i}`;
    tlTitle(li).classList.add('pl-what');
    tlTitle(li).title = stepDescription(step);

    // WHAT IT TOUCHES BELONGS TO THE ACTION, so it rides the action's own
    // row, in the machine-value slot every other row uses for the same job.
    const spec = WRITE_ACTIONS[step.tool];
    if (spec) {
      const m = tlMeta(li);
      m.classList.add('pl-touch');
      m.textContent = WHAT_IT_TOUCHES[spec.tierName] ?? spec.tierName;
    }

    // ---- what the row opens into: why, what it costs, and the two buttons
    const inner = tlBody(li);
    if (step.because) {
      const b = document.createElement('p');
      b.className = 'pl-because';
      renderCitedText(b, step.because);
      inner.append(b);
    }
    const cost = WRITE_ACTIONS[step.tool]?.cost;
    if (cost) {
      const c = document.createElement('p');
      c.className = 'pl-cost';
      const ck = document.createElement('span');
      ck.className = 'pl-cost-k';
      ck.textContent = 'Costs';
      c.append(ck, document.createTextNode(cost));
      inner.append(c);
    }
    const note = document.createElement('p');
    note.className = 'pl-note';
    note.textContent = i === 0 ? 'proposing…' : 'not proposed until the step above has run';
    inner.append(note);
    const slot = document.createElement('div');
    slot.className = 'pl-slot';
    inner.append(slot);

    list.append(li);
    stepEls.push(li);
    // THE WHOLE SEQUENCE LIGHTS UP ON THE CONSOLE, IN ORDER, before a single
    // step is approved: the operator sees where this plan lands on the
    // surface they already operate, not only inside the agent's column.
    const anchor = anchorFor(step.tool, step.input);
    anchors.push(anchor);
    if (anchor) {
      anchor.classList.add('plan-anchor');
      anchor.dataset.planStep = String(i + 1);
      anchor.dataset.planState = 'pending';
    }
  });
  el.append(list);

  const receipt = document.createElement('footer');
  receipt.className = 'pl-receipt';
  receipt.hidden = true;
  receipt.dataset.testid = 'plan-receipt';
  receipt.innerHTML =
    '<span class="plr-count"></span><span class="plr-bypass"></span>';
  el.append(receipt);

  const plan: LivePlan = {
    id: d.planId,
    reason: String(d.reason ?? ''),
    steps,
    index: 0,
    el,
    stepEls,
    pips: [],
    anchors,
    state: 'running',
  };
  plans.set(plan.id, plan);
  foldTimeline(); // the preamble compresses the moment the plan lands
  syncAirlock();
  advancePlan(plan);
}

/**
 * A plan that finished AND ended the incident says so on the receipt.
 * Reported once, when it is actually true — not when the clicking stopped.
 */
function reportPlanOutcome(): void {
  if (document.documentElement.dataset.health !== 'ok') return;
  for (const plan of plans.values()) {
    if (plan.state !== 'complete' || plan.el.dataset.outcome) continue;
    plan.el.dataset.outcome = 'resolved';
    // and the thread closes with it: the column that carried the whole
    // response should not go silent at the moment it worked
    threadResolved();
  }
}

function resetPlans(): void {
  for (const p of plans.values()) clearPlanAnchors(p);
  plans.clear();
  planForProposal.clear();
  approvalToProposal.clear();
}

/**
 * "tier 3 · route" told a first-time operator nothing: `tier` is this
 * codebase's internal risk ladder and the number is meaningless without it.
 * The card says what the change TOUCHES, in words anyone on call already
 * uses, and names the only consequence of the ladder they can act on —
 * whether it needs the second key. The tier number stays in the event log,
 * where it belongs, for the audit trail and the engine's own checks.
 */
const WHAT_IT_TOUCHES: Record<string, string> = {
  deploy: 'a deploy',
  env: 'an environment value',
  flag: 'a feature flag',
  route: 'traffic routing',
  dns: 'DNS',
  service: 'a service',
  data: 'the database',
  cache: 'a cache',
  alerting: 'alerting',
  incident: 'this incident',
  comms: 'what customers are told',
};

/**
 * THE HELD GESTURE.
 *
 * A host that can call the page's tools can usually operate the page too —
 * ChatGPT's in-app browser did exactly that: proposed a change through
 * `propose_*`, then clicked Approve itself, and the receipt said "approved
 * by you" because a synthetic click is indistinguishable from a person's.
 * The page cannot make a computer-use host impossible to bypass. It can make
 * approval a gesture that a one-shot click does not satisfy, and say so.
 *
 * So while a host is attached, Approve is press-and-hold: `pointerdown`
 * starts a 700ms hold with a visible fill, any release, leave or cancel
 * before that ends it, and only completion approves. A plain click — real
 * or synthesised — starts a hold and ends it a few milliseconds later. The
 * keyboard chord holds the same way (⌘ enter down for 700ms, auto-repeat
 * ignored, any keyup cancels): a synthesised keypress is exactly as cheap
 * as a synthesised click, so the two paths cost the same. With no host on
 * the line nothing changes — a click is a click.
 */
const HOLD_MS = 700;
type Hold = { start: (kind: 'pointer' | 'key') => void; cancel: () => void };
const holds = new WeakMap<HTMLElement, Hold>();

function armHold(el: HTMLElement, done: (via: 'hold' | 'key-hold') => void): Hold {
  let timer: number | null = null;
  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    delete el.dataset.holding;
  };
  const start = (kind: 'pointer' | 'key'): void => {
    if (timer !== null || el.dataset.hold !== '1') return;
    if ((el as HTMLButtonElement).disabled) return;
    el.dataset.holding = '1';
    timer = window.setTimeout(() => {
      timer = null;
      delete el.dataset.holding;
      done(kind === 'pointer' ? 'hold' : 'key-hold');
    }, HOLD_MS);
  };
  el.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    start('pointer');
  });
  const release = (): void => {
    cancel();
    // the click that follows a completed hold's release is not a second
    // gesture; the flag that says so lives exactly as long as that click
    if (el.dataset.held === '1') window.setTimeout(() => delete el.dataset.held, 0);
  };
  for (const t of ['pointerup', 'pointerleave', 'pointercancel']) el.addEventListener(t, release);
  const h = { start, cancel };
  holds.set(el, h);
  return h;
}

/** A click where a hold was needed: the control says so for a beat. */
function nudgeHold(el: HTMLElement): void {
  el.dataset.nudge = '1';
  window.setTimeout(() => delete el.dataset.nudge, 700);
}

/**
 * The host can attach after a card is on screen; the card follows. Called
 * from every status-bar render, which is every capability render.
 */
function syncHoldMode(): void {
  const hold = hostAttached();
  for (const { card } of pendingCards.values()) {
    const btn = card.querySelector<HTMLButtonElement>('.ap-approve');
    if (!btn) continue;
    if (hold) btn.dataset.hold = '1';
    else delete btn.dataset.hold;
    const label = btn.querySelector<HTMLElement>('.ap-label');
    if (label) label.textContent = hold ? 'Hold to approve' : 'Approve';
    const key = card.querySelector<HTMLElement>('.ap-key');
    if (key) {
      if (hold) key.dataset.hold = '1';
      else delete key.dataset.hold;
    }
  }
}

/**
 * How each approval arrived, kept on the page so the receipt can say it.
 * `hosted` is whether a host was attached at the moment of the gesture —
 * the only moment the distinction means anything.
 */
const decisionGesture = new Map<number, { via: string; hosted: boolean }>();

/** Who or what an approval is credited to. Held gestures, and every gesture with no host attached, are yours. */
function approvedBy(proposalSeq: number): 'you' | 'click' | 'keyboard' {
  const g = decisionGesture.get(proposalSeq);
  if (!g || !g.hosted) return 'you';
  if (g.via === 'click') return 'click';
  if (g.via === 'key') return 'keyboard';
  return 'you';
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
  // ONE VOICE AT THE MOMENT OF DECISION. The narration line is for what the
  // agent is doing while nobody is being asked anything; left running under a
  // pending approval it is a second, staler voice describing a read that has
  // already finished, above the two buttons that are the actual question.
  narrate(null);
  const card = document.createElement('div');
  card.dataset.proposalSeq = String(e.seq);
  card.dataset.tier = String(d.tier);
  card.dataset.testid = `approval-${e.seq}`;
  // A proposal is on the key rung either because of its tier, or because the
  // page knows where the idea came from (src/sim/provenance.ts).
  const dualKey = d.tier === 4 || d.requiresKey === true;
  // with a host on the line, approval is a HELD gesture (see armHold)
  const hold = hostAttached();
  card.innerHTML = `
    <div class="ap-head">
      <span class="ap-actor">agent proposes</span>
      <span class="ap-tier">${WHAT_IT_TOUCHES[d.tierName] ?? d.tierName}${dualKey ? ' · needs your key' : ''}</span>
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
        ? `<label class="ap-key"${hold ? ' data-hold="1"' : ''}><span class="ap-fill" aria-hidden="true"></span><input type="checkbox" class="ap-key-toggle" data-testid="key-${e.seq}"><span class="ap-key-text">${hold ? 'hold to engage key' : 'engage key'} — held while the agent executes${d.provenance ? ' (required: untrusted evidence)' : ''}</span></label>`
        : ''
    }
    <div class="ap-actions">
      <button type="button" class="ctl-btn primary ap-approve" data-act="approve" data-seq="${e.seq}" data-testid="approve-${e.seq}"${hold ? ' data-hold="1"' : ''} ${dualKey ? 'disabled' : ''}><span class="ap-fill" aria-hidden="true"></span><span class="ap-label">${hold ? 'Hold to approve' : 'Approve'}</span><kbd class="ap-kbd">⌘ enter</kbd></button>
      <button type="button" class="ctl-btn ap-reject" data-act="reject" data-seq="${e.seq}" data-testid="reject-${e.seq}">Reject<kbd class="ap-kbd">⌘ del</kbd></button>
    </div>
  `;
  card.querySelector('.ap-diff')!.textContent = d.diffSummary;
  // right under WHAT it wants, before WHETHER you may: the review order
  card.querySelector('.ap-diff')!.after(buildEvidence(e.seq));
  // textContent, never innerHTML: this string is attacker-controlled
  const quote = card.querySelector('.ap-prov-quote');
  // the line carries its own quoting; wrapping it again collides with it
  if (quote && d.provenance) quote.textContent = d.provenance.excerpt;
  card.querySelector<HTMLInputElement>('.ap-key-toggle')?.addEventListener('change', (ev) => {
    const engaged = (ev.target as HTMLInputElement).checked;
    card.querySelector<HTMLButtonElement>('.ap-approve')!.disabled = !engaged;
  });
  const approveBtn = card.querySelector<HTMLButtonElement>('.ap-approve')!;
  armHold(approveBtn, (via) => {
    approveBtn.dataset.held = '1';
    approveBtn.dataset.via = via;
    approveBtn.click(); // the one path every decision takes (below, data-act)
    approveBtn.disabled = true; // the pointer's own trailing click lands on nothing
  });
  const keyToggle = card.querySelector<HTMLInputElement>('.ap-key-toggle');
  const keyLabel = card.querySelector<HTMLElement>('.ap-key');
  if (keyToggle && keyLabel) {
    // The second key is the same gesture as the first: with a host attached,
    // engaging it is a hold on the label, and a click — which a host can
    // synthesise — only ever RELEASES it.
    const keyHold = armHold(keyLabel, () => {
      keyLabel.dataset.held = '1';
      keyToggle.checked = true;
      keyToggle.dispatchEvent(new window.Event('change'));
    });
    keyToggle.addEventListener('click', (ev) => {
      if (keyLabel.dataset.hold !== '1') return;
      // the pointer's trailing click after a completed hold, or a click
      // trying to engage: neither is the gesture
      if (keyLabel.dataset.held === '1' || keyToggle.checked) {
        ev.preventDefault();
        if (keyLabel.dataset.held !== '1') nudgeHold(keyLabel);
      }
    });
    keyToggle.addEventListener('keydown', (ev) => {
      if (ev.key !== ' ' || keyLabel.dataset.hold !== '1' || keyToggle.checked) return;
      ev.preventDefault();
      if (!ev.repeat) keyHold.start('key');
    });
    keyToggle.addEventListener('keyup', (ev) => {
      if (ev.key === ' ') keyHold.cancel();
    });
  }
  // The card lives in the AIRLOCK — a pinned region of the centre pane. It
  // used to be inserted after the row it would mutate, which reads well until
  // that row is below the fold or on an inactive evidence tab, and then the
  // one decision the agent is waiting on is invisible. The row still lights
  // up (`.proposal-anchor`), so the card says what, the row says where.
  const anchor = anchorFor(d.tool, d.input);
  if (anchor) {
    anchor.classList.add('proposal-anchor');
    revealAnchor(anchor);
  }
  // a plan step's card belongs INSIDE its step, so the sequence stays one
  // object on screen instead of scattering into loose asks
  const slot = planHostFor(e.seq);
  if (slot) {
    card.classList.add('approval-card');
    slot.appendChild(card);
  } else {
    // A STANDALONE PROPOSAL IS A STEP OF ONE. It was the last bordered card
    // in the dock — its own left rule, its own ground, mounted in the live
    // tail under a "Waiting on you" label — which is the second grammar the
    // plan gave up. A real agent mostly makes exactly this move: one
    // propose_* call, no plan. So it files the way a plan step files: a row
    // on the spine, what it would do as the title, what it touches on the
    // right, and the ask itself in the row's own expansion.
    card.classList.add('ap-ask');
    askRow(e.seq, d, dualKey).querySelector<HTMLElement>('.pl-slot')!.appendChild(card);
  }
  // THE COLUMN ADVANCES, it does not jump. The live step is sticky to the
  // bottom of the dock, so scrollIntoView saw it as already visible and did
  // nothing — which meant the steps between the top of the timeline and the
  // decision stayed hidden BEHIND the sticky card, chopped mid-line. Running
  // the scroller to the end puts the newest beat at the bottom and the ones
  // that led to it directly above, in order, which is the whole point.
  const scroller = card.closest<HTMLElement>('.dock-body');
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
  else card.scrollIntoView({ block: 'nearest' });
  pendingCards.set(e.seq, {
    card,
    anchor,
    ask: {
      seq: e.seq,
      summary: d.diffSummary,
      touches: WHAT_IT_TOUCHES[d.tierName] ?? d.tierName,
      dualKey,
      scope: proposalScope(d.tool, d.input),
    },
  });
  syncAirlock();
}

/** If the highlighted row sits on an evidence tab that isn't showing, show it. */
function revealAnchor(anchor: HTMLElement): void {
  const pane = anchor.closest<HTMLElement>('.tabpane');
  if (pane && pane.hidden) selectTab(pane.id.replace(/^zone-|^err-/, '') as string);
  anchor.scrollIntoView({ block: 'nearest' });
}

/** proposalSeq → the ledger row a standalone proposal filed as */
const askRows = new Map<number, HTMLElement>();

/**
 * The row a standalone proposal files as. It is a plan step's row — same
 * kind, same states, same density rule, same slot for the ask — with one
 * difference in the marker: a step of one has no ordinal, so the disc in
 * the step-number slot carries the agent's diamond instead of a number.
 */
function askRow(
  seq: number,
  d: { tool: string; tierName: string; diffSummary: string },
  dualKey: boolean
): HTMLElement {
  threadConnected(); // beat 1 first, whatever order the events arrived in
  const touches = WHAT_IT_TOUCHES[d.tierName] ?? d.tierName;
  const el = tlAdd('step', d.diffSummary, `${touches}${dualKey ? ' · needs your key' : ''}`);
  el.classList.add('tl-ask');
  el.dataset.state = 'live';
  el.dataset.testid = `ask-${seq}`;
  // it holds itself open until it is decided; foldTimeline leaves it alone
  el.dataset.hold = 'true';
  el.dataset.fold = 'false';
  const n = document.createElement('span');
  n.className = 'tl-n tl-n-ask';
  n.setAttribute('aria-hidden', 'true');
  el.querySelector('.tl-head')!.prepend(n);
  tlTitle(el).classList.add('pl-what');
  tlTitle(el).title = d.diffSummary;
  tlMeta(el).classList.add('pl-touch');

  const inner = tlBody(el);
  const cost = WRITE_ACTIONS[d.tool]?.cost;
  if (cost) {
    const c = document.createElement('p');
    c.className = 'pl-cost';
    const ck = document.createElement('span');
    ck.className = 'pl-cost-k';
    ck.textContent = 'Costs';
    c.append(ck, document.createTextNode(cost));
    inner.append(c);
  }
  const note = document.createElement('p');
  note.className = 'pl-note';
  note.textContent = 'waiting on your decision';
  inner.append(note);
  const slot = document.createElement('div');
  slot.className = 'pl-slot';
  inner.append(slot);
  askRows.set(seq, el);
  return el;
}

/** The state a standalone ask's row takes once a person has answered it. */
function askDecided(proposalSeq: number, state: 'done' | 'skipped', note: string): void {
  const el = askRows.get(proposalSeq);
  if (!el) return;
  el.dataset.state = state;
  el.querySelector<HTMLElement>('.pl-note')!.textContent = note;
  delete el.dataset.hold;
  // STATE DECIDES DENSITY, and a person's own pin still wins — see setStepState
  if (el.dataset.pin !== 'open') el.dataset.fold = 'true';
  if (state === 'skipped') landRefusal(el, note);
}

/**
 * The same beat a plan step gets when its write lands: what it did to the
 * world, as a row directly beneath it. Without a row to file against
 * (a proposal from before a reset) the observation files on its own line.
 */
function askExecuted(proposalSeq: number): void {
  const el = askRows.get(proposalSeq);
  if (!el) {
    standaloneStateReport();
    return;
  }
  const by = approvedBy(proposalSeq);
  el.querySelector<HTMLElement>('.pl-note')!.textContent =
    by === 'you' ? 'executed' : `executed · approved by ${by}`;
  landObservation(el, diffFacts(prevFacts, snapshotFacts(world ?? undefined)));
}

const airlockEl = document.querySelector<HTMLElement>('#airlock')!;
/**
 * Assigned by the palette, which is built further down this file. Reaching
 * the other way — a `const` down there, called from up here — puts a proposal
 * that lands during boot inside its temporal dead zone. The dependency runs
 * one direction only: the airlock announces, the palette listens if it is open.
 */
let paletteRefresh: (() => void) | null = null;
/**
 * The region only exists while something is pending; it never leaves a void.
 * A plan holds it open for its whole life, INCLUDING after the last step ran:
 * the finished sequence with its ticks is the operator's receipt, and it used
 * to vanish the instant the final card resolved.
 */
/** The one narration a DECISION ends, so it is named in both places. */
function waitingNarration(): string {
  return 'Agent is waiting on your decision';
}
function syncAirlock(): void {
  // the region STAYS while a finished plan's receipt is on screen...
  airlockEl.dataset.pending = String(pendingCards.size + plans.size);
  // ...but it must stop SAYING "waiting on you" once it is not. A label that
  // keeps asking after you have answered is the console lying to you.
  const label = airlockEl.querySelector<HTMLElement>('.al-label')!;
  label.dataset.state = pendingCards.size ? 'waiting' : 'settled';
  label.querySelector<HTMLElement>('.al-text')!.textContent = pendingCards.size
    ? pendingCards.size > 1
      ? `Waiting on you · ${pendingCards.size} decisions`
      : 'Waiting on you'
    : 'Nothing waiting on you';
  // ...and the NARRATION under it has to stop saying it too. That line is
  // present tense on a 4s timer, and a decision routinely lands sooner: the
  // settled dock read "Nothing waiting on you" with "Agent is waiting on your
  // decision" directly beneath it, in the exact frame the film ends on. A
  // decision ends that sentence; the timer does not know a decision happened.
  // Only that one line is cleared — a read narration ("Agent is reading the
  // logs") is still true after you decide.
  if (!pendingCards.size) {
    const doing = document.querySelector<HTMLElement>('#agent-doing');
    if (doing && !doing.hidden && doing.textContent === waitingNarration()) narrate(null);
  }
  // ...but the region only ELEVATES while something is actually undecided.
  // Keying elevation off the same count left the dock covering the page for
  // the rest of the session once a plan completed, because its receipt is
  // deliberately kept.
  //
  // A RUNNING PLAN COUNTS AS UNDECIDED. Approving step 1 empties the airlock
  // for the ~6ms it takes step 2's proposal to come back from the worker, and
  // keying elevation off the count alone made the dock un-elevate and
  // re-elevate inside a single frame: 660px → 410px and 250px to the right,
  // then back. That one-frame collapse is the flash after the first approval.
  // Between one step executing and the next being put to you, you have not
  // stopped deciding — the plan says so itself, so ask it.
  const planRunning = [...plans.values()].some((p) => p.state === 'running');
  document.querySelector<HTMLElement>('.wb')!.dataset.decision =
    pendingCards.size || planRunning ? 'pending' : 'none';
  // an ask that arrives or resolves while ⌘K is open
  paletteRefresh?.();
  syncPresence();
}

function resolveApprovalCard(proposalSeq: number): void {
  const entry = pendingCards.get(proposalSeq);
  if (!entry) return;
  entry.card.remove();
  entry.anchor?.classList.remove('proposal-anchor');
  pendingCards.delete(proposalSeq);
  agentSettled();
  syncAirlock();
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

/**
 * THE PILL IS A FOLD OF STATE, NOT A TRAIL OF EVENTS. It used to be set by
 * whatever moved the cursor last — so a hover over Silence printed "working"
 * over a pending decision, and a finished plan stayed "working" for as long
 * as the cursor's idle timer happened to run. Four words, one order:
 *   waiting on you      an ask is undecided
 *   working             a tool call just landed, or a step is being proposed
 *   done                every plan on the ledger has resolved
 *   connected, waiting  nothing in flight, nothing to decide
 */
let agentBusy = false;
let agentBusyTimer: number | undefined;
function syncPresence(): void {
  if (!connected) {
    setPresence('off', 'not connected');
    return;
  }
  if (pendingCards.size) {
    setPresence('live', 'waiting on you');
    return;
  }
  const running = [...plans.values()].some((p) => p.state === 'running');
  if (agentBusy || running) {
    setPresence('live', 'working');
    return;
  }
  setPresence('idle', plans.size ? 'done' : 'connected, waiting');
}
/** a tool call landed: the agent is mid-move for the next beat */
function agentWorking(): void {
  agentBusy = true;
  window.clearTimeout(agentBusyTimer);
  agentBusyTimer = window.setTimeout(() => {
    agentBusy = false;
    syncPresence();
  }, 4000);
  syncPresence();
}
/** a decision ends the move it was waiting on; the timer must not outlive it */
function agentSettled(): void {
  agentBusy = false;
  window.clearTimeout(agentBusyTimer);
  syncPresence();
}

/**
 * The cursor is positioned in VIEWPORT coordinates, so anything that scrolls
 * afterwards (an approval card calling scrollIntoView, the human scrolling
 * the console) leaves the label pointing at nothing. A label pointing at the
 * wrong thing is worse than no label, so it follows its target and hides when
 * the target leaves the viewport. Caught by screenshot.
 */
let lastAgentTarget: Element | null = null;

/** what the chip must never sit on: anything a hand could be reaching for */
const CONTROL_SEL = 'button, [data-act], summary, input, select, textarea, a, label';

/** true if a chip drawn at (x, y, w, h) would cover a control */
function coversControl(x: number, y: number, w: number, h: number): boolean {
  const pts: [number, number][] = [
    [x + 2, y + 2],
    [x + w - 2, y + 2],
    [x + 2, y + h - 2],
    [x + w - 2, y + h - 2],
    [x + w / 2, y + h / 2],
  ];
  // the chip itself is pointer-events: none, so hit-testing looks through it
  return pts.some(([px, py]) => document.elementFromPoint(px, py)?.closest(CONTROL_SEL) != null);
}

/**
 * The left edge of a gap inside a single-line row wide enough for the chip,
 * or null. A row's words and controls sit at its ends; the middle is ground.
 * Text is measured by its glyphs, not its box — the state column stretches
 * across the row and right-aligns its text, so its box says nothing.
 */
function freeSpanIn(target: Element, r: DOMRect, need: number): number | null {
  const spans: [number, number][] = [];
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent?.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const b of range.getClientRects()) if (b.width) spans.push([b.left, b.right]);
  }
  for (const el of target.querySelectorAll(`${CONTROL_SEL}, svg, img`)) {
    const b = el.getBoundingClientRect();
    if (b.width) spans.push([b.left, b.right]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let edge = r.left + 4;
  for (const [l, rt] of spans) {
    if (l - edge >= need) return Math.round(edge + 6);
    edge = Math.max(edge, rt);
  }
  return r.right - 4 - edge >= need ? Math.round(edge + 6) : null;
}

function placeAgentCursor(target: Element): void {
  const r = target.getBoundingClientRect();
  if (r.width === 0) return;
  const offscreen = r.bottom < 0 || r.top > window.innerHeight;
  agentCursor.hidden = offscreen;
  if (offscreen) return;
  const box = agentCursor.getBoundingClientRect();
  const w = box.width || 64;
  const h = box.height || 18;
  const clampX = (x: number): number => Math.round(Math.min(Math.max(4, x), window.innerWidth - w - 4));
  const above = Math.max(4, Math.round(r.top - 22));
  const below = Math.round(r.bottom + 4);
  // WHERE IT RESTS. Above-right was the rule (above-left printed "Agent" on
  // the group heading), but every control row ends in an `Actions` menu, so
  // above-right of one row is exactly on top of the row above's menu — at
  // the resolved beat the chip sat on the web row's `Actions ▾`. A single-
  // line row has ground in its middle, between its name and its state, and
  // a chip there covers nothing and says "on this row" more plainly than a
  // chip floating over the row above. Failing that, the four shoulders in
  // the old order, the first that does not land on a control.
  const rest: [number, number] = [clampX(r.right - w), above];
  const cands: [number, number][] = [];
  if (r.height <= 48) {
    const gap = freeSpanIn(target, r, w + 12);
    if (gap !== null) cands.push([clampX(gap), Math.round(r.top + (r.height - h) / 2)]);
  }
  cands.push(rest, [clampX(r.left), above], [clampX(r.right - w), below], [clampX(r.left), below]);
  const [x, y] = cands.find(([cx, cy]) => !coversControl(cx, cy, w, h)) ?? rest;
  agentCursor.style.transform = `translate(${x}px, ${y}px)`;
}

function repositionAgentCursor(): void {
  if (lastAgentTarget && lastAgentTarget.isConnected) placeAgentCursor(lastAgentTarget);
}
// capture phase: the console's inner scrollers do not bubble scroll events
window.addEventListener('scroll', repositionAgentCursor, { capture: true, passive: true });
window.addEventListener('resize', repositionAgentCursor, { passive: true });

function moveAgentCursor(target: Element | null): void {
  if (!target) return;
  // The cursor exists to show CO-PRESENCE on the shared surface — the console
  // both parties operate. Inside the agent's own rail it is redundant (the
  // presence card and the narration line already say it, better) and it lands
  // on top of the labels it would explain. Caught by screenshot.
  if (target.closest('#tool-rail')) {
    agentCursor.dataset.state = 'idle';
    return;
  }
  const r = target.getBoundingClientRect();
  if (r.width === 0) return;
  // ride the TOP-LEFT shoulder of the target: landing on the middle put the
  // label straight over the Approve button the human needs to click
  // Sit FULLY above the target, never on top of it. `top - 9` still covered
  // the first ~9px of a full-width row (it was landing on the db service
  // line); clamp so a target near the top of the viewport keeps the label
  // on screen. Caught by screenshot, like the Approve-button overlap before.
  // A burst of reads against the same region used to re-place the cursor on
  // every one of them, which is the twitch. Staying put IS the signal that
  // it is still looking there.
  if (target !== lastAgentTarget) placeAgentCursor(target);
  lastAgentTarget = target;
  agentCursor.dataset.state = 'active';
  window.clearTimeout(agentIdleTimer);
  agentIdleTimer = window.setTimeout(() => {
    // it fades out rather than parking: a label left on a region the agent
    // stopped reading is a claim that is no longer true
    agentCursor.dataset.state = 'idle';
    lastAgentTarget = null;
  }, 4000);
}

/**
 * AGENT LEGIBILITY (ux-debt #12 follow-on, Sid: "really clear, elegant
 * transitions that make you feel safe and understood").
 *
 * One idea, applied everywhere: THE AGENT'S ATTENTION IS ALWAYS VISIBLE ON
 * THE SURFACE IT IS TOUCHING. A read is not a log entry — it is the console
 * region lighting up because someone just looked at it. The point is not
 * decoration: if the gate cannot promise rescue, what it can promise is that
 * you always know what the agent looked at, what it can reach, and what it
 * wants to change.
 */

/** Each read tool, said as a person would say it, and where it reads FROM. */
/* `says` is the PRESENT tense, for the live narration line ("Agent is reading
   service logs"). `reads` is the same read named as a thing, for the timeline
   entry, which is written after the fact ("Read the service logs"). One
   record, because a read that narrates one way and files another is two
   different claims about the same call. */
const READ_NARRATION: Record<string, { says: string; reads: string; region: string }> = {
  airlock_status: { says: 'checking service health and impact', reads: 'service health and impact', region: '#situation' },
  list_deploys: { says: 'reviewing what shipped recently', reads: 'what shipped recently', region: '#zone-changed' },
  // the logs are their own pane; #zone-activity is the activity feed, and
  // pointing a read at a surface that does not hold what it read is a dead link
  read_logs: { says: 'reading service logs', reads: 'the service logs', region: '#zone-logs' },
  list_changes: { says: 'checking flags, env and routes', reads: 'flags, env and routes', region: '#zone-controls' },
  traffic_history: { says: 'looking at the error-rate history', reads: 'the error-rate history', region: '#err-chart' },
  explain_surface: { says: 'asking why its tools changed', reads: 'why its tools changed', region: '#tool-surface' },
};

const WRITE_NARRATION: Record<string, string> = {
  propose_flag_change: 'asking to change a feature flag',
  propose_rollback: 'asking to roll a deploy back',
  propose_rollforward: 'asking to ship a fixed build forward',
  propose_env_change: 'asking to change an environment value',
  propose_route_change: 'asking to move traffic',
};

let narrationTimer: number | undefined;

/** Say what the agent is doing, in words, where the human is already looking. */
function narrate(text: string | null): void {
  const el = document.querySelector<HTMLElement>('#agent-doing');
  if (!el) return;
  window.clearTimeout(narrationTimer);
  if (!text) {
    el.hidden = true;
    return;
  }
  el.textContent = text;
  el.hidden = false;
  // it describes the present tense, so it must not outlive it
  narrationTimer = window.setTimeout(() => {
    el.hidden = true;
  }, 4000);
}

/**
 * Light up the region the data actually came from. This is the "you can see
 * it looking around" beat, and it is why a read is worth rendering at all.
 */
function touchRegion(selector: string): void {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return;
  // ATTENTION IS SINGULAR. Reads arrive in bursts, so without this the whole
  // console glows at once and the signal becomes wallpaper — the opposite of
  // legible. Exactly one region is ever lit: where it is looking NOW.
  for (const prev of document.querySelectorAll('.agent-touch')) {
    prev.classList.remove('agent-touch');
  }
  void el.offsetWidth; // restart the animation on a repeat read
  el.classList.add('agent-touch');
  window.setTimeout(() => el.classList.remove('agent-touch'), 1400);
}

/** Called for every agent event: narrate it and touch what it touched. */
/**
 * The agent's own read of the incident, in the operator's console.
 *
 * This is the whole reason record_finding exists. WebMCP hands the page tool
 * calls, never the model's reasoning — so the best thing our agent produced
 * ("I did not roll back d-201: 43,857 rows are already in v2 and 1.9.x reads
 * only v1") was invisible to the person who needed it most. What it RULED
 * OUT is often worth more than what it did.
 */
/**
 * THE AIRLOCK POINTS BOTH WAYS.
 *
 * Everyone builds "human approves agent". The other direction is the one
 * that actually bites at 3am: the HUMAN reaches for the obvious lever and it
 * is the wrong one. Our own console has a Roll back button that will strand
 * old code in front of migrated data, and nothing stopped anyone clicking it.
 *
 * An agent that has already read the evidence can say so. It COUNSELS, it
 * NEVER BLOCKS — the human stays sovereign or the whole thesis inverts. One
 * click surfaces the reasoning; the next one proceeds regardless.
 */
const advisories = new Map<string, { summary: string; ruledOut?: string }>();

/** The answer-key vocabulary, so agent advice and human clicks speak the same language. */
function humanActionKey(tool: string, input: Record<string, unknown>): string {
  return actionKey(tool, input);
}

/** the action key the open caution is about — the control may re-render under it */
let cautionKey: string | null = null;

function clearCaution(): void {
  cautionKey = null;
  document.querySelectorAll('.agent-caution').forEach((n) => n.remove());
  document.querySelectorAll<HTMLElement>('[data-caution="pending"]').forEach((b) => {
    delete b.dataset.caution;
  });
}

/**
 * Show the agent's objection next to the control the human just reached for.
 * Returns true if we intercepted (caller must not dispatch yet).
 */
function cautionFor(btn: HTMLButtonElement, key: string): boolean {
  const advice = advisories.get(key);
  if (!advice) return false;
  // SECOND CLICK: THEY MEANT IT. The caution goes with the click — it used to
  // rely on the row re-rendering under it, which the command row does not do
  // while a caution is outside it, and a re-render between the two clicks
  // (a tick) replaced the button and lost its flag, so the second click was
  // intercepted again. The key survives both.
  if (btn.dataset.caution === 'pending' || cautionKey === key) {
    clearCaution();
    return false;
  }
  clearCaution();
  cautionKey = key;
  // ONE OBJECTION AT A TIME. The hover popover answered the reach; the click
  // is the next beat, and a hand that clicks without moving leaves the
  // popover up, layered over this caution with the same sentence in both.
  clearHoverCounsel();
  btn.dataset.caution = 'pending';

  const box = document.createElement('div');
  box.className = 'agent-caution';
  box.dataset.testid = 'agent-caution';
  box.setAttribute('role', 'alert');

  const who = document.createElement('span');
  who.className = 'caution-who';
  who.textContent = 'The agent has read this';
  const why = document.createElement('p');
  why.className = 'caution-why';
  why.textContent = advice.ruledOut ?? advice.summary;
  const foot = document.createElement('p');
  foot.className = 'caution-foot';
  foot.textContent = 'Click again to do it anyway.';

  box.append(who, why, foot);
  // A DEPLOY ROW IS A GRID, and its action cell is an `auto` track. Dropped
  // beside the button inside that cell, the caution stretched Roll back to
  // its own height (240px) and squeezed the deploy's title to one word per
  // line. It files as a row of the grid instead, under the whole deploy row
  // — the same track the Details disclosure already spans.
  // THE COMMAND ROW NEVER WRAPS (`.cmd-row` is nowrap by rule), so a caution
  // dropped beside Silence was squeezed to one word per line and 900px tall.
  // It files after the row instead, inside the bar, which does wrap: a full
  // line under all six commands, the way the deploy caution is a row of its
  // card.
  const host = btn.closest('.deploy-card')
    ? (btn.closest<HTMLElement>('.dc-actions') ?? btn)
    : (btn.closest<HTMLElement>('.cmd-row') ?? btn);
  host.parentElement?.insertBefore(box, host.nextSibling);
  // A warning below the fold is not a warning. `nearest` keeps this inside
  // the console's own scroller — `center` drags the whole shell (the bug the
  // stream hit earlier).
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return true;
}

/**
 * The agent speaks BEFORE the click, not after it.
 *
 * `cautionFor` intercepts a press, which is the safe backstop — but by then
 * the operator has already decided. If the agent has ruled an action out, the
 * moment worth telling them is when they REACH for it. Hovering a control the
 * agent has advised against surfaces its objection, in the agent's own
 * colour, attached to that control: counsel, not a block. The click path is
 * untouched, so nothing here can prevent a human from acting.
 */
function actionKeyOfControl(btn: HTMLElement): string | null {
  const w = world;
  if (!w) return null;
  switch (btn.dataset.act) {
    case 'flag-toggle': {
      const flag = w.flags.find((f) => f.id === btn.dataset.flag);
      if (!flag) return null;
      const on = flag.state === 'on' || (typeof flag.state === 'number' && flag.state > 0);
      return humanActionKey('flag.set', { id: flag.id, state: on ? 'off' : 'on' });
    }
    case 'rollback':
      return humanActionKey('deploy.rollback', { deployId: btn.dataset.deploy });
    case 'lever':
    case 'undo-holding':
      return humanActionKey(
        String(btn.dataset.tool),
        JSON.parse(String(btn.dataset.input)) as Record<string, unknown>
      );
    default:
      return null;
  }
}

/** The hover objection: one at a time, removed the moment the pointer leaves. */
function clearHoverCounsel(): void {
  document.querySelectorAll('.agent-counsel').forEach((n) => n.remove());
  document.querySelectorAll('[data-counselled]').forEach((n) => {
    delete (n as HTMLElement).dataset.counselled;
  });
}

function showHoverCounsel(btn: HTMLElement): void {
  if (btn.dataset.counselled === 'true' || btn.dataset.caution === 'pending') return;
  const key = actionKeyOfControl(btn);
  if (!key) return;
  const advice = advisories.get(key);
  if (!advice) return;
  clearHoverCounsel();
  btn.dataset.counselled = 'true';

  const box = document.createElement('div');
  box.className = 'agent-counsel';
  box.dataset.testid = 'agent-counsel';
  const who = document.createElement('span');
  who.className = 'counsel-who';
  who.textContent = 'The agent advises against this';
  const why = document.createElement('p');
  why.className = 'counsel-why';
  why.textContent = advice.ruledOut ?? advice.summary;
  box.append(who, why);
  btn.parentElement?.insertBefore(box, btn.nextSibling);
  // KEEP THE OBJECTION ON SCREEN. `.wb-centre` is `overflow: hidden` — the
  // console is a region, not a page — so a popover that always opens to the
  // RIGHT is clipped the moment its control sits near the pane's edge. With
  // the storefront open (it reveals itself when checkout starts failing) the
  // centre is at its 560px floor, which is exactly where the counsel scene
  // gets reviewed: the agent's objection shipped as a violet sliver about
  // fifteen pixels wide. Flip it to the other side, and put it under the
  // control if neither side fits.
  const pane = document.querySelector('.wb-centre');
  if (pane) {
    const lim = pane.getBoundingClientRect();
    if (box.getBoundingClientRect().right > lim.right - 8) {
      box.dataset.side = 'left';
      if (box.getBoundingClientRect().left < lim.left + 8) box.dataset.side = 'below';
    }
  }
  moveAgentCursor(btn);
}

document.querySelector('#console')!.addEventListener('pointerover', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (btn) showHoverCounsel(btn);
  else clearHoverCounsel();
});
document.querySelector('#console')!.addEventListener('pointerleave', clearHoverCounsel);
// keyboard reaches the same counsel: tabbing onto the control is reaching for it
document.querySelector('#console')!.addEventListener('focusin', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (btn) showHoverCounsel(btn);
});
document.querySelector('#console')!.addEventListener('focusout', clearHoverCounsel);

/* ======================================================================
   THE AGENT TIMELINE — one ordered list, six kinds, one spine.

   Sid, 2026-09-02: "the linear flow should be I wake up the agent, I see it
   run tools, I see it learn a hypothesis, it proposes a plan, we execute
   steps of the plan, it reports intermediate state, we continue executing
   steps, and final observation is incident closure. I don't see any of that
   sequence at all in the current UX."

   He was right, and the reason is structural rather than cosmetic: the dock
   rendered CONCLUSIONS. Three of the seven beats had no representation at
   all, and the three that did were all the same `.finding` element with a
   different modifier class, so nothing on screen said these were different
   KINDS of event. A reader could not tell a tool call from a hypothesis
   from a receipt without reading every word.

   Every entry now declares its kind, and kind decides the marker, the
   colour and the density. `tlAdd` is the only way onto the list, so a new
   beat cannot arrive without picking one.
   ====================================================================== */

type TlKind = 'connect' | 'call' | 'finding' | 'plan' | 'step' | 'state' | 'resolved';

const tlHost = (): HTMLElement | null => document.querySelector<HTMLElement>('#agent-timeline');
const tlTail = (): HTMLElement | null => document.querySelector<HTMLElement>('#tl-tail');

/** The empty state goes the moment anything real lands on the list. */
function tlStarted(): void {
  const empty = document.querySelector<HTMLElement>('#findings-empty');
  if (empty) empty.hidden = true;
}

/**
 * THE ROW. There is exactly one, and every beat of the incident is one of
 * these: the agent connecting, each tool call, each finding, the plan, each
 * step of it, each observation of what a step did, and the resolution.
 *
 *   [marker]  what happened, in prose            the machine value
 *             └── what it opens into
 *
 * Kind decides the marker and the voice; NOTHING else varies. A plan step is
 * not a card, an observation is not a tinted box, a tool call is not a list
 * item in someone else's list. That is the whole of *"there is still no
 * linear ledger"*: the previous panel had a row grammar for the preamble and
 * a card grammar for the plan, stacked, and two grammars read as two things.
 */
function tlRow(kind: TlKind, title: string, meta = '', ordinal?: number): HTMLElement {
  const el = document.createElement('li');
  el.className = 'tl-ev';
  el.dataset.kind = kind;
  el.dataset.fold = 'false';

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'tl-head';
  if (ordinal !== undefined) {
    const n = document.createElement('span');
    n.className = 'tl-n';
    n.textContent = String(ordinal);
    n.setAttribute('aria-hidden', 'true');
    head.append(n);
  }
  const t = document.createElement('span');
  t.className = 'tl-title';
  t.textContent = title;
  head.append(t);
  if (meta) {
    const m = document.createElement('span');
    m.className = 'tl-meta';
    m.textContent = meta;
    head.append(m);
  }
  head.addEventListener('click', () => {
    if (el.dataset.leaf === 'true') return;
    el.dataset.fold = el.dataset.fold === 'true' ? 'false' : 'true';
    el.dataset.pin = el.dataset.fold === 'true' ? 'shut' : 'open';
  });
  el.append(head);

  // TWO ELEMENTS, because the 0fr -> 1fr collapse only tracks ONE grid row:
  // the outer is the track, the inner is the content that gets clipped.
  const body = document.createElement('div');
  body.className = 'tl-body';
  const inner = document.createElement('div');
  inner.className = 'tl-in';
  body.append(inner);
  el.append(body);
  return el;
}

/** A row, filed on the ledger above the live tail. `tlRow` is the shape. */
function tlAdd(kind: TlKind, title: string, meta = '', ordinal?: number): HTMLElement {
  const host = tlHost();
  if (!host) throw new Error('timeline missing');
  tlStarted();
  const el = tlRow(kind, title, meta, ordinal);
  // the tail is the PRESENT — everything that already happened goes above it
  const tail = tlTail();
  if (tail && tail.parentElement === host) host.insertBefore(el, tail);
  else host.append(el);
  foldTimeline();
  return el;
}

const tlBody = (el: HTMLElement): HTMLElement => el.querySelector<HTMLElement>('.tl-in')!;
const tlTitle = (el: HTMLElement): HTMLElement => el.querySelector<HTMLElement>('.tl-title')!;
const tlMeta = (el: HTMLElement): HTMLElement => {
  let m = el.querySelector<HTMLElement>(':scope > .tl-head > .tl-meta');
  if (!m) {
    m = document.createElement('span');
    m.className = 'tl-meta';
    el.querySelector('.tl-head')!.append(m);
  }
  return m;
};

/**
 * NEWEST OPEN, EVERYTHING ABOVE IT FOLDED — except what a person opened by
 * hand, and except the resolution, which is the answer to the only question
 * anyone asked.
 *
 * Plan steps are NOT folded here: their state folds them (see setStepState),
 * because a step's density is a fact about the step, not about its age.
 */
function foldTimeline(): void {
  const host = tlHost();
  if (!host) return;
  const entries = [...host.children].filter(
    (c) => (c as HTMLElement).classList.contains('tl-ev') && (c as HTMLElement).dataset.kind !== 'live'
  ) as HTMLElement[];
  // ONCE A PLAN IS ON SCREEN, THE PREAMBLE IS PREAMBLE. The connect, the tool
  // calls and the findings are why the plan is worth reading; they are not
  // what anyone is deciding, and left at full height they cost the seventh
  // step its place on screen. Every one of them folds to a line the moment
  // the plan arrives — and every one of them still opens on click, which is
  // the difference between folding history and hiding it.
  const planning = plans.size > 0;
  const last = entries[entries.length - 1];
  for (const el of entries) {
    if (el.dataset.pin === 'open') continue;
    // an undecided standalone ask holds itself open until it is decided —
    // that is the system's hold, kept apart from a person's `data-pin`
    if (el.dataset.hold === 'true') continue;
    el.dataset.fold = !planning && el === last ? 'false' : 'true';
  }
}

// ---- beat 1: the agent wakes -------------------------------------------
// It had no representation at all. Presence was a dot on the dock heading —
// true, and never an EVENT, so the timeline began mid-sentence with the dock
// simply starting to have content in it.
let connected = false;
function threadConnected(): void {
  if (connected) return;
  connected = true;
  const n = airlockTools.list().filter((t) => t.status === 'active').length;
  const el = tlAdd('connect', 'An agent connected to this console', n ? `${n} tools` : '');
  const p = document.createElement('p');
  p.className = 'tl-line';
  p.textContent = `It can reach what the ${airlockTools.mode()} stage allows, and nothing else. Every write it wants still comes through you.`;
  tlBody(el).append(p);
  syncPresence();
}

/* ----------------------------------------------------------------------
   BEAT 2 — THE CALLS, AND WHAT CAME BACK.

   Every read is its own row, because *"we see it call tools"* is a sequence
   of events and not a count. Five reads merged into "Read 5 sources" told
   the operator a number; it never told them the agent read the logs BEFORE
   it concluded anything about the logs, which is the only reason the
   conclusion is worth anything.

   And the row opens onto THE OUTPUT — the bytes the agent got back, from
   `toolResults`, captured on the way past on the main thread. Not the tool's
   name, not a hand-written phrase about what the tool is for: the answer.
   Everything downstream on this ledger is a claim about these bytes, so
   this is the bottom of the provenance chain and the only row on the list
   that is not somebody's summary of something else.
   ---------------------------------------------------------------------- */

/** `{ "a": 1 }` tinted so a key reads as a key. Tokens only; no parsing. */
const JSON_TOKENS = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

function paintJson(host: HTMLElement, text: string): void {
  let last = 0;
  for (const m of text.matchAll(JSON_TOKENS)) {
    const at = m.index ?? 0;
    if (at > last) host.append(document.createTextNode(text.slice(last, at)));
    const span = document.createElement('span');
    if (m[1] !== undefined) span.className = m[2] ? 'j-k' : 'j-s';
    else if (m[3] !== undefined) span.className = 'j-b';
    else span.className = 'j-n';
    span.textContent = m[0];
    host.append(span);
    last = at + m[0].length;
  }
  if (last < text.length) host.append(document.createTextNode(text.slice(last)));
}

/** The row's expansion: the tool's answer, and a way onto the surface it read. */
function renderCallOutput(el: HTMLElement, tool: string): void {
  const body = tlBody(el);
  body.textContent = '';
  const result = takeToolResult(tool);

  const head = document.createElement('div');
  head.className = 'tc-head';
  const k = document.createElement('span');
  k.className = 'tc-k';
  k.textContent = result ? 'It got back' : 'No answer was recorded for this call';
  head.append(k);
  if (result) {
    const bytes = JSON.stringify(result).length;
    tlMeta(el).textContent = `${bytes} B`;
    const stamp = document.createElement('code');
    stamp.className = 'tc-stamp';
    const asOf = result.asOfSeq;
    stamp.textContent = typeof asOf === 'number' ? `${bytes} bytes · as of #${asOf}` : `${bytes} bytes`;
    head.append(stamp);
  }
  const where = document.createElement('button');
  where.type = 'button';
  where.className = 'tc-where';
  where.textContent = 'show me where';
  where.addEventListener('click', (ev) => {
    ev.stopPropagation();
    focusRead(tool);
  });
  head.append(where);
  body.append(head);

  if (result) {
    const pre = document.createElement('pre');
    pre.className = 'tc-out';
    pre.dataset.testid = `tool-output-${tool}`;
    paintJson(pre, JSON.stringify(result, null, 2));
    body.append(pre);
  } else {
    el.dataset.leaf = 'true';
  }
}

function threadRead(tool: string): void {
  const said = READ_NARRATION[tool];
  if (!tlHost() || !said) return;
  threadConnected();
  const el = tlAdd('call', `Read ${said.reads}`);
  el.dataset.tool = tool;
  // the tool's own name is a machine value, so it is set in the machine face
  // beside the prose rather than instead of it
  const name = document.createElement('code');
  name.className = 'tl-tool';
  name.textContent = tool;
  tlTitle(el).after(name);
  renderCallOutput(el, tool);
}

/** BEAT 3 — a hypothesis. The agent's own words, and what it ruled out. */
function renderFinding(e: Event): void {
  if (!tlHost()) return;
  const d = e.data as { summary?: string; ruledOut?: string; advisesAgainst?: string };
  if (!d.summary) return;
  if (d.advisesAgainst) {
    advisories.set(d.advisesAgainst, { summary: d.summary, ruledOut: d.ruledOut });
  }
  threadConnected();

  const el = tlAdd('finding', d.summary);
  el.dataset.seq = String(e.seq);
  // A CLAMPED LINE MUST OPEN, and it must not open onto a copy of itself. The
  // claim IS the title, so opening the row is what unclamps it — the body
  // carries only what the title does not. Citations are rendered into the
  // title itself so they stay clickable in both states.
  const t = tlTitle(el);
  t.textContent = '';
  renderCitedText(t, d.summary);
  if (d.ruledOut) {
    const ruled = document.createElement('p');
    ruled.className = 'finding-ruled';
    const k = document.createElement('span');
    k.className = 'finding-k';
    k.textContent = 'Ruled out';
    ruled.append(k, document.createTextNode(d.ruledOut));
    tlBody(el).append(ruled);
  }
}

/* ----------------------------------------------------------------------
   BEAT 6 — WHAT THE STEP DID TO THE WORLD.

   This beat did not exist. You approved a step and the plan advanced to the
   next one; nothing anywhere said what the approval had changed. Sid asked
   for "what was observed, what happened, how that changed state" and the
   third of those was simply missing, which also made the airlock's whole
   argument unverifiable — a gate you cannot see the far side of is a gate on
   faith.

   It is derived, not narrated. The world is a pure fold of the event log, so
   the report is a DIFF of two folds: snapshot the operator-legible facts
   before the batch, snapshot them after, print what moved. Nothing here is
   authored per action, which is why it cannot drift from what actually
   happened and why a lever added later reports itself for free.
   ---------------------------------------------------------------------- */

type Facts = Map<string, string>;

function snapshotFacts(w: World | undefined): Facts {
  const f: Facts = new Map();
  if (!w) return f;
  f.set('Incident owner', w.incident.acknowledgedBy ?? 'nobody');
  f.set('Severity', w.incident.severity ? w.incident.severity.toUpperCase() : 'not set');
  f.set('Deploys', w.incident.deploysFrozen ? 'frozen' : 'open');
  f.set('Alerts', w.incident.alertsSilenced ? 'silenced' : 'live');
  const posts = w.incident.statusPosts;
  f.set('Status page', posts.length ? posts[posts.length - 1]!.state : 'silent');
  for (const r of w.routes) {
    f.set(`${r.path} rate limit`, r.rateLimitRps ? `${r.rateLimitRps} req/s` : 'uncapped');
    if (r.drained) f.set(`${r.path} traffic`, 'drained');
    if (typeof r.splitPercent === 'number') f.set(`${r.path} split`, `${r.splitPercent}% to ${r.target}`);
  }
  // build and health are two facts, not one: joined, a service coming back
  // healthy reported as a BUILD change with the same version on both sides.
  for (const s of w.services) {
    f.set(`${s.name} build`, s.version);
    f.set(`${s.name} health`, s.health);
  }
  for (const fl of w.flags) f.set(`flag ${fl.name}`, String(fl.state));
  if (w.dbPrimary) f.set('Writes go to', w.dbPrimary);
  for (const d of w.dns) f.set(d.hostname, d.target);
  return f;
}

/** The facts as of the end of the previous render batch — the "before". */
let prevFacts: Facts = new Map();

interface FactChange {
  label: string;
  from: string;
  to: string;
}
function diffFacts(before: Facts, after: Facts): FactChange[] {
  const out: FactChange[] = [];
  for (const [k, v] of after) {
    const b = before.get(k);
    if (b !== undefined && b !== v) out.push({ label: k, from: b, to: v });
  }
  return out;
}

/** live metric rows, so the newest report keeps reading the world it changed */
interface LiveState {
  el: HTMLElement;
  at: { err: number; users: number; lost: number };
}
let liveState: LiveState | null = null;

const pctText = (n: number): string => `${(n * 100).toFixed(1)}%`;

/**
 * BEAT 6 — WHAT THE STEP DID TO THE WORLD, AS ITS OWN ROW.
 *
 * *"Clean interleaving of action/observation of state"*. It is interleaving
 * only if the observation is a beat in the same sequence as the action, so
 * an observation is a row of the same grammar, filed directly under the step
 * that caused it. Read the spine and it is agent, world, agent, world, seven
 * times: violet marker, green marker, violet marker, green marker.
 *
 * It is DERIVED, not narrated: the world is a pure fold of the event log, so
 * this is a diff of two folds. Nothing is authored per action, which is why
 * it cannot drift from what actually happened, and why a lever added later
 * reports itself for free.
 */
function landObservation(step: HTMLElement, changes: FactChange[]): void {
  if (!world) return;
  const row = tlRow('state', '');
  row.dataset.leaf = String(changes.length < 2);
  row.dataset.obsFor = step.dataset.testid ?? '';

  const title = tlTitle(row);
  title.classList.add('tl-fact');
  if (!changes.length) {
    title.textContent = 'nothing in the world moved';
    row.dataset.empty = 'true';
  } else {
    // ONE CHANGE LEADS. A step that moved three things says so on the right
    // and opens onto all of them — an operator scanning the column wants the
    // headline fact per beat, and the audit one click under it.
    title.append(...factParts(changes[0]!));
    if (changes.length > 1) {
      tlMeta(row).textContent = `+${changes.length - 1} more`;
      const dl = document.createElement('dl');
      dl.className = 'tl-state-rows';
      for (const c of changes.slice(1)) {
        const dt = document.createElement('dt');
        dt.textContent = c.label;
        const dd = document.createElement('dd');
        dd.append(...factParts(c).slice(1));
        dl.append(dt, dd);
      }
      tlBody(row).append(dl);
    }
  }

  // ...and what the world is DOING since, which a discrete diff cannot say.
  // The freeze is instantaneous; the queue draining is not.
  const since = document.createElement('p');
  since.className = 'pl-since';
  since.hidden = true;
  row.append(since);

  step.after(row);

  // it ARRIVES, once, so the eye is told a beat happened. The value is the
  // only thing on this surface that is allowed to animate.
  row.dataset.landed = 'true';

  // IT IS A LIVE READING, NOT A MEASUREMENT OF THIS STEP. Left frozen on the
  // row when the next step supersedes it, it becomes a causal claim the
  // console cannot support — seven steps each captioned with whatever the
  // error rate happened to do while they were on top. It belongs to the
  // newest observation only, and is retired with it.
  const prior = liveState?.el.querySelector<HTMLElement>('.pl-since');
  if (prior) {
    prior.hidden = true;
    prior.textContent = '';
  }
  liveState = {
    el: row,
    at: {
      err: world.traffic.errRate,
      users: world.damage.usersErrored,
      lost: world.damage.revenueLost,
    },
  };
  refreshLiveState();
}

/** `Deploys  open → frozen`, in the machine face, as spans. */
function factParts(c: FactChange): HTMLElement[] {
  const k = document.createElement('span');
  k.className = 'plo-k';
  k.textContent = c.label;
  const from = document.createElement('span');
  from.className = 'plo-from';
  from.textContent = c.from;
  const arrow = document.createElement('span');
  arrow.className = 'plo-arrow';
  arrow.textContent = '→';
  arrow.setAttribute('aria-hidden', 'true');
  const to = document.createElement('span');
  to.className = 'plo-to';
  to.textContent = c.to;
  return [k, from, arrow, to];
}

/**
 * A REFUSAL IS AN OBSERVATION TOO — and the only one where the answer is
 * that nothing happened because a person said no. It gets the same row, so
 * the operator's own decision is reflected back on the ledger rather than
 * buried in a detail pane the step collapses.
 */
function landRefusal(step: HTMLElement, note: string): void {
  if (step.nextElementSibling?.getAttribute('data-kind') === 'state') return;
  const row = tlRow('state', note);
  row.dataset.leaf = 'true';
  row.dataset.refused = 'true';
  step.after(row);
}

/**
 * The live reading under the newest observation, re-read every tick. It is
 * the difference between a console that says a lever was pulled and one that
 * says the lever worked, and it is the beat the film turns on: cap the route,
 * and the line starts counting down while you are still looking at it.
 */
function refreshLiveState(): void {
  if (!liveState || !world) return;
  const line = liveState.el.querySelector<HTMLElement>('.pl-since');
  if (!line) return;
  const err = world.traffic.errRate;
  const d = err - liveState.at.err;
  const users = world.damage.usersErrored - liveState.at.users;
  // Under half a point either way is noise, not a trend — and a line saying
  // "holding" under every control-plane verb is four repetitions of nothing.
  const moved = Math.abs(d) >= 0.005;
  line.hidden = !moved;
  if (!moved) return;
  line.dataset.dir = d < 0 ? 'down' : 'up';
  line.textContent = `error rate ${pctText(liveState.at.err)} → ${pctText(err)}${users > 0 ? ` · ${users} more users hit` : ''}`;
}

/**
 * The same beat for an approval that was never part of a plan: no step to
 * file it against, so it files itself as its own line on the timeline.
 */
function standaloneStateReport(): void {
  const changes = diffFacts(prevFacts, snapshotFacts(world ?? undefined));
  if (!changes.length) return;
  const el = tlAdd('state', '');
  const title = tlTitle(el);
  title.classList.add('tl-fact');
  title.append(...factParts(changes[0]!));
  if (changes.length > 1) tlMeta(el).textContent = `+${changes.length - 1} more`;
  el.dataset.leaf = 'true';
}

/** A new scenario is a new story: the timeline starts empty, not mid-thought. */
function resetTimeline(): void {
  const host = tlHost();
  if (host) {
    for (const c of [...host.children]) {
      if ((c as HTMLElement).dataset.kind !== 'live') c.remove();
    }
  }
  const empty = document.querySelector<HTMLElement>('#findings-empty');
  if (empty) empty.hidden = false;
  connected = false;
  liveState = null;
  prevFacts = new Map();
  toolResults.clear();
  askRows.clear();
}

/**
 * BEAT 7 — the end of the timeline. An incident that ends has to LOOK like it
 * ended: the console already turns teal and the storefront starts checking
 * out, and the agent's own column said nothing at all.
 */
function threadResolved(): void {
  const host = tlHost();
  if (!host || host.querySelector('[data-kind="resolved"]')) return;
  tlStarted();
  const el = tlRow('resolved', 'Checkout is serving again and the error rate is back to baseline.');
  el.dataset.pin = 'open';
  el.dataset.testid = 'thread-resolved';
  el.dataset.leaf = 'true';
  // the resolution is the last word, so it sits AFTER the live tail
  host.append(el);
  foldTimeline();
  // ...and the last word has to be ON SCREEN. A finished seven-step receipt
  // is taller than the dock, so the one line saying the incident is over
  // landed below the fold — in the exact frame the film ends on.
  el.scrollIntoView({ block: 'end' });
}

function showAgentAttention(e: Event): void {
  const d = e.data as Record<string, unknown>;
  threadConnected(); // beat 1 — whatever it did first, it is here now
  if (e.kind === 'tool.called') {
    agentWorking();
    const tool = String(d.tool);
    const read = READ_NARRATION[tool];
    if (read) {
      narrate(`Agent is ${read.says}`);
      threadRead(tool);
      touchRegion(read.region);
    } else if (WRITE_NARRATION[tool]) {
      narrate(`Agent is ${WRITE_NARRATION[tool]}`);
    }
    return;
  }
  if (e.kind === 'action.proposed') {
    // THE ASK HAS ITS OWN VOICE AND IT IS LOUDER THAN THIS ONE. The airlock
    // label says "Waiting on you" and the card carries the ask, the price and
    // the two buttons; a narration line above them repeating "waiting on your
    // decision" was a third voice saying what two louder ones already said,
    // and with a plan running it was a fourth. The narration is for what the
    // agent is doing while nobody is being asked anything.
    return;
  }
  if (e.kind === 'action.blocked') {
    narrate('Agent tried something it cannot reach in this mode');
    touchRegion('#tool-surface');
  }
}

/**
 * WHERE THE AGENT IS LOOKING — on the console, never in its own rail.
 *
 * This used to point at the agent's tool-list ROW for a read, and at the
 * approval card for a proposal. Both live in the agent dock, and the cursor
 * refuses to draw inside the dock (it lands on the labels it would explain),
 * so it went idle and sat wherever it happened to be — motion with no
 * meaning, which is exactly how it read.
 *
 * A read now points at the console region that read is ABOUT, and a proposal
 * at the row it would change. The path tells the story on its own:
 * status → what shipped → the logs → the route it wants to cap.
 */
function agentTargetFor(e: Event): Element | null {
  const d = e.data as Record<string, unknown>;
  switch (e.kind) {
    case 'tool.called': {
      const region = READ_NARRATION[String(d.tool)]?.region;
      return region ? document.querySelector(region) : null;
    }
    case 'action.proposed':
    case 'action.executed':
      return anchorFor(String(d.tool), (d.input ?? {}) as Record<string, unknown>);
    case 'action.blocked':
      return null; // nothing on the console changed; the rail says it, better
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
function revealSiteOnTrouble(phase: string): void {
  if (siteAutoRevealed) return;
  if (phase === 'incident' || phase === 'down') {
    siteAutoRevealed = true;
    setRegion('site', true);
  }
}
// any deliberate touch of the storefront's own visibility ends the automatic
// behaviour — an auto-opening panel that keeps coming back is worse than one
// that never opens
document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('[data-toggle="site"]')) siteAutoRevealed = true;
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

// Delegated from the DOCUMENT, not from #console. It was scoped to the centre
// column, which was invisible until the airlock moved into the agent dock and
// every Approve and Reject silently stopped working — the buttons were outside
// the listener. A control's behaviour must not depend on which region it was
// rendered into. Selection is still a CONSOLE gesture and is guarded as one.
document.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]');
  if (!btn) {
    // not a control: a click on a NODE is the human pointing at it. Other
    // interactive elements in the deck (audit toggle, dual-key checkbox) and
    // dead space are NOT selection gestures — they must never clear or move
    // the selection. Click-again on the selected node is the clear gesture.
    if (!(e.target as HTMLElement).closest('#console')) return;
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
      const card = btn.closest<HTMLElement>('.approval-card, .ap-ask');
      const keyEngaged = card?.querySelector<HTMLInputElement>('.ap-key-toggle')?.checked ?? false;
      const approve = btn.dataset.act === 'approve';
      // with a host attached, a click that was not the end of a hold is not
      // an approval — it is the thing the hold exists to refuse
      if (approve && btn.dataset.hold === '1' && btn.dataset.held !== '1') {
        nudgeHold(btn);
        return;
      }
      const via = approve ? (btn.dataset.via ?? 'click') : undefined;
      delete btn.dataset.via;
      if (approve && via) decisionGesture.set(Number(btn.dataset.seq), { via, hosted: hostAttached() });
      send({
        type: 'decide',
        proposalSeq: Number(btn.dataset.seq),
        decision: approve ? 'approve' : 'reject',
        ...(approve && keyEngaged ? { keyHolder: 'operator' } : {}),
        ...(via ? { via } : {}),
      });
      return;
    }
    case 'flag-toggle': {
      const flag = world.flags.find((f) => f.id === btn.dataset.flag);
      if (!flag) return;
      const on = flag.state === 'on' || (typeof flag.state === 'number' && flag.state > 0);
      const input = { id: flag.id, state: on ? 'off' : 'on' };
      if (cautionFor(btn, humanActionKey('flag.set', input))) return;
      send({ type: 'act', tool: 'flag.set', input });
      break;
    }
    case 'rollback': {
      const input = { deployId: btn.dataset.deploy };
      if (cautionFor(btn, humanActionKey('deploy.rollback', input))) return;
      send({ type: 'act', tool: 'deploy.rollback', input });
      break;
    }
    case 'lever': {
      const tool = String(btn.dataset.tool);
      const input = JSON.parse(String(btn.dataset.input)) as Record<string, unknown>;
      if (cautionFor(btn, humanActionKey(tool, input))) return;
      send({ type: 'act', tool, input });
      break;
    }
    case 'undo-holding': {
      const tool = String(btn.dataset.tool);
      const input = JSON.parse(String(btn.dataset.input)) as Record<string, unknown>;
      if (cautionFor(btn, humanActionKey(tool, input))) return;
      send({ type: 'act', tool, input });
      break;
    }
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

/**
 * What a service is carrying right now, from the same `traffic.tick` the
 * masthead plots: the routes that terminate at it, summed, error rate
 * weighted by load. `sampled` is false until a tick has reported on one of
 * its routes — a service with no routes (db) never has numbers to show, and
 * the strip must not invent any. `worst` names the route the errors enter
 * through, so a reader sees WHERE the incident meets the chain.
 */
function serviceLoad(
  w: World,
  id: string
): { rps: number; err: number; sampled: boolean; worst: { path: string; err: number } | null } {
  let rps = 0;
  let errs = 0;
  let sampled = false;
  let worst: { path: string; err: number } | null = null;
  for (const r of w.routes) {
    if (r.target !== id) continue;
    const t = w.traffic.byRoute[r.path];
    if (!t) continue;
    sampled = true;
    rps += t.rps;
    errs += t.rps * t.errRate;
    if (!worst || t.errRate > worst.err) worst = { path: r.path, err: t.errRate };
  }
  return { rps, err: rps > 0 ? errs / rps : 0, sampled, worst };
}

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
          <span class="topo-live">
            <span class="topo-health"></span>
            <span class="topo-rps"></span>
            <span class="topo-err"></span>
            <span class="topo-route"></span>
          </span>
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
    node.querySelector('.topo-health')!.textContent = s.health;
    // the live line: what the routes ending here are doing, this tick.
    // Empty until traffic has reported on them, so a standing console and a
    // service nothing routes to (db) both read as health word only.
    const load = serviceLoad(w, s.id);
    node.dataset.sampled = String(load.sampled);
    node.querySelector('.topo-rps')!.textContent = load.sampled ? `· ${Math.round(load.rps)}/s` : '';
    node.querySelector('.topo-err')!.textContent = load.sampled ? `· ${teleFormat('err', load.err)}` : '';
    // the route the errors come in on, named only while the service is not
    // ok and that route is actually erroring (same floor the masthead warns at)
    const failing = s.health !== 'ok' && load.worst && load.worst.err > 0.01 ? load.worst.path : '';
    node.querySelector('.topo-route')!.textContent = failing ? `· ${failing}` : '';
  }
}

// ---- living site pane (M2-06): the world state, rendered as the product --

const storefront = document.querySelector<HTMLDivElement>('#storefront')!;
const sfBanner = document.querySelector<HTMLDivElement>('.sf-banner')!;
const sfBuy = document.querySelector<HTMLButtonElement>('.sf-buy')!;
const sfFeed = document.querySelector<HTMLDivElement>('.sf-feed')!;
const sfStatus = document.querySelector<HTMLElement>('.sf-status')!;
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

  // A SHOP TALKS TO SHOPPERS. It never quotes an error rate or a throughput
  // figure — those exist for the operator and live in the console. Anything
  // here that explains the incident is presentation, not product.
  if (state === 'ok') {
    sfBanner.textContent = '';
    sfBuy.textContent = 'Checkout · $48.00';
    sfFeed.textContent = 'Free returns within 30 days';
  } else if (state === 'broken') {
    sfBanner.textContent = "We're having trouble taking payments right now. Your card has not been charged.";
    sfBuy.textContent = 'Try payment again';
    sfFeed.textContent = 'Your basket is saved.';
  }
  // 'down' shows the outage overlay via CSS; feed/banner stay as they were

  // WHAT THE OPERATOR PUBLISHED, ON THE PAGE THE CUSTOMER IS ON. Step 4 of the
  // certified plan is "tell customers", and until now approving it moved a
  // panel in the console and nothing whatsoever on the shop — the one step
  // whose entire justification is the customer ("every minute unsaid is a
  // support ticket") had no customer-visible effect at all, which made the
  // shop a decoration for six of the seven steps.
  //
  // It quotes the post verbatim: the same string that went out, read off the
  // world, never a second copy written to look good here. A resolved post
  // takes the notice down, because a status banner that outlives its incident
  // is the most common way a real status page lies.
  const posts = w.incident.statusPosts;
  const post = posts.length ? posts[posts.length - 1]! : null;
  const showing = post && post.state !== 'resolved';
  sfStatus.hidden = !showing;
  if (showing) {
    // A WARNING OUTLIVING ITS INCIDENT IS THE COMMONEST WAY A STATUS PAGE
    // LIES. Once checkout is serving, this post is no longer a warning — it
    // is the last thing customers were told, and it is out of date. It keeps
    // the operator's words verbatim either way; only the frame around them
    // changes, because only the frame is ours to write. The seven-step plan
    // never posts the all-clear, so the strip standing down to "Last update"
    // is also the console being honest that somebody still owes one.
    const stale = state === 'ok';
    sfStatus.dataset.state = stale ? 'stale' : post.state;
    sfStatus.querySelector<HTMLElement>('.sf-status-k')!.textContent = stale
      ? 'Last update'
      : (STATUS_WORD[post.state] ?? 'Update');
    // textContent, never innerHTML: operator-authored copy is still untrusted
    sfStatus.querySelector<HTMLElement>('.sf-status-t')!.textContent = post.text;
  }
}

/** How a status page names its own states to shoppers, not to engineers. */
const STATUS_WORD: Record<string, string> = {
  investigating: 'Investigating',
  identified: 'Known issue',
  monitoring: 'Monitoring the fix',
  resolved: 'Resolved',
};

// ---- logs pane: the human's read_logs -----------------------------------
// THE PARITY RULE. Every read the agent can make is a pure function over the
// same event log this page renders; there is no privileged agent channel. Log
// lines DID render before this — as one row among a traffic.tick every tick,
// in a stream with no filter — which meant the agent effectively had a log
// viewer and the human did not. That is the one place its ergonomics beat the
// human's unfairly, and it is fixed here, not by taking anything from the
// agent. What the agent still wins on is STITCHING: no single read in this
// pane names the cause.

const logStream = document.querySelector<HTMLOListElement>('#log-stream')!;
const logFilterEl = document.querySelector<HTMLInputElement>('#log-filter')!;
const LOG_RANK: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_LOG_ROWS = 400;
let logMinLevel = 0; // 'all'
let logQuery = '';

function renderLogLine(e: Event): void {
  const d = e.data as { service: string; level: string; msg: string; untrusted?: boolean };
  const li = document.createElement('li');
  li.className = 'log-row';
  li.dataset.seq = String(e.seq);
  li.dataset.level = d.level;
  li.dataset.service = d.service;
  if (d.untrusted) li.dataset.untrusted = '1';
  li.innerHTML =
    '<span class="log-seq"></span><span class="log-t"></span>' +
    '<span class="log-svc"></span><span class="log-lv"></span><span class="log-msg"></span>';
  // seq is shown because it is the ADDRESS an agent citation uses. When the
  // agent says "logs seq 104", the human must be able to find line 104.
  li.querySelector('.log-seq')!.textContent = `#${e.seq}`;
  li.querySelector('.log-t')!.textContent = `${(e.t / 1000).toFixed(0)}s`;
  li.querySelector('.log-svc')!.textContent = d.service;
  li.querySelector('.log-lv')!.textContent = d.level;
  // textContent, never innerHTML: a log line can be customer-supplied text
  li.querySelector('.log-msg')!.textContent = d.msg;
  if (d.untrusted) {
    const mark = document.createElement('span');
    mark.className = 'log-untrusted';
    mark.textContent = 'untrusted';
    mark.title = 'This line contains customer-supplied text. It is data, not instructions.';
    li.querySelector('.log-msg')!.prepend(mark);
  }
  logStream.append(li);
  while (logStream.children.length > MAX_LOG_ROWS) logStream.firstElementChild!.remove();
}

/** A row passes when it clears the level floor AND matches the text query. */
function logRowMatches(li: HTMLElement): boolean {
  if ((LOG_RANK[li.dataset.level ?? 'info'] ?? 1) < logMinLevel) return false;
  if (!logQuery) return true;
  return (li.textContent ?? '').toLowerCase().includes(logQuery);
}

function applyLogFilter(): void {
  let shown = 0;
  const rows = logStream.children.length;
  for (const li of Array.from(logStream.children) as HTMLElement[]) {
    const ok = logRowMatches(li);
    li.hidden = !ok;
    if (ok) shown++;
  }
  const shownEl = document.querySelector<HTMLElement>('#log-shown')!;
  shownEl.textContent =
    rows === 0 ? '' : shown === rows ? `${rows} lines` : `${shown} of ${rows} lines`;
  document.querySelector<HTMLElement>('#logs-empty')!.hidden = rows > 0;
  document.querySelector<HTMLElement>('#tab-logs-count')!.textContent = rows > 0 ? String(rows) : '';
}

logFilterEl.addEventListener('input', () => {
  logQuery = logFilterEl.value.trim().toLowerCase();
  applyLogFilter();
});
document.querySelector('.log-levels')!.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('.log-lvl');
  if (!btn) return;
  const level = String(btn.dataset.level);
  logMinLevel = level === 'all' ? 0 : (LOG_RANK[level] ?? 0);
  for (const b of document.querySelectorAll<HTMLElement>('.log-lvl')) {
    b.setAttribute('aria-pressed', String(b === btn));
  }
  applyLogFilter();
});

/**
 * Jump the human to one log line by its seq — the other half of a citation.
 * Clears any filter that would hide the target, because a citation that lands
 * on an empty pane is worse than no citation at all.
 */
function focusLogSeq(seq: number): boolean {
  const row = logStream.querySelector<HTMLElement>(`li[data-seq="${seq}"]`);
  if (!row) return false;
  if (!logRowMatches(row)) {
    logQuery = '';
    logFilterEl.value = '';
    logMinLevel = 0;
    for (const b of document.querySelectorAll<HTMLElement>('.log-lvl')) {
      b.setAttribute('aria-pressed', String(b.dataset.level === 'all'));
    }
    applyLogFilter();
  }
  selectTab('logs');
  row.scrollIntoView({ block: 'center' });
  for (const r of logStream.querySelectorAll('.log-cited')) r.classList.remove('log-cited');
  row.classList.add('log-cited');
  return true;
}

// ---- stream rendering ----------------------------------------------------

function applyHealth(w: World): void {
  const worst = w.services.reduce<Health>(
    (acc, s) => (SEVERITY[s.health] > SEVERITY[acc] ? s.health : acc),
    'ok'
  );
  if (document.documentElement.dataset.health !== worst) setHealth(worst);
  reportPlanOutcome();
  renderSituation(w, worst);
  const phase = document.querySelector<HTMLElement>('#situation')!.dataset.phase!;
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
/**
 * A NUMBER THAT CHANGES SHOULD BE SEEN TO CHANGE.
 *
 * 13 -> 27 is the one claim this whole submission rests on, and it SNAPPED —
 * the difference between "the page says 27" and "I watched it change" is the
 * entire Impact argument, and a still frame cannot carry it either way.
 *
 * It counts through, and the styling pulses for a beat.
 *
 * BE HONEST ABOUT THE RISK: the tween DOES write intermediate values into
 * `textContent` for ~520ms, so a test that reads this node during that window
 * reads a number in flight. Nothing does today — both capability gates read
 * `window.__airlock.list()`, which is the surface itself rather than its
 * label, and that is the right thing for them to assert anyway. If a gate
 * ever needs the settled count off the DOM, wait for `[data-changed]` to
 * clear. Reduced motion skips the tween and lands on the answer immediately.
 */
function pulseValue(el: HTMLElement, next: string): void {
  const prev = el.textContent ?? '';
  el.textContent = next;
  if (prev === next || prev === '') return;
  const from = Number(prev);
  const to = Number(next);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.dataset.changed = 'true';
  window.setTimeout(() => delete el.dataset.changed, 700);
  if (reduce || !Number.isFinite(from) || !Number.isFinite(to) || from === to) return;
  const started = performance.now();
  const DUR = 520;
  const step = (now: number): void => {
    const t = Math.min(1, (now - started) / DUR);
    // ease-out so it decelerates onto the answer instead of stopping dead
    const v = Math.round(from + (to - from) * (1 - Math.pow(1 - t, 3)));
    el.textContent = t < 1 ? String(v) : next;
    if (t < 1) window.requestAnimationFrame(step);
  };
  window.requestAnimationFrame(step);
}

/**
 * THE READOUT'S IMPACT FIELD — and the reason it exists separately.
 *
 * The console has TWO renderers for damage: the stat CARDS, and this
 * compressed field list. At 1512x945 with the storefront open the centre is
 * at its 560px floor and the FIELD LIST is what is on screen — so putting the
 * burn rate only on the card would have shipped it into the one renderer the
 * film never shows. Both carry it now.
 */
function impactField(w: World): string {
  const burn = burnPerMin(w);
  // Users and the BURN. Appending the burn to the running total overflowed
  // the field and truncated to `$39.7…`, and the cumulative was the half
  // worth dropping anyway: during an incident it is history, and it is still
  // on the stat card underneath the rate.
  return burn === null || burn < 1
    ? `${w.damage.usersErrored} users · $${w.damage.revenueLost.toFixed(2)}`
    : `${w.damage.usersErrored} users · $${fmtMoney(burn)}/min`;
}

/** last `valuePerReq` the sim stated, so the burn can be derived (see below) */
let valuePerReq: number | null = null;

/** What this incident is costing per minute AT THE CURRENT ERROR RATE. */
function burnPerMin(w: World): number | null {
  if (valuePerReq === null) return null;
  return w.traffic.rps * w.traffic.errRate * valuePerReq * 60;
}

/** Money at a glance: no cents once it is past a hundred, thousands as k. */
function fmtMoney(n: number): string {
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return n.toFixed(0);
  return n.toFixed(2);
}

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
      // THE RATE LEADS, NOT THE TOTAL. The total is a fact about how long the
      // clip has been running — forty seconds of a small fleet reads as an
      // exquisitely engineered system protecting lunch money, which is how an
      // outside reviewer put it. During an incident the number an operator
      // acts on is the BURN, and it is the number that visibly collapses when
      // the fix lands. The total keeps its place underneath, with the formula.
      k: 'Revenue burn',
      v: burnPerMin(w) === null ? `$${w.damage.revenueLost.toFixed(2)}` : `$${fmtMoney(burnPerMin(w)!)}/min`,
      sub: `$${w.damage.revenueLost.toFixed(2)} lost so far · Σ rps × err × value/req`,
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
  const streamRows = document.querySelector('#event-stream')?.childElementCount ?? 0;
  document.querySelector<HTMLElement>('#stream-empty')!.hidden = streamRows > 0;
  document.querySelector<HTMLElement>('#tab-changed-count')!.textContent =
    hasDeploys ? String(w.deploys.length) : '';
  document.querySelector<HTMLElement>('#tab-activity-count')!.textContent =
    streamRows > 0 ? String(streamRows) : '';
  const zone = document.querySelector<HTMLElement>('#situation')!;
  const state = document.querySelector<HTMLElement>('#sit-state')!;
  const head = document.querySelector<HTMLElement>('#sit-head')!;
  const fields = document.querySelector<HTMLElement>('#sit-fields')!;
  document.querySelector<HTMLElement>('#sit-clock')!.textContent = clock(simNowMs);

  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const checkoutErr = w.traffic.byRoute['/checkout']?.errRate ?? w.traffic.errRate;
  const bad = w.services.filter((s) => s.health !== 'ok');
  // THE BUILD ON THE SERVICE THAT IS BROKEN, not whichever deploy landed last.
  // This took the newest live deploy across the whole estate, which was fine
  // while every deploy in a scenario belonged to the service in trouble. The
  // moment another team's rollout was added to retry-storm, an api incident
  // started reporting "LIVE BUILD d-513 payments: settlement retry window" —
  // the storefront's build, named as the thing at fault, on the line an
  // operator reads first. Fall back to the estate-wide newest only when
  // nothing is degraded, which is what the calm state wants anyway.
  const liveOn = (svc: string): Deploy | undefined =>
    [...w.deploys].reverse().find((d) => d.status === 'live' && d.service === svc);
  const live =
    bad.map((sv) => liveOn(sv.id)).find(Boolean) ??
    [...w.deploys].reverse().find((d) => d.status === 'live');

  const put = (rows: Array<[string, string, string?]>): void => {
    fields.innerHTML = rows
      .map(
        ([k, v, tone]) =>
          `<div class="sit-f" data-k="${k}"><dt>${k}</dt><dd${tone ? ` data-tone="${tone}"` : ''}>${v}</dd></div>`
      )
      .join('');
  };

  // NO PROPOSAL BRANCH HERE (removed 2026-09-01, Sid).
  //
  // A pending proposal used to hijack this readout — PROPOSAL PENDING /
  // OPERATOR DECISION REQUIRED, with the action and what it touches restated
  // as fields. Two things wrong with that. It DUPLICATED the approval card,
  // which already says all of it and says it better, in a corner of the
  // console away from the buttons. And it evicted the incident readout at the
  // exact moment an operator most needs to know what is broken and what it is
  // costing while they decide.
  //
  // This zone reports the WORLD. What the agent is asking for belongs in the
  // agent's own region, with the decision, and lives there only.

  if (worst === 'down') {
    zone.dataset.phase = 'down';
    state.textContent = 'OUTAGE';
    head.textContent = `${bad.map((s) => s.name.toUpperCase()).join(' / ')} DOWN`;
    put([
      ['ERR', `${pct(checkoutErr)} /checkout`, 'bad'],
      ['SVC', bad.map((s) => `${s.id} ${s.health}`).join(' · '), 'bad'],
      ['LIVE BUILD', live ? `${live.id} ${live.note ?? live.version}` : 'unknown'],
      ['IMPACT', impactField(w), 'bad'],
    ]);
    return;
  }

  if (worst === 'degraded') {
    zone.dataset.phase = 'incident';
    state.textContent = 'INCIDENT ACTIVE';
    // DERIVED, never asserted. This read 'CHECKOUT FAILING' for every
    // scenario, which is a verdict the console has no business making — and
    // in the family whose errors are spread across all routes it was simply
    // false. Name what is degraded; the ERR row carries the route detail.
    head.textContent = `${bad.map((sv) => sv.name.toUpperCase()).join(' / ') || 'SERVICE'} DEGRADED`;
    put([
      ['ERR', `${pct(checkoutErr)} /checkout`, 'warn'],
      ['SVC', bad.map((s) => `${s.id} ${s.health}`).join(' · ') || '—', 'warn'],
      ['LIVE BUILD', live ? `${live.id} ${live.note ?? live.version}` : 'unknown'],
      ['IMPACT', impactField(w), 'warn'],
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
 * The activity feed is read by an operator, not by whoever wrote the event
 * schema. `traffic.tick` and `action.executed` are our internal vocabulary
 * leaking onto the surface — the clearest "built by engineers, for
 * engineers" tell left in the console.
 */
const KIND_LABEL: Record<string, string> = {
  'deploy.started': 'Deploy started',
  'deploy.finished': 'Deploy landed',
  'deploy.failed': 'Deploy failed',
  'service.health': 'Health changed',
  'migration.applied': 'Migration applied',
  'user.impact': 'Customer impact',
  'log.line': 'Log',
  'action.proposed': 'Agent proposed',
  'action.approved': 'You approved',
  'action.rejected': 'You rejected',
  'action.executed': 'Change applied',
  'action.blocked': 'Blocked by the airlock',
  'tool.called': 'Agent looked',
  'mode.changed': 'Response stage',
  'selection.changed': 'You pointed at',
  'finding.recorded': 'Agent concluded',
  'annotation.added': 'Agent highlighted',
  'scenario.seeded': 'Scenario loaded',
  'traffic.tick': 'Traffic',
};

/**
 * WHAT IS CURRENTLY IN FORCE.
 *
 * Rule taken from Vercel's Firewall, read live: a control surface keeps a
 * first-class table of "Persistent Actions" — the interventions currently
 * applied, when they started, and how to lift them. Our console applied a
 * change and forgot it, which is the difference between a dashboard and a
 * control centre.
 *
 * It is also the real on-call experience: you accumulate mitigations during
 * an incident and then have to remember what to unwind. Every row here is
 * derived from action.executed in the log — nothing is stored separately.
 */
/**
 * Only action.executed is retained — bounded by the number of real actions
 * taken in an incident, not by tick count.
 */
const executedLog: Event[] = [];

interface Holding {
  key: string;
  what: string;
  by: Actor;
  atMs: number;
  undo?: { tool: string; input: Record<string, unknown>; label: string };
}

function holdingsFrom(events: readonly Event[], w: World): Holding[] {
  const held = new Map<string, Holding>();
  const put = (key: string, what: string, e: Event, undo?: Holding['undo']): void => {
    held.set(key, { key, what, by: e.actor, atMs: e.t, ...(undo ? { undo } : {}) });
  };

  for (const e of events) {
    if (e.kind !== 'action.executed') continue;
    // scenario setup is not a mitigation anyone has to unwind
    if (e.actor !== 'human' && e.actor !== 'agent') continue;
    const { tool, input } = e.data as { tool: string; input: Record<string, unknown> };

    switch (tool) {
      case 'flag.set': {
        const id = String(input.id);
        if (String(input.state) === 'off') {
          put(`flag:${id}`, `Feature flag ${id} held off`, e, {
            tool: 'flag.set',
            input: { id, state: 'on' },
            label: 'Turn back on',
          });
        } else held.delete(`flag:${id}`);
        break;
      }
      case 'traffic.drain':
        put(`drain:${String(input.route)}`, `${String(input.route)} drained — serving nobody`, e, {
          tool: 'traffic.shift',
          input: { route: String(input.route), percent: 100, target: 'api' },
          label: 'Restore traffic',
        });
        break;
      case 'traffic.shift':
        held.delete(`drain:${String(input.route)}`);
        put(
          `shift:${String(input.route)}`,
          `${String(input.percent)}% of ${String(input.route)} sent to ${String(input.target ?? 'secondary')}`,
          e
        );
        break;
      case 'ratelimit.set':
        put(`rl:${String(input.route)}`, `${String(input.route)} capped at ${String(input.rps)} req/s`, e, {
          tool: 'ratelimit.set',
          input: { route: String(input.route), rps: 0 },
          label: 'Remove cap',
        });
        break;
      case 'canary.set':
        put(`canary:${String(input.deployId)}`, `${String(input.deployId)} serving ${String(input.percent)}% of traffic`, e);
        break;
      case 'service.scale':
        put(`scale:${String(input.service)}`, `${String(input.service)} scaled to ${String(input.replicas)} replicas`, e);
        break;
      case 'db.failover':
        put(`failover:${String(input.service)}`, `${String(input.service)} running on the promoted replica`, e);
        break;
      case 'dns.cutover':
        put(`dns:${String(input.hostname)}`, `${String(input.hostname)} pointed at ${String(input.target)}`, e);
        break;
      case 'deploy.freeze':
        if (input.frozen === true) {
          put('freeze', 'Deploys frozen across all services', e, {
            tool: 'deploy.freeze',
            input: { frozen: false },
            label: 'Lift freeze',
          });
        } else held.delete('freeze');
        break;
      case 'alerts.silence':
        if (input.silenced === true) {
          put('silence', 'Alerting silenced', e, {
            tool: 'alerts.silence',
            input: { silenced: false },
            label: 'Unsilence',
          });
        } else held.delete('silence');
        break;
      case 'env.set':
        put(`env:${String(input.key)}`, `${String(input.key)} changed`, e);
        break;
      case 'route.set':
        put(`route:${String(input.id)}`, `Route ${String(input.id)} pointed at ${String(input.target)}`, e);
        break;
      case 'deploy.rollback':
        put(`rb:${String(input.deployId)}`, `${String(input.deployId)} rolled back`, e);
        break;
      // service.restart and cache.flush are MOMENTS, not standing state:
      // there is nothing left in force afterwards to unwind
      default:
        break;
    }
  }

  // a roll-forward supersedes the rollback it replaced
  for (const d of w.deploys) if (d.status === 'live') held.delete(`rb:${d.id}`);
  return [...held.values()].sort((a, b) => a.atMs - b.atMs);
}

const WHO: Record<string, string> = { human: 'you', agent: 'the agent', sim: 'the system', system: 'the system' };

function renderHoldings(events: readonly Event[], w: World): void {
  const list = document.querySelector<HTMLElement>('#holding-list');
  const empty = document.querySelector<HTMLElement>('#holding-empty');
  const meta = document.querySelector<HTMLElement>('#holding-meta');
  if (!list || !empty || !meta) return;

  const rows = holdingsFrom(events, w);
  meta.textContent = rows.length ? `${rows.length} in force` : '';
  empty.hidden = rows.length > 0;
  list.innerHTML = '';

  for (const h of rows) {
    const row = document.createElement('div');
    row.className = 'holding';
    row.dataset.holding = h.key;
    const t = document.createElement('div');
    t.className = 'holding-text';
    const what = document.createElement('span');
    what.className = 'holding-what';
    what.textContent = h.what;
    const meta2 = document.createElement('span');
    meta2.className = 'holding-meta';
    meta2.textContent = `by ${WHO[h.by] ?? h.by} · ${Math.max(0, Math.round((simNowMs - h.atMs) / 1000))}s ago`;
    what.append(document.createTextNode(' '));
    t.append(what, meta2);
    row.append(t);
    if (h.undo) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ctl-btn';
      b.dataset.act = 'undo-holding';
      b.dataset.tool = h.undo.tool;
      b.dataset.input = JSON.stringify(h.undo.input);
      b.dataset.testid = `undo-${h.key}`;
      b.setAttribute('data-testid', `undo-${h.key}`);
      b.textContent = h.undo.label;
      row.append(b);
    }
    list.append(row);
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
    li.innerHTML = `<span class="ev-t">${(e.t / 1000).toFixed(0)}s</span><span class="ev-kind"></span><span class="ev-summary"></span>`;
    li.querySelector('.ev-kind')!.textContent = KIND_LABEL[e.kind] ?? e.kind;
    li.querySelector('.ev-summary')!.textContent = summarize(e);
    streamEl.append(li);

    if (e.kind === 'traffic.tick') {
      pushTele(e.data as { rps: number; errRate: number; p95: number });
    } else if (e.kind === 'log.line') renderLogLine(e);
    else if (e.kind === 'action.proposed') addApprovalCard(e);
    else if (e.kind === 'plan.proposed') renderPlan(e);
    else if (e.kind === 'action.approved' || e.kind === 'action.rejected') {
      const ps = (e.data as { proposalSeq: number }).proposalSeq;
      resolveApprovalCard(ps);
      // approval is not execution — the mode or the key can still refuse at
      // decision time — so a plan advances on the WRITE, and action.executed
      // names only its approval. Keep the join.
      if (e.kind === 'action.approved') {
        approvalToProposal.set(e.seq, ps);
        askDecided(ps, 'done', approvedBy(ps) === 'you' ? 'approved' : `approved by ${approvedBy(ps)}`);
      } else {
        planDecided(ps, false);
        askDecided(ps, 'skipped', 'you rejected this');
      }
    } else if (e.kind === 'action.executed' && typeof e.causedBy === 'number') {
      const ps = approvalToProposal.get(e.causedBy);
      if (ps !== undefined) {
        if (planForProposal.has(ps)) planDecided(ps, true);
        else askExecuted(ps);
      }
    } else if (e.kind === 'annotation.added' && e.actor === 'agent') {
      telestrate((e.data as { target: EntityRef }).target);
    }
    if (e.kind === 'finding.recorded') {
      renderFinding(e);
      const fd = e.data as { summary?: string };
      if (fd.summary) latestFinding = { summary: fd.summary, seq: e.seq };
    }
    if (e.actor === 'agent') {
      // the tally has to be updated BEFORE the next proposal card is built,
      // and it is: events are applied in log order
      if (e.kind === 'tool.called') noteAgentRead(String((e.data as { tool?: unknown }).tool), e.seq);
      moveAgentCursor(agentTargetFor(e));
      showAgentAttention(e);
    }
  }
  for (const e of events) if (e.kind === 'action.executed') executedLog.push(e);
  // THE BURN RATE NEEDS THE PRICE OF A REQUEST, and the world only carries the
  // running total. Every `user.impact` event states the formula it used, so
  // the render layer remembers the last one rather than the sim growing a
  // field for a presentation concern.
  for (const e of events) {
    if (e.kind !== 'user.impact') continue;
    const f = (e.data as { revenueLostFormula?: { valuePerReq?: number } }).revenueLostFormula;
    if (typeof f?.valuePerReq === 'number') valuePerReq = f.valuePerReq;
  }
  renderHoldings(executedLog, w);
  if (events.some((e) => e.kind === 'log.line')) applyLogFilter();

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
  // the newest state report keeps reading the world it changed...
  refreshLiveState();
  // ...and THIS batch's world is the next report's "before".
  prevFacts = snapshotFacts(w);
}

/**
 * The console is a fold of a world that arrives from the Worker, so the
 * markup that boots is a skeleton with empty readouts. `.wb` stays
 * `visibility: hidden` until the first render has filled it — an unpainted
 * box cannot shift, and that skeleton paint was the whole of our CLS.
 * Hoisted, so it may be called from the message handler declared above it.
 */
function revealShell(): void {
  if (!shellEl.dataset.ready) shellEl.dataset.ready = 'true';
}

worker.onmessage = (e: MessageEvent<SimResponse>) => {
  const msg = e.data;
  revealShell();
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

const shellEl = document.querySelector<HTMLElement>('.shell')!;

/* ============================================================
   WORKBENCH REGIONS (2026-09-01)
   Docks, tabs and sashes. One controller owns every region's
   visibility, so a closed region always has exactly one obvious
   way back — the activity bar button that closed it, still lit.
   ============================================================ */

type Region = 'site' | 'rail' | 'panel';

/** Visibility is one attribute per region; CSS owns the geometry. */
function setRegion(which: Region, open: boolean): void {
  shellEl.dataset[which] = open ? 'on' : 'off';
  document
    .querySelectorAll<HTMLElement>(`.act-btn[data-toggle="${which}"]`)
    .forEach((b) => b.setAttribute('aria-pressed', String(open)));
}
const regionOpen = (which: Region): boolean => shellEl.dataset[which] === 'on';

document.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-toggle]');
  if (!t) return;
  const which = t.dataset.toggle as Region;
  // an activity-bar button toggles; a region's own close button only closes
  setRegion(which, t.classList.contains('act-btn') ? !regionOpen(which) : false);
});

/* ---- evidence panel: three views of one thing, so they are tabs -------- */

const TABS = ['changed', 'activity', 'logs', 'chart'] as const;
type TabName = (typeof TABS)[number];
const paneFor: Record<TabName, string> = {
  changed: 'zone-changed',
  activity: 'zone-activity',
  logs: 'zone-logs',
  chart: 'err-chart',
};

function selectTab(name: string): void {
  if (!TABS.includes(name as TabName)) return;
  setRegion('panel', true); // selecting a view is asking to see it
  for (const t of TABS) {
    const tab = document.querySelector<HTMLElement>(`#tab-${t}`)!;
    const pane = document.querySelector<HTMLElement>(`#${paneFor[t]}`)!;
    const on = t === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    pane.hidden = !on;
  }
  if (name === 'chart') renderErrChart(); // the plot sizes off its own box
}

document.querySelector('.panel-tabs')!.addEventListener('click', (e) => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>('.ptab');
  if (tab) selectTab(String(tab.dataset.tab));
});
// ARIA tabs pattern: arrows move between tabs, home/end to the ends
document.querySelector('.panel-tabs')!.addEventListener('keydown', (e) => {
  const ev = e as KeyboardEvent;
  const cur = (ev.target as HTMLElement).closest<HTMLElement>('.ptab');
  if (!cur) return;
  const i = TABS.indexOf(String(cur.dataset.tab) as TabName);
  const next =
    ev.key === 'ArrowRight' ? (i + 1) % TABS.length
    : ev.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length
    : ev.key === 'Home' ? 0
    : ev.key === 'End' ? TABS.length - 1
    : -1;
  if (next < 0) return;
  ev.preventDefault();
  const target = TABS[next]!;
  selectTab(target);
  document.querySelector<HTMLElement>(`#tab-${target}`)!.focus();
});

/* ---- sashes: WAI-ARIA window splitter, pointer + keyboard ------------- */

interface SashSpec { prop: string; min: number; max: number; axis: 'x' | 'y' }
const SASH: Record<Region, SashSpec> = {
  site: { prop: '--w-site', min: 320, max: 1100, axis: 'x' },
  rail: { prop: '--w-rail', min: 280, max: 620, axis: 'x' },
  panel: { prop: '--h-panel', min: 120, max: 900, axis: 'y' },
};

function sizeOf(name: Region): number {
  const spec = SASH[name];
  return parseFloat(getComputedStyle(shellEl).getPropertyValue(spec.prop)) || spec.min;
}
function setSize(name: Region, px: number): void {
  const spec = SASH[name];
  const v = Math.max(spec.min, Math.min(spec.max, px));
  shellEl.style.setProperty(spec.prop, `${Math.round(v)}px`);
  const handle = document.querySelector<HTMLElement>(`.wb-sash[data-sash="${name}"]`);
  handle?.setAttribute(
    'aria-valuenow',
    String(Math.round(((v - spec.min) / (spec.max - spec.min)) * 100))
  );
}

for (const handle of document.querySelectorAll<HTMLElement>('.wb-sash')) {
  const name = handle.dataset.sash as Region;
  const spec = SASH[name];
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.dataset.dragging = 'true';
    const start = spec.axis === 'x' ? e.clientX : e.clientY;
    const from = sizeOf(name);
    const move = (m: PointerEvent): void => {
      // the docks grow leftward and the panel grows upward, so drag inverts
      const delta = (spec.axis === 'x' ? m.clientX : m.clientY) - start;
      setSize(name, from - delta);
    };
    const up = (): void => {
      delete handle.dataset.dragging;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  handle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 64 : 16;
    const grow = spec.axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
    const shrink = spec.axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    if (e.key === grow) setSize(name, sizeOf(name) + step);
    else if (e.key === shrink) setSize(name, sizeOf(name) - step);
    else if (e.key === 'Home') setSize(name, spec.min);
    else if (e.key === 'End') setSize(name, spec.max);
    else if (e.key === 'Enter') {
      // the splitter pattern's collapse toggle
      setRegion(name, !regionOpen(name));
    } else return;
    e.preventDefault();
  });
}

/**
 * THE CAPABILITY SHEET.
 *
 * Same overlay idiom as ⌘K on purpose: one way to open a thing over the page,
 * not two. It is opened from the dock's pinned footer, which is the only part
 * of the agent region that never scrolls away — the whole complaint was that
 * an inline ladder at the bottom of a scrolling column is hidden whether it is
 * collapsed or not.
 */
const surfaceEl = document.querySelector<HTMLElement>('#surface')!;
const surfaceBtn = document.querySelector<HTMLElement>('#tool-surface')!;
let surfaceReturnFocus: HTMLElement | null = null;

function openSurface(): void {
  surfaceReturnFocus = document.activeElement as HTMLElement;
  surfaceEl.hidden = false;
  surfaceBtn.setAttribute('aria-expanded', 'true');
  document.querySelector<HTMLElement>('#surface-close')!.focus();
}
function closeSurface(): void {
  surfaceEl.hidden = true;
  surfaceBtn.setAttribute('aria-expanded', 'false');
  surfaceReturnFocus?.focus();
}
surfaceBtn.addEventListener('click', () => (surfaceEl.hidden ? openSurface() : closeSurface()));
document.querySelector('#surface-close')!.addEventListener('click', () => closeSurface());
surfaceEl.addEventListener('click', (e) => { if (e.target === surfaceEl) closeSurface(); });

document.querySelector('#act-palette')!.addEventListener('click', () => openPalette());
document.querySelector('#cmdk-open')!.addEventListener('click', () => openPalette());

/* ---- row action menus: one at a time --------------------------------------
   These are <details>, so every one the operator opened stayed open and the
   popups stacked on top of each other. A menu is a menu: opening one closes
   the rest, clicking away or pressing Escape closes them all, and a menu that
   would open past the bottom of its scroll container flips upward instead of
   being clipped. `toggle` does not bubble, so this listens in the capture
   phase — which also means it keeps working across re-renders. */

function closeMenus(except?: Element): void {
  document.querySelectorAll<HTMLDetailsElement>('details.actions-menu[open]').forEach((d) => {
    if (d !== except) d.open = false;
  });
  const sc = document.querySelector<HTMLDetailsElement>('#scenario-pick');
  if (sc && sc !== except) sc.open = false;
}

/** Open upward when there is no room below inside the scrolling region. */
function placeMenu(menu: HTMLDetailsElement): void {
  const list = menu.querySelector<HTMLElement>('.am-list');
  const scroller = menu.closest<HTMLElement>('.wb-centre-body, .tabpane, .dock-body');
  if (!list || !scroller) return;
  delete menu.dataset.drop;
  const room = scroller.getBoundingClientRect().bottom - menu.getBoundingClientRect().bottom;
  if (list.getBoundingClientRect().height + 12 > room) menu.dataset.drop = 'up';
}

document.addEventListener(
  'toggle',
  (e) => {
    const d = e.target as HTMLElement;
    if (!(d instanceof HTMLDetailsElement) || !d.open) return;
    if (!d.classList.contains('actions-menu') && d.id !== 'scenario-pick') return;
    closeMenus(d);
    if (d.classList.contains('actions-menu')) placeMenu(d);
  },
  true
);

document.addEventListener('pointerdown', (e) => {
  const inside = (e.target as HTMLElement).closest('details.actions-menu, #scenario-pick');
  if (!inside) closeMenus();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.querySelector('details.actions-menu[open], #scenario-pick[open]')) {
    closeMenus();
  }
});

/**
 * COMMAND PALETTE (Cmd/Ctrl+K).
 *
 * Nineteen levers is past the point where hunting works. Every ops tool
 * worth using has one of these — it was in Grafana's own top bar while I was
 * reading their alerting surface.
 *
 * Commands are built from the WORLD, not from the vocabulary alone, so they
 * are concrete ("Drain /checkout") rather than abstract ("traffic.drain").
 * Each carries the same `cost` string the control and the agent's proposal
 * carry, and execution goes through the SAME path as a click — including the
 * agent's caution, so a lever the agent has advised against still stops you
 * here.
 */
interface Command {
  label: string;
  group: string;
  tool: string;
  input: Record<string, unknown>;
}

function buildCommands(w: World): Command[] {
  const out: Command[] = [];
  const add = (group: string, label: string, tool: string, input: Record<string, unknown>): void => {
    if (WRITE_ACTIONS[tool]) out.push({ group, label, tool, input });
  };

  add('Incident', 'Acknowledge the incident', 'incident.acknowledge', { by: 'you' });
  for (const lvl of ['sev1', 'sev2', 'sev3']) add('Incident', `Declare ${lvl.toUpperCase()}`, 'incident.severity', { level: lvl });
  add('Incident', 'Page database on-call', 'incident.escalate', { team: 'database on-call' });
  add('Incident', w.incident.alertsSilenced ? 'Unsilence alerting' : 'Silence alerting', 'alerts.silence', { silenced: !w.incident.alertsSilenced });
  add('Incident', w.incident.deploysFrozen ? 'Lift the deploy freeze' : 'Freeze deploys', 'deploy.freeze', { frozen: !w.incident.deploysFrozen });
  add('Customers', 'Post a status page update', 'statuspage.post', {
    state: 'investigating',
    text: 'We are investigating elevated checkout failures.',
  });

  for (const f of w.flags) {
    const on = f.state === 'on' || (typeof f.state === 'number' && f.state > 0);
    add('Release', `Turn ${on ? 'off' : 'on'} flag ${f.id}`, 'flag.set', { id: f.id, state: on ? 'off' : 'on' });
  }
  for (const d of w.deploys) {
    if (d.status === 'live') {
      add('Release', `Roll back ${d.id} (${d.service} ${d.version})`, 'deploy.rollback', { deployId: d.id });
      add('Release', `Put ${d.id} in front of 5% of traffic`, 'canary.set', { deployId: d.id, percent: 5 });
    }
  }
  for (const svc of w.services) {
    add('Compute', `Restart ${svc.id}`, 'service.restart', { service: svc.id });
    add('Compute', `Scale ${svc.id} to 4 replicas`, 'service.scale', { service: svc.id, replicas: 4 });
  }
  for (const r of w.routes) {
    add('Traffic', `Drain ${r.path}`, 'traffic.drain', { route: r.id });
    add('Traffic', `Shift 50% of ${r.path} to secondary`, 'traffic.shift', { route: r.id, percent: 50, target: 'secondary' });
    add('Traffic', `Cap ${r.path} at 100 req/s`, 'ratelimit.set', { route: r.id, rps: 100 });
  }
  add('Data', 'Flush the session cache', 'cache.flush', { scope: 'session' });
  add('Data', 'Fail over to the database replica', 'db.failover', { service: 'db' });
  add('DNS', 'Cut shop.example over to the secondary edge', 'dns.cutover', {
    hostname: 'shop.example',
    target: 'edge-secondary',
  });
  return out;
}

const paletteEl = document.querySelector<HTMLElement>('#palette')!;
const paletteInput = document.querySelector<HTMLInputElement>('#palette-input')!;
const paletteList = document.querySelector<HTMLElement>('#palette-list')!;
const paletteAsks = document.querySelector<HTMLElement>('#palette-asks')!;
const paletteAsksList = document.querySelector<HTMLElement>('#palette-asks-list')!;
let paletteCmds: Command[] = [];
let paletteActive = 0;
let paletteReturnFocus: HTMLElement | null = null;

function paletteMatches(): Command[] {
  const q = paletteInput.value.trim().toLowerCase();
  if (!q) return paletteCmds;
  return paletteCmds.filter((c) => `${c.group} ${c.label}`.toLowerCase().includes(q));
}

/**
 * THE AGENT'S OPEN ASKS, at the top of the palette.
 *
 * It does not approve anything. Approve-from-palette would put a second door
 * on the gate, and the gate is the product — so a row here is a POINTER: it
 * closes the palette and puts you in front of the decision, where the cost,
 * the evidence and the key still are.
 */
function renderAsks(): void {
  const asks = [...pendingCards.values()].map((p) => p.ask);
  paletteAsks.hidden = asks.length === 0;
  paletteAsksList.innerHTML = '';
  for (const a of asks) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'pa-item';
    row.dataset.seq = String(a.seq);
    row.dataset.testid = `palette-ask-${a.seq}`;
    const label = document.createElement('span');
    label.className = 'pa-label';
    label.textContent = a.summary;
    const meta = document.createElement('span');
    meta.className = 'pa-meta';
    meta.textContent = `${a.touches}${a.dualKey ? ' · needs your key' : ''} · pending`;
    const go = document.createElement('span');
    go.className = 'pa-go';
    go.textContent = 'go to the decision';
    row.append(label, meta, go);
    paletteAsksList.append(row);
  }
}

function renderPalette(): void {
  const items = paletteMatches();
  // the levers the agent has an open ask on, so the menu row says so too
  const proposed = new Set([...pendingCards.values()].map((p) => p.ask.scope));
  if (paletteActive >= items.length) paletteActive = Math.max(0, items.length - 1);
  paletteList.innerHTML = '';
  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'palette-empty';
    empty.textContent = 'No command matches that.';
    paletteList.append(empty);
    return;
  }
  items.forEach((c, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'palette-item';
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(i === paletteActive));
    row.dataset.idx = String(i);
    const g = document.createElement('span');
    g.className = 'pi-group';
    g.textContent = c.group;
    const l = document.createElement('span');
    l.className = 'pi-label';
    l.textContent = c.label;
    const cost = document.createElement('span');
    cost.className = 'pi-cost';
    cost.textContent = WRITE_ACTIONS[c.tool]?.cost ?? '';
    row.append(g, l, cost);
    if (proposed.has(proposalScope(c.tool, c.input))) {
      row.dataset.proposed = 'true';
      // NOT "proposed". The ask is `cap at 150`; this canned row is `cap at
      // 100`. A row labelled "proposed" invites an enter press that would run
      // a DIFFERENT command, as the human, and read as approving the agent.
      // The mark claims only what is true: the agent has asked about this
      // lever — go and read the ask.
      row.title = 'the agent has an open ask on this lever — see the top of the palette';
      const flag = document.createElement('span');
      flag.className = 'pi-flag';
      flag.textContent = 'agent asked';
      row.append(flag);
    }
    paletteList.append(row);
  });
  paletteList.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

function openPalette(): void {
  if (!world) return;
  paletteReturnFocus = document.activeElement as HTMLElement;
  paletteCmds = buildCommands(world);
  paletteInput.value = '';
  paletteActive = 0;
  paletteEl.hidden = false;
  renderAsks();
  renderPalette();
  paletteInput.focus();
}

function closePalette(): void {
  paletteEl.hidden = true;
  paletteReturnFocus?.focus();
}

function runPalette(i: number): void {
  const c = paletteMatches()[i];
  if (!c) return;
  closePalette();
  // the same path a click takes, so the agent's caution still applies
  const key = humanActionKey(c.tool, c.input);
  const target = document.querySelector<HTMLButtonElement>(`[data-tool="${c.tool}"]`);
  if (target && cautionFor(target, key)) {
    target.scrollIntoView({ block: 'nearest' });
    return;
  }
  send({ type: 'act', tool: c.tool, input: c.input });
}

/**
 * THE AGENT IS A REGION, SO IT GETS A REGION'S SHORTCUT.
 *
 * ⌘J brings the agent up or puts it away — that is all it does. It is the
 * sibling of ⌘K and is advertised next to it in the status bar, because a
 * shortcut nobody can see is a shortcut nobody has.
 *
 * ⌘⏎ / ⌘⌫ decide the ask that is waiting. Both are CHORDS on purpose: the
 * gate is the product, and a bare key that approves a production write on a
 * mis-hit would be the console undoing its own thesis. They also refuse to
 * bypass the second key — on a dual-key card the chord takes you to the key
 * and stops, which is the same answer the button gives.
 */
function liveDecision(): { card: HTMLElement } | undefined {
  return [...pendingCards.values()][0];
}

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
    e.preventDefault();
    setRegion('rail', !regionOpen('rail'));
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === 'Enter' || e.key === 'Backspace')) {
    const entry = liveDecision();
    if (!entry) return;
    e.preventDefault();
    if (!regionOpen('rail')) setRegion('rail', true);
    const btn = entry.card.querySelector<HTMLButtonElement>(
      e.key === 'Enter' ? '.ap-approve' : '.ap-reject'
    );
    if (!btn) return;
    if (btn.disabled) {
      // the key is not engaged: show them the thing that is stopping them
      entry.card.scrollIntoView({ block: 'nearest' });
      entry.card.querySelector<HTMLElement>('.ap-key-toggle')?.focus();
      return;
    }
    if (btn.dataset.hold === '1') {
      // a host is attached: the chord is held, like the button (see armHold)
      if (!e.repeat) holds.get(btn)?.start('key');
      return;
    }
    btn.dataset.via = 'key';
    btn.click();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    paletteEl.hidden ? openPalette() : closePalette();
    return;
  }
  if (!surfaceEl.hidden && e.key === 'Escape') { e.preventDefault(); closeSurface(); return; }
  if (paletteEl.hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); paletteActive++; renderPalette(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); paletteActive = Math.max(0, paletteActive - 1); renderPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); runPalette(paletteActive); }
});
// any key coming up ends a held chord — on macOS the Enter keyup is not
// always delivered while ⌘ is down, so the modifier's own keyup counts too
document.addEventListener('keyup', (e) => {
  if (e.key !== 'Enter' && e.key !== 'Meta' && e.key !== 'Control') return;
  const btn = liveDecision()?.card.querySelector<HTMLButtonElement>('.ap-approve');
  if (btn) holds.get(btn)?.cancel();
});
paletteInput.addEventListener('input', () => { paletteActive = 0; renderPalette(); });
paletteList.addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-idx]');
  if (row) runPalette(Number(row.dataset.idx));
});
paletteAsksList.addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-seq]');
  if (!row) return;
  const entry = pendingCards.get(Number(row.dataset.seq));
  closePalette(); // restores focus first, so ours below wins
  if (!entry) return;
  entry.card.scrollIntoView({ block: 'nearest' });
  // the key toggle when there is one: engaging it is the first thing to do
  (
    entry.card.querySelector<HTMLElement>('.ap-key-toggle') ??
    entry.card.querySelector<HTMLElement>('.ap-approve')
  )?.focus();
});
paletteEl.addEventListener('click', (e) => { if (e.target === paletteEl) closePalette(); });

// both ends exist now: the airlock can tell an OPEN palette that the set of
// asks moved under it
paletteRefresh = () => {
  if (paletteEl.hidden || !world) return;
  paletteCmds = buildCommands(world);
  renderAsks();
  renderPalette();
};

/** The Run/Pause button's one job, named so a URL can press it (?run=1). */
function toggleRun(): void {
  running = !running;
  syncPacer();
}
runBtn.addEventListener('click', toggleRun);

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
  const writes = active.filter((t) => !t.readOnly && t.name !== 'record_finding');
  const countEl = document.querySelector<HTMLElement>('#tool-count');
  if (countEl) pulseValue(countEl, String(active.length));
  renderWebMCPStatus(active.length);
  // the count is only true for the stage you are on, so the sheet says which
  const stageEl = document.querySelector<HTMLElement>('#surface-stage');
  if (stageEl) stageEl.textContent = `${tools.mode()} stage · ${active.length} available now`;
}

/**
 * THE CAPABILITY LADDER.
 *
 * A list of function names is an inventory; it tells an operator nothing.
 * What they need is: what can this thing reach RIGHT NOW, and what is still
 * shut. So the rail shows the whole ladder — granted rungs as plain
 * sentences, and locked rungs with the stage that would open them.
 *
 * The thesis made visible rather than argued: the PAGE decides what the
 * agent may attempt, and you can see the decision. Raw tool names stay one
 * hover away, for whoever actually wants them.
 */
const RUNG_LABEL: Record<string, string> = {
  airlock_status: 'Check service health and impact',
  list_deploys: 'Review what shipped recently',
  read_logs: 'Read service logs',
  list_changes: 'Check flags, env and routes',
  traffic_history: 'Look at the error-rate history',
  explain_surface: 'Ask why its own tools changed',
  record_finding: 'Write what it concludes into this console',
  propose_plan: 'Ask for a sequence of actions, in a stated order',
  // incident command — granted in triage
  propose_acknowledge: 'Ask to take ownership of the incident',
  propose_severity: 'Ask to set the severity',
  propose_escalate: 'Ask to page another team',
  propose_silence_alerts: 'Ask to silence alerting while you work',
  propose_status_update: 'Ask to tell customers on the status page',
  // reversible production levers — diagnosis
  propose_flag_change: 'Ask you to turn a feature flag on or off',
  propose_deploy_freeze: 'Ask to freeze deploys',
  propose_canary: 'Ask to change how much traffic a build serves',
  propose_rate_limit: 'Ask to cap a route',
  // the rest — recovery
  propose_rollback: 'Ask you to roll a deploy back',
  propose_rollforward: 'Ask you to ship a fixed build forward',
  propose_env_change: 'Ask you to change an environment value',
  propose_route_change: 'Ask you to move traffic elsewhere',
  propose_traffic_change: 'Ask to shift a share of a route',
  propose_drain: 'Ask to drain a route',
  propose_restart: 'Ask to restart a service',
  propose_scale: 'Ask to change replica count',
  propose_cache_flush: 'Ask to flush a cache',
  propose_failover: 'Ask to promote a database replica',
};

/** Which stage first grants each proposal, for the locked rungs. */
function grantingStage(tool: string): Mode | undefined {
  return MODES.find((m) => MODE_WRITE_TOOLS[m].includes(tool));
}

function renderToolRail(tools: AirlockTools): void {
  const list = document.querySelector<HTMLUListElement>('#tool-list')!;
  list.innerHTML = '';
  const shown = new Set<string>();
  for (const t of tools.list()) {
    shown.add(t.name);
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
    li.querySelector('.tool-name')!.textContent = RUNG_LABEL[t.name] ?? t.name;
    li.title = t.name; // the raw tool name stays one hover away
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
  // the rungs this page has NOT granted yet — shown, not hidden, because
  // "what it cannot do" is the more reassuring half
  for (const name of Object.keys(RUNG_LABEL)) {
    if (shown.has(name)) continue;
    const stage = grantingStage(name);
    if (!stage) continue;
    const li = document.createElement('li');
    li.dataset.tool = name;
    li.dataset.status = 'locked';
    li.title = name;
    li.innerHTML = `<span class="tool-name"></span><span class="tool-badges"><span class="tool-badge tool-badge-locked"></span></span>`;
    li.querySelector('.tool-name')!.textContent = RUNG_LABEL[name]!;
    li.querySelector('.tool-badge-locked')!.textContent =
      `needs ${stage.charAt(0).toUpperCase()}${stage.slice(1)}`;
    list.append(li);
  }

  document.querySelectorAll<HTMLButtonElement>('#mode-switch [data-mode]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.mode === tools.mode()));
  });
  document.querySelector('#wbs-mode')!.textContent = tools.mode();
  const foot = document.querySelector<HTMLElement>('#ladder-foot');
  if (foot) {
    const locked = list.querySelectorAll('li[data-status="locked"]').length;
    foot.textContent = locked
      ? `${locked} more become available as you move the response stage on.`
      : 'Every action on this page is available to the agent as a proposal.';
  }
  renderCapability(tools);
}

/** The agent's own words, into the same log everything else lives in. */
function recordFindingToWorker(data: Record<string, unknown>): void {
  send({ type: 'record', kind: 'finding.recorded', actor: 'agent', data });
}

/**
 * An ordered intent, onto the record. It authorizes nothing — renderPlan puts
 * step 1, and only step 1, through the ordinary airlock when this lands.
 */
function proposePlanToWorker(plan: {
  planId: string;
  reason: string;
  steps: { tool: string; input: Record<string, unknown>; because?: string }[];
}): void {
  send({ type: 'record', kind: 'plan.proposed', actor: 'agent', data: { ...plan } });
}

const airlockTools = createAirlockTools(
  runToolQuery,
  proposeToWorker,
  recordFindingToWorker,
  proposePlanToWorker
);
renderToolRail(airlockTools);

// mode switching is the operator's ritual: swap the surface, record the
// mode.changed event (with the registration diff) into the same log.
// One function, so the click and the `?mode=` boot param cannot drift: both
// go through `setMode` and both put `mode.changed` on the record.
function switchMode(to: Mode): void {
  const { from, added, removed } = airlockTools.setMode(to);
  if (from === to) return;
  send({
    type: 'record',
    kind: 'mode.changed',
    actor: 'human',
    data: { from, to, toolsAdded: added, toolsRemoved: removed, reason: 'operator switched mode in console' },
  });
  renderToolRail(airlockTools);
}

document.querySelector('#mode-switch')!.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-mode]');
  if (!btn) return;
  switchMode(btn.dataset.mode as Mode);
});

// ---- walkthrough: the film scene, played from the product ----------------
// The agent half of this console cannot be reached by clicking, so a judge
// with no WebMCP host attached would never see the ledger fill, the refusal,
// or the plan. `play` drives the page through `airlockTools` — the same
// execute path a host uses — and hands every decision back to the viewer.
// What is scripted is WHO is calling; #walk-line says so, in the heading,
// for as long as the walkthrough's work is on the ledger.
const walkLine = document.querySelector<HTMLElement>('#walk-line')!;
const walkStateEl = walkLine.querySelector<HTMLElement>('.wl-state')!;
const walkStopBtn = walkLine.querySelector<HTMLButtonElement>('.wl-stop')!;
let walkCtl: AbortController | null = null;
/** the play in flight, so a stop can wait for its last call to land */
let walkRun: Promise<void> | null = null;

function setWalk(state: PlayState | 'off', detail = ''): void {
  walkLine.hidden = state === 'off';
  walkLine.dataset.state = state;
  walkStateEl.textContent =
    state === 'running' ? 'preparing' : state === 'failed' ? `failed — ${detail}` : '';
  // while the script is still calling, or a decision is still with the
  // viewer, the way out is Stop; once the arc has been handed over and
  // decided, what is left on screen is a receipt, and the way out is Reset
  walkStopBtn.textContent = state === 'settled' || state === 'failed' ? 'Reset' : 'Stop';
}

/** Anything that re-seeds the console ends the walkthrough with it. */
function endWalk(): void {
  if (walkCtl) {
    walkCtl.abort();
    walkCtl = null;
  }
  setWalk('off');
}

async function startWalk(): Promise<void> {
  if (walkCtl) return;
  // the scene names its scenario; seed it BEFORE the controller exists, so
  // the re-seed's own endWalk() has nothing to end
  if (currentTemplate !== filmScene.template) {
    seed(filmScene.template);
    await new Promise((r) => setTimeout(r, 400));
  }
  const ctl = new AbortController();
  walkCtl = ctl;
  setWalk('running', 'preparing');
  try {
    walkRun = play(filmScene, {
      air: airlockTools,
      isRunning: () => running,
      toggleRun: () => runBtn.click(),
      template: filmScene.template,
      seedTemplate: (id) => seed(id),
      signal: ctl.signal,
      onState: (state, detail) => {
        if (walkCtl === ctl) setWalk(state, detail);
      },
    });
    await walkRun;
  } catch {
    // already on the line, via onState('failed')
  } finally {
    walkRun = null;
  }
}

document.querySelector<HTMLButtonElement>('#walk-start')!.addEventListener('click', () => void startWalk());
walkStopBtn.addEventListener('click', () => {
  const inFlight = walkRun;
  endWalk();
  // the call in flight still lands — on the world being thrown away, not on
  // the fresh one. Wait for it, THEN seed: a fresh console is the empty
  // state, not a half-told story with one stray row on it.
  void Promise.resolve(inFlight).then(
    () => undefined,
    () => undefined
  ).then(() => {
    seed(currentTemplate);
    // the scripted caller is gone, so nothing on the heading may say otherwise
    window.clearTimeout(agentIdleTimer);
    window.clearTimeout(agentBusyTimer);
    agentBusy = false;
    setPresence('off', 'not connected');
    narrate(null);
    moveAgentCursor(null);
  });
});

/** The prompts in the empty state copy with one click. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* no clipboard permission, or not a secure context — fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
document.querySelector<HTMLElement>('#findings-empty')!.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.te-copy');
  if (!btn) return;
  const text = btn.closest('li')?.querySelector('.te-q')?.textContent?.trim() ?? '';
  void copyText(text).then((ok) => {
    btn.dataset.done = ok ? 'true' : 'false';
    window.setTimeout(() => delete btn.dataset.done, 1400);
  });
});

// boot: seed() touches deck + storefront elements, so it runs after every
// element ref above is initialized
seed(TEMPLATE_ID);
// ?mode=diagnosis | recovery: boot with the response stage already moved,
// through the same `switchMode` the operator's click calls — so `setMode`
// swaps the registered surface and `mode.changed` lands on the log exactly as
// it would have. It has to run after seed(), which calls `airlockTools.reset()`
// and would put the stage back to triage.
// Why it exists: Chrome's webmcp-evals CLI drives a URL, and 9 of the 11
// recovery cases are tools that are ABSENT in triage — correct behaviour, and
// unrunnable against the production URL without a way in.
// (study/chrome-evals/README.md names this as the blocker.)
if (BOOT_MODE) switchMode(BOOT_MODE);
// ?site=1 / ?run=1: the two gestures a visitor would make — the storefront's
// activity-bar toggle, then Run sim — made for them. After seed(), which
// resets the pacer and the storefront; through the same code the buttons use.
if (OPEN_SITE) setRegion('site', true);
if (AUTO_RUN) toggleRun();

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

// ---- review harness (?review=<scene>) — DEV BUILD ONLY -------------------
// The agent-side half of this console cannot be reached by clicking: to see
// an evidence strip or a plan you have to BE an agent, which meant reviewing
// them from a devtools console. Each scene puts the page into one situation
// through the real tool path and then stops, handing the human half back.
// Guarded by import.meta.env.DEV so it is never in the production bundle a
// judge loads — this is a workbench for reviewing the product, not part of it.
if (import.meta.env.DEV && params.has('review')) {
  void import('./review').then((review) =>
    review.run({
      air: airlockTools,
      isRunning: () => running,
      toggleRun: () => runBtn.click(),
      template: TEMPLATE_ID,
      seedTemplate: (id) => seed(id),
    })
  );
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
