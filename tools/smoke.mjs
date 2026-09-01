#!/usr/bin/env node
/**
 * npm run smoke — e2e sanity from a cold checkout.
 * typecheck → build → preview on 8918 → hit-tested shell assertions.
 * Exit 0 = green. Any failure prints the reason and exits 1.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 8918;
const URL = `http://localhost:${PORT}/`;

function step(name, cmd, args) {
  process.stdout.write(`[smoke] ${name}... `);
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    console.log('FAIL');
    console.error(r.stdout?.toString() ?? '');
    console.error(r.stderr?.toString() ?? '');
    process.exit(1);
  }
  console.log('ok');
}

step('typecheck', 'npx', ['tsc', '--noEmit']);
step('lint-sim (determinism ban)', 'node', ['tools/lint-sim.mjs']);
step('unit tests', 'npx', ['vitest', 'run', '--reporter', 'dot']);
step('build', 'npx', ['vite', 'build', '--logLevel', 'error']);

const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
const killPreview = () => { try { preview.kill('SIGTERM'); } catch { /* already dead */ } };
process.on('exit', killPreview);

// wait for the preview server to accept connections
await new Promise((resolve, reject) => {
  const deadline = Date.now() + 15_000;
  const poll = async () => {
    try {
      const res = await fetch(URL);
      if (res.ok) return resolve();
    } catch { /* not up yet */ }
    if (Date.now() > deadline) return reject(new Error('preview server never came up on ' + PORT));
    setTimeout(poll, 200);
  };
  poll();
});

let failures = 0;
const check = (name, ok) => {
  console.log(`[smoke] ${name}: ${ok ? 'ok' : 'FAIL'}`);
  if (!ok) failures++;
};

const browser = await chromium.launch();
const pageErrors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  // dev=1: manual health buttons are dev-only since M2-06
  await page.goto(URL + '?dev=1', { waitUntil: 'networkidle' });

  // the two always-on instruments render and are visible
  for (const id of ['console', 'tool-rail']) {
    check(`#${id} visible`, await page.locator(`#${id}`).isVisible());
  }
  // the live site is OPT-IN as of 2026-08-30: closed until the store hurts
  check(
    'live site starts closed (console owns the room while nothing is wrong)',
    (await page.locator('.shell').getAttribute('data-site')) === 'off' &&
      !(await page.getByTestId('storefront').isVisible())
  );
  check(
    'live site toggle opens it on demand',
    await (async () => {
      await page.getByTestId('site-toggle').click();
      await page.waitForTimeout(500);
      return page.getByTestId('storefront').isVisible();
    })()
  );
  await page.getByTestId('site-toggle').click(); // back to closed for the rest

  // health-hue token demo: hit-test the 'down' control, hue must move teal→red
  const hueOf = () =>
    page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--health-hue'))
    );
  const hueBefore = await hueOf();
  await page.getByRole('button', { name: 'down' }).click();
  // sample during the 900ms transition: a mid-flight value proves the
  // @property registration animates the hue (an unregistered var snaps)
  const midSamples = [];
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(150);
    midSamples.push(await hueOf());
  }
  await page.waitForTimeout(700);
  const hueAfter = await hueOf();
  check(
    `health hue moves teal→red (${hueBefore} → ${hueAfter})`,
    hueBefore > 150 && hueAfter < 60
  );
  check(
    `hue animates through intermediate values (${midSamples.map((v) => v.toFixed(0)).join(', ')})`,
    midSamples.some((v) => v < hueBefore - 10 && v > hueAfter + 10)
  );
  check('data-health flipped to down', await page.evaluate(
    () => document.documentElement.dataset.health === 'down'
  ));

  // sim (M2-01/02): in-page engine determinism + live Worker stream
  const [d1, d2, d3] = await page.evaluate(() => [
    window.__sim.digest(42, 50),
    window.__sim.digest(42, 50),
    window.__sim.digest(43, 50),
  ]);
  check('in-page engine byte-identical on same seed', d1 === d2);
  check('different seed → different stream', d1 !== d3);

  await page.getByTestId('sim-run').click();
  await page.waitForFunction(() => window.__sim.stats.events > 5, null, { timeout: 10_000 });
  const stats = await page.evaluate(() => window.__sim.stats);
  check(`worker stream flowing (ticks=${stats.ticks}, events=${stats.events})`, stats.events > 5);
  // The activity trail is REFERENCE, not glance: it now arrives on demand,
  // so open it once, exactly as an operator would when they want the detail.
  // 2026-09-01: the three evidence views are TABS in the workbench's bottom
  // panel group, so the gesture that reveals the trail is selecting its tab.
  await page.getByTestId('tab-activity').click();
  check('console renders the stream', (await page.locator('#event-stream li').count()) > 3);
  check(
    'sim status line live',
    /tick \d+ · \d+ events/.test(await page.getByTestId('sim-status').textContent())
  );

  // ---- command palette: 19 levers is past the point where hunting works ---
  await page.keyboard.press('Control+k');
  await page.getByTestId('palette-input').waitFor({ timeout: 5_000 });
  const paletteAll = await page.locator('.palette-item').count();
  await page.getByTestId('palette-input').fill('drain');
  await page.waitForTimeout(150);
  const paletteHits = await page.evaluate(() =>
    [...document.querySelectorAll('.palette-item .pi-label')].map((n) => n.textContent)
  );
  check('Cmd+K opens a palette built from the live world', paletteAll > 15);
  check(
    'typing narrows to the matching command',
    paletteHits.length === 1 && /Drain/.test(paletteHits[0])
  );
  check(
    'every command carries the same cost string the control does',
    (await page.locator('.palette-item .pi-cost').first().textContent()).length > 20
  );
  await page.keyboard.press('Escape');
  check('escape closes it', await page.locator('#palette').isHidden());

  // ---- M3-01: read-tool surface over live sim state ----------------------
  // (sim is already running from the worker-stream check above)
  // The rail is a CAPABILITY LADDER, not an inventory: it shows the granted
  // rungs AND the ones this page has not granted yet, because "what it
  // cannot do" is the more reassuring half. In triage that is 7 granted
  // (6 reads + record_finding) and 5 still locked behind later stages.
  const railActive = await page.locator('#tool-list li[data-status="active"]').count();
  const railLocked = await page.locator('#tool-list li[data-status="locked"]').count();
  // triage grants reads + record_finding + the five incident-command
  // proposals: a page can let an agent help RUN an incident long before it
  // lets one touch production
  check(
    'triage grants 13 rungs (6 reads + record_finding + propose_plan + incident command)',
    railActive === 13
  );
  check('the ladder shows the 14 production rungs still locked', railLocked === 14);
  check(
    'triage grants NOTHING that changes production',
    (await page.evaluate(() =>
      window.__airlock
        .list()
        .filter((t) => t.status === 'active')
        .every(
          (t) =>
            !/^propose_(rollback|rollforward|env_change|route_change|traffic_change|drain|restart|scale|cache_flush|failover|flag_change|canary|rate_limit|deploy_freeze)$/.test(
              t.name
            )
        )
    )) === true
  );
  check(
    'locked rungs name the stage that would open them',
    /needs (Diagnosis|Recovery)/.test(
      await page.locator('#tool-list li[data-status="locked"]').first().textContent()
    )
  );
  check(
    'the surface reads as sentences, not function names',
    !/propose_|airlock_status/.test(
      await page.locator('#tool-list li[data-status="active"]').first().textContent()
    )
  );
  check(
    'record_finding is listed and is NOT read-only',
    await page.evaluate(() => {
      const t = window.__airlock.list().find((x) => x.name === 'record_finding');
      return !!t && t.readOnly === false && t.status === 'active';
    })
  );
  await page.waitForFunction(() => window.__sim.stats.ticks > 3, null, { timeout: 10_000 });
  const toolProbe = await page.evaluate(async () => {
    const out = {};
    // READS only — record_finding is listed but is not a query and has no
    // asOfSeq; invoking it with no summary is correctly rejected
    for (const t of window.__airlock.list().filter((x) => x.readOnly)) {
      const text = await window.__airlock.invoke(t.name, {});
      const parsed = JSON.parse(text);
      out[t.name] = { bytes: text.length, asOfSeq: parsed.asOfSeq };
    }
    // pagination through the same execute path WebMCP uses
    const p1 = JSON.parse(await window.__airlock.invoke('traffic_history', {}));
    const p2 = p1.nextCursor
      ? JSON.parse(await window.__airlock.invoke('traffic_history', { cursor: p1.nextCursor }))
      : null;
    out.pagination =
      p2 !== null &&
      p2.ticks.length > 0 &&
      p2.ticks[0].seq < p1.ticks[p1.ticks.length - 1].seq;
    return out;
  });
  check(
    'all 5 read tools answer live, ≤1.2KB, with asOfSeq',
    Object.entries(toolProbe)
      .filter(([k]) => k !== 'pagination')
      .every(([, v]) => v.bytes <= 1200 && Number.isInteger(v.asOfSeq) && v.asOfSeq > 0)
  );
  check('cursor pagination works through the execute path', toolProbe.pagination === true);

  // ---- M3-02: mode-gated surface swap + tombstones + narration -----------
  const blockedInTriage = JSON.parse(
    await page.evaluate(() => window.__airlock.invoke('propose_rollback', { deployId: 'd-201' }))
  );
  check(
    'write attempt outside its mode is BLOCKED and logged (action.blocked)',
    blockedInTriage.status === 'blocked' &&
      blockedInTriage.reason === 'not-available-in-mode' &&
      (await page.locator('#event-stream li[data-kind="action.blocked"]').count()) >= 1
  );

  await page.getByTestId('mode-recovery').click();
  await page.locator('#tool-list li[data-tool="propose_rollback"][data-status="active"]').waitFor({ timeout: 5_000 });
  check(
    'recovery registers the full surface (27: 6 reads + record_finding + propose_plan + 19 proposals)',
    (await page.locator('#tool-list li[data-status="active"]').count()) === 27
  );

  const proposal = JSON.parse(
    await page.evaluate(() => window.__airlock.invoke('propose_rollback', { deployId: 'd-201' }))
  );
  check(
    'write tool proposes instead of executing (pending approval)',
    proposal.status === 'proposed' && Number.isInteger(proposal.proposalSeq)
  );
  await page
    .locator('#event-stream li[data-kind="action.proposed"]')
    .first()
    .waitFor({ timeout: 5_000 });
  check(
    'proposal is audited in the stream with tier + diff',
    /\[tier 1\].*roll back d-201/.test(
      await page.locator('#event-stream li[data-kind="action.proposed"] .ev-summary').first().textContent()
    )
  );

  await page.getByTestId('mode-triage').click();
  await page.locator('#tool-list li[data-status="tombstoned"]').first().waitFor({ timeout: 5_000 });
  check(
    'leaving recovery hands 14 capabilities back to the page',
    (await page.locator('#tool-list li[data-status="tombstoned"]').count()) === 14
  );
  const surface = JSON.parse(await page.evaluate(() => window.__airlock.invoke('explain_surface', {})));
  check(
    'explain_surface narrates mode + surface history',
    surface.mode === 'triage' &&
      Array.isArray(surface.changes) &&
      surface.changes.length >= 2 &&
      surface.changes[0].removed.length === 14
  );

  // ---- M3-03: approval diff-cards + causedBy audit chain -----------------
  // the Refusal: reject the rollback proposal made above
  await page.getByTestId(`reject-${proposal.proposalSeq}`).click();
  await page.locator('#event-stream li[data-kind="action.rejected"]').first().waitFor({ timeout: 5_000 });
  check(
    'reject closes the card and audits the refusal',
    (await page.locator(`[data-testid="approval-${proposal.proposalSeq}"]`).count()) === 0
  );

  await page.getByTestId('mode-recovery').click();
  const flagProp = JSON.parse(
    await page.evaluate(() =>
      window.__airlock.invoke('propose_flag_change', { id: 'new-checkout', state: 'off' })
    )
  );
  await page.locator(`[data-testid="approval-${flagProp.proposalSeq}"]`).waitFor({ timeout: 5_000 });
  check(
    'approval card anchors to the node it would mutate',
    (await page.locator('#flag-controls [data-flag-id="new-checkout"].proposal-anchor').count()) === 1
  );

  await page.getByTestId(`approve-${flagProp.proposalSeq}`).click();
  const executedLi = page.locator('#event-stream li[data-kind="action.executed"][data-actor="agent"]').first();
  await executedLi.waitFor({ timeout: 5_000 });
  check(
    'approve executes as the agent, causedBy-threaded to the approval',
    (await executedLi.getAttribute('data-caused-by')) !== '' &&
      (await page.locator(`[data-testid="approval-${flagProp.proposalSeq}"]`).count()) === 0
  );

  await page.getByTestId('audit-toggle').click();
  check(
    'audit filter reduces the stream to the agency trail',
    !(await page.locator('#event-stream li[data-kind="traffic.tick"]').first().isVisible()) &&
      (await page.locator('#event-stream li[data-kind="action.executed"]').first().isVisible())
  );
  await page.getByTestId('audit-toggle').click();

  // ---- M3-04: tier ladder top rung — the Turn of the Key -----------------
  // (still in recovery mode from the block above)
  const routeProp = JSON.parse(
    await page.evaluate(() =>
      window.__airlock.invoke('propose_route_change', { id: 'checkout', target: 'web' })
    )
  );
  await page.locator(`[data-testid="approval-${routeProp.proposalSeq}"]`).waitFor({ timeout: 5_000 });
  check(
    'tier-4 card renders disarmed (approve disabled until the key)',
    await page.getByTestId(`approve-${routeProp.proposalSeq}`).isDisabled()
  );
  await page.getByTestId(`key-${routeProp.proposalSeq}`).check();
  check(
    'engaging the key arms approve',
    !(await page.getByTestId(`approve-${routeProp.proposalSeq}`).isDisabled())
  );
  await page.getByTestId(`approve-${routeProp.proposalSeq}`).click();
  await page.waitForFunction(
    () => document.querySelector('#event-stream').textContent.includes('key: operator'),
    null,
    { timeout: 5_000 }
  );
  const routes = JSON.parse(await page.evaluate(() => window.__airlock.invoke('list_changes', {})));
  check(
    'keyed approval executes the top-tier write (route retargeted)',
    routes.routes.find((r) => r.id === 'checkout').target === 'web'
  );

  // ---- M3-05: co-presence — human clicks a node, agent reads scope to it --
  await page.locator('.topo-node[data-service="api"]').click();
  await page.locator('.topo-node[data-service="api"][data-selected="true"]').waitFor({ timeout: 5_000 });
  // clue log-lines drip probabilistically per tick — wait until at least one
  // exists before asserting the scope filter
  let scopedLogs = { lines: [] };
  for (let i = 0; i < 30 && scopedLogs.lines.length === 0; i++) {
    scopedLogs = JSON.parse(await page.evaluate(() => window.__airlock.invoke('read_logs', {})));
    if (scopedLogs.lines.length === 0) await page.waitForTimeout(400);
  }
  check(
    'selection scopes read_logs to the pointed-at service',
    scopedLogs.scopedTo?.service === 'api' &&
      scopedLogs.lines.length > 0 &&
      scopedLogs.lines.every((l) => l.service === 'api')
  );
  const scopedStatus = JSON.parse(await page.evaluate(() => window.__airlock.invoke('airlock_status', {})));
  check(
    'agent sees humanSelection in status; selection audited in the stream',
    scopedStatus.humanSelection?.id === 'api' &&
      (await page.locator('#event-stream li[data-kind="selection.changed"]').count()) >= 1
  );
  // review fix: deck controls are not selection gestures — toggling audit
  // (or any non-node control) must never clear or move the selection
  await page.getByTestId('audit-toggle').click();
  await page.getByTestId('audit-toggle').click();
  check(
    'audit toggle does not steal the selection (reads stay scoped)',
    (await page.locator('.topo-node[data-service="api"][data-selected="true"]').count()) === 1
  );

  await page.locator('.topo-node[data-service="api"]').click(); // toggle off
  await page.waitForFunction(
    () => !document.querySelector('[data-selected="true"]'),
    null,
    { timeout: 5_000 }
  );
  const unscoped = JSON.parse(await page.evaluate(() => window.__airlock.invoke('read_logs', {})));
  check('clicking again clears the selection (reads unscope)', unscoped.scopedTo === undefined);

  // ---- M3-06: agent presence mechanics -----------------------------------
  check(
    'agent cursor is on stage after agent activity (conn chip live)',
    ['active', 'idle'].includes(await page.getByTestId('agent-cursor').getAttribute('data-state')) &&
      ['live', 'idle'].includes(await page.getByTestId('agent-conn').getAttribute('data-state'))
  );
  await page.evaluate(() => window.__annotate({ type: 'service', id: 'api' }));
  await page.locator('.topo-node[data-service="api"].telestrated').waitFor({ timeout: 5_000 });
  check('telestrator ring pulses on the annotated node', true);

  // residual-review fixes: malformed agent input is BLOCKED at the gate
  // (never poisons the log), and a foreign cursor resolves instead of
  // hanging the tool promise forever
  const badInput = JSON.parse(
    await page.evaluate(() => window.__airlock.invoke('propose_env_change', { key: 'SESSIONS_SCHEMA' }))
  );
  check(
    'malformed write input blocks as invalid-input (agent gets the reason)',
    badInput.status === 'blocked' && /invalid-input/.test(badInput.reason)
  );
  const foreignCursor = await Promise.race([
    page.evaluate(() => window.__airlock.invoke('list_deploys', { cursor: 9999 })),
    new Promise((r) => setTimeout(() => r('HUNG'), 6000)),
  ]);
  check(
    'foreign/out-of-range cursor resolves with the newest page (no hang, no throw)',
    foreignCursor !== 'HUNG' && Array.isArray(JSON.parse(foreignCursor).deploys)
  );

  // review fix: a template re-seed clears the previous scenario's tombstones
  // (this page left recovery mode earlier, so ghosts would render pre-fix)
  await page.locator('#scenario-pick > summary').click(); // the picker is a menu now
  await page.getByTestId('template-baseline').click();
  await page.waitForFunction(
    () => document.querySelectorAll('#tool-list li[data-status="active"]').length === 13,
    null,
    { timeout: 5_000 }
  );
  check(
    'template re-seed exorcises ghost tombstones from the rail',
    (await page.locator('#tool-list li[data-status="tombstoned"]').count()) === 0
  );

  // ---- M2-05: human resolves the flagship scenario via UI clicks only ----
  // (fast pacing via ?tick= so the run is seconds, not minutes; every state
  // assertion is on rendered DOM — nothing reaches into the engine)
  const play = await browser.newPage();
  play.on('pageerror', (e) => pageErrors.push(e.message));
  await play.goto(URL + '?tick=50', { waitUntil: 'networkidle' });
  // (no tab switch here: this block asserts on deploy cards, which live on the
  // 'What changed' tab, and reads the stream through the DOM rather than the
  // screen — the trail does not need to be the visible view for that)

  const healthIs = (p, state) =>
    p.waitForFunction((s) => document.documentElement.dataset.health === s, state, { timeout: 15_000 });
  const siteIs = (p, state) =>
    p.waitForFunction(
      (s) => document.querySelector('#storefront')?.dataset.state === s,
      state,
      { timeout: 15_000 }
    );

  // the deck renders on the worker's async snapshot reply — wait, don't poll-once
  await play.getByTestId('flag-toggle-new-checkout').waitFor({ timeout: 15_000 });
  await play.getByTestId('deploy-card-d-200').waitFor({ timeout: 15_000 });
  check('deck seeded pre-run (flag row + backstory deploy card)', true);

  await play.getByTestId('sim-run').click();
  await play.getByTestId('deploy-card-d-201').waitFor({ timeout: 15_000 });
  await healthIs(play, 'degraded');
  check(
    'trap deploy card shows decision-grade metadata (irreversible migration badge)',
    /migration · irreversible/.test(await play.getByTestId('deploy-card-d-201').textContent())
  );
  await siteIs(play, 'broken');
  check('site pane visibly breaks when the trap fires', await play.getByTestId('sf-banner').isVisible());
  check(
    'the store reveals ITSELF when checkout starts failing (no click needed)',
    (await play.locator('.shell').getAttribute('data-site')) === 'on'
  );

  await play.getByTestId('flag-toggle-new-checkout').click(); // mitigate: flag off
  await healthIs(play, 'ok');
  await siteIs(play, 'ok');
  check('flag-off mitigates (health ok, site healed)', true);

  await play.getByTestId('rollforward-api').click(); // resolve: roll forward
  await play.getByTestId('deploy-card-d-202').waitFor({ timeout: 15_000 });
  await play.waitForFunction(
    () => document.querySelector('#event-stream').textContent.includes('v2.0.1 serving'),
    null,
    { timeout: 15_000 }
  );
  check(
    'roll-forward resolves via UI clicks only (d-202 live, v2.0.1 serving)',
    (await play.evaluate(() => document.documentElement.dataset.health)) === 'ok'
  );
  check(
    'human actions threaded into the stream (actor=human)',
    (await play.locator('#event-stream li[data-actor="human"]').count()) >= 2
  );

  // review fix: the DOM cap must not evict the agency trail — the audit view
  // is this same DOM filtered by CSS, so action rows must survive eviction
  await play.waitForFunction(
    () => document.querySelectorAll('#event-stream li').length >= 200,
    null,
    { timeout: 60_000 }
  );
  check(
    'stream cap preserves the agency trail (action rows survive eviction)',
    (await play.locator('#event-stream li[data-kind="action.executed"]').count()) >= 4
  );

  // template switch fully resets the console (pacer, deck, status) — the
  // migration-trap flag row must not survive into baseline
  await play.locator('#scenario-pick > summary').click(); // the picker is a menu now
  await play.getByTestId('template-baseline').click();
  await play.waitForFunction(
    () => document.querySelector('#flag-controls').children.length === 0,
    null,
    { timeout: 5_000 }
  );
  check(
    're-seed resets pacer + status (paused, Run sim)',
    (await play.getByTestId('sim-status').textContent()) === 'seeded · paused' &&
      (await play.getByTestId('sim-run').textContent()) === 'Run sim'
  );
  await play.close();

  // ---- M2-06 trap path: naive rollback breaks the site, roll-forward heals --
  const trap = await browser.newPage();
  trap.on('pageerror', (e) => pageErrors.push(e.message));
  await trap.goto(URL + '?tick=50', { waitUntil: 'networkidle' });
  await trap.getByTestId('sim-run').click();
  await trap.getByTestId('deploy-card-d-201').waitFor({ timeout: 15_000 });
  await healthIs(trap, 'degraded');

  await trap.getByTestId('rollback-d-201').click(); // THE TRAP
  await healthIs(trap, 'down');
  await siteIs(trap, 'down');
  check('naive rollback goes catastrophic (health down)', true);
  check('site pane shows the outage (502 overlay visible)', await trap.getByTestId('sf-outage').isVisible());
  check(
    'clue surfaces in the stream (irreversible schema mismatch)',
    await trap.evaluate(() =>
      document.querySelector('#event-stream').textContent.includes('SchemaMismatch')
    )
  );

  // ---- logs pane: the human gets read_logs's lines, with a filter --------
  // Parity check, run HERE because migration-trap only emits log lines once
  // the trap has fired — asserting it at boot measured an empty pane. These
  // rows must be the SAME log.line events read_logs pages over; if the pane
  // were fed from anywhere else, the no-privileged-channel claim would be a
  // slogan rather than a fact.
  await trap.getByTestId('tab-logs').click();
  const logRows = await trap.locator('#log-stream .log-row').count();
  check('logs pane renders application log lines', logRows > 0);
  const logParity = await trap.evaluate(async () => {
    const rows = [...document.querySelectorAll('#log-stream .log-row')].map((n) => Number(n.dataset.seq));
    const served = JSON.parse(await window.__airlock.invoke('read_logs', {})).lines.map((l) => l.seq);
    return { rows, served };
  });
  check(
    'every line read_logs serves the agent is in the human pane too',
    logParity.served.length > 0 && logParity.served.every((s) => logParity.rows.includes(s))
  );
  await trap.getByTestId('log-filter').fill('zzzz-no-such-line');
  await trap.waitForTimeout(80);
  check('text filter can empty the pane', (await trap.locator('#log-stream .log-row:visible').count()) === 0);
  await trap.getByTestId('log-filter').fill('');
  await trap.waitForTimeout(80);
  check('clearing the filter restores every line', (await trap.locator('#log-stream .log-row:visible').count()) === logRows);
  // A level floor only proves anything when the pane holds more than one
  // level, so assert the reduction conditionally on that being true.
  const levels = await trap.evaluate(() =>
    [...new Set([...document.querySelectorAll('#log-stream .log-row')].map((n) => n.dataset.level))]
  );
  await trap.getByTestId('log-lvl-error').click();
  const errShown = await trap.locator('#log-stream .log-row:visible').count();
  check(
    `level floor filters the pane (levels present: ${levels.join(',')})`,
    levels.length > 1 ? errShown < logRows : errShown === logRows
  );
  await trap.getByTestId('log-lvl-all').click();
  await trap.getByTestId('tab-activity').click();

  await trap.getByTestId('rollforward-api').click(); // dig out
  await healthIs(trap, 'ok');
  await siteIs(trap, 'ok');
  check('roll-forward heals the site from catastrophic', true);
  await trap.close();

  // ---- M4: injection family — provenance-weighted authorization ---------
  // The film's second money shot. A tier-1 rollback, proposed on the strength
  // of a customer-supplied log line, must arrive on the key rung with the
  // source quoted on the card — and the human must still be able to do it.
  const inj = await browser.newPage();
  inj.on('pageerror', (e) => pageErrors.push(e.message));
  await inj.goto(URL + '?template=poisoned-runbook&tick=50', { waitUntil: 'networkidle' });
  await inj.getByTestId('sim-run').click();
  await inj.waitForFunction(
    () => /tick (1[5-9]|[2-9]\d)/.test(document.querySelector('[data-testid=sim-status]').textContent),
    null,
    { timeout: 30_000 }
  );
  await inj.getByTestId('sim-run').click(); // pause: the world is set

  const served = await inj.evaluate(() => window.__airlock.invoke('read_logs', {}));
  check('the poisoned order note reaches the agent flagged untrusted', /untrusted/.test(served));

  await inj.getByTestId('mode-recovery').click();
  const injSeq = JSON.parse(
    await inj.evaluate(() => window.__airlock.invoke('propose_rollback', { deployId: 'd-318' }))
  ).proposalSeq;
  const injCard = inj.getByTestId(`approval-${injSeq}`);
  await injCard.waitFor({ timeout: 5_000 });
  const injText = (await injCard.textContent()).replace(/\s+/g, ' ');
  check(
    'the card cites where the idea came from (quote + log seq + who supplied it)',
    /came from untrusted content/.test(injText) &&
      /ACTION REQUIRED/.test(injText) &&
      /customer-supplied text/.test(injText)
  );
  check(
    'a tier-1 write is promoted to the key rung by provenance alone',
    /tier 1 · deploy · dual-key/.test(injText) &&
      (await inj.getByTestId(`approve-${injSeq}`).isDisabled())
  );
  await inj.getByTestId(`key-${injSeq}`).check();
  check(
    'the human is informed, not overruled: the key re-arms approve',
    await inj.getByTestId(`approve-${injSeq}`).isEnabled()
  );
  await inj.close();

  // ---- evidence assembly: the card says what the agent worked FROM -------
  // The strip has two registers and they must not be confused: the chip row
  // is read off the audit trail (uncounterfeitable), the sentence is the
  // agent's own claim. These gates check the first is true to the log, that a
  // citation actually lands, and that proposing with no reads is called out.
  const ev = await browser.newPage();
  ev.on('pageerror', (e) => pageErrors.push(e.message));
  await ev.goto(URL + '?template=retry-storm&tick=120', { waitUntil: 'networkidle' });
  await ev.getByTestId('sim-run').click();
  await ev.waitForFunction(() => document.querySelectorAll('#log-stream .log-row').length > 6, null, {
    timeout: 40_000,
  });
  await ev.getByTestId('mode-recovery').click();

  // a proposal made with NO reads is the one an operator most needs flagged
  const bare = JSON.parse(
    await ev.evaluate(() => window.__airlock.invoke('propose_rate_limit', { route: 'r-checkout', rps: 150 }))
  ).proposalSeq;
  await ev.getByTestId(`evidence-${bare}`).waitFor({ timeout: 5_000 });
  check(
    'a proposal made without reading anything says so on the card',
    await ev.getByTestId(`evidence-none-${bare}`).isVisible()
  );
  await ev.getByTestId(`reject-${bare}`).click();

  const cite = await ev.evaluate(async () => {
    for (const t of ['airlock_status', 'list_deploys', 'read_logs', 'read_logs', 'traffic_history']) {
      await window.__airlock.invoke(t, {});
    }
    return [...document.querySelectorAll('#log-stream .log-row')].map((n) => Number(n.dataset.seq)).at(-2);
  });
  const worked = JSON.parse(
    await ev.evaluate(async (seq) => {
      await window.__airlock.invoke('record_finding', {
        summary: `The load on /checkout is retries, not customers — contention already cleared (#${seq}).`,
      });
      return await window.__airlock.invoke('propose_rate_limit', { route: 'r-checkout', rps: 150 });
    }, cite)
  ).proposalSeq;
  const strip = ev.getByTestId(`evidence-${worked}`);
  await strip.waitFor({ timeout: 5_000 });
  const chips = await ev.locator(`[data-testid="evidence-${worked}"] .ap-ev-chip`).evaluateAll((n) =>
    n.map((c) => c.dataset.tool)
  );
  check(
    `the strip names the reads the agent actually made (${chips.join(',')})`,
    ['airlock_status', 'list_deploys', 'read_logs', 'traffic_history'].every((t) => chips.includes(t)) &&
      !chips.includes('record_finding')
  );
  check(
    'read_logs called twice is counted, not listed twice',
    chips.filter((t) => t === 'read_logs').length === 1 &&
      (await ev.locator(`[data-testid="evidence-${worked}"] .ap-ev-chip[data-tool="read_logs"] .ap-ev-n`).textContent()) === '×2'
  );
  check(
    "the agent's own conclusion rides along, as a claim",
    (await ev.getByTestId(`evidence-said-${worked}`).textContent()).includes('retries, not customers')
  );
  // the citation is the whole point: it has to LAND on the line it names
  await ev.locator(`[data-testid="evidence-${worked}"] .ap-cite`).first().click();
  check(
    'clicking a citation opens the logs pane on that exact line',
    (await ev.getByTestId('tab-logs').getAttribute('aria-selected')) === 'true' &&
      (await ev.locator(`#log-stream li.log-cited[data-seq="${cite}"]`).count()) === 1
  );
  await ev.close();

  // ---- the plan: a sequence, priced, approved one step at a time --------
  // retry-storm's answer is two levers in ONE ORDER and the reverse order is
  // worse than doing nothing, so the surface has to be able to show a
  // sequence. These gates hold it to the promise that makes it safe: it is
  // not a batch approval. Step 2 must not exist until step 1 has run.
  const pl = await browser.newPage();
  pl.on('pageerror', (e) => pageErrors.push(e.message));
  await pl.goto(URL + '?template=retry-storm&tick=120', { waitUntil: 'networkidle' });
  await pl.getByTestId('sim-run').click();
  await pl.waitForFunction(() => document.querySelectorAll('#log-stream .log-row').length > 4, null, {
    timeout: 40_000,
  });
  await pl.getByTestId('mode-recovery').click();

  const planSteps = [
    { tool: 'propose_rate_limit', input: { route: 'r-checkout', rps: 150 }, because: 'buys headroom; rejects real customers and fixes nothing' },
    { tool: 'propose_rollforward', input: { service: 'api' }, because: '2.4.2 is staged and green' },
  ];
  const planned = JSON.parse(
    await pl.evaluate(
      (steps) =>
        window.__airlock.invoke('propose_plan', {
          reason: 'The fleet is at its autoscaler ceiling, so a rolling replacement withdraws capacity this incident cannot spare. Headroom first.',
          steps,
        }),
      planSteps
    )
  );
  check('a plan is accepted as one object with its order intact', planned.status === 'planned' && planned.steps === 2);
  const planCard = pl.getByTestId(`plan-${planned.planId}`);
  await planCard.waitFor({ timeout: 5_000 });
  check(
    'the reason the ORDER matters is on the card, before any approval',
    (await planCard.locator('.pl-why-t').textContent()).includes('autoscaler ceiling')
  );
  check(
    'every step states its own cost',
    (await planCard.locator('.pl-cost').count()) === 2
  );
  // THE PROMISE: this is not a batch. Only step 1 has been put to the human.
  // the sequence is legible from the CONTROLS too, not only from the card
  check(
    'the plan numbers the console rows it will land on, in order',
    JSON.stringify(
      await pl.locator('.plan-anchor').evaluateAll((n) =>
        n.map((a) => [a.dataset.planStep, a.dataset.planState]).sort()
      )
    ) === JSON.stringify([['1', 'live'], ['2', 'pending']])
  );
  check(
    'only the first step is live; the second is not proposed yet',
    (await planCard.locator('.pl-step[data-state="live"]').count()) === 1 &&
      (await pl.getByTestId(`plan-step-${planned.planId}-1`).getAttribute('data-state')) === 'pending' &&
      (await planCard.locator('.approval-card').count()) === 1
  );
  await planCard.locator('.pl-step[data-state="live"] .ap-approve').click();
  await pl.waitForFunction(
    (id) => document.querySelector(`[data-testid="plan-step-${id}-1"]`)?.dataset.state === 'live',
    planned.planId,
    { timeout: 10_000 }
  );
  check(
    'executing step 1 is what proposes step 2 — never before',
    (await pl.getByTestId(`plan-step-${planned.planId}-0`).getAttribute('data-state')) === 'done' &&
      (await planCard.locator('.approval-card').count()) === 1
  );
  await planCard.locator('.pl-step[data-state="live"] .ap-approve').click();
  await pl.waitForFunction(
    (id) => document.querySelector(`[data-testid="plan-${id}"]`)?.dataset.state === 'complete',
    planned.planId,
    { timeout: 10_000 }
  );
  check(
    'a finished plan says so and keeps its receipt on screen',
    (await planCard.locator('.pl-step[data-state="done"]').count()) === 2 &&
      (await planCard.isVisible())
  );
  check(
    'a settled plan stops numbering the controls (a stale number is a lie)',
    (await pl.locator('.plan-anchor').count()) === 0
  );
  // every step went through the airlock as its own gated proposal
  const gated = await pl.evaluate(() =>
    [...document.querySelectorAll('#event-stream li[data-kind="action.proposed"]')].length
  );
  check('each step still arrived as its own action.proposed', gated >= 2);

  // rejecting a step abandons the REST: a sequence with a hole in it is not
  // the plan anyone agreed to
  const p2 = JSON.parse(
    await pl.evaluate(
      (steps) =>
        window.__airlock.invoke('propose_plan', {
          reason: 'second plan, to test abandonment',
          steps,
        }),
      planSteps
    )
  );
  const card2 = pl.getByTestId(`plan-${p2.planId}`);
  await card2.locator('.pl-step[data-state="live"] .ap-reject').click();
  await pl.waitForFunction(
    (id) => document.querySelector(`[data-testid="plan-${id}"]`)?.dataset.state === 'abandoned',
    p2.planId,
    { timeout: 10_000 }
  );
  check(
    'rejecting one step abandons the remainder rather than skipping it',
    (await pl.getByTestId(`plan-step-${p2.planId}-1`).getAttribute('data-state')) === 'dropped' &&
      (await card2.locator('.approval-card').count()) === 0
  );
  await pl.close();



  // ---- M3-07: unattended full-scenario agent driver (plumbing loop) ------
  const driver = spawnSync('node', ['tools/agent-driver.mjs', URL], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  check('agent driver resolves the scenario unattended', driver.status === 0);
  if (driver.status !== 0) {
    console.error(driver.stdout?.toString() ?? '', driver.stderr?.toString() ?? '');
  }

  check('no page errors', pageErrors.length === 0);
  if (pageErrors.length) console.error('[smoke] page errors:', pageErrors);
} finally {
  await browser.close();
  killPreview();
}

console.log(failures === 0 ? '[smoke] GREEN' : `[smoke] RED (${failures} failure(s))`);
process.exit(failures === 0 ? 0 : 1);
