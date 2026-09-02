// THE WHOLE LEDGER, BEAT BY BEAT — the walk Sid reviews.
//
// walk-plan.mjs shoots the console; this shoots the ONE thing under review:
// the agent panel, cropped at 2x, from the empty state through every tool
// call, finding, plan step and observation to the resolution — and it opens
// a tool call on the way past, because "the output is openable" is a claim
// that has to be photographed, not asserted.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const OUT = process.argv[2] ?? 'log/ledger';
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1512, height: 945 }, deviceScaleFactor: 2 });
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
const rail = () => p.locator('#tool-rail');
const shot = (name) => rail().screenshot({ path: `${OUT}/${name}.png` });

// beat 0: no agent has connected yet
await p.goto('http://localhost:8917/', { waitUntil: 'networkidle' });
await p.waitForTimeout(800);
await shot('00-not-connected');

// beats 1..n: the certified seven-step response
await p.goto('http://localhost:8917/?review=plan', { waitUntil: 'networkidle' });
await p.locator('[data-testid="review-banner"][data-state="ready"]').waitFor({ timeout: 90_000 });
await p.waitForTimeout(700);
await shot('01-proposed');

// the claim under test: a tool call row opens onto what the agent GOT BACK
const call = p.locator('.tl-ev[data-kind="call"][data-tool="read_logs"]').first();
await call.locator('.tl-head').click();
await p.waitForTimeout(500);
await shot('02-tool-output-open');
await call.locator('.tl-head').click();
await p.waitForTimeout(400);

for (let n = 1; n <= 8; n++) {
  const step = p.locator('.pl-step[data-state="live"]').first();
  if (!(await step.count())) break;
  const key = step.locator('.ap-key-toggle').first();
  if (await key.count()) await key.check();
  await step.locator('.ap-approve').first().click();
  await p.waitForTimeout(1500);
  await shot(`${String(n + 2).padStart(2, '0')}-after-step${n}`);
}
await p.waitForTimeout(4500);
await shot('99-resolved');
console.log(errs.length ? `ERRORS: ${errs.slice(0, 5).join(' | ')}` : 'no console errors');
await b.close();
