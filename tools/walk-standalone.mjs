// THE STANDALONE PROPOSAL, DRIVEN — the path a live agent is most likely
// to take. One propose_* call, no plan: the review scenes `bare`, `evidence`
// and `provenance` each end on one, and this walks every state of it at
// 1512x945 — pending, then DRIVEN to approved or rejected, never loaded —
// plus the counsel scene's hover and click-caution on the deploy row.
// Usage: AIRLOCK_PORT=8923 node tools/walk-standalone.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'log/standalone';
const BASE = `http://localhost:${process.env.AIRLOCK_PORT ?? 8917}`;
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const errs = [];
const newPage = async () => {
  const p = await b.newPage({ viewport: { width: 1512, height: 945 } });
  p.on('pageerror', (e) => errs.push(String(e)));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  return p;
};
const full = (p, name) => p.screenshot({ path: `${OUT}/${name}.png` });
const rail = (p, name) => p.locator('#tool-rail').screenshot({ path: `${OUT}/${name}.png` });

const scene = async (p, id) => {
  await p.goto(`${BASE}/?review=${id}`, { waitUntil: 'networkidle' });
  await p.locator('[data-testid="review-banner"][data-state="ready"]').waitFor({ timeout: 90_000 });
  await p.waitForTimeout(700);
};

// the pending ask: the one thing on screen a judge is waiting to decide
const pending = (p) => p.locator('[data-testid^="approval-"]').first();

// ---- bare: a proposal with no reads behind it, approved --------------------
{
  const p = await newPage();
  await scene(p, 'bare');
  await full(p, 'bare-01-pending');
  await rail(p, 'bare-01-pending-rail');
  await pending(p).locator('.ap-approve').click();
  await p.waitForFunction(() => !document.querySelector('[data-testid^="approval-"]'), null, { timeout: 10_000 });
  await p.waitForTimeout(1200);
  await full(p, 'bare-02-approved');
  await rail(p, 'bare-02-approved-rail');
  await p.close();
}

// ---- evidence: the same proposal with its reads, rejected ------------------
{
  const p = await newPage();
  await scene(p, 'evidence');
  await full(p, 'evidence-01-pending');
  await rail(p, 'evidence-01-pending-rail');
  const strip = p.locator('[data-testid^="evidence-"]').first();
  if (await strip.count()) {
    await strip.locator('summary').click();
    await p.waitForTimeout(400);
    await rail(p, 'evidence-02-strip-open-rail');
  }
  await pending(p).locator('.ap-reject').click();
  await p.waitForFunction(() => !document.querySelector('[data-testid^="approval-"]'), null, { timeout: 10_000 });
  await p.waitForTimeout(900);
  await full(p, 'evidence-03-rejected');
  await rail(p, 'evidence-03-rejected-rail');
  await p.close();
}

// ---- provenance: the key rung — disarmed, then keyed, then approved --------
{
  const p = await newPage();
  await scene(p, 'provenance');
  await full(p, 'provenance-01-pending');
  await rail(p, 'provenance-01-pending-rail');
  // the chord refuses to bypass the key: it lands on the checkbox
  await p.keyboard.press('Meta+Enter');
  await p.waitForTimeout(300);
  await rail(p, 'provenance-02-chord-refused-rail');
  await pending(p).locator('.ap-key-toggle').check();
  await p.waitForTimeout(300);
  await rail(p, 'provenance-03-keyed-rail');
  await pending(p).locator('.ap-approve').click();
  await p.waitForFunction(() => !document.querySelector('[data-testid^="approval-"]'), null, { timeout: 10_000 });
  await p.waitForTimeout(1200);
  await full(p, 'provenance-04-approved');
  await rail(p, 'provenance-04-approved-rail');
  await p.close();
}

// ---- counsel: the agent objecting at the Roll back control ----------------
{
  const p = await newPage();
  await scene(p, 'counsel');
  const rb = p.getByTestId('rollback-d-201');
  await rb.scrollIntoViewIfNeeded();
  await rb.hover();
  await p.waitForTimeout(700);
  await full(p, 'counsel-01-hover');
  const box = async () => rb.evaluate((n) => {
    const r = n.getBoundingClientRect();
    const c = document.querySelector('.agent-counsel, .agent-caution');
    const cr = c?.getBoundingClientRect();
    return { button: `${Math.round(r.width)}x${Math.round(r.height)}`, card: cr ? `${Math.round(cr.width)}x${Math.round(cr.height)}` : 'none' };
  });
  console.log('hover  ', JSON.stringify(await box()));
  await rb.click();
  await p.waitForTimeout(700);
  await full(p, 'counsel-02-caution');
  console.log('caution', JSON.stringify(await box()));
  await p.close();
}

console.log(errs.length ? `ERRORS: ${errs.slice(0, 5).join(' | ')}` : 'no console errors');
await b.close();
