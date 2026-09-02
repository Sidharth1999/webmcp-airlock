// Walk the certified seven-step response, shooting the panel at each beat.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2] ?? 'log/walk';
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1512, height: 945 } });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto('http://localhost:8917/?review=plan', { waitUntil: 'networkidle' });
await p.locator('[data-testid="review-banner"][data-state="ready"]').waitFor({ timeout: 90_000 });
await p.waitForTimeout(600);
await p.screenshot({ path: `${OUT}/00-proposed.png` });
for (let n = 1; n <= 8; n++) {
  const step = p.locator('.pl-step[data-state="live"]').first();
  if (!(await step.count())) break;
  const key = step.locator('.ap-key-toggle').first();
  if (await key.count()) await key.check();
  await step.locator('.ap-approve').first().click();
  await p.waitForTimeout(1400);
  await p.screenshot({ path: `${OUT}/${String(n).padStart(2, '0')}-after-step${n}.png` });
}
await p.waitForTimeout(4000);
await p.screenshot({ path: `${OUT}/99-settled.png` });
console.log(errs.length ? `ERRORS: ${errs.slice(0, 5).join(' | ')}` : 'no console errors');
await b.close();
