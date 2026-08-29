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
  check('tool rail lists the read surface (5 tools)', rail === 5);
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

  check('no page errors', pageErrors.length === 0);
  if (pageErrors.length) console.error('[smoke] page errors:', pageErrors);
} finally {
  await browser.close();
  killPreview();
}

console.log(failures === 0 ? '[smoke] GREEN' : `[smoke] RED (${failures} failure(s))`);
process.exit(failures === 0 ? 0 : 1);
