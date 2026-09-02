// THE WALKTHROUGH, END TO END, AS A VIEWER WOULD CLICK IT.
// Shoots the dock's empty state, the copy affordance, the running line with
// its disclosure, the refusal, the plan, each approval, the resolution, and
// the way out — at 1512x945, which is the window the review happens in.
// Usage: node tools/walk-through.mjs [outDir]   (AIRLOCK_PORT, default 8917)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'log/walkthrough';
const BASE = `http://localhost:${process.env.AIRLOCK_PORT ?? 8917}`;
mkdirSync(OUT, { recursive: true });

const b = await chromium.launch();
const ctx = await b.newContext({
  viewport: { width: 1512, height: 945 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
const shot = async (name) => {
  await p.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  captured ${name}`);
};
const walkState = () => p.getByTestId('walk-line').getAttribute('data-state');

await p.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await p.waitForTimeout(600);
console.log('empty state visible:', await p.getByTestId('findings-empty').isVisible());
console.log('walk line hidden at rest:', await p.getByTestId('walk-line').isHidden());
await shot('00-empty');

// the copy affordance puts the prompt on the clipboard
await p.getByTestId('copy-ask-2').click();
await p.waitForTimeout(200);
console.log('clipboard:', JSON.stringify(await p.evaluate(() => navigator.clipboard.readText())));
await shot('01-copied');
await p.waitForTimeout(1500);

// start, and the disclosure stands while it runs
await p.getByTestId('walk-start').click();
await p.locator('[data-testid="walk-line"][data-state="running"]').waitFor({ timeout: 10_000 });
await p.waitForTimeout(500);
console.log('walk line:', JSON.stringify(await p.getByTestId('walk-line').innerText()));
await shot('02-running');

// the refusal: a cap asked for in Triage, blocked at the gate
await p.locator('#event-stream li[data-kind="action.blocked"]').first().waitFor({ state: 'attached', timeout: 60_000 });
await p.waitForTimeout(600);
await shot('03-refusal');

// the plan lands and the script stops: the decision is the viewer's
await p.locator('[data-testid="walk-line"][data-state="ready"]').waitFor({ timeout: 90_000 });
await p.waitForTimeout(600);
console.log('state at handover:', await walkState(), '| sim:', await p.getByTestId('sim-status').innerText());
await shot('04-plan');

for (let n = 1; n <= 3; n++) {
  const step = p.locator('.pl-step[data-state="live"]').first();
  if (!(await step.count())) break;
  const key = step.locator('.ap-key-toggle').first();
  if (await key.count()) await key.check();
  await step.locator('.ap-approve').first().click();
  await p.waitForTimeout(1500);
  await shot(`0${4 + n}-after-step${n}`);
}
console.log('state after the last approval:', await walkState());

await p.getByTestId('thread-resolved').waitFor({ timeout: 120_000 });
await p.waitForTimeout(800);
console.log('state at resolution:', await walkState(), '| stop button says:', await p.getByTestId('walk-stop').innerText());
await shot('08-resolved');

// the way out: back to the empty state
await p.getByTestId('walk-stop').click();
await p.waitForTimeout(600);
console.log(
  'after reset — empty visible:',
  await p.getByTestId('findings-empty').isVisible(),
  '| walk line hidden:',
  await p.getByTestId('walk-line').isHidden(),
  '| ledger rows:',
  await p.locator('#agent-timeline .tl-ev:not([data-kind="live"])').count()
);
await shot('09-reset');

// stopping MID-RUN also lands on the empty state, with nothing half-said
await p.getByTestId('walk-start').click();
await p.locator('#agent-timeline .tl-ev[data-kind="call"]').first().waitFor({ timeout: 60_000 });
await p.getByTestId('walk-stop').click();
await p.waitForTimeout(2500);
console.log(
  'after a mid-run stop — empty visible:',
  await p.getByTestId('findings-empty').isVisible(),
  '| walk line hidden:',
  await p.getByTestId('walk-line').isHidden(),
  '| ledger rows:',
  await p.locator('#agent-timeline .tl-ev:not([data-kind="live"])').count(),
  '| pending cards:',
  await p.locator('.approval-card').count()
);
await shot('10-stopped-midrun');

console.log(errs.length ? `ERRORS: ${errs.slice(0, 3).join(' | ')}` : 'no console errors');
await b.close();
