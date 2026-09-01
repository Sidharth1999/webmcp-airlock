#!/usr/bin/env node
/**
 * Gallery stills (M6-04). Judges may judge on video + text + images alone, so
 * these are DELIBERATE frames, not sweep output: one wide shot for context and
 * five tight ones, each carrying a single idea that reads at gallery-card size.
 *
 * Shot at 2400x1350 (Sid's display) and cropped with padding rather than
 * element-tight, because a tight crop of a dark card on a dark ground reads as
 * a rectangle of noise in a thumbnail grid.
 *
 * Usage: node tools/capture-stills.mjs [outDir]   (dev server 8917 must be up)
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] ?? 'log/stills';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const errors = [];
const newPage = async () => {
  const p = await browser.newPage({ viewport: { width: 2400, height: 1350 } });
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return p;
};

/** Crop around a selector with breathing room, clamped to the viewport. */
const framed = async (page, selector, name, pad = 28) => {
  await page.waitForTimeout(350);
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  const clip = {
    x: Math.max(0, box.x - pad),
    y: Math.max(0, box.y - pad),
    width: Math.min(2400 - Math.max(0, box.x - pad), box.width + pad * 2),
    height: Math.min(1350 - Math.max(0, box.y - pad), box.height + pad * 2),
  };
  await page.screenshot({ path: `${OUT}/${name}.png`, clip });
  console.log(`  ${name}  ${Math.round(clip.width)}x${Math.round(clip.height)}`);
};
/** Crop around SEVERAL things at once — some ideas are the relationship
 *  between two elements, and a tight crop of one of them loses it. */
const framedUnion = async (page, selectors, name, pad = 28) => {
  await page.waitForTimeout(350);
  const boxes = [];
  for (const sel of selectors) {
    const b = await page.locator(sel).first().boundingBox();
    if (!b) throw new Error(`no box for ${sel}`);
    boxes.push(b);
  }
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  const clip = {
    x: Math.max(0, x - pad),
    y: Math.max(0, y - pad),
    width: Math.min(2400 - Math.max(0, x - pad), right - x + pad * 2),
    height: Math.min(1350 - Math.max(0, y - pad), bottom - y + pad * 2),
  };
  await page.screenshot({ path: `${OUT}/${name}.png`, clip });
  console.log(`  ${name}  ${Math.round(clip.width)}x${Math.round(clip.height)}`);
};

const full = async (page, name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ${name}  2400x1350`);
};

const invoke = (page, name, input = {}) =>
  page.evaluate(([n, i]) => window.__airlock.invoke(n, i), [name, input]).then(JSON.parse);

// ---------------------------------------------------------------- STILL 1
// The product, standing on its own: a real console with a failing store beside
// it and no agent connected. This is the one that answers "is this a toy?".
{
  const p = await newPage();
  await p.goto('http://localhost:8917/?tick=120', { waitUntil: 'networkidle' });
  await p.getByTestId('sim-run').click();
  await p.waitForFunction(
    () => document.querySelector('#sit-state')?.textContent?.includes('INCIDENT'),
    { timeout: 30000 }
  );
  await p.waitForTimeout(1400);
  await full(p, '1-console-without-an-agent');
  await p.close();
}

// ---------------------------------------------------------------- STILL 2+3
// The plan: the order and its reason before any approval, then the proof that
// step 2 was not proposed until step 1 had actually run.
{
  const p = await newPage();
  await p.goto('http://localhost:8917/?template=retry-storm&tick=120', { waitUntil: 'networkidle' });
  await p.getByTestId('sim-run').click();
  await p.waitForFunction(() => document.querySelectorAll('#log-stream .log-row').length > 6, {
    timeout: 40000,
  });
  await p.getByTestId('mode-recovery').click();
  const seqs = await p.evaluate(async () => {
    for (const t of ['airlock_status', 'list_deploys', 'read_logs', 'read_logs', 'traffic_history', 'list_changes']) {
      await window.__airlock.invoke(t, {});
    }
    return [...document.querySelectorAll('#log-stream .log-row')].map((n) => Number(n.dataset.seq));
  });
  await invoke(p, 'record_finding', {
    summary: `Offered rate on /checkout is ~4x its organic share while /browse is flat, and the db already reported contention cleared (#${seqs.at(-3)}) — this load is retries sustaining themselves.`,
  });
  const plan = await invoke(p, 'propose_plan', {
    reason: `The fleet is at its autoscaler ceiling with no spare instances (#${seqs.at(-2)}), so a rolling replacement withdraws capacity this incident cannot spare. Headroom has to exist before the fix ships; the other way round takes api down.`,
    steps: [
      { tool: 'propose_rate_limit', input: { route: 'r-checkout', rps: 150 }, because: 'buys headroom now — it rejects real customers and fixes nothing' },
      { tool: 'propose_rollforward', input: { service: 'api' }, because: '2.4.2 is staged and green: retry attempts 2, full jitter, budget 10%' },
    ],
  });
  await p.getByTestId(`plan-${plan.planId}`).waitFor({ timeout: 10000 });
  await framed(p, `[data-testid="plan-${plan.planId}"]`, '2-a-plan-is-an-order-with-a-price');

  // STILL 3 — the whole console while a plan is live: the numbered rows on the
  // controls are the half that does not fit in a crop.
  await full(p, '3-the-plan-numbers-the-controls-it-will-touch');

  await p.locator('.pl-step[data-state="live"] .ap-approve').click();
  await p.waitForFunction(
    (id) => document.querySelector(`[data-testid="plan-step-${id}-1"]`)?.dataset.state === 'live',
    plan.planId,
    { timeout: 15000 }
  );
  await framed(p, `[data-testid="plan-${plan.planId}"]`, '4-step-2-was-not-proposed-until-step-1-ran');
  await p.close();
}

// ---------------------------------------------------------------- STILL 5
// Provenance: a tier-1 rollback promoted to the two-key rung because the page
// knows the deploy id reached the agent inside customer-supplied text IT
// served. The identity thesis, on screen, in one card.
{
  const p = await newPage();
  await p.goto('http://localhost:8917/?template=poisoned-runbook&tick=50', { waitUntil: 'networkidle' });
  await p.getByTestId('sim-run').click();
  // let the poisoned order note land, then pause: the world is set
  await p.waitForFunction(
    () => /tick (1[5-9]|[2-9]\d)/.test(document.querySelector('[data-testid=sim-status]').textContent),
    { timeout: 30000 }
  );
  await p.getByTestId('sim-run').click();
  await p.getByTestId('mode-recovery').click();
  const served = await invoke(p, 'read_logs');
  const line = (served.lines ?? []).find((l) => l.untrusted && /d-\d+/.test(l.msg));
  const target = line ? (line.msg.match(/d-\d+/) ?? [])[0] : null;
  if (!target) throw new Error('no deploy id inside an untrusted log line');
  const prop = await invoke(p, 'propose_rollback', { deployId: target });
  await p.getByTestId(`approval-${prop.proposalSeq}`).waitFor({ timeout: 10000 });
  // pad generously: the agent's presence label floats above the card, and a
  // label sliced in half reads as a rendering bug in a thumbnail grid
  await framed(p, `[data-testid="approval-${prop.proposalSeq}"]`, '5-the-page-knows-where-the-idea-came-from', 56);
  await p.close();
}

// ---------------------------------------------------------------- STILL 6
// Counsel before the click: the human reaches for the wrong lever and the
// agent's reasoning appears beside it. It advises; it never blocks.
{
  const p = await newPage();
  await p.goto('http://localhost:8917/?tick=120', { waitUntil: 'networkidle' });
  await p.getByTestId('sim-run').click();
  await p.waitForTimeout(1500);
  await invoke(p, 'record_finding', {
    summary: 'The failing checkout path is the new session schema, not the build. d-201 shipped an irreversible migration.',
    ruledOut: 'Rolling d-201 back. api 1.9.3 reads the v1 session layout only, and 43,857 rows have already been written in v2 — the rollback takes the store down rather than healing it.',
    advisesAgainst: 'deploy.rollback:d-201',
  });
  await p.getByTestId('rollback-d-201').scrollIntoViewIfNeeded({ timeout: 6000 });
  // The CLICK path, not the hover one: the first click is intercepted and the
  // objection appears with "click again to do it anyway" on it, which is the
  // whole point — it counsels, it does not block. Nothing is dispatched.
  await p.getByTestId('rollback-d-201').click();
  await p.waitForSelector('.agent-caution', { timeout: 10000 });
  await p.waitForTimeout(700);
  // the idea IS the relationship: the lever they reached for and the answer
  // it got, in one frame. Either one alone says nothing.
  await framedUnion(
    p,
    ['[data-testid="rollback-d-201"]', '.agent-caution'],
    '6-the-agent-objects-before-your-click',
    44
  );
  await p.close();
}

await browser.close();
if (errors.length) {
  console.log(`\n!! ${errors.length} console/page error(s):`);
  for (const e of errors.slice(0, 5)) console.log(`   ${e}`);
} else {
  console.log('\nno console errors');
}
console.log(`stills → ${OUT}/`);
