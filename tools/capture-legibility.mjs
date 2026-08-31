// Capture the agent-legibility beats MID-ANIMATION. A screenshot taken after
// the fact shows nothing — these states only exist for ~1.4s, which is the
// whole point of them.
// Usage: node tools/capture-legibility.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'log/legibility';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.goto('http://localhost:8917/?tick=120', { waitUntil: 'networkidle' });
await page.getByTestId('deploy-card-d-200').waitFor({ timeout: 15000 });
await page.getByTestId('sim-run').click();
await page.waitForFunction(
  () => document.querySelector('#sit-state')?.textContent?.includes('INCIDENT'),
  { timeout: 30000 }
);

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  captured ${name}`);
};

// --- a read: narration + the region it read FROM lighting up -------------
for (const [tool, label] of [
  ['airlock_status', 'status'],
  ['list_deploys', 'deploys'],
  ['read_logs', 'logs'],
  ['traffic_history', 'traffic'],
]) {
  await page.evaluate((t) => window.__airlock.invoke(t, {}), tool);
  await page.waitForTimeout(180); // inside the 1400ms touch window
  await shot(`read-${label}`);
}

// --- the mode flip: tools materializing ----------------------------------
await page.getByTestId('mode-recovery').click();
await page.waitForTimeout(120); // mid-stagger
await shot('materializing');
await page.waitForTimeout(600);
await shot('materialized');

// --- a proposal arriving --------------------------------------------------
const prop = await page.evaluate(async () => {
  const r = await window.__airlock.invoke('propose_rollback', { deployId: 'd-201' });
  return JSON.parse(r);
});
if (prop?.proposalSeq !== undefined) {
  await page.waitForTimeout(140);
  await shot('proposal-arriving');
}

// --- leaving recovery: tools receding ------------------------------------
await page.getByTestId('mode-triage').click();
await page.waitForTimeout(150);
await shot('tools-leaving');

// --- reduced motion must still be legible ---------------------------------
const rm = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  reducedMotion: 'reduce',
});
await rm.goto('http://localhost:8917/?tick=120', { waitUntil: 'networkidle' });
await rm.getByTestId('deploy-card-d-200').waitFor({ timeout: 15000 });
await rm.getByTestId('sim-run').click();
await rm.waitForFunction(
  () => document.querySelector('#sit-state')?.textContent?.includes('INCIDENT'),
  { timeout: 30000 }
);
await rm.evaluate(() => window.__airlock.invoke('list_deploys', {}));
await rm.waitForTimeout(180);
await rm.screenshot({ path: `${OUT}/reduced-motion.png` });
console.log('  captured reduced-motion');

console.log(errors.length ? `  !! ${errors.length} error(s): ${errors.slice(0, 3).join(' | ')}` : '  no console errors');
await browser.close();
console.log(`captured to ${OUT}/`);
