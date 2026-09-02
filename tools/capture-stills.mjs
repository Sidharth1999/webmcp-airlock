#!/usr/bin/env node
/**
 * GALLERY STILLS AND THUMBNAILS — the frames a judge sees before the film.
 *
 * Two output sets from one run, every state DRIVEN through the real tool path
 * (`window.__airlock` / the `?review=` scenes) and then approved by clicking
 * the same buttons a person clicks. Loading a scene is never enough: a
 * post-decision frame has to be earned by making the decision.
 *
 *   log/stills/   Sid's viewport, 1512x945 at 2x. Six frames, one claim each.
 *   log/devpost/  the curated Devpost set:
 *                   1..6  gallery, 1680x945 at 2x (exact 16:9), named by claim
 *                   thumb-*  three 1200x800 (3:2) crops of ONE moment each,
 *                            shot at 3x so they still read at ~300px wide;
 *                            preview-300/ holds the downscaled check copies.
 *
 * Dev chrome (the `dev scene` disclosure line the review harness draws in the
 * dock) is hidden by an injected stylesheet at shoot time. It is dev-only and
 * never in a production bundle, so hiding it here is honest: the product ships
 * without it.
 *
 * Usage: node tools/capture-stills.mjs   (dev server 8917 must be up)
 */
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const STILLS = 'log/stills';
const DEVPOST = 'log/devpost';
const PREVIEW = `${DEVPOST}/preview-300`;
for (const d of [STILLS, DEVPOST, PREVIEW]) mkdirSync(d, { recursive: true });

const SID = { width: 1512, height: 945 }; // the window Sid reviews in
const WIDE = { width: 1680, height: 945 }; // 16:9 at the same height: the gallery frame
const BASE = 'http://localhost:8917';

// ONLY=bare,refusal,plan,stills,thumbs,moment,provenance,counsel  — re-shoot a subset
const ONLY = (process.env.ONLY ?? '').split(',').filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);

const browser = await chromium.launch();
const errors = [];

const newPage = async (viewport, deviceScaleFactor) => {
  const p = await browser.newPage({ viewport, deviceScaleFactor });
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  p._vp = viewport;
  return p;
};

/** dev-only chrome out of the frame: the review harness's disclosure line */
const hideDevChrome = (p) => p.addStyleTag({ content: '#review-banner{display:none!important}' });

/** ENSURE, never toggle: a blind click closes the surface you meant to open. */
const ensure = async (p, key, on) => {
  const cur = await p.evaluate((k) => document.querySelector('.wb').dataset[k], key);
  if ((cur === 'on') !== on) {
    await p.getByTestId(key === 'site' ? 'site-toggle' : 'restore-panel').click();
    await p.waitForTimeout(350);
  }
};

const full = async (p, path) => {
  await p.waitForTimeout(400);
  await p.screenshot({ path });
  console.log(`  ${path}  ${p._vp.width}x${p._vp.height}`);
};

/** clip around a selector with breathing room, clamped to the viewport */
const clipAround = async (p, selectors, pad) => {
  const boxes = [];
  for (const sel of selectors) {
    const b = await p.locator(sel).first().boundingBox();
    if (!b) throw new Error(`no box for ${sel}`);
    boxes.push(b);
  }
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
  const right = Math.min(p._vp.width, Math.max(...boxes.map((b) => b.x + b.width)) + pad);
  const bottom = Math.min(p._vp.height, Math.max(...boxes.map((b) => b.y + b.height)) + pad);
  return { x, y, width: right - x, height: bottom - y };
};

const framed = async (p, selectors, path, pad = 28) => {
  await p.waitForTimeout(400);
  const clip = await clipAround(p, selectors, pad);
  await p.screenshot({ path, clip });
  console.log(`  ${path}  ${Math.round(clip.width)}x${Math.round(clip.height)} css`);
};

/**
 * A 3:2 window the width of the agent dock, anchored on one row — the
 * thumbnail discipline: one moment, not a region. `above` is how far above the
 * anchor's top edge the window starts; `prev` anchors on the row BEFORE the
 * selector instead (an observation row, say, so the crop opens on a clean row
 * boundary). Shot at 3x and resampled to exactly 1200x800.
 */
const saveThumb = async (p, clip, name, note) => {
  const path = `${DEVPOST}/${name}.png`;
  await p.screenshot({ path, clip });
  execFileSync('sips', ['-z', '800', '1200', path], { stdio: 'ignore' });
  // the check copy: does it still read at card size?
  execFileSync('sips', ['-Z', '300', path, '--out', `${PREVIEW}/${name}.png`], { stdio: 'ignore' });
  console.log(`  ${path}  1200x800 (3:2, from ${Math.round(clip.width)}x${Math.round(clip.height)} css${note})  + preview-300`);
};

const thumb = async (p, anchorSel, name, { above = 8, prev = false } = {}) => {
  await p.waitForTimeout(400);
  const rail = await p.locator('#tool-rail').boundingBox();
  const top = await p.evaluate(
    ([sel, usePrev]) => {
      const el = document.querySelector(sel);
      const t = usePrev && el?.previousElementSibling ? el.previousElementSibling : el;
      return t ? t.getBoundingClientRect().top : NaN;
    },
    [anchorSel, prev]
  );
  if (!rail || Number.isNaN(top)) throw new Error(`thumb: no box for ${anchorSel}`);
  const w = Math.min(410, p._vp.width - Math.round(rail.x));
  const h = Math.round(w / 1.5);
  const x = Math.round(rail.x);
  const y = Math.min(p._vp.height - h, Math.max(0, Math.round(top - above)));
  await saveThumb(p, { x, y, width: w, height: h }, name, ' at 3x');
};

const invoke = (p, name, input = {}) =>
  p.evaluate(([n, i]) => window.__airlock.invoke(n, i), [name, input]).then(JSON.parse);

const sceneReady = async (p, scene) => {
  await p.goto(`${BASE}/?review=${scene}`, { waitUntil: 'networkidle' });
  await p.locator('[data-testid="review-banner"][data-state="ready"]').waitFor({ timeout: 90_000 });
  await hideDevChrome(p);
  await p.waitForTimeout(500);
};

/** Approve the live step the way a person does, then wait for its consequence. */
const approveLive = async (p, expectNextLive = true) => {
  const step = p.locator('.pl-step[data-state="live"]').first();
  const id = await step.getAttribute('data-testid');
  const key = step.locator('.ap-key-toggle').first();
  if (await key.count()) await key.check();
  await step.locator('.ap-approve').first().click();
  await p.waitForFunction(
    (sel) => document.querySelector(`[data-testid="${sel}"]`)?.dataset.state !== 'live',
    id,
    { timeout: 15_000 }
  );
  if (expectNextLive) {
    await p.locator('.pl-step[data-state="live"]').first().waitFor({ timeout: 15_000 });
  }
  await p.waitForTimeout(1400); // the observation row lands under the step
};

// =========================================================================
// DRIVERS — each puts the page into one situation and stops.
// =========================================================================

/** the product on its own: incident open, shop failing, no agent attached */
async function driveBare(p) {
  await p.goto(`${BASE}/?tick=120`, { waitUntil: 'networkidle' });
  await p.getByTestId('sim-run').click();
  await p.waitForFunction(
    () => document.querySelector('#sit-state')?.textContent?.includes('INCIDENT'),
    { timeout: 30_000 }
  );
  await p.waitForTimeout(1400);
}

/**
 * The refusal. In Triage the agent reads, concludes, and reaches for the cap
 * it just argued for — a tool the page does not publish in this stage. The
 * airlock writes a BLOCKED row and the dock says so. Nothing is dispatched.
 */
async function driveRefusal(p) {
  await p.goto(`${BASE}/?template=retry-storm`, { waitUntil: 'networkidle' });
  await p.getByTestId('sim-run').click();
  await p.waitForFunction(() => document.querySelectorAll('#log-stream .log-row').length > 6, {
    timeout: 40_000,
  });
  await p.getByTestId('sim-run').click(); // hold the world still
  const seqs = await p.evaluate(async () => {
    for (const t of ['airlock_status', 'list_deploys', 'read_logs', 'traffic_history']) {
      await window.__airlock.invoke(t, {});
    }
    return [...document.querySelectorAll('#log-stream .log-row')].map((n) => Number(n.dataset.seq));
  });
  await invoke(p, 'record_finding', {
    summary: `Offered rate on /checkout is ~4x its organic share while /browse is flat, and contention already cleared (#${seqs.at(2)}) — the load is retries sustaining themselves.`,
  });
  const res = await invoke(p, 'propose_rate_limit', { route: 'r-checkout', rps: 150 });
  if (res.status !== 'blocked') throw new Error(`expected a refusal in triage, got ${JSON.stringify(res)}`);
  await p.waitForTimeout(1200);
  // the console's own record of the refusal lives in the Activity feed
  await ensure(p, 'site', false);
  await ensure(p, 'panel', true);
  await p.getByTestId('tab-activity').click();
  const audit = p.getByTestId('audit-toggle');
  if ((await audit.getAttribute('aria-pressed')) !== 'true') await audit.click();
  await p.locator('#event-stream li[data-kind="action.blocked"]').first().waitFor({ timeout: 5000 });
  await p.waitForTimeout(500);
}

// =========================================================================
// SHOOT
// =========================================================================

// ---------------------------------------------------------------- 1. BARE
if (want('bare')) {
  console.log('\n[1] the console without an agent');
  const s = await newPage(SID, 2);
  await driveBare(s);
  await full(s, `${STILLS}/1-console-without-an-agent.png`);
  await s.close();
  const g = await newPage(WIDE, 2);
  await driveBare(g);
  await full(g, `${DEVPOST}/1-the-console-without-an-agent.png`);
  await g.close();
}

// ---------------------------------------------------------------- 2. REFUSAL
if (want('refusal')) {
  console.log('\n[2] the page refuses a tool that does not exist in triage');
  const g = await newPage(WIDE, 2);
  await driveRefusal(g);
  await full(g, `${DEVPOST}/2-the-page-refuses-a-tool-that-does-not-exist-in-triage.png`);
  await g.close();
  // thumbnail: the dock at the moment of refusal — the finding, the line
  // under it, and the count that explains it
  const t = await newPage(SID, 3);
  await driveRefusal(t);
  await thumb(t, '#tool-rail .tl-ev[data-kind="connect"]', 'thumb-b-refused-in-triage', { above: 14 });
  await t.close();
}

// ---------------------------------------------------------------- 3..6 PLAN
// One seven-step plan, driven from proposal to resolution. The gallery frame
// is 16:9; the stills are Sid's viewport; thumbnails are 3x crops.
if (want('plan')) {
  console.log('\n[3-6] the plan, from proposal to the shop coming back');
  const g = await newPage(WIDE, 2);
  await sceneReady(g, 'plan');
  await ensure(g, 'site', true);
  await g.waitForTimeout(500);
  // the plan landed: the reason is open, step 1 is live with its cost
  await full(g, `${DEVPOST}/3-a-plan-is-an-order-with-a-price.png`);

  // every read opens onto what the agent got back
  const call = g.locator('.tl-ev[data-kind="call"][data-tool="read_logs"]').first();
  await call.locator('.tl-head').click();
  await g.waitForTimeout(600);
  await full(g, `${DEVPOST}/5-every-read-opens-onto-what-the-agent-got-back.png`);
  await call.locator('.tl-head').click();
  await g.waitForTimeout(400);

  // step 1 approved: its observation lands, and only now is step 2 live
  await approveLive(g);
  await full(g, `${DEVPOST}/4-step-2-was-not-proposed-until-step-1-ran.png`);

  // steps 2..7, then the shop comes back
  for (let n = 2; n <= 7; n++) await approveLive(g, n < 7);
  await g.locator('.tl-ev[data-kind="resolved"]').first().waitFor({ timeout: 30_000 });
  await g.waitForFunction(() => document.querySelector('#storefront')?.dataset.state === 'ok', {
    timeout: 30_000,
  });
  await g.waitForTimeout(1500);
  await full(g, `${DEVPOST}/6-the-shop-gets-told-then-comes-back.png`);
  await g.close();
}

// stills at Sid's viewport: plan landed (crop + full), then after step 1
if (want('stills')) {
  const s = await newPage(SID, 2);
  await sceneReady(s, 'plan');
  await ensure(s, 'site', true);
  await framed(s, ['#tool-rail'], `${STILLS}/2-a-plan-is-an-order-with-a-price.png`, 0);
  await full(s, `${STILLS}/3-the-plan-numbers-the-controls-it-will-touch.png`);
  await approveLive(s);
  await framed(s, ['#tool-rail'], `${STILLS}/4-step-2-was-not-proposed-until-step-1-ran.png`, 0);
  await s.close();
}

// thumbnails from the plan: the action/observation alternation once four
// steps have run, then the last approval rung with the observation above it
if (want('thumbs')) {
  const t = await newPage(SID, 3);
  await sceneReady(t, 'plan');
  await ensure(t, 'site', true);
  for (let n = 1; n <= 4; n++) await approveLive(t);
  await thumb(t, '#tool-rail .tl-ev[data-kind="plan"]', 'thumb-c-action-then-observation', { above: 6 });
  for (let n = 5; n <= 6; n++) await approveLive(t);
  // the rung alone: title, its reason, its cost, the two buttons and the
  // keyboard hint — anchored on the step so the hint is not the cut edge
  await thumb(t, '.pl-step[data-state="live"]', 'thumb-a-the-approval-rung', { above: 6 });
  await t.close();
}

// thumb-d: THE SUSPENDED MOMENT. The shop is failing on the left, the first
// step is waiting for a click on the right, and the frame holds both — the
// customer's notice and the operator's button — as its two big shapes.
if (want('moment')) {
  const t = await newPage(SID, 2);
  await sceneReady(t, 'plan');
  await ensure(t, 'site', true);
  await t.waitForTimeout(500);
  const notice = await t.getByTestId('sf-banner').boundingBox();
  const approve = await t.locator('.pl-step[data-state="live"] .ap-approve').first().boundingBox();
  if (!notice || !approve) throw new Error('moment: no notice or approve box');
  const x0 = Math.round(notice.x - 14);
  // end just past Approve: a sliver of Reject at the edge reads as a cut
  const x1 = Math.min(t._vp.width, Math.round(approve.x + approve.width + 10));
  const w = x1 - x0;
  const h = Math.round(w / 1.5);
  let y0 = Math.round(notice.y - 16);
  const needBottom = approve.y + approve.height + 16;
  if (needBottom > y0 + h) y0 = Math.round(needBottom - h); // keep the button in
  y0 = Math.min(y0, t._vp.height - h);
  await saveThumb(t, { x: x0, y: y0, width: w, height: h }, 'thumb-d-the-suspended-moment', ' at 2x');
  await t.close();
}

// ---------------------------------------------------------------- 5. PROVENANCE (still)
// A tier-1 rollback promoted to the two-key rung because the deploy id reached
// the agent inside customer-supplied text the page itself served.
if (want('provenance')) {
  console.log('\n[still 5] the page knows where the idea came from');
  const s = await newPage(SID, 2);
  await s.goto(`${BASE}/?template=poisoned-runbook&tick=50`, { waitUntil: 'networkidle' });
  await s.getByTestId('sim-run').click();
  await s.waitForFunction(
    () => /tick (1[5-9]|[2-9]\d)/.test(document.querySelector('[data-testid=sim-status]').textContent),
    { timeout: 30_000 }
  );
  await s.getByTestId('sim-run').click();
  await s.getByTestId('mode-recovery').click();
  const served = await invoke(s, 'read_logs');
  const line = (served.lines ?? []).find((l) => l.untrusted && /d-\d+/.test(l.msg));
  const target = line ? (line.msg.match(/d-\d+/) ?? [])[0] : null;
  if (!target) throw new Error('no deploy id inside an untrusted log line');
  const prop = await invoke(s, 'propose_rollback', { deployId: target });
  await s.getByTestId(`approval-${prop.proposalSeq}`).waitFor({ timeout: 10_000 });
  await framed(s, [`[data-testid="approval-${prop.proposalSeq}"]`], `${STILLS}/5-the-page-knows-where-the-idea-came-from.png`, 40);
  await s.close();

  // thumb-e: the same card from the review scene, cropped to the ask, the
  // quoted customer text and the key rung — the buttons are not the idea
  const t = await newPage(SID, 4);
  await sceneReady(t, 'provenance');
  const card = await t.locator('.approval-card').first().boundingBox();
  const key = await t.locator('.approval-card .ap-key').first().boundingBox();
  if (!card || !key) throw new Error('provenance thumb: no card or key box');
  // the card's own width sets the window; it ENDS under the key rung (the
  // buttons are not the idea) and reaches up past 'Waiting on you'
  // 3px of air each side: any more and the window reaches up into the
  // 'Waiting on you' label and cuts it mid-word
  const w = Math.round(card.width + 6);
  const h = Math.round(w / 1.5);
  const y1 = Math.round(key.y + key.height + 8);
  const y0 = Math.max(0, y1 - h);
  let x0 = Math.round(card.x + card.width / 2 - w / 2);
  x0 = Math.max(0, Math.min(t._vp.width - w, x0));
  await saveThumb(t, { x: x0, y: y0, width: w, height: h }, 'thumb-e-the-page-knows-where-the-idea-came-from', ' at 4x');
  await t.close();
}

// ---------------------------------------------------------------- 6. COUNSEL (still)
// The human reaches for the wrong lever and the agent's objection appears
// beside it. It counsels; a second click still proceeds.
if (want('counsel')) {
  console.log('\n[still 6] the agent objects before your click');
  const s = await newPage(SID, 2);
  await s.goto(`${BASE}/?tick=120`, { waitUntil: 'networkidle' });
  await s.getByTestId('sim-run').click();
  await s.waitForTimeout(1500);
  await invoke(s, 'record_finding', {
    summary: 'The failing checkout path is the new session schema, not the build. d-201 shipped an irreversible migration.',
    ruledOut: 'Rolling d-201 back. api 1.9.3 reads the v1 session layout only, and 43,857 rows have already been written in v2 — the rollback takes the store down rather than healing it.',
    advisesAgainst: 'deploy.rollback:d-201',
  });
  await ensure(s, 'site', false);
  await ensure(s, 'panel', true);
  await s.getByTestId('tab-changed').click();
  await s.getByTestId('rollback-d-201').scrollIntoViewIfNeeded({ timeout: 6000 });
  await s.getByTestId('rollback-d-201').click();
  await s.waitForSelector('.agent-caution', { timeout: 10_000 });
  await s.waitForTimeout(700);
  // the idea IS the relationship: the deploy they reached for, the lever, and
  // the answer it got, in one frame
  await framed(
    s,
    [':has(> .dc-status):has([data-testid="rollback-d-201"])', '.agent-caution'],
    `${STILLS}/6-the-agent-objects-before-your-click.png`,
    12 // the card sits at the foot of the console; more padding pulls in the status bar
  );
  await s.close();
}

await browser.close();
if (errors.length) {
  console.log(`\n!! ${errors.length} console/page error(s):`);
  for (const e of errors.slice(0, 5)) console.log(`   ${e}`);
} else {
  console.log('\nno console errors');
}
console.log(`stills → ${STILLS}/   devpost → ${DEVPOST}/`);
