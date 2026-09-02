// The live service strip, in every state that must look right.
// Usage: AIRLOCK_PORT=8925 node tools/capture-strip.mjs [outDir]
// Frames land in log/strip/ as <viewport>-<nn>-<state>.png; the console
// prints, per frame, the strip's text, whether it sits on one line, and
// whether the document overflows its viewport (it must not).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'log/strip';
const BASE = `http://localhost:${process.env.AIRLOCK_PORT ?? 8917}`;
mkdirSync(OUT, { recursive: true });

// sid (1512x945) is where the review happens; ultra (2400) is where the
// layout is tuned. Both, always.
const VIEWPORTS = {
  sid: { width: 1512, height: 945 },
  ultra: { width: 2400, height: 1350 },
};

const readStrip = (page) =>
  page.evaluate(() => {
    const nodes = [...document.querySelectorAll('#topology .topo-node')];
    const tops = nodes.map((n) => Math.round(n.getBoundingClientRect().top));
    const topoEl = document.querySelector('#topology');
    const topo = topoEl.getBoundingClientRect();
    const head = document.querySelector('#zone-controls .zone-head').getBoundingClientRect();
    const title = document.querySelector('#zone-controls .zone-title').getBoundingClientRect();
    return {
      nodes: nodes.map((n) => ({
        id: n.dataset.service,
        health: n.dataset.health,
        text: n.textContent.replace(/\s+/g, ' ').trim(),
        errColor: getComputedStyle(n.querySelector('.topo-err')).color,
      })),
      oneLine: new Set(tops).size === 1,
      sameRowAsTitle: Math.abs(topo.top + topo.height / 2 - (title.top + title.height / 2)) < 4,
      // content, not box: the strip is a flex item that shrinks to fit, so
      // its rect always "fits" — the nodes inside it are what can overflow
      fits:
        topoEl.scrollWidth <= topoEl.clientWidth + 1 && topo.right <= head.right - 15,
      stripW: Math.round(topo.width),
      headH: Math.round(head.height),
      overflow:
        document.documentElement.scrollWidth !== innerWidth ||
        document.documentElement.scrollHeight !== innerHeight,
    };
  });

const shot = async (page, name) => {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  // the head alone, at 1:1, so the strip can be read without squinting
  await page.locator('#zone-controls .zone-head').screenshot({ path: `${OUT}/${name}-strip.png` });
  const s = await readStrip(page);
  const flags = [
    s.oneLine ? 'one line' : '!! WRAPPED',
    s.sameRowAsTitle ? 'beside title' : 'under title',
    s.fits ? 'fits' : '!! OVERFLOWS HEAD',
    s.overflow ? '!! DOCUMENT SCROLLS' : 'no scroll',
    `strip ${s.stripW}px`,
    `head ${s.headH}px`,
  ].join(' · ');
  console.log(`  ${name}: ${flags}`);
  for (const n of s.nodes) console.log(`      ${n.id.padEnd(4)} ${n.health.padEnd(8)} "${n.text}"  err ${n.errColor}`);
  return s;
};

const waitClock = (page, secs) =>
  page.waitForFunction(
    (s) => {
      const m = /T\+(\d\d):(\d\d)/.exec(document.querySelector('#sit-clock')?.textContent ?? '');
      return m && Number(m[1]) * 60 + Number(m[2]) >= s;
    },
    secs,
    { timeout: 60_000 }
  );

/** approve the live plan step, engaging the key first when the step needs it */
const approveLive = async (page) => {
  const live = page.locator('.pl-step[data-state="live"]');
  await live.waitFor({ timeout: 15_000 });
  const key = live.locator('.ap-key-toggle');
  if (await key.count()) await key.check();
  await live.locator('.ap-approve').click();
};

const browser = await chromium.launch();
const errors = [];

for (const [vp, viewport] of Object.entries(VIEWPORTS)) {
  console.log(`\n[${vp}] ${viewport.width}x${viewport.height}`);
  const open = async (q) => {
    const page = await browser.newPage({ viewport });
    page.on('pageerror', (e) => errors.push(`${vp} ${q}: ${e}`));
    await page.goto(`${BASE}/${q}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.shell[data-ready="true"]', { timeout: 15_000 });
    return page;
  };

  // 1-2. the landing URL: shop open, incident on its way
  let page = await open('?template=retry-storm&run=1&site=1');
  await shot(page, `${vp}-01-site-t0`);
  await waitClock(page, 15);
  await shot(page, `${vp}-02-site-t15`);
  await page.close();

  // 3-4. console alone
  page = await open('?template=retry-storm&run=1');
  await shot(page, `${vp}-03-run-t0`);
  await waitClock(page, 15);
  await shot(page, `${vp}-04-run-t15`);
  await page.close();

  // 5-6. the plan: the cap lands at step 5, the fix ships at step 7
  page = await open('?review=plan');
  await page.locator('.pl-step[data-state="live"]').waitFor({ timeout: 60_000 });
  for (let i = 0; i < 5; i++) {
    await approveLive(page);
    await page.waitForFunction(
      (n) => document.querySelectorAll('.pl-step[data-state="done"]').length >= n,
      i + 1,
      { timeout: 15_000 }
    );
  }
  // let the cap show in the traffic before the frame
  await page.waitForTimeout(2500);
  await shot(page, `${vp}-05-plan-step5-capped`);
  for (let i = 5; i < 7; i++) {
    await approveLive(page);
    await page.waitForFunction(
      (n) => document.querySelectorAll('.pl-step[data-state="done"]').length >= n,
      i + 1,
      { timeout: 15_000 }
    );
  }
  await page.waitForFunction(
    () => document.querySelector('#topology [data-service="api"]')?.dataset.health === 'ok',
    { timeout: 30_000 }
  ).catch(() => console.log('  (api did not return to ok within 30s)'));
  await page.waitForTimeout(1500);
  await shot(page, `${vp}-06-plan-step7-fixed`);
  await page.close();
}

await browser.close();
if (errors.length) {
  console.log(`\n!! ${errors.length} page error(s):`);
  for (const e of errors) console.log(`   ${e}`);
  process.exit(1);
}
console.log(`\ncaptured to ${OUT}/`);
