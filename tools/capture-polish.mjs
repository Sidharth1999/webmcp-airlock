// POLISH SHOT SET — the states an outside reviewer has to see, at the size the
// product is reviewed and filmed at (1512x945, Sid's window).
//
// This is NOT capture-ux.mjs. That one sweeps five viewports for layout
// defects. This one narrows to one viewport and covers the flows and the
// TRANSITIONS: the decision states, the two rungs, the palette, the capability
// sheet, and the layout with the evidence panel put away.
//
// Usage: node tools/capture-polish.mjs [outDir]   (dev 8917 must be up)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'log/polish';
mkdirSync(OUT, { recursive: true });
const VIEWPORT = { width: 1512, height: 945 };

const browser = await chromium.launch();
const errors = [];
const openPage = async (url) => {
  const p = await browser.newPage({ viewport: VIEWPORT });
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`${url} :: ${m.text()}`); });
  await p.goto(url, { waitUntil: 'networkidle' });
  return p;
};
const shot = async (page, name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ${name}`);
};

// ---- 1-3: the console on its own, which is the "would an SRE use this
// without an agent" test and the only thing gate 1 actually validates -------
{
  const p = await openPage('http://localhost:8917/?tick=120');
  await p.getByTestId('deploy-card-d-200').waitFor({ timeout: 15000 });
  await shot(p, '01-standby');
  await p.getByTestId('sim-run').click();
  await p.waitForFunction(() => document.querySelector('#sit-state')?.textContent?.includes('INCIDENT'), { timeout: 30000 });
  await p.waitForTimeout(1600);
  await shot(p, '02-incident-live');
  // the incident-command strip once the human has taken command
  await p.getByTestId('ack-incident').click();
  await p.getByTestId('sev1').click();
  await p.getByTestId('escalate').click();
  await p.mouse.move(760, 600);
  await shot(p, '03-command-taken');
  // ...and the layout with the evidence panel put away (the #13 states)
  await p.getByTestId('close-panel').click();
  await shot(p, '04-panel-hidden');
  await p.getByTestId('restore-panel').click();
  // the capability sheet, opened in Recovery so its count is the high one
  await p.getByTestId('mode-recovery').click();
  await p.waitForTimeout(400);
  await p.getByTestId('tool-surface').click();
  await shot(p, '05-capability-recovery');
  await p.keyboard.press('Escape');
  // ...and the SAME sheet in Triage, because the pair is the only thing gate 1
  // actually validates: the page changes the agent's surface live.
  await p.getByTestId('mode-triage').click();
  await p.waitForTimeout(400);
  await p.getByTestId('tool-surface').click();
  await shot(p, '05b-capability-triage');
  await p.keyboard.press('Escape');
  await p.close();
}

// ---- 4-9: the agent surface, through the real tool path ------------------
// A scene sets itself up by RUNNING THE SIM — the plan scene waits for log
// lines before it has anything to reason from. A fixed timeout shot the page
// before the agent had acted (the first pass caught `waiting for log lines`
// in the banner and an empty palette). The banner says when it is ready, so
// wait on that and nothing else.
const scene = async (id, shots) => {
  const p = await openPage(`http://localhost:8917/?review=${id}`);
  await p.locator('[data-testid="review-banner"][data-state="ready"]').waitFor({ timeout: 90_000 });
  await p.waitForTimeout(600);
  await shots(p);
  await p.close();
};

await scene('plan', async (p) => {
  await shot(p, '06-plan-step1-live');
  // the palette, on a page that has a pending ask
  await p.keyboard.press('Meta+k');
  await p.waitForTimeout(500);
  await shot(p, '07-palette-agent-asked');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  // step 2 does not exist until step 1 has RUN
  const planId = await p.locator('[data-testid^="plan-"]').first().getAttribute('data-testid');
  const id = planId.replace('plan-', '');
  await p.locator('.pl-step[data-state="live"] .ap-approve').first().click();
  await p.waitForFunction(
    (i) => document.querySelector(`[data-testid="plan-step-${i}-1"]`)?.dataset.state === 'live',
    id,
    { timeout: 20_000 }
  );
  await shot(p, '08-plan-step2-arrives');
  await p.locator('.pl-step[data-state="live"] .ap-approve').first().click();
  await p.waitForFunction(
    (i) => document.querySelector(`[data-testid="plan-${i}"]`)?.dataset.state === 'complete',
    id,
    { timeout: 20_000 }
  );
  await p.waitForTimeout(1200);
  await shot(p, '09-plan-done-receipt');
});

await scene('abandon', async (p) => {
  const abId = (await p.locator('[data-testid^="plan-"]').first().getAttribute('data-testid')).replace('plan-', '');
  await p.locator('.pl-step[data-state="live"] .ap-reject').first().click();
  await p.waitForFunction(
    (i) => document.querySelector(`[data-testid="plan-${i}"]`)?.dataset.state === 'abandoned',
    abId,
    { timeout: 20_000 }
  );
  await p.waitForTimeout(800);
  await shot(p, '10-plan-abandoned');
});

await scene('provenance', async (p) => shot(p, '11-dual-key-rung'));
await scene('counsel', async (p) => {
  // the objection only exists at the control: the scene records the finding,
  // the reviewer reaches for the lever it advises against. Shooting the scene
  // without that gesture shows the finding and not the counsel.
  await p.getByTestId('rollback-d-201').scrollIntoViewIfNeeded();
  await p.getByTestId('rollback-d-201').hover();
  await p.waitForTimeout(900);
  await shot(p, '12-agent-objects');
});
await scene('evidence', async (p) => shot(p, '13-evidence-strip'));
await scene('bare', async (p) => shot(p, '14-same-ask-no-evidence'));

console.log(errors.length ? `\n!! ${errors.length} console error(s):\n${errors.slice(0, 6).join('\n')}` : '\nno console errors');
console.log(`captured to ${OUT}/`);
await browser.close();
