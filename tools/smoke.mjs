#!/usr/bin/env node
/**
 * npm run smoke — e2e sanity from a cold checkout.
 * typecheck → build → preview on 8918 → hit-tested shell assertions.
 * Exit 0 = green. Any failure prints the reason and exits 1.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

// SMOKE_PORT lets a worktree run this beside the main tree; 8918 stays the default.
const PORT = Number(process.env.SMOKE_PORT ?? 8918);
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
  // ---- the dock is opt-in, and reachable from the keyboard --------------
  // 27 rows of capability was eating the dock by default. It is closed now,
  // but the COUNT stays on the summary: that the surface is bounded, and by
  // how much, is the reassuring half and must survive the collapse.
  // Collapsed INLINE it was still at the bottom of a scrolling column, which
  // is hidden whether it is open or not. It is a pinned line that never
  // scrolls away, and it opens over the page.
  check(
    'capability is a pinned line that says how many tools this stage grants',
    (await page.getByTestId('tool-surface').isVisible()) &&
      (await page.locator('#surface').isHidden()) &&
      /^\d+ tools available/.test(
        (await page.getByTestId('tool-surface').textContent()).replace(/\s+/g, ' ').trim()
      )
  );
  await page.getByTestId('tool-surface').click();
  check(
    'it opens over the page, naming the stage the count is true for',
    (await page.locator('#surface').isVisible()) &&
      (await page.locator('#tool-list li').count()) > 10 &&
      /triage stage/.test(await page.locator('#surface-stage').textContent())
  );
  await page.keyboard.press('Escape');
  check('escape closes the capability sheet', await page.locator('#surface').isHidden());
  // ⌘J is the region's shortcut, advertised in the status bar and on the dock
  await page.keyboard.press('Control+j');
  const railHidden = await page.evaluate(() => document.querySelector('.wb').dataset.rail);
  await page.keyboard.press('Control+j');
  check(
    '⌘J hides and restores the agent dock, and says so on screen',
    railHidden === 'off' &&
      (await page.evaluate(() => document.querySelector('.wb').dataset.rail)) === 'on' &&
      /⌘J/.test(await page.locator('.wb-status').textContent()) &&
      /⌘J/.test(await page.locator('#tool-rail .dock-head').textContent())
  );

  // presence is one bit of information, so it is a marker on the heading, not
  // a card in the body — and it must not repeat the heading it sits next to
  check(
    'agent presence is a marker on the dock heading, not a section in the body',
    (await page.locator('#tool-rail .dock-head #agent-presence').count()) === 1 &&
      (await page.locator('#tool-rail .dock-body #agent-presence').count()) === 0 &&
      !/Agent\s+Agent/.test(
        (await page.locator('#tool-rail .dock-head').textContent()).replace(/\s+/g, ' ')
      )
  );
  // the deck carries `min-height: 100%` so a short console leaves no bare
  // ground; stretched to that track it rendered its last card BELOW itself,
  // over the status bar, because `.zone` cannot clip (cost popovers escape).
  check(
    'the control deck contains its own cards — nothing renders past its bottom edge',
    await page.evaluate(() => {
      const deck = document.querySelector('#control-deck');
      const b = deck.getBoundingClientRect().bottom;
      return [...deck.children]
        .filter((c) => c.getBoundingClientRect().height > 0)
        .every((c) => c.getBoundingClientRect().bottom <= b + 1);
    })
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
  // Capability opens over the page now, so the rung a human would go and LOOK
  // at is behind one click. The gate below still demands the rung be VISIBLE —
  // that assertion is untouched; this is the gesture the UI now requires.
  await page.getByTestId('tool-surface').click();
  await page.locator('#tool-list li[data-tool="propose_rollback"][data-status="active"]').waitFor({ timeout: 5_000 });
  check(
    'recovery registers the full surface (27: 6 reads + record_finding + propose_plan + 19 proposals)',
    (await page.locator('#tool-list li[data-status="active"]').count()) === 27
  );
  // it is a modal: leave it open and every click after this one hits the scrim
  await page.keyboard.press('Escape');

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
  // the VANISHING is the point, so this gate demands the rung be visible —
  // untouched; opening the sheet is the gesture the UI now requires
  await page.getByTestId('tool-surface').click();
  await page.locator('#tool-list li[data-status="tombstoned"]').first().waitFor({ timeout: 5_000 });
  check(
    'leaving recovery hands 14 capabilities back to the page',
    (await page.locator('#tool-list li[data-status="tombstoned"]').count()) === 14
  );
  await page.keyboard.press('Escape');
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

  // ---- the palette and the agent surface are ONE vocabulary (#16) --------
  // The lever the agent is asking for is a lever the human can reach by hand,
  // so ⌘K — where they reach for it — has to say the ask is open. It shows,
  // it does not decide: no approve button is reachable from in here.
  await page.keyboard.press('Control+k');
  await page.getByTestId('palette-input').waitFor({ timeout: 5_000 });
  check(
    'an open ask shows at the top of the palette',
    (await page.locator('#palette-asks').isVisible()) &&
      (await page.locator('.pa-item').count()) === 1 &&
      (await page.locator('.pa-item .pa-label').textContent()).length > 10
  );
  check(
    'the command for that same lever is marked, and the mark does not claim to BE the ask',
    (await page.locator('.palette-item[data-proposed="true"]').count()) === 1 &&
      /flag new-checkout/.test(
        await page.locator('.palette-item[data-proposed="true"] .pi-label').textContent()
      ) &&
      /agent asked/.test(
        await page.locator('.palette-item[data-proposed="true"] .pi-flag').textContent()
      )
  );
  check(
    'the palette shows the ask, it does not decide it',
    (await page.locator('#palette [data-act="approve"], #palette [data-act="reject"]').count()) === 0
  );
  // a row here is a POINTER: it closes and puts you in front of the decision
  await page.locator('.pa-item').click();
  check(
    'clicking the ask closes the palette on the decision itself',
    (await page.locator('#palette').isHidden()) &&
      (await page.evaluate(() => document.activeElement?.dataset.testid)) ===
        `approve-${flagProp.proposalSeq}`
  );

  await page.getByTestId(`approve-${flagProp.proposalSeq}`).click();
  const executedLi = page.locator('#event-stream li[data-kind="action.executed"][data-actor="agent"]').first();
  await executedLi.waitFor({ timeout: 5_000 });
  check(
    'approve executes as the agent, causedBy-threaded to the approval',
    (await executedLi.getAttribute('data-caused-by')) !== '' &&
      (await page.locator(`[data-testid="approval-${flagProp.proposalSeq}"]`).count()) === 0
  );

  check(
    'deciding it empties the palette section — no ghost ask',
    await page.evaluate(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      const hidden = document.querySelector('#palette-asks').hidden;
      const marked = document.querySelectorAll('.palette-item[data-proposed="true"]').length;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return hidden && marked === 0;
    })
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
  // the palette repeats the one consequence of the ladder a human can act on
  await page.keyboard.press('Control+k');
  await page.getByTestId('palette-input').waitFor({ timeout: 5_000 });
  check(
    'a two-key ask says so in the palette too',
    /needs your key/.test(await page.locator('.pa-item .pa-meta').textContent())
  );
  await page.keyboard.press('Escape');

  // ⌘ enter decides the ask that is waiting — but it is not a way PAST the
  // gate. On a two-key card it takes you to the key and stops, which is the
  // same answer the disabled button gives.
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(300);
  check(
    'the approve chord refuses to bypass the second key',
    (await page.locator(`[data-testid="approval-${routeProp.proposalSeq}"]`).count()) === 1 &&
      (await page.evaluate(() => document.activeElement?.className)).includes('ap-key-toggle')
  );
  check(
    'the card advertises the chords on the buttons that fire them',
    /⌘ enter/.test(await page.getByTestId(`approve-${routeProp.proposalSeq}`).textContent()) &&
      /⌘ del/.test(await page.getByTestId(`reject-${routeProp.proposalSeq}`).textContent())
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
  // ...and the same must be true of the DECK. Rows are created per entity and
  // nothing removed them, so a scenario switch left the previous world's
  // routes on the console with working buttons on them. baseline has no
  // routes at all, which makes it the sharpest probe available.
  check(
    'a scenario switch leaves no ghost controls on the deck',
    (await page.evaluate(() => {
      const w = { routes: 0, flags: 0, services: 0 };
      w.routes = document.querySelectorAll('#route-controls [data-route-id]').length;
      w.flags = document.querySelectorAll('#flag-controls [data-flag-id]').length;
      w.services = document.querySelectorAll('#service-controls [data-service-id]').length;
      return JSON.stringify(w);
    })) === JSON.stringify({ routes: 0, flags: 0, services: 3 })
  );
  // the review harness is a DEV affordance and must not reach a judge: this
  // page is the production build, so its chrome must be absent entirely
  check(
    'the review harness is not in the production build',
    (await page.evaluate(() => document.querySelector('#review-banner') !== null)) === false &&
      !(await page.content()).includes('review-banner')
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
    /irreversible migration/.test(await play.getByTestId('deploy-card-d-201').textContent())
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
    /a deploy · needs your key/.test(injText) &&
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
  // The strip is a DISCLOSURE now: the count is the glance, the chips are
  // the audit. Assert the summary carries the number, then open it the way
  // a reviewer does before checking what is inside.
  check(
    'the reads are summarised, and the detail is opt-in',
    (await strip.evaluate((d) => d.tagName)) === 'DETAILS' &&
      (await strip.evaluate((d) => d.open)) === false &&
      /Worked from \d+ reads/.test(await strip.locator('summary').textContent())
  );
  await strip.locator('summary').click();
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

  // ---- the agent's objection has to be READABLE ------------------------
  // `.wb-centre` is `overflow: hidden`, and the counsel popover always opened
  // to the RIGHT of its control. The storefront reveals itself when checkout
  // starts failing, which puts the centre at its 560px floor — exactly where
  // the counsel scene gets reviewed — and the objection was clipped to a
  // violet sliver about fifteen pixels wide. Counsel nobody can read is not
  // counsel.
  const cs = await browser.newPage();
  cs.on('pageerror', (e) => pageErrors.push(e.message));
  await cs.goto(URL + '?tick=120', { waitUntil: 'networkidle' });
  await cs.getByTestId('sim-run').click();
  await cs.waitForFunction(
    () => (document.querySelector('#sit-state')?.textContent ?? '').includes('INCIDENT'),
    null,
    { timeout: 40_000 }
  );
  await cs.evaluate(async () => {
    await window.__airlock.invoke('record_finding', {
      summary: 'The failing checkout path is the new session schema, not the build.',
      ruledOut:
        'Rolling d-201 back. api 1.9.3 reads the v1 session layout only, and 43,857 rows have already been written in v2 — the rollback takes the store down rather than healing it.',
      advisesAgainst: 'deploy.rollback:d-201',
    });
  });
  await cs.getByTestId('rollback-d-201').scrollIntoViewIfNeeded();
  await cs.getByTestId('rollback-d-201').hover();
  await cs.getByTestId('agent-counsel').waitFor({ timeout: 5_000 });
  check(
    "the agent's objection stays inside the console it is spoken in",
    await cs.evaluate(() => {
      const box = document.querySelector('.agent-counsel').getBoundingClientRect();
      const pane = document.querySelector('.wb-centre').getBoundingClientRect();
      return box.right <= pane.right + 1 && box.left >= pane.left - 1 && box.width > 60;
    })
  );
  await cs.close();

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
  // THE DOCK MUST NOT FLINCH BETWEEN STEPS. Approving step 1 empties the
  // airlock for the few ms it takes step 2's proposal to return, and keying
  // elevation off that count alone collapsed the dock 660px -> 410px and
  // 250px to the right, inside ONE frame. Sample its box every frame.
  await pl.evaluate(() => {
    window.__boxes = new Set();
    const rail = document.querySelector('#tool-rail');
    const t0 = performance.now();
    (function tick() {
      const r = rail.getBoundingClientRect();
      window.__boxes.add(`${Math.round(r.width)}x${Math.round(r.left)}:${getComputedStyle(rail).position}`);
      if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
    })();
  });
  await planCard.locator('.pl-step[data-state="live"] .ap-approve').click();
  await pl.waitForFunction(
    (id) => document.querySelector(`[data-testid="plan-step-${id}-1"]`)?.dataset.state === 'live',
    planned.planId,
    { timeout: 10_000 }
  );
  check(
    'the dock does not flinch between two steps of a plan',
    (await pl.evaluate(() => [...window.__boxes])).length === 1
  );
  // the airlock's cards carried a 520px floor from when the airlock lived in
  // the centre column; in the dock that made every card wider than its box
  check(
    'an airlock card never outgrows the dock holding it',
    await pl.evaluate(() => {
      const box = document.querySelector('#airlock-cards');
      const w = box.getBoundingClientRect().width;
      return [...box.querySelectorAll('.plan-card, .approval-card')].every(
        (c) => c.getBoundingClientRect().width <= w + 1
      );
    })
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
  // The narration under the label is present tense on a 4s timer, and a
  // decision lands sooner than that, so the settled dock read "Nothing waiting
  // on you" with "Agent is waiting on your decision" directly beneath it — in
  // the exact frame the film ends on.
  check(
    'a settled plan leaves nobody narrating a decision',
    await pl.evaluate(() => {
      const el = document.querySelector('#agent-doing');
      return !el || el.hidden || el.textContent !== 'Agent is waiting on your decision';
    })
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
  check('agent driver resolves BOTH scenarios unattended (trap + ordering)', driver.status === 0);
  if (driver.status !== 0) {
    console.error(driver.stdout?.toString() ?? '', driver.stderr?.toString() ?? '');
  }

  // ---- landing URL: a judge who opens the link cold lands IN the story ---
  // ?run=1 presses Run sim on load, ?site=1 opens the storefront on load.
  // Both compose with ?template=; neither adds copy. Retry-storm breaks
  // /checkout at tick 12, so at the default 500ms tick the shop is failing
  // within ~6s of arrival and, because the storm sustains itself, stays so
  // until someone acts. Same viewport Sid reviews in.
  const land = await browser.newPage({ viewport: { width: 1512, height: 945 } });
  land.on('pageerror', (e) => pageErrors.push(e.message));
  await land.goto(URL + '?template=retry-storm&run=1&site=1', { waitUntil: 'networkidle' });
  const landRunning = await land
    .waitForFunction(
      () => /tick \d+ · \d+ events/.test(document.querySelector('[data-testid=sim-status]').textContent),
      null,
      { timeout: 10_000 }
    )
    .then(() => true, () => false);
  const landSiteOpen =
    (await land.locator('.shell').getAttribute('data-site')) === 'on' &&
    (await land.getByTestId('storefront').isVisible());
  const landBroke = await land
    .waitForFunction(
      () =>
        document.querySelector('#storefront')?.dataset.state === 'broken' &&
        document.documentElement.dataset.health === 'degraded',
      null,
      { timeout: 20_000 }
    )
    .then(() => true, () => false);
  check(
    '?template=retry-storm&run=1&site=1 opens running with the shop open, and the shop is failing within 20s',
    landRunning &&
      (await land.getByTestId('sim-run').textContent()) === 'Pause sim' &&
      !/paused/.test(await land.getByTestId('sim-status').textContent()) &&
      landSiteOpen &&
      landBroke &&
      (await land.getByTestId('sf-banner').isVisible())
  );
  await land.close();
  // and without the params the default is untouched: seeded, paused, shop closed
  const cold = await browser.newPage({ viewport: { width: 1512, height: 945 } });
  cold.on('pageerror', (e) => pageErrors.push(e.message));
  await cold.goto(URL, { waitUntil: 'networkidle' });
  await cold.getByTestId('flag-toggle-new-checkout').waitFor({ timeout: 15_000 }); // seeded
  await cold.waitForTimeout(1500); // long enough that an unwanted pacer would have ticked
  check(
    'the bare URL still opens seeded · paused with the storefront closed (default untouched)',
    (await cold.getByTestId('sim-status').textContent()) === 'seeded · paused' &&
      (await cold.getByTestId('sim-run').textContent()) === 'Run sim' &&
      (await cold.locator('.shell').getAttribute('data-site')) === 'off' &&
      !(await cold.getByTestId('storefront').isVisible())
  );
  await cold.close();
  // ---- the walkthrough: the film scene, playable from the PRODUCTION page --
  // A judge with no WebMCP host attached must still be able to see the agent
  // half. The dock's empty state says how to attach one and what to ask, and
  // offers a scripted caller on the same execute path a host uses — with a
  // standing disclosure in the heading while its work is on the ledger.
  const walk = await browser.newPage({ viewport: { width: 1512, height: 945 } });
  const walkErrors = [];
  walk.on('pageerror', (e) => walkErrors.push(e.message));
  await walk.goto(URL, { waitUntil: 'networkidle' });
  check(
    'the empty dock says how to attach an agent, what to ask, and offers the walkthrough',
    (await walk.getByTestId('findings-empty').isVisible()) &&
      (await walk.getByTestId('walk-start').isVisible()) &&
      (await walk.locator('#findings-empty .te-q').count()) === 3 &&
      (await walk.locator('#findings-empty .te-copy').count()) === 3 &&
      (await walk.getByTestId('walk-line').isHidden())
  );
  await walk.getByTestId('walk-start').click();
  await walk.locator('[data-testid="walk-line"][data-state="running"]').waitFor({ timeout: 10_000 });
  check(
    'while it runs, the dock heading discloses a scripted caller, and offers a stop',
    /scripted caller, not a model/.test(await walk.getByTestId('walk-line').innerText()) &&
      (await walk.getByTestId('walk-stop').innerText()) === 'Stop'
  );
  await walk.locator('[data-testid="walk-line"][data-state="ready"]').waitFor({ timeout: 90_000 });
  check(
    'the walkthrough reaches the refusal and the plan through the real tool path, then hands over',
    (await walk.locator('#event-stream li[data-kind="action.blocked"][data-actor="agent"]').count()) >= 1 &&
      (await walk.locator('#agent-timeline .tl-ev[data-kind="call"]').count()) >= 5 &&
      (await walk.locator('.pl-step[data-state="live"] .ap-approve').count()) === 1 &&
      /paused|tick/.test(await walk.getByTestId('sim-status').innerText())
  );
  check(
    'the production walkthrough carries none of the dev harness',
    (await walk.evaluate(() => document.querySelector('#review-banner') === null)) &&
      !(await walk.content()).includes('review-banner')
  );
  await walk.getByTestId('walk-stop').click();
  await walk.waitForTimeout(1200);
  check(
    'stopping the walkthrough returns the console to its empty state',
    (await walk.getByTestId('findings-empty').isVisible()) &&
      (await walk.getByTestId('walk-line').isHidden()) &&
      (await walk.locator('#agent-timeline .tl-ev:not([data-kind="live"])').count()) === 0 &&
      (await walk.locator('.approval-card').count()) === 0
  );
  check('no page errors during the walkthrough', walkErrors.length === 0);
  if (walkErrors.length) console.error('[smoke] walkthrough page errors:', walkErrors);
  await walk.close();

  // ---- the full response: the seven-step plan, playable from the product --
  // "I would like the walkthrough to have a larger sequence of actions like
  // updating the status page for customers as well." The dock's second
  // control plays the seven-step plan — ownership, severity, freeze, the
  // status post, the cap, the lift, the ship — with the shop open, because
  // step 4 lands there. The film arc stays on the first control, untouched.
  const full = await browser.newPage({ viewport: { width: 1512, height: 945 } });
  const fullErrors = [];
  full.on('pageerror', (e) => fullErrors.push(e.message));
  await full.goto(URL, { waitUntil: 'networkidle' });
  await full.getByTestId('flag-toggle-new-checkout').waitFor({ timeout: 15_000 });
  check(
    'the empty dock offers the full response beside the walkthrough, shop closed until asked',
    (await full.getByTestId('walk-start').innerText()) === 'Watch a walkthrough' &&
      (await full.getByTestId('walk-full').innerText()) === 'Watch the full response' &&
      (await full.locator('.shell').getAttribute('data-site')) === 'off'
  );
  await full.getByTestId('walk-full').click();
  await full.locator('[data-testid="walk-line"][data-state="running"]').waitFor({ timeout: 10_000 });
  await full.locator('[data-testid="walk-line"][data-state="ready"]').waitFor({ timeout: 90_000 });
  await full.waitForTimeout(300);
  check(
    'the full response reaches a seven-step plan with step 1 decidable, the shop open, no refusal',
    (await full.locator('.plan-card .pl-step').count()) === 7 &&
      (await full.locator('.pl-step[data-state="live"] .ap-approve').count()) === 1 &&
      (await full.locator('.shell').getAttribute('data-site')) === 'on' &&
      (await full.getByTestId('storefront').isVisible()) &&
      (await full.locator('#event-stream li[data-kind="action.blocked"][data-actor="agent"]').count()) === 0 &&
      /scripted caller, not a model/.test(await full.getByTestId('walk-line').innerText()) &&
      (await full.getByTestId('sf-status').isHidden())
  );
  const fullPlan = full.locator('.plan-card').first();
  const fullPlanId = ((await fullPlan.getAttribute('data-testid')) ?? '').replace(/^plan-/, '');
  let fullNoticeAt4 = false;
  for (let i = 0; i < 7; i++) {
    const approve = full.locator('.pl-step[data-state="live"] .ap-approve');
    await approve.waitFor({ timeout: 15_000 });
    if (await approve.isDisabled()) {
      await full.locator('.pl-step[data-state="live"] .ap-key').first().click();
      await full.waitForTimeout(200);
    }
    await approve.click();
    await full.waitForFunction(
      (n) => document.querySelectorAll('.plan-card .pl-step[data-state="done"]').length >= n,
      i + 1,
      { timeout: 15_000 }
    );
    await full.waitForTimeout(300);
    if (i === 3) {
      const st = full.getByTestId('sf-status');
      fullNoticeAt4 =
        (await st.isVisible()) &&
        /Checkout is failing for some customers/.test(await st.innerText()) &&
        (await st.getAttribute('data-state')) === 'identified';
    }
  }
  check('approving step 4 quotes the status post on the shop, as a known issue', fullNoticeAt4);
  await full.waitForFunction(
    (id) => document.querySelector(`[data-testid="plan-${id}"]`)?.dataset.state === 'complete',
    fullPlanId,
    { timeout: 15_000 }
  );
  check(
    'all seven steps done and the receipt stays on screen',
    (await fullPlan.locator('.pl-step[data-state="done"]').count()) === 7 && (await fullPlan.isVisible())
  );
  // the airlock is empty, so the sim moves again and the ship heals checkout
  await full
    .waitForFunction(
      () => document.querySelector('[data-testid="sf-status"]')?.dataset.state === 'stale',
      null,
      { timeout: 90_000 }
    )
    .catch(() => {});
  await full.waitForTimeout(600);
  check(
    'after step 7 checkout is back on the shop and the status strip stands down to a last update',
    !(await full.getByTestId('sf-banner').isVisible()) &&
      (await full.getByTestId('sf-status').getAttribute('data-state')) === 'stale' &&
      /^Checkout/.test(await full.getByTestId('sf-buy').innerText()) &&
      (await full.getByTestId('walk-stop').innerText()) === 'Reset'
  );
  await full.getByTestId('walk-stop').click();
  await full.waitForTimeout(1200);
  check(
    'reset after the full response returns the console to its empty state',
    (await full.getByTestId('findings-empty').isVisible()) &&
      (await full.getByTestId('walk-line').isHidden()) &&
      (await full.locator('.plan-card').count()) === 0
  );
  check('no page errors during the full response', fullErrors.length === 0);
  if (fullErrors.length) console.error('[smoke] full response page errors:', fullErrors);
  await full.close();

  // ---- ?walk=<film|plan|provenance>: a walkthrough as a boot param --------
  // Applied after the other boot params; the scene's own scenario wins over
  // ?template=; an unknown value does nothing.
  const wp = await browser.newPage({ viewport: { width: 1512, height: 945 } });
  wp.on('pageerror', (e) => pageErrors.push(e.message));
  await wp.goto(URL + '?walk=provenance', { waitUntil: 'networkidle' });
  await wp.locator('[data-testid="walk-line"][data-state="ready"]').waitFor({ timeout: 90_000 });
  await wp.waitForTimeout(300);
  const wpCard = wp.locator('[data-testid^="approval-"]').first();
  const wpText = ((await wpCard.textContent()) ?? '').replace(/\s+/g, ' ');
  check(
    '?walk=provenance reaches the two-key card with the customer line quoted and approve disarmed',
    /came from untrusted content/.test(wpText) &&
      /customer-supplied text/.test(wpText) &&
      (await wpCard.locator('.ap-key').count()) === 1 &&
      (await wpCard.locator('.ap-approve').isDisabled())
  );
  await wp.close();
  const wf = await browser.newPage({ viewport: { width: 1512, height: 945 } });
  wf.on('pageerror', (e) => pageErrors.push(e.message));
  await wf.goto(URL + '?template=baseline&walk=film', { waitUntil: 'networkidle' });
  await wf.locator('[data-testid="walk-line"][data-state="ready"]').waitFor({ timeout: 90_000 });
  await wf.waitForTimeout(300);
  check(
    '?walk=film still plays the refusal-and-unlock arc, and its scenario wins over ?template=',
    (await wf.locator('#event-stream li[data-kind="action.blocked"][data-actor="agent"]').count()) >= 1 &&
      (await wf.locator('.plan-card .pl-step').count()) === 2 &&
      (await wf.locator('.pl-step[data-state="live"] .ap-approve').count()) === 1
  );
  await wf.close();
  const wu = await browser.newPage({ viewport: { width: 1512, height: 945 } });
  wu.on('pageerror', (e) => pageErrors.push(e.message));
  await wu.goto(URL + '?walk=bogus', { waitUntil: 'networkidle' });
  await wu.getByTestId('flag-toggle-new-checkout').waitFor({ timeout: 15_000 });
  await wu.waitForTimeout(800);
  check(
    'an unknown ?walk= value does nothing',
    (await wu.getByTestId('walk-line').isHidden()) &&
      (await wu.getByTestId('sim-status').innerText()) === 'seeded · paused'
  );
  await wu.close();

  // ---- ?mode=<stage>: the response stage as a boot param -----------------
  // Chrome's webmcp-evals CLI drives a URL, and 9 of the 11 recovery cases are
  // tools that do not exist in triage — so the recovery set could not be run
  // against the deployed page at all. `?mode=recovery` moves the stage through
  // the same switchMode() the operator's click calls.
  const rec = await browser.newPage({ viewport: { width: 1512, height: 945 } });
  rec.on('pageerror', (e) => pageErrors.push(e.message));
  await rec.goto(URL + '?template=retry-storm&mode=recovery', { waitUntil: 'networkidle' });
  await rec.getByTestId('mode-recovery').waitFor({ timeout: 15_000 });
  await rec.waitForTimeout(600);
  check(
    '?template=retry-storm&mode=recovery boots on the Recovery stage with 27 tools in the dock footer',
    (await rec.getByTestId('mode-recovery').getAttribute('aria-pressed')) === 'true' &&
      (await rec.locator('#wbs-mode').textContent()) === 'recovery' &&
      (await rec.locator('#tool-count').textContent()) === '27' &&
      (await rec.evaluate(() => window.__airlock.mode())) === 'recovery' &&
      (await rec.locator('#event-stream li[data-kind="mode.changed"]').count()) === 1
  );
  await rec.close();
  // ---- a standalone proposal is a row on the ledger, not a card ---------
  // One propose_* call with no plan behind it is the move a live agent makes
  // most, and it was the last bordered card in the dock (its own left rule,
  // mounted in the live tail). It files as a step row now: on the spine, the
  // ask in the row's own expansion, and its observation directly beneath it
  // once the write lands. Same viewport Sid reviews in.
  const sa = await browser.newPage({ viewport: { width: 1512, height: 945 } });
  sa.on('pageerror', (e) => pageErrors.push(e.message));
  await sa.goto(URL, { waitUntil: 'networkidle' });
  await sa.getByTestId('flag-toggle-new-checkout').waitFor({ timeout: 15_000 });
  await sa.getByTestId('mode-recovery').click();
  // whichever way the flag sits, ask for the other — a no-op write has no
  // observation to land
  const saFlag = (await sa.locator('[data-flag-id="new-checkout"]').getAttribute('data-flag-state')) === 'on' ? 'off' : 'on';
  const saProp = JSON.parse(
    await sa.evaluate(
      (state) => window.__airlock.invoke('propose_flag_change', { id: 'new-checkout', state }),
      saFlag
    )
  );
  await sa.getByTestId(`approval-${saProp.proposalSeq}`).waitFor({ timeout: 5_000 });
  check(
    "a standalone proposal is a row on the ledger's spine, not a card",
    (await sa
      .locator(`#agent-timeline > [data-testid="ask-${saProp.proposalSeq}"][data-kind="step"][data-state="live"]`)
      .count()) === 1 &&
      (await sa
        .locator(`[data-testid="ask-${saProp.proposalSeq}"] [data-testid="approval-${saProp.proposalSeq}"]`)
        .count()) === 1 &&
      (await sa.locator('#agent-timeline .approval-card').count()) === 0 &&
      (await sa.locator('#airlock-cards > *').count()) === 0
  );
  check(
    'it wears the step marker at the same x as every other beat, and says what it touches on the right',
    await sa.evaluate((seq) => {
      const row = document.querySelector(`[data-testid="ask-${seq}"]`);
      const mark = row.querySelector(':scope > .tl-head > .tl-n.tl-n-ask');
      const head = row.querySelector(':scope > .tl-head');
      const connect = document.querySelector('#agent-timeline > .tl-ev[data-kind="connect"] > .tl-head');
      return (
        !!mark &&
        Math.round(head.getBoundingClientRect().left) === Math.round(connect.getBoundingClientRect().left) &&
        /a feature flag/.test(row.querySelector(':scope > .tl-head > .pl-touch').textContent) &&
        row.querySelectorAll('.pl-cost').length === 1
      );
    }, saProp.proposalSeq)
  );
  await sa.getByTestId(`approve-${saProp.proposalSeq}`).click();
  const saLanded = await sa
    .waitForFunction(
      (seq) => {
        const row = document.querySelector(`[data-testid="ask-${seq}"]`);
        return row?.dataset.state === 'done' && row.nextElementSibling?.dataset.kind === 'state';
      },
      saProp.proposalSeq,
      { timeout: 10_000 }
    )
    .then(() => true, () => false);
  check(
    'its observation lands directly beneath it after approval, and the row stays as the receipt',
    saLanded &&
      (await sa.evaluate((seq) => {
        const row = document.querySelector(`[data-testid="ask-${seq}"]`);
        const obs = row.nextElementSibling;
        return (
          row.dataset.fold === 'true' &&
          !row.querySelector(`[data-testid="approval-${seq}"]`) &&
          obs.dataset.obsFor === `ask-${seq}` &&
          /new-checkout/.test(obs.textContent)
        );
      }, saProp.proposalSeq))
  );
  // the key rung rides the row's own machine-value slot, and a refusal is
  // an observation beneath the row, exactly as a rejected plan step gets
  const saKey = JSON.parse(
    await sa.evaluate(() =>
      window.__airlock.invoke('propose_route_change', { id: 'checkout', target: 'web' })
    )
  );
  await sa.getByTestId(`approval-${saKey.proposalSeq}`).waitFor({ timeout: 5_000 });
  check(
    'a two-key ask says "needs your key" on its row and arrives disarmed',
    /needs your key/.test(
      await sa.locator(`[data-testid="ask-${saKey.proposalSeq}"] > .tl-head > .pl-touch`).textContent()
    ) && (await sa.getByTestId(`approve-${saKey.proposalSeq}`).isDisabled())
  );
  await sa.getByTestId(`reject-${saKey.proposalSeq}`).click();
  const saRefused = await sa
    .waitForFunction(
      (seq) => document.querySelector(`[data-testid="ask-${seq}"]`)?.dataset.state === 'skipped',
      saKey.proposalSeq,
      { timeout: 10_000 }
    )
    .then(() => true, () => false);
  check(
    'rejecting it files the refusal directly beneath its row',
    saRefused &&
      (await sa.evaluate((seq) => {
        const row = document.querySelector(`[data-testid="ask-${seq}"]`);
        const next = row.nextElementSibling;
        return (
          !row.querySelector(`[data-testid="approval-${seq}"]`) &&
          next?.dataset.kind === 'state' &&
          next.dataset.refused === 'true' &&
          document.querySelectorAll('#agent-timeline .approval-card').length === 0
        );
      }, saKey.proposalSeq))
  );
  await sa.close();

  // ---- a write that changed nothing says why, on the ledger -------------
  // The paid run (2026-09-02, ChatGPT in-app browser): a roll-forward into a
  // fleet at its autoscaler ceiling was approved, the ledger said "nothing
  // in the world moved", and the agent spent four more writes finding out
  // why. The observation row now carries the write's own outcome.
  const ne = await browser.newPage({ viewport: { width: 1512, height: 945 } });
  ne.on('pageerror', (e) => pageErrors.push(e.message));
  await ne.goto(URL + '?template=retry-storm&tick=120&run=1&mode=recovery', { waitUntil: 'networkidle' });
  await ne.getByTestId('mode-recovery').waitFor({ timeout: 15_000 });
  // the storm has to be open: the fleet is at its ceiling from the start,
  // but 2.4.2 is only staged once the incident is
  for (let i = 0; i < 80; i++) {
    const st = JSON.parse(await ne.evaluate(() => window.__airlock.invoke('airlock_status')));
    if (st.incidentOpen === true) break;
    await ne.waitForTimeout(500);
  }
  await ne.waitForTimeout(300);
  // the first roll-forward is halted (a partial outcome); the SECOND is the
  // no-op the paid run hit with no line to read
  const neFirst = JSON.parse(await ne.evaluate(() => window.__airlock.invoke('propose_rollforward', { service: 'api' })));
  await ne.getByTestId(`approve-${neFirst.proposalSeq}`).waitFor({ timeout: 5_000 });
  await ne.getByTestId(`approve-${neFirst.proposalSeq}`).click();
  await ne
    .waitForFunction(
      (seq) => document.querySelector(`[data-testid="ask-${seq}"]`)?.nextElementSibling?.dataset.kind === 'state',
      neFirst.proposalSeq,
      { timeout: 10_000 }
    )
    .catch(() => {});
  check(
    'a roll-forward into a fleet with no headroom lands as Halted with the ceiling as its reason',
    await ne.evaluate((seq) => {
      const obs = document.querySelector(`[data-testid="ask-${seq}"]`)?.nextElementSibling;
      return (
        obs?.dataset.kind === 'state' &&
        obs.dataset.effect === 'partial' &&
        /^Halted\s*·\s*roll-forward to 2\.4\.2 halted after 2 of 6 instances: api is at its autoscaler ceiling/.test(
          obs.querySelector('.tl-title').textContent.replace(/\s+/g, ' ').trim()
        )
      );
    }, neFirst.proposalSeq)
  );
  const neAgain = JSON.parse(await ne.evaluate(() => window.__airlock.invoke('propose_rollforward', { service: 'api' })));
  await ne.getByTestId(`approve-${neAgain.proposalSeq}`).waitFor({ timeout: 5_000 });
  await ne.getByTestId(`approve-${neAgain.proposalSeq}`).click();
  await ne
    .waitForFunction(
      (seq) => document.querySelector(`[data-testid="ask-${seq}"]`)?.nextElementSibling?.dataset.kind === 'state',
      neAgain.proposalSeq,
      { timeout: 10_000 }
    )
    .catch(() => {});
  check(
    'a write that changed nothing reads "No effect · <reason>" beneath its row, and airlock_status carries the same outcome',
    (await ne.evaluate((seq) => {
      const obs = document.querySelector(`[data-testid="ask-${seq}"]`)?.nextElementSibling;
      const text = obs?.querySelector('.tl-title')?.textContent.replace(/\s+/g, ' ').trim() ?? '';
      return (
        obs?.dataset.kind === 'state' &&
        obs.dataset.effect === 'none' &&
        /^No effect\s*·\s*roll-forward to 2\.4\.2 cannot start: the earlier rollout was halted mid-way/.test(text) &&
        !/nothing in the world moved/.test(text)
      );
    }, neAgain.proposalSeq)) &&
      (await (async () => {
        const st = JSON.parse(await ne.evaluate(() => window.__airlock.invoke('airlock_status')));
        const top = st.recentOutcomes?.[0];
        return (
          top?.tool === 'deploy.rollforward' &&
          top.effect === 'none' &&
          /cannot start/.test(top.reason) &&
          st.services.find((s) => s.id === 'api')?.capacity?.headroom === 0
        );
      })())
  );
  await ne.close();

  // ---- the click caution on a deploy row is a row of that grid ----------
  // Inserted beside Roll back inside the deploy's `auto` action cell, the
  // caution stretched the button to its own height (240px) and squeezed the
  // deploy title to one word per line. The button keeps its height.
  const cc = await browser.newPage({ viewport: { width: 1512, height: 945 } });
  cc.on('pageerror', (e) => pageErrors.push(e.message));
  // d-201 ships during the incident, so run until it is on the board, then
  // hold the world still the way the counsel scene does
  await cc.goto(URL + '?run=1', { waitUntil: 'networkidle' });
  await cc.locator('[data-testid="rollback-d-201"]:enabled').waitFor({ timeout: 40_000 });
  await cc.getByTestId('sim-run').click();
  await cc.evaluate(() =>
    window.__airlock.invoke('record_finding', {
      summary: 'd-201 shipped an irreversible migration.',
      ruledOut:
        'Rolling d-201 back. api 1.9.3 reads the v1 session layout only, and 43,857 rows have already been written in v2 — the rollback takes the store down rather than healing it.',
      advisesAgainst: 'deploy.rollback:d-201',
    })
  );
  await cc.getByTestId('rollback-d-201').scrollIntoViewIfNeeded();
  const ccBefore = await cc
    .getByTestId('rollback-d-201')
    .evaluate((n) => n.getBoundingClientRect().height);
  await cc.getByTestId('rollback-d-201').click();
  await cc.getByTestId('agent-caution').waitFor({ timeout: 5_000 });
  check(
    'the caution under a deploy row does not stretch Roll back to its own height',
    await cc.evaluate((h0) => {
      const btn = document.querySelector('[data-testid="rollback-d-201"]');
      const box = document.querySelector('.agent-caution');
      const card = btn.closest('.deploy-card');
      return (
        Math.abs(btn.getBoundingClientRect().height - h0) < 2 &&
        box.parentElement === card &&
        box.getBoundingClientRect().width > card.getBoundingClientRect().width * 0.8
      );
    }, ccBefore)
  );
  await cc.close();

  // ---- the service strip is live: health words at rest, numbers under load
  // Each node in the Response controls head carries its health word from the
  // world and, once traffic has reported on the routes ending there, load and
  // error rate. Nothing is invented: at boot there are no ticks, so there are
  // no numbers; db has no routes, so it never gets any.
  const st = await browser.newPage({ viewport: { width: 1512, height: 945 } });
  st.on('pageerror', (e) => pageErrors.push(e.message));
  await st.goto(URL + '?template=retry-storm', { waitUntil: 'networkidle' });
  await st.locator('#topology .topo-node').nth(2).waitFor({ timeout: 15_000 });
  check(
    'service strip at boot: three services, a health word each, no numbers beyond the version',
    await st.evaluate(() => {
      const nodes = [...document.querySelectorAll('#topology .topo-node')];
      return (
        nodes.length === 3 &&
        nodes.every((n) => {
          const word = n.querySelector('.topo-health').textContent;
          return (
            ['ok', 'degraded', 'down'].includes(word) &&
            n.querySelector('.topo-live').textContent.trim() === word &&
            /^\d+(\.\d+)*$/.test(n.querySelector('.topo-ver').textContent)
          );
        })
      );
    })
  );
  await st.goto(URL + '?template=retry-storm&run=1', { waitUntil: 'networkidle' });
  // health flips a tick before the storm's traffic reports, and the dot takes
  // its 900ms settle to reach the hue — wait for the strip to have caught up
  // (route named, dot settled), not for the attribute alone
  await st.waitForFunction(
    () => {
      const api = document.querySelector('#topology [data-service="api"]');
      return (
        api?.dataset.health === 'degraded' &&
        api.querySelector('.topo-route').textContent !== '' &&
        getComputedStyle(api.querySelector('.topo-dot')).backgroundColor ===
          getComputedStyle(api.querySelector('.topo-err')).color
      );
    },
    { timeout: 40_000 }
  );
  check(
    'service strip under the incident: api reads degraded, its error rate takes the health hue, /checkout is named, one line',
    await st.evaluate(() => {
      const api = document.querySelector('#topology [data-service="api"]');
      const err = api.querySelector('.topo-err');
      const ok = document.querySelector('#topology [data-service="db"]');
      const topo = document.querySelector('#topology');
      const tops = new Set(
        [...topo.querySelectorAll('.topo-node')].map((n) => Math.round(n.getBoundingClientRect().top))
      );
      return (
        api.querySelector('.topo-health').textContent === 'degraded' &&
        /^· \d+\.\d\d%$/.test(err.textContent) &&
        // the same hue the node's own dot turned, not the ghost ink a nominal value keeps
        getComputedStyle(err).color === getComputedStyle(api.querySelector('.topo-dot')).backgroundColor &&
        getComputedStyle(err).color !== getComputedStyle(ok.querySelector('.topo-health')).color &&
        api.querySelector('.topo-route').textContent === '· /checkout' &&
        ok.querySelector('.topo-live').textContent.trim() === ok.querySelector('.topo-health').textContent &&
        tops.size === 1 &&
        topo.scrollWidth <= topo.clientWidth + 1
      );
    })
  );
  await st.close();

  // ---- with a host attached, approval is a HELD gesture -----------------
  // ChatGPT's in-app browser proposed a change through propose_* and then
  // clicked the page's own Approve button; the receipt said "approved by
  // you". While a host is attached, Approve is press-and-hold (700ms), the
  // chord is held the same way, and the second key is engaged by a hold.
  // `?host=1` is the dev-build switch; this is the production bundle, so
  // the host is installed the way a browser installs it — a modelContext on
  // the document — which is the flag the page actually reads.
  const hh = await browser.newPage({ viewport: { width: 1512, height: 945 } });
  hh.on('pageerror', (e) => pageErrors.push(e.message));
  await hh.addInitScript(() => {
    document.modelContext = { registerTool() {}, unregisterTool() {} };
  });
  await hh.goto(URL, { waitUntil: 'networkidle' });
  await hh.getByTestId('flag-toggle-new-checkout').waitFor({ timeout: 15_000 });
  await hh.getByTestId('mode-recovery').click();
  await hh.waitForTimeout(300);
  const hhPropose = async () => {
    const state = (await hh.locator('[data-flag-id="new-checkout"]').getAttribute('data-flag-state')) === 'on' ? 'off' : 'on';
    const r = JSON.parse(
      await hh.evaluate((st) => window.__airlock.invoke('propose_flag_change', { id: 'new-checkout', state: st }), state)
    );
    await hh.getByTestId(`approval-${r.proposalSeq}`).waitFor({ timeout: 5_000 });
    return r.proposalSeq;
  };
  const hhPending = (seq) => hh.locator(`[data-testid="approval-${seq}"]`).count();
  const hhLanded = (seq) =>
    hh.waitForFunction((sq) => document.querySelector(`[data-testid="ask-${sq}"]`)?.dataset.state === 'done', seq, { timeout: 10_000 })
      .then(() => true, () => false);
  const hhVia = (seq) =>
    hh.evaluate((sq) => {
      const row = [...document.querySelectorAll('#event-stream li[data-kind="action.approved"]')]
        .find((r) => r.textContent.includes(`#${sq} `));
      return row ? row.querySelector('.ev-summary').textContent : null;
    }, seq);
  const hhHold = async (loc, ms) => {
    const box = await loc.boundingBox();
    await hh.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await hh.mouse.down();
    await hh.waitForTimeout(ms);
    await hh.mouse.up();
  };
  const hh1 = await hhPropose();
  check(
    'with a host attached the status bar says so, the button reads Hold to approve, and the dock line says approvals are held',
    /host attached/.test(await hh.locator('#wbs-webmcp').textContent()) &&
      (await hh.getByTestId(`approve-${hh1}`).locator('.ap-label').textContent()) === 'Hold to approve' &&
      (await hh.getByTestId('held-note').textContent()) === 'Approvals are a held gesture while an agent is attached.' &&
      /don't click anything in the console — I decide\.$/.test(await hh.locator('#findings-empty .te-q').nth(2).textContent())
  );
  await hh.getByTestId(`approve-${hh1}`).click();
  await hh.evaluate((sq) => document.querySelector(`[data-testid="approve-${sq}"]`).click(), hh1);
  await hh.waitForTimeout(500);
  check(
    'a plain click on Approve — pointer or element.click() — does not approve while a host is attached',
    (await hhPending(hh1)) === 1 &&
      (await hh.locator(`[data-testid="ask-${hh1}"]`).getAttribute('data-state')) === 'live'
  );
  await hhHold(hh.getByTestId(`approve-${hh1}`), 350);
  await hh.waitForTimeout(500);
  check('a hold released at 350ms does not approve', (await hhPending(hh1)) === 1);
  await hhHold(hh.getByTestId(`approve-${hh1}`), 850);
  const hh1Landed = await hhLanded(hh1);
  await hh.waitForTimeout(600);
  check(
    'a 700ms hold approves, and the log records the gesture as hold',
    hh1Landed && /· hold$/.test((await hhVia(hh1)) ?? '')
  );
  const hh2 = await hhPropose();
  await hh.keyboard.down('Meta');
  await hh.keyboard.down('Enter');
  await hh.waitForTimeout(250);
  const hh2Holding = (await hh.getByTestId(`approve-${hh2}`).getAttribute('data-holding')) === '1';
  await hh.keyboard.up('Enter');
  await hh.keyboard.up('Meta');
  await hh.waitForTimeout(600);
  const hh2StillPending = (await hhPending(hh2)) === 1;
  await hh.keyboard.down('Meta');
  await hh.keyboard.down('Enter');
  await hh.waitForTimeout(850);
  await hh.keyboard.up('Enter');
  await hh.keyboard.up('Meta');
  const hh2Landed = await hhLanded(hh2);
  await hh.waitForTimeout(600);
  check(
    '⌘ enter tapped does not approve while a host is attached; held for 700ms it does, recorded as key-hold',
    hh2Holding && hh2StillPending && hh2Landed && /· key-hold$/.test((await hhVia(hh2)) ?? '')
  );
  const hh3 = JSON.parse(
    await hh.evaluate(() => window.__airlock.invoke('propose_route_change', { id: 'checkout', target: 'web' }))
  ).proposalSeq;
  await hh.getByTestId(`approval-${hh3}`).waitFor({ timeout: 5_000 });
  await hh.getByTestId(`key-${hh3}`).click();
  await hh.waitForTimeout(300);
  const hh3ClickRefused =
    !(await hh.getByTestId(`key-${hh3}`).isChecked()) && (await hh.getByTestId(`approve-${hh3}`).isDisabled());
  await hhHold(hh.locator(`[data-testid="approval-${hh3}"] .ap-key`), 850);
  await hh.waitForTimeout(300);
  const hh3Engaged =
    (await hh.getByTestId(`key-${hh3}`).isChecked()) && !(await hh.getByTestId(`approve-${hh3}`).isDisabled());
  await hhHold(hh.getByTestId(`approve-${hh3}`), 850);
  const hh3Landed = await hhLanded(hh3);
  await hh.waitForTimeout(600);
  check(
    'the second key: a click does not engage it, a hold does, and the write lands under key: operator · hold',
    hh3ClickRefused && hh3Engaged && hh3Landed && /key: operator · hold$/.test((await hhVia(hh3)) ?? '')
  );
  await hh.close();

  check('no page errors', pageErrors.length === 0);
  if (pageErrors.length) console.error('[smoke] page errors:', pageErrors);
} finally {
  await browser.close();
  killPreview();
}

console.log(failures === 0 ? '[smoke] GREEN' : `[smoke] RED (${failures} failure(s))`);
process.exit(failures === 0 ? 0 : 1);
