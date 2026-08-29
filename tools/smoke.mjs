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

  // the three instruments render and are visible
  for (const id of ['console', 'site-pane', 'tool-rail']) {
    check(`#${id} visible`, await page.locator(`#${id}`).isVisible());
  }

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
  check('console renders the stream', (await page.locator('#event-stream li').count()) > 3);
  check(
    'sim status line live',
    /tick \d+ · \d+ events/.test(await page.getByTestId('sim-status').textContent())
  );

  // ---- M3-01: read-tool surface over live sim state ----------------------
  // (sim is already running from the worker-stream check above)
  const rail = await page.locator('#tool-list li').count();
  check('tool rail lists the read surface (6 tools incl. explain_surface)', rail === 6);
  await page.waitForFunction(() => window.__sim.stats.ticks > 3, null, { timeout: 10_000 });
  const toolProbe = await page.evaluate(async () => {
    const out = {};
    for (const t of window.__airlock.list()) {
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
    'recovery registers the write set (11 active tools)',
    (await page.locator('#tool-list li[data-status="active"]').count()) === 11
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
    'leaving recovery tombstones the writes (5 ghosts)',
    (await page.locator('#tool-list li[data-status="tombstoned"]').count()) === 5
  );
  const surface = JSON.parse(await page.evaluate(() => window.__airlock.invoke('explain_surface', {})));
  check(
    'explain_surface narrates mode + surface history',
    surface.mode === 'triage' &&
      Array.isArray(surface.changes) &&
      surface.changes.length >= 2 &&
      surface.changes[0].removed.length === 5
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

  // review fix: a template re-seed clears the previous scenario's tombstones
  // (this page left recovery mode earlier, so ghosts would render pre-fix)
  await page.getByTestId('template-pick').selectOption('baseline');
  await page.waitForFunction(
    () => document.querySelectorAll('#tool-list li[data-status="active"]').length === 6,
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
  await play.getByTestId('template-pick').selectOption('baseline');
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

  await trap.getByTestId('rollforward-api').click(); // dig out
  await healthIs(trap, 'ok');
  await siteIs(trap, 'ok');
  check('roll-forward heals the site from catastrophic', true);
  await trap.close();

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
