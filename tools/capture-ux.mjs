// UX capture sweep — every state that must look right, in one run.
// Re-run this after EVERY visual change; bugs here are caught by looking.
// Usage: node tools/capture-ux.mjs [outDir]   (dev server 8917 must be up)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'log/ux';
mkdirSync(OUT, { recursive: true });

// SID'S DISPLAY IS ~2330px WIDE. Capturing only 1440 hid every wide-layout
// defect he reported — `1fr` columns absorbing all the slack, content
// stranded at opposite edges, the glance band wasting its left half.
// Never judge this layout without looking at `ultra`.
const VIEWPORTS = {
  ultra: { width: 2400, height: 1350 },
  wide: { width: 1920, height: 1080 },
  desk: { width: 1440, height: 900 },
  narrow: { width: 1120, height: 820 },
};

const shot = async (page, name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  captured ${name}`);
};

const browser = await chromium.launch();

for (const [vp, viewport] of Object.entries(VIEWPORTS)) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  console.log(`\n[${vp}] ${viewport.width}x${viewport.height}`);
  await page.goto('http://localhost:8917/?tick=120', { waitUntil: 'networkidle' });
  await page.getByTestId('deploy-card-d-200').waitFor({ timeout: 15000 });

  // 1. the very first thing a stranger sees
  await shot(page, `${vp}-01-standby`);

  // 2. incident running
  await page.getByTestId('sim-run').click();
  await page.waitForFunction(
    () => document.querySelector('#sit-state')?.textContent?.includes('INCIDENT'),
    { timeout: 30000 }
  );
  await shot(page, `${vp}-02-incident`);

  // 3. the store revealing its own failure
  await page.waitForTimeout(1200);
  await shot(page, `${vp}-03-incident-store`);

  // 4. agent capability surface after the mode flip (THE shot)
  await page.getByTestId('mode-recovery').click();
  await page.waitForTimeout(500);
  await shot(page, `${vp}-04-recovery`);

  // 5. a pending proposal awaiting the human
  const proposal = await page.evaluate(async () => {
    const r = await window.__airlock.invoke('propose_rollback', { deployId: 'd-201' });
    return JSON.parse(r);
  });
  if (proposal?.proposalSeq !== undefined) {
    await page.getByTestId(`approval-${proposal.proposalSeq}`).waitFor({ timeout: 10000 });
    await shot(page, `${vp}-05-approval-pending`);
  }

  // 6. back to triage: what the agent can no longer reach
  await page.getByTestId('mode-triage').click();
  await page.waitForTimeout(500);
  await shot(page, `${vp}-06-triage-after`);

  if (errors.length) {
    console.log(`  !! ${errors.length} console/page error(s):`);
    for (const e of errors.slice(0, 5)) console.log(`     ${e}`);
  } else {
    console.log('  no console errors');
  }
  await page.close();
}

await browser.close();
console.log(`\ncaptured to ${OUT}/`);
