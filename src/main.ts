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
const TICK_INTERVAL_MS = Number(params.get('tick')) || 500;
const DEV_MODE = params.get('dev') === '1';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <div class="palette" id="palette" role="dialog" aria-modal="true" aria-label="Run a command" hidden>
    <div class="palette-box">
      <input id="palette-input" type="text" autocomplete="off" spellcheck="false"
             placeholder="Run a command — try &quot;drain&quot;, &quot;restart&quot;, &quot;status page&quot;"
             aria-label="Search commands" data-testid="palette-input" />
      <div class="palette-list" id="palette-list" role="listbox" data-testid="palette-list"></div>
      <div class="palette-foot"><kbd>↑</kbd><kbd>↓</kbd> to move · <kbd>enter</kbd> to run · <kbd>esc</kbd> to close</div>
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
        <summary aria-label="Choose scenario"><span class="sc-k">Scenario</span><span class="sc-v" id="scenario-current"></span></summary>
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
        <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="6" width="12" height="9" rx="2.5"/><path d="M10 3v3M7 10h.01M13 10h.01"/></svg>
      </button>
      <button type="button" class="act-btn" data-toggle="site" data-testid="site-toggle"
              aria-pressed="false" aria-label="Storefront" title="Storefront — what customers see">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 7.5h13v9h-13z"/><path d="M3 7.5 5 3.5h10l2 4"/><path d="M8 16.5v-4h4v4"/></svg>
      </button>
    </nav>

    <!-- CENTRE. Readout and airlock are pinned; only the control grid scrolls,
         and at desk widths it does not need to. -->
    <section class="wb-centre" id="console" aria-label="Console">
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
        <span class="cmdbar-meta" id="command-meta"></span>
      </div>

      <div class="wb-centre-body">
        <div id="control-deck" data-testid="control-deck">
          <section class="zone" id="zone-controls" data-testid="zone-controls">
            <div class="zone-head">
              <h2 class="zone-title">Manual controls</h2>
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
        <div class="panel-tabs" role="tablist" aria-label="Evidence">
          <button type="button" role="tab" class="ptab" data-tab="changed" data-testid="tab-changed"
                  id="tab-changed" aria-controls="zone-changed" aria-selected="true" tabindex="0">
            What changed<span class="ptab-count" id="tab-changed-count"></span>
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
            <p class="empty" id="stream-empty">Nothing has happened yet. Start the scenario to bring the store online.</p>
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
            <p class="empty" id="logs-empty">No application logs yet. These are the same lines <code>read_logs</code> serves the agent.</p>
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
              <p class="chart-empty">Nothing plotted yet — start the scenario and the error rate builds here, so you can see when it began and whether it is recovering.</p>
            </div>
            <div class="chart-axis"><span>60 ticks ago</span><span>now</span></div>
          </section>
        </div>
      </section>
    </section>

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
            <span class="sf-hero-kicker">New for Fall</span>
            <span class="sf-hero-line">Field-tested goods, guaranteed for the long trail.</span>
          </div>
          <div class="sf-banner" data-testid="sf-banner" role="status"></div>
          <div class="sf-grid">
            <div class="sf-card"><div class="sf-img"><svg viewBox="0 0 100 100" aria-hidden="true"><rect x="26" y="18" width="48" height="60" rx="4" fill="#3f6b52"/><path d="M50 18v60" stroke="#2b4c39" stroke-width="2"/><path d="M38 18l12 14 12-14" fill="#31543f"/><rect x="18" y="22" width="10" height="40" rx="4" fill="#3f6b52"/><rect x="72" y="22" width="10" height="40" rx="4" fill="#3f6b52"/><rect x="32" y="52" width="12" height="9" rx="2" fill="#2b4c39"/><rect x="56" y="52" width="12" height="9" rx="2" fill="#2b4c39"/></svg></div><div class="sf-name">Field Jacket</div><div class="sf-price">$128</div></div>
            <div class="sf-card"><div class="sf-img"><svg viewBox="0 0 100 100" aria-hidden="true"><path d="M28 34h44l-4 46H32z" fill="#c8a173"/><path d="M40 34c0-9 4-14 10-14s10 5 10 14" stroke="#8a6b45" stroke-width="3" fill="none" stroke-linecap="round"/><rect x="40" y="50" width="20" height="14" rx="2" fill="#a8834f"/></svg></div><div class="sf-name">Canvas Tote</div><div class="sf-price">$42</div></div>
            <div class="sf-card"><div class="sf-img"><svg viewBox="0 0 100 100" aria-hidden="true"><rect x="38" y="26" width="24" height="54" rx="9" fill="#6f8fc4"/><rect x="43" y="14" width="14" height="12" rx="3" fill="#3f5c8d"/><rect x="38" y="44" width="24" height="12" fill="#5679b3"/><path d="M62 32c5 3 5 9 0 12" stroke="#3f5c8d" stroke-width="3" fill="none" stroke-linecap="round"/></svg></div><div class="sf-name">Trail Bottle</div><div class="sf-price">$28</div></div>
            <div class="sf-card"><div class="sf-img"><svg viewBox="0 0 100 100" aria-hidden="true"><path d="M28 56a22 22 0 0 1 44 0z" fill="#c48f9a"/><rect x="24" y="56" width="52" height="13" rx="6" fill="#a86f7d"/><circle cx="50" cy="26" r="7" fill="#a86f7d"/></svg></div><div class="sf-name">Wool Beanie</div><div class="sf-price">$34</div></div>
            <div class="sf-card"><div class="sf-img"><svg viewBox="0 0 100 100" aria-hidden="true"><rect x="30" y="32" width="36" height="42" rx="5" fill="#8d9c5c"/><rect x="30" y="32" width="36" height="8" rx="4" fill="#6f7d43"/><path d="M66 44h7a8 8 0 0 1 0 16h-7" stroke="#6f7d43" stroke-width="5" fill="none" stroke-linecap="round"/></svg></div><div class="sf-name">Camp Mug</div><div class="sf-price">$22</div></div>
            <div class="sf-card"><div class="sf-img"><svg viewBox="0 0 100 100" aria-hidden="true"><path d="M32 40h36v34a6 6 0 0 1-6 6H38a6 6 0 0 1-6-6z" fill="#78889a"/><rect x="30" y="30" width="40" height="11" rx="5" fill="#56657a"/><path d="M36 30c0-5 6-8 14-8s14 3 14 8" stroke="#56657a" stroke-width="3" fill="none"/><rect x="32" y="56" width="36" height="4" fill="#66768a"/></svg></div><div class="sf-name">Dry Sack</div><div class="sf-price">$36</div></div>
          </div>
          <div class="sf-checkout">
            <div class="sf-cart-line">
              <span class="sf-cart-items">1 item · Field Jacket</span>
              <span class="sf-cart-total">$48.00</span>
            </div>
            <button type="button" class="sf-buy" data-testid="sf-buy">Checkout · $48.00</button>
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

    <div class="wb-sash" data-sash="rail" role="separator" tabindex="0"
         aria-orientation="vertical" aria-label="Resize the agent panel"
         aria-controls="tool-rail" aria-valuemin="0" aria-valuemax="100" aria-valuenow="18"></div>

    <section class="wb-dock" id="tool-rail" aria-label="Agent">
      <header class="dock-head">
        <span class="dock-title">Agent</span>
        <span class="pane-sub" id="rail-sub">standing by</span>
        <button type="button" class="dock-close" data-toggle="rail" data-min="rail" data-testid="min-rail"
                aria-label="Close the agent panel" title="Close">&times;</button>
      </header>
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
        <!-- THE AIRLOCK, inside the agent region.
             It used to be a pinned block in the CENTRE column, which meant
             the console had to be laid out twice — once with a decision
             pending and once without — and at 1512px it overflowed its track
             and sat underneath the storefront. Everything the agent says or
             asks now lives in one column, and when a decision is pending that
             column ELEVATES over the page instead of reshaping it. One
             reserved area, one axis. -->
        <div class="airlock" id="airlock" data-pending="0">
          <div class="al-label"><span class="al-dot" aria-hidden="true"></span>Waiting on you</div>
          <div class="al-cards" id="airlock-cards"></div>
        </div>

        <div class="agent-presence" id="agent-presence" data-state="off">
          <span class="ap-dot" aria-hidden="true"></span>
          <span class="ap-text">
            <span id="agent-conn" data-testid="agent-conn" data-state="off">No agent connected</span>
            <span class="ap-sub ap-sub-off">WebMCP on this page: <span id="webmcp-status">…</span>. Assistance is optional — every control in this console works without one.</span>
            <span class="ap-sub ap-sub-on">Working through this page's tools — every write still needs your approval.</span>
          </span>
        </div>

        <p class="agent-doing" id="agent-doing" aria-live="polite" hidden></p>

        <section class="findings-region" aria-label="What the agent has concluded">
          <div class="ladder-head">
            <span class="ladder-title">What the agent has worked out</span>
            <span class="ts-count" id="finding-count"></span>
          </div>
          <div class="findings" id="agent-findings" aria-live="polite"></div>
          <p class="findings-empty" id="findings-empty">
            Nothing concluded yet. When an agent works this incident, what it
            establishes — and what it rules out — is written here, in the
            console, where you can check it.
          </p>
        </section>

        <!-- 27 rows of capability is REFERENCE, not glance. It is collapsible
             so an operator mid-decision can put it away — but it stays OPEN by
             default, because "what this page lets the agent do" is the single
             most legible thing about the mechanism and hiding it by default
             would be hiding the point. Density is bought back in the type,
             not by concealing the surface. -->
        <details class="ladder" id="tool-surface" open aria-label="What the agent can reach">
          <summary class="ladder-head">
            <span class="ladder-title">What this page lets the agent do</span>
            <span class="ts-count" id="tool-count"></span>
          </summary>
          <ul id="tool-list" data-testid="tool-list"></ul>
          <p class="ladder-foot" id="ladder-foot"></p>
        </details>
      </div>
    </section>

    <!-- STATUS BAR. Machine state that used to be scattered through the
         console's chrome: it is reference, and reference belongs at the edge. -->
    <footer class="wb-status">
      <span class="wbs-item wbs-mode" id="wbs-mode">triage</span>
      <span class="wbs-item" id="sim-status" data-testid="sim-status">seeded · paused</span>
      <span class="spacer"></span>
      <span class="wbs-item wbs-hint"><kbd>⌘K</kbd> commands</span>
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

document.querySelector('#webmcp-status')!.textContent = hasWebMCP()
  ? 'detected'
  : 'not detected (plain browser — page fully usable without an agent)';
document.querySelector('#wbs-webmcp')!.textContent = hasWebMCP()
  ? 'WebMCP ready'
  : 'WebMCP not detected';

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
    card.innerHTML = `
      <div class="dc-title"></div>
      <div class="dc-head">
        <span class="dc-target"></span>
        <span class="dc-id"></span>
        <span class="dc-status"></span>
      </div>
      ${
        deploy.containsMigration
          ? `<div class="dc-flag"><span class="dc-badge dc-badge-migration">migration · ${
              deploy.migrationReversible ? 'reversible' : 'irreversible'
            }</span></div>`
          : ''
      }
      <details class="dc-details">
        <summary data-testid="details-${deploy.id}">Details</summary>
        <div class="dc-meta">
          ${deploy.flagsTouched.length ? `<span class="dc-badge">flags: ${deploy.flagsTouched.join(', ')}</span>` : ''}
          <span class="dc-badge">${canary}</span>
          <span class="dc-badge">${deploy.diffstat.files} files +${deploy.diffstat.plus} −${deploy.diffstat.minus}</span>
        </div>
      </details>
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
  testid: string
): string {
  const spec = WRITE_ACTIONS[tool];
  const cost = spec ? spec.cost : '';
  return `<button type="button" class="ctl-btn lever" data-act="lever" data-tool="${tool}"
    data-input='${JSON.stringify(input)}' data-testid="${testid}"
    title="${cost.replace(/"/g, '&quot;')}">${label}<span class="lever-cost">${cost}</span></button>`;
}

/**
 * Incident command — the half of on-call that is not infrastructure.
 * incident.io splits its product exactly this way (On-call / Response /
 * Status Pages), and a console with only infra levers is missing the part
 * an on-call engineer actually spends the first five minutes on.
 */
function renderCommand(w: World): void {
  const row = document.querySelector<HTMLElement>('#cmd-row');
  const meta = document.querySelector<HTMLElement>('#command-meta');
  if (!row || !meta) return;
  const inc = w.incident;

  meta.textContent = [
    inc.severity ? inc.severity.toUpperCase() : 'severity unset',
    inc.acknowledgedBy ? `owned by ${inc.acknowledgedBy}` : 'unowned',
  ].join(' · ');

  row.innerHTML = `
    ${
      inc.acknowledgedBy
        ? `<span class="cmd-state">Acknowledged by ${inc.acknowledgedBy}</span>`
        : lever('incident.acknowledge', { by: 'you' }, 'Acknowledge', 'ack-incident')
    }
    ${lever('incident.severity', { level: 'sev1' }, 'Declare SEV1', 'sev1')}
    ${lever('incident.escalate', { team: 'database on-call' }, 'Page database on-call', 'escalate')}
    ${
      inc.alertsSilenced
        ? lever('alerts.silence', { silenced: false }, 'Unsilence alerts', 'silence')
        : lever('alerts.silence', { silenced: true }, 'Silence alerts', 'silence')
    }
    ${
      inc.deploysFrozen
        ? lever('deploy.freeze', { frozen: false }, 'Lift deploy freeze', 'freeze')
        : lever('deploy.freeze', { frozen: true }, 'Freeze deploys', 'freeze')
    }
    ${lever(
      'statuspage.post',
      { state: 'investigating', text: 'We are investigating elevated checkout failures.' },
      'Post update',
      'statuspage-post'
    )}
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

const pendingCards = new Map<number, { card: HTMLElement; anchor: HTMLElement | null }>();

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

/** Take the human to the surface a read looked at, so a chip is a place. */
function focusRead(tool: string): void {
  if (tool === 'read_logs') {
    selectTab('logs');
    return;
  }
  const region = READ_NARRATION[tool]?.region;
  if (!region) return;
  const el = document.querySelector<HTMLElement>(region);
  if (!el) return;
  const pane = el.closest<HTMLElement>('.tabpane');
  if (pane?.hidden) selectTab(pane.id.replace(/^zone-|^err-/, ''));
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
  // the console row wears the same state, so the plan is legible from the
  // controls as well as from the card
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

/** Put the next step through the airlock. Nothing else advances a plan. */
function advancePlan(plan: LivePlan): void {
  const step = plan.steps[plan.index];
  if (!step) {
    plan.state = 'complete';
    plan.el.dataset.state = 'complete';
    plan.el.querySelector<HTMLElement>('.pl-state')!.textContent = 'every step executed';
    clearPlanAnchors(plan);
    syncAirlock();
    return;
  }
  setStepState(plan, plan.index, 'live', 'waiting on your decision');
  void proposeToWorker(step.tool, step.input).then((res) => {
    if (res.outcome === 'blocked') {
      // the airlock refused it — the plan stops here, and says why
      setStepState(plan, plan.index, 'blocked', res.reason ?? 'refused by the airlock');
      plan.state = 'abandoned';
      plan.el.dataset.state = 'abandoned';
      plan.el.querySelector<HTMLElement>('.pl-state')!.textContent =
        'stopped: the airlock refused this step';
      clearPlanAnchors(plan);
      return;
    }
    plan.currentProposalSeq = res.seq;
    planForProposal.set(res.seq, plan.id);
  });
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
    setStepState(plan, plan.index, 'done', 'executed');
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
  plan.el.querySelector<HTMLElement>('.pl-state')!.textContent =
    'abandoned — a sequence with a hole in it is not the plan that was agreed';
  clearPlanAnchors(plan);
}

function renderPlan(e: Event): void {
  const d = e.data as { planId?: string; reason?: string; steps?: PlanStep[] };
  const steps = Array.isArray(d.steps) ? d.steps : [];
  if (!d.planId || steps.length < 2) return;

  const el = document.createElement('div');
  el.className = 'plan-card';
  el.dataset.state = 'running';
  el.dataset.testid = `plan-${d.planId}`;
  el.dataset.planId = d.planId;

  const head = document.createElement('div');
  head.className = 'pl-head';
  const who = document.createElement('span');
  who.className = 'pl-actor';
  who.textContent = `agent proposes ${steps.length} steps, in this order`;
  const state = document.createElement('span');
  state.className = 'pl-state';
  state.textContent = 'one at a time — nothing runs ahead of you';
  head.append(who, state);
  el.append(head);

  // THE ORDER'S REASON COMES FIRST. It is what distinguishes this from a
  // batch, and the operator must weigh it before the first approval, not
  // discover it between steps.
  const why = document.createElement('div');
  why.className = 'pl-why';
  const k = document.createElement('span');
  k.className = 'pl-why-k';
  k.textContent = 'Why this order';
  const body = document.createElement('p');
  body.className = 'pl-why-t';
  body.tabIndex = 0;
  body.title = 'Show the whole reason';
  // clamped to two lines at rest; the reason for an ORDER is worth reading in
  // full, but not worth three lines of wall before you have decided to
  body.addEventListener('click', () => {
    body.dataset.expanded = body.dataset.expanded === 'true' ? 'false' : 'true';
  });
  renderCitedText(body, String(d.reason ?? ''));
  why.append(k, body);
  el.append(why);

  const list = document.createElement('ol');
  list.className = 'pl-steps';
  const stepEls: HTMLElement[] = [];
  const anchors: (HTMLElement | null)[] = [];
  steps.forEach((step, i) => {
    const li = document.createElement('li');
    li.className = 'pl-step';
    li.dataset.state = 'pending';
    li.dataset.testid = `plan-step-${d.planId}-${i}`;
    const what = document.createElement('p');
    what.className = 'pl-what';
    what.textContent = stepDescription(step);
    li.append(what);
    const cost = WRITE_ACTIONS[step.tool]?.cost;
    if (cost) {
      const c = document.createElement('p');
      c.className = 'pl-cost';
      const ck = document.createElement('span');
      ck.className = 'pl-cost-k';
      ck.textContent = 'Costs';
      c.append(ck, document.createTextNode(cost));
      li.append(c);
    }
    if (step.because) {
      const b = document.createElement('p');
      b.className = 'pl-because';
      renderCitedText(b, step.because);
      li.append(b);
    }
    const note = document.createElement('p');
    note.className = 'pl-note';
    note.textContent = i === 0 ? 'proposing…' : 'not proposed until the step above has run';
    li.append(note);
    // the real approval card for this step gets mounted here when it arrives
    const slot = document.createElement('div');
    slot.className = 'pl-slot';
    li.append(slot);
    list.append(li);
    stepEls.push(li);
    // THE WHOLE SEQUENCE LIGHTS UP ON THE CONSOLE, IN ORDER, before a single
    // step is approved. The operator sees where this plan is going to land on
    // the surface they already operate, not only inside the agent's card.
    const anchor = anchorFor(step.tool, step.input);
    anchors.push(anchor);
    if (anchor) {
      anchor.classList.add('plan-anchor');
      anchor.dataset.planStep = String(i + 1);
      anchor.dataset.planState = 'pending';
    }
  });
  el.append(list);
  airlockCards.appendChild(el);

  const plan: LivePlan = {
    id: d.planId,
    reason: String(d.reason ?? ''),
    steps,
    index: 0,
    el,
    stepEls,
    anchors,
    state: 'running',
  };
  plans.set(plan.id, plan);
  syncAirlock();
  advancePlan(plan);
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
        ? `<label class="ap-key"><input type="checkbox" class="ap-key-toggle" data-testid="key-${e.seq}"><span>engage key — held while the agent executes${d.provenance ? ' (required: untrusted evidence)' : ''}</span></label>`
        : ''
    }
    <div class="ap-actions">
      <button type="button" class="ctl-btn primary ap-approve" data-act="approve" data-seq="${e.seq}" data-testid="approve-${e.seq}" ${dualKey ? 'disabled' : ''}>Approve</button>
      <button type="button" class="ctl-btn ap-reject" data-act="reject" data-seq="${e.seq}" data-testid="reject-${e.seq}">Reject</button>
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
  (planHostFor(e.seq) ?? airlockCards).appendChild(card);
  // the agent dock scrolls as one column, so a long plan can put the very
  // buttons being asked about below the fold. Bring the live decision up.
  card.scrollIntoView({ block: 'nearest' });
  pendingCards.set(e.seq, { card, anchor });
  syncAirlock();
}

/** If the highlighted row sits on an evidence tab that isn't showing, show it. */
function revealAnchor(anchor: HTMLElement): void {
  const pane = anchor.closest<HTMLElement>('.tabpane');
  if (pane && pane.hidden) selectTab(pane.id.replace(/^zone-|^err-/, '') as string);
  anchor.scrollIntoView({ block: 'nearest' });
}

const airlockEl = document.querySelector<HTMLElement>('#airlock')!;
const airlockCards = document.querySelector<HTMLElement>('#airlock-cards')!;
/**
 * The region only exists while something is pending; it never leaves a void.
 * A plan holds it open for its whole life, INCLUDING after the last step ran:
 * the finished sequence with its ticks is the operator's receipt, and it used
 * to vanish the instant the final card resolved.
 */
function syncAirlock(): void {
  // the region STAYS while a finished plan's receipt is on screen...
  airlockEl.dataset.pending = String(pendingCards.size + plans.size);
  // ...but the region only ELEVATES while something is actually undecided.
  // Keying elevation off the same count left the dock covering the page for
  // the rest of the session once a plan completed, because its receipt is
  // deliberately kept. Elevation answers "are you waiting on me", nothing else.
  document.querySelector<HTMLElement>('.wb')!.dataset.decision = pendingCards.size
    ? 'pending'
    : 'none';
}

function resolveApprovalCard(proposalSeq: number): void {
  const entry = pendingCards.get(proposalSeq);
  if (!entry) return;
  entry.card.remove();
  entry.anchor?.classList.remove('proposal-anchor');
  pendingCards.delete(proposalSeq);
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
 * The cursor is positioned in VIEWPORT coordinates, so anything that scrolls
 * afterwards (an approval card calling scrollIntoView, the human scrolling
 * the console) leaves the label pointing at nothing. A label pointing at the
 * wrong thing is worse than no label, so it follows its target and hides when
 * the target leaves the viewport. Caught by screenshot.
 */
let lastAgentTarget: Element | null = null;

function placeAgentCursor(target: Element): void {
  const r = target.getBoundingClientRect();
  if (r.width === 0) return;
  const offscreen = r.bottom < 0 || r.top > window.innerHeight;
  agentCursor.hidden = offscreen;
  if (offscreen) return;
  const labelY = Math.max(4, Math.round(r.top - 22));
  agentCursor.style.transform = `translate(${Math.round(r.left - 6)}px, ${labelY}px)`;
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
  setPresence('live', 'Agent is working');
  window.clearTimeout(agentIdleTimer);
  agentIdleTimer = window.setTimeout(() => {
    // it fades out rather than parking: a label left on a region the agent
    // stopped reading is a claim that is no longer true
    agentCursor.dataset.state = 'idle';
    lastAgentTarget = null;
    setPresence('idle', 'Agent connected, waiting');
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
const READ_NARRATION: Record<string, { says: string; region: string }> = {
  airlock_status: { says: 'checking service health and impact', region: '#situation' },
  list_deploys: { says: 'reviewing what shipped recently', region: '#zone-changed' },
  read_logs: { says: 'reading service logs', region: '#zone-activity' },
  list_changes: { says: 'checking flags, env and routes', region: '#zone-controls' },
  traffic_history: { says: 'looking at the error-rate history', region: '#err-chart' },
  explain_surface: { says: 'asking why its tools changed', region: '#tool-surface' },
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

function clearCaution(): void {
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
  if (btn.dataset.caution === 'pending') return false; // second click: they meant it
  clearCaution();
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
  btn.parentElement?.insertBefore(box, btn.nextSibling);
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

function renderFinding(e: Event): void {
  const host = document.querySelector<HTMLElement>('#agent-findings');
  if (!host) return;
  const d = e.data as { summary?: string; ruledOut?: string; advisesAgainst?: string };
  if (!d.summary) return;
  if (d.advisesAgainst) {
    advisories.set(d.advisesAgainst, { summary: d.summary, ruledOut: d.ruledOut });
  }

  const card = document.createElement('article');
  card.className = 'finding';
  card.dataset.seq = String(e.seq);
  document.querySelector<HTMLElement>('#findings-empty')!.hidden = true;

  const head = document.createElement('p');
  head.className = 'finding-summary';
  head.textContent = d.summary;
  card.append(head);

  if (d.ruledOut) {
    const ruled = document.createElement('p');
    ruled.className = 'finding-ruled';
    const k = document.createElement('span');
    k.className = 'finding-k';
    k.textContent = 'Ruled out';
    ruled.append(k, document.createTextNode(d.ruledOut));
    card.append(ruled);
  }

  host.prepend(card);
  // the newest reading is the useful one; older ones stay in the audit trail
  while (host.children.length > 3) host.lastElementChild!.remove();
}

function showAgentAttention(e: Event): void {
  const d = e.data as Record<string, unknown>;
  if (e.kind === 'tool.called') {
    const tool = String(d.tool);
    const read = READ_NARRATION[tool];
    if (read) {
      narrate(`Agent is ${read.says}`);
      touchRegion(read.region);
    } else if (WRITE_NARRATION[tool]) {
      narrate(`Agent is ${WRITE_NARRATION[tool]}`);
    }
    return;
  }
  if (e.kind === 'action.proposed') {
    narrate('Agent is waiting on your decision');
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
}

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
      ['TOUCHES', tier.replace(/\s+/g, ' ').trim() || '—'],
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
      ['LIVE BUILD', live ? `${live.id} ${live.note ?? live.version}` : 'unknown'],
      ['IMPACT', `${w.damage.usersErrored} users · $${w.damage.revenueLost.toFixed(2)}`, 'bad'],
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
      if (e.kind === 'action.approved') approvalToProposal.set(e.seq, ps);
      else planDecided(ps, false);
    } else if (e.kind === 'action.executed' && typeof e.causedBy === 'number') {
      const ps = approvalToProposal.get(e.causedBy);
      if (ps !== undefined) planDecided(ps, true);
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
let paletteCmds: Command[] = [];
let paletteActive = 0;
let paletteReturnFocus: HTMLElement | null = null;

function paletteMatches(): Command[] {
  const q = paletteInput.value.trim().toLowerCase();
  if (!q) return paletteCmds;
  return paletteCmds.filter((c) => `${c.group} ${c.label}`.toLowerCase().includes(q));
}

function renderPalette(): void {
  const items = paletteMatches();
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

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    paletteEl.hidden ? openPalette() : closePalette();
    return;
  }
  if (paletteEl.hidden) return;
  if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); paletteActive++; renderPalette(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); paletteActive = Math.max(0, paletteActive - 1); renderPalette(); }
  else if (e.key === 'Enter') { e.preventDefault(); runPalette(paletteActive); }
});
paletteInput.addEventListener('input', () => { paletteActive = 0; renderPalette(); });
paletteList.addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-idx]');
  if (row) runPalette(Number(row.dataset.idx));
});
paletteEl.addEventListener('click', (e) => { if (e.target === paletteEl) closePalette(); });

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
  const writes = active.filter((t) => !t.readOnly && t.name !== 'record_finding');
  const countEl = document.querySelector<HTMLElement>('#tool-count');
  if (countEl) countEl.textContent = String(active.length);
  const fc = document.querySelector<HTMLElement>('#finding-count');
  const n = document.querySelectorAll('#agent-findings .finding').length;
  if (fc) fc.textContent = n ? String(n) : '';
  const sub = document.querySelector<HTMLElement>('#rail-sub');
  if (sub) {
    sub.textContent =
      writes.length === 0 ? 'can look, cannot change' : `can ask for ${writes.length} changes`;
  }
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
  runWorkerQuery,
  proposeToWorker,
  recordFindingToWorker,
  proposePlanToWorker
);
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
