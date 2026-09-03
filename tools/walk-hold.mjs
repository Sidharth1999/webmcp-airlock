// THE HELD APPROVAL, DRIVEN — what a host's synthetic click gets, and what
// a person's hold gets, with a host attached (`?host=1`, dev build only).
// Every state at 1512x945: the refused click, the cancelled hold, the
// completed hold, the held chord, the second key, and the receipt.
// Usage: AIRLOCK_PORT=8929 node tools/walk-hold.mjs [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'log/hold';
const BASE = `http://localhost:${process.env.AIRLOCK_PORT ?? 8917}`;
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const errs = [];
let fails = 0;
const ok = (name, v) => {
  console.log(`[hold] ${name}: ${v ? 'ok' : 'FAIL'}`);
  if (!v) fails++;
};
const newPage = async () => {
  const p = await b.newPage({ viewport: { width: 1512, height: 945 } });
  p.on('pageerror', (e) => errs.push(String(e)));
  p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  return p;
};
const full = (p, name) => p.screenshot({ path: `${OUT}/${name}.png` });
const rail = (p, name) => p.locator('#tool-rail').screenshot({ path: `${OUT}/${name}.png` });

const pendingCount = (p, seq) => p.locator(`[data-testid="approval-${seq}"]`).count();
const rowState = (p, seq) => p.locator(`[data-testid="ask-${seq}"]`).getAttribute('data-state');
const centre = async (loc) => {
  const box = await loc.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const holdPointer = async (p, loc, ms) => {
  const c = await centre(loc);
  await p.mouse.move(c.x, c.y);
  await p.mouse.down();
  await p.waitForTimeout(ms);
  await p.mouse.up();
};
const proposeFlag = async (p) => {
  const state = (await p.locator('[data-flag-id="new-checkout"]').getAttribute('data-flag-state')) === 'on' ? 'off' : 'on';
  const r = JSON.parse(
    await p.evaluate((s) => window.__airlock.invoke('propose_flag_change', { id: 'new-checkout', state: s }), state)
  );
  await p.getByTestId(`approval-${r.proposalSeq}`).waitFor({ timeout: 5_000 });
  return r.proposalSeq;
};
const landed = (p, seq) =>
  p.waitForFunction((s) => document.querySelector(`[data-testid="ask-${s}"]`)?.dataset.state === 'done', seq, { timeout: 10_000 })
    .then(() => true, () => false);
const streamVia = (p, seq) =>
  p.evaluate((s) => {
    const rows = [...document.querySelectorAll('#event-stream li[data-kind="action.approved"]')];
    const row = rows.find((r) => r.textContent.includes(`#${s} `));
    return row ? row.querySelector('.ev-summary').textContent : null;
  }, seq);

// ---- with a host attached ---------------------------------------------------
{
  const p = await newPage();
  await p.goto(`${BASE}/?host=1`, { waitUntil: 'networkidle' });
  await p.getByTestId('flag-toggle-new-checkout').waitFor({ timeout: 15_000 });
  await p.waitForTimeout(600);
  ok('status bar says host attached', /host attached/.test(await p.locator('#wbs-webmcp').textContent()));
  ok(
    'the dock says it: third prompt + the held-gesture line',
    /don't click anything in the console — I decide\.$/.test(await p.locator('#findings-empty .te-q').nth(2).textContent()) &&
      (await p.getByTestId('held-note').textContent()) === 'Approvals are a held gesture while an agent is attached.'
  );
  await full(p, '00-dock-empty-host');
  await rail(p, '00-dock-empty-host-rail');

  await p.getByTestId('mode-recovery').click();
  await p.waitForTimeout(300);
  const s1 = await proposeFlag(p);
  const btn = p.getByTestId(`approve-${s1}`);
  ok('the button reads Hold to approve', (await btn.locator('.ap-label').textContent()) === 'Hold to approve');
  await full(p, '01-pending-hold');
  await rail(p, '01-pending-hold-rail');

  // a plain click: what a host's automation sends
  await btn.click();
  await p.waitForTimeout(120);
  await rail(p, '02-click-refused-rail');
  await p.waitForTimeout(400);
  ok('a plain click does NOT approve', (await pendingCount(p, s1)) === 1 && (await rowState(p, s1)) === 'live');
  // element.click() from script: the same nothing
  await p.evaluate((s) => document.querySelector(`[data-testid="approve-${s}"]`).click(), s1);
  await p.waitForTimeout(400);
  ok('a scripted element.click() does NOT approve', (await pendingCount(p, s1)) === 1);

  // a hold released early
  const c = await centre(btn);
  await p.mouse.move(c.x, c.y);
  await p.mouse.down();
  await p.waitForTimeout(350);
  ok('mid-hold the button is filling', (await btn.getAttribute('data-holding')) === '1');
  await rail(p, '03-hold-midway-rail');
  await p.mouse.up();
  await p.waitForTimeout(500);
  ok('a cancelled hold does NOT approve', (await pendingCount(p, s1)) === 1 && (await btn.getAttribute('data-holding')) === null);
  await rail(p, '04-hold-cancelled-rail');
  // and a hold that leaves the button
  await p.mouse.down();
  await p.waitForTimeout(300);
  await p.mouse.move(c.x, c.y + 200);
  await p.waitForTimeout(600);
  await p.mouse.up();
  ok('a hold that leaves the button does NOT approve', (await pendingCount(p, s1)) === 1);

  // the hold, completed
  await p.mouse.move(c.x, c.y);
  await p.mouse.down();
  await p.waitForTimeout(450);
  await rail(p, '05-holding-rail');
  await p.waitForTimeout(400);
  await p.mouse.up();
  ok('a 700ms hold approves', await landed(p, s1));
  await p.waitForTimeout(900);
  const via1 = await streamVia(p, s1);
  ok(`the log records the gesture (${via1})`, /· hold$/.test(via1 ?? ''));
  ok('the row says executed, not by click', (await p.locator(`[data-testid="ask-${s1}"] .pl-note`).textContent()) === 'executed');
  await full(p, '06-approved-by-hold');
  await rail(p, '06-approved-by-hold-rail');

  // the chord, held
  const s2 = await proposeFlag(p);
  await p.keyboard.down('Meta');
  await p.keyboard.down('Enter');
  await p.waitForTimeout(300);
  ok('⌘ enter down starts the same hold', (await p.getByTestId(`approve-${s2}`).getAttribute('data-holding')) === '1');
  await rail(p, '07-chord-holding-rail');
  await p.keyboard.up('Enter');
  await p.keyboard.up('Meta');
  await p.waitForTimeout(500);
  ok('a tapped ⌘ enter does NOT approve', (await pendingCount(p, s2)) === 1);
  await p.keyboard.down('Meta');
  await p.keyboard.down('Enter');
  await p.waitForTimeout(850);
  await p.keyboard.up('Enter');
  await p.keyboard.up('Meta');
  ok('⌘ enter held 700ms approves', await landed(p, s2));
  await p.waitForTimeout(600);
  ok(`the log records key-hold (${await streamVia(p, s2)})`, /· key-hold$/.test((await streamVia(p, s2)) ?? ''));
  await rail(p, '08-chord-approved-rail');

  // the second key
  const r = JSON.parse(await p.evaluate(() => window.__airlock.invoke('propose_route_change', { id: 'checkout', target: 'web' })));
  const s3 = r.proposalSeq;
  await p.getByTestId(`approval-${s3}`).waitFor({ timeout: 5_000 });
  const key = p.getByTestId(`key-${s3}`);
  const keyLabel = p.locator(`[data-testid="approval-${s3}"] .ap-key`);
  await rail(p, '09-dualkey-pending-rail');
  await key.click();
  await p.waitForTimeout(120);
  await rail(p, '10-key-click-refused-rail');
  await p.waitForTimeout(400);
  ok('a click does NOT engage the key', !(await key.isChecked()) && (await p.getByTestId(`approve-${s3}`).isDisabled()));
  await holdPointer(p, keyLabel, 350);
  await p.waitForTimeout(300);
  ok('a cancelled hold does NOT engage the key', !(await key.isChecked()));
  const kc = await centre(keyLabel);
  await p.mouse.move(kc.x, kc.y);
  await p.mouse.down();
  await p.waitForTimeout(400);
  await rail(p, '11-key-holding-rail');
  await p.waitForTimeout(450);
  await p.mouse.up();
  await p.waitForTimeout(200);
  ok('a held key engages', (await key.isChecked()) && !(await p.getByTestId(`approve-${s3}`).isDisabled()));
  await rail(p, '12-key-engaged-rail');
  await key.click();
  await p.waitForTimeout(200);
  ok('a click releases the key', !(await key.isChecked()) && (await p.getByTestId(`approve-${s3}`).isDisabled()));
  await holdPointer(p, keyLabel, 850);
  await p.waitForTimeout(200);
  await holdPointer(p, p.getByTestId(`approve-${s3}`), 850);
  ok('the two-key write lands under two holds', await landed(p, s3));
  await p.waitForTimeout(600);
  ok(`its log line carries the key and the gesture (${await streamVia(p, s3)})`, /key: operator · hold$/.test((await streamVia(p, s3)) ?? ''));
  await full(p, '13-dualkey-approved');
  await rail(p, '13-dualkey-approved-rail');
  await p.close();
}

// ---- the plan's receipt, every step held --------------------------------------
{
  const p = await newPage();
  await p.goto(`${BASE}/?host=1&review=plan`, { waitUntil: 'networkidle' });
  await p.locator('[data-testid="review-banner"][data-state="ready"]').waitFor({ timeout: 90_000 });
  await p.waitForTimeout(700);
  let guard = 0;
  while (guard++ < 12) {
    const card = p.locator('[data-testid^="approval-"]').first();
    if (!(await card.count())) break;
    const keyLabel = card.locator('.ap-key');
    if (await keyLabel.count()) await holdPointer(p, keyLabel, 850);
    await holdPointer(p, card.locator('.ap-approve'), 850);
    await p.waitForFunction(() => !document.querySelector('[data-testid^="approval-"]'), null, { timeout: 10_000 }).catch(() => {});
    await p.waitForTimeout(400);
    // the next step is proposed once this one executes
    await p.locator('[data-testid^="approval-"]').first().waitFor({ timeout: 4_000 }).catch(() => {});
  }
  await p.waitForTimeout(800);
  const receipt = await p.locator('.pl-receipt .plr-count').first().textContent().catch(() => null);
  ok(`the receipt still says by you when every step was held (${receipt})`, /^\d+ of \d+ approved by you$/.test(receipt ?? ''));
  await full(p, '14-plan-receipt-held');
  await rail(p, '14-plan-receipt-held-rail');
  await p.close();
}

// ---- without a host: nothing changed --------------------------------------------
{
  const p = await newPage();
  await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await p.getByTestId('flag-toggle-new-checkout').waitFor({ timeout: 15_000 });
  await p.getByTestId('mode-recovery').click();
  const s = await proposeFlag(p);
  ok('no host: the button reads Approve', (await p.getByTestId(`approve-${s}`).locator('.ap-label').textContent()) === 'Approve');
  await p.getByTestId(`approve-${s}`).click();
  ok('no host: a click approves, as before', await landed(p, s));
  await p.waitForTimeout(600);
  ok('no host: the row says executed', (await p.locator(`[data-testid="ask-${s}"] .pl-note`).textContent()) === 'executed');
  await rail(p, '15-nohost-click-approved-rail');
  await p.close();
}

await b.close();
if (errs.length) console.log('[hold] page errors:', errs);
console.log(fails === 0 && errs.length === 0 ? '[hold] GREEN' : `[hold] RED (${fails} failure(s), ${errs.length} error(s))`);
process.exit(fails === 0 && errs.length === 0 ? 0 : 1);
