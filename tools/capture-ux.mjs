// UX capture sweep — every state that must look right, in one run.
// Re-run this after EVERY visual change; bugs here are caught by looking.
// Usage: node tools/capture-ux.mjs [outDir]   (dev server 8917 must be up)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'log/ux';
// AIRLOCK_PORT lets a worktree shoot against its own dev server; 8917 stays the default.
const BASE = `http://localhost:${process.env.AIRLOCK_PORT ?? 8917}`;
mkdirSync(OUT, { recursive: true });

// SID'S DISPLAY IS ~2330px WIDE. Capturing only 1440 hid every wide-layout
// defect he reported — `1fr` columns absorbing all the slack, content
// stranded at opposite edges, the glance band wasting its left half.
// Never judge this layout without looking at `ultra`.
// AND SID REVIEWS AT 1512x945. That width was not in this list, which is how
// a `max-width: 1500px` rule shipped that never fired on the machine the
// review happened on — twelve pixels above it. Every capture looked right and
// the artifact did not. `sid` is the size the feedback comes from; `ultra` is
// the size the layout is tuned at. Look at BOTH.
const VIEWPORTS = {
  ultra: { width: 2400, height: 1350 },
  sid: { width: 1512, height: 945 },
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
  await page.goto(`${BASE}/?tick=120`, { waitUntil: 'networkidle' });
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

  // 7. the agent objecting BEFORE the click — record a finding that advises
  //    against rolling d-201 back, then reach for that very button.
  await page.evaluate(async () => {
    await window.__airlock.invoke('record_finding', {
      summary:
        'The failing checkout path is the new session schema, not the build. d-201 shipped an irreversible migration.',
      ruledOut:
        'Rolling d-201 back. api 1.9.3 reads the v1 session layout only, and 43,857 rows have already been written in v2 — the rollback takes the store down rather than healing it.',
      advisesAgainst: 'deploy.rollback:d-201',
    });
  });
  await page.waitForTimeout(300);
  // at narrow widths the deploy card can sit off-screen; the counsel shot is
  // best-effort there rather than failing the whole sweep
  try {
    await page.getByTestId('rollback-d-201').scrollIntoViewIfNeeded({ timeout: 4000 });
    await page.getByTestId('rollback-d-201').hover({ timeout: 4000 });
    await page.waitForTimeout(700);
    await shot(page, `${vp}-07-agent-counsel`);
  } catch {
    console.log('  (counsel shot skipped: control not reachable at this width)');
  }

  // ---- 8-11: the agent-UX surfaces (2026-09-01) -------------------------
  // These live on retry-storm, because it is the only family whose answer is
  // a SEQUENCE and the only one that emits log lines from the first ticks.
  const rs = await browser.newPage({ viewport });
  rs.on('pageerror', (e) => errors.push(String(e)));
  rs.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await rs.goto(`${BASE}/?template=retry-storm&tick=120`, { waitUntil: 'networkidle' });
  await rs.getByTestId('sim-run').click();
  await rs.waitForFunction(() => document.querySelectorAll('#log-stream .log-row').length > 6, {
    timeout: 40000,
  });
  await rs.getByTestId('mode-recovery').click();

  // 8. the human's own read_logs, with a level floor applied
  await rs.getByTestId('tab-logs').click();
  await shot(rs, `${vp}-08-logs-pane`);
  await rs.getByTestId('log-lvl-warn').click();
  await shot(rs, `${vp}-08b-logs-filtered`);
  await rs.getByTestId('log-lvl-all').click();

  // 9. a proposal carrying the reads it was assembled from
  const cite = await rs.evaluate(async () => {
    for (const t of ['airlock_status', 'list_deploys', 'read_logs', 'read_logs', 'traffic_history', 'list_changes']) {
      await window.__airlock.invoke(t, {});
    }
    return [...document.querySelectorAll('#log-stream .log-row')].map((n) => Number(n.dataset.seq));
  });
  await rs.evaluate(async (c) => {
    await window.__airlock.invoke('record_finding', {
      summary: `Offered rate on /checkout is ~4x its organic share while /browse is flat, and contention already cleared (#${c.at(-3)}) — the load is retries sustaining themselves.`,
    });
  }, cite);

  // 10. THE PLAN: the order, its reason, every step priced, one gate live
  const plan = JSON.parse(
    await rs.evaluate(
      (c) =>
        window.__airlock.invoke('propose_plan', {
          reason: `The fleet is at its autoscaler ceiling with no spare instances (#${c.at(-2)}), so a rolling replacement withdraws capacity this incident cannot spare. Headroom has to exist before the fix ships; the other way round takes api down.`,
          steps: [
            { tool: 'propose_rate_limit', input: { route: 'r-checkout', rps: 150 }, because: 'buys headroom now — it rejects real customers and fixes nothing' },
            { tool: 'propose_rollforward', input: { service: 'api' }, because: '2.4.2 is staged and green: retry attempts 2, full jitter, budget 10%' },
          ],
        }),
      cite
    )
  );
  await rs.getByTestId(`plan-${plan.planId}`).waitFor({ timeout: 10000 });
  await rs.waitForTimeout(400);
  await shot(rs, `${vp}-10-plan-step1`);

  // 11. step 1 executed — and only NOW is step 2 put to the human
  await rs.locator('.pl-step[data-state="live"] .ap-approve').click();
  await rs.waitForFunction(
    (id) => document.querySelector(`[data-testid="plan-step-${id}-1"]`)?.dataset.state === 'live',
    plan.planId,
    { timeout: 10000 }
  );
  await shot(rs, `${vp}-11-plan-step2`);
  await rs.locator('.pl-step[data-state="live"] .ap-approve').click();
  await rs.waitForFunction(
    (id) => document.querySelector(`[data-testid="plan-${id}"]`)?.dataset.state === 'complete',
    plan.planId,
    { timeout: 10000 }
  );
  await shot(rs, `${vp}-12-plan-done`);
  await rs.close();

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
