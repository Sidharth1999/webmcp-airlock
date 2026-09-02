// THE CUSTOMER'S VIEW, ACROSS THE WHOLE ARC.
// Shoots the full console with the storefront OPEN at every beat, because the
// question the shop answers — did the thing the operator approved reach the
// people it was failing? — is only answerable if the shop is on screen when
// it happens.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2] ?? 'log/site';
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1512, height: 945 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
await p.goto('http://localhost:8917/?review=plan', { waitUntil: 'networkidle' });
await p.locator('[data-testid="review-banner"][data-state="ready"]').waitFor({ timeout: 90_000 });
// ENSURE, never toggle: the scene may already have the shop open, and a
// blind click then closes the one surface this walk exists to photograph.
if ((await p.evaluate(() => document.querySelector('.wb').dataset.site)) !== 'on') {
  await p.getByTestId('site-toggle').click();
}
await p.waitForTimeout(800);
const state = () => p.evaluate(() => document.querySelector('#storefront').dataset.state);
console.log('proposed:', await state());
await p.screenshot({ path: `${OUT}/00-proposed.png` });
for (let n = 1; n <= 8; n++) {
  const step = p.locator('.pl-step[data-state="live"]').first();
  if (!(await step.count())) break;
  const key = step.locator('.ap-key-toggle').first();
  if (await key.count()) await key.check();
  await step.locator('.ap-approve').first().click();
  await p.waitForTimeout(1500);
  console.log(`step ${n}:`, await state());
  await p.screenshot({ path: `${OUT}/${String(n).padStart(2, '0')}-after-step${n}.png` });
}
await p.waitForTimeout(5000);
console.log('settled:', await state());
await p.screenshot({ path: `${OUT}/99-settled.png` });
console.log(errs.length ? `ERRORS: ${errs.slice(0, 3).join(' | ')}` : 'no console errors');
await b.close();
