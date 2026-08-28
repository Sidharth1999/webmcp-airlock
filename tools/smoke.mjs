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
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(URL, { waitUntil: 'networkidle' });

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

  check('no page errors', pageErrors.length === 0);
  if (pageErrors.length) console.error('[smoke] page errors:', pageErrors);
} finally {
  await browser.close();
  killPreview();
}

console.log(failures === 0 ? '[smoke] GREEN' : `[smoke] RED (${failures} failure(s))`);
process.exit(failures === 0 ? 0 : 1);
