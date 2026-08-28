#!/usr/bin/env node
// One-shot evidence capture for M2-05/06: screenshots of the four canonical
// states (pre-run deck, incident+broken site, catastrophic+outage, resolved).
// Assumes a server on 8918 (npx vite preview --port 8918) or pass a URL.
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://localhost:8918/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });

const healthIs = (s) =>
  page.waitForFunction((x) => document.documentElement.dataset.health === x, s, { timeout: 15_000 });
const siteIs = (s) =>
  page.waitForFunction((x) => document.querySelector('#storefront')?.dataset.state === x, s, {
    timeout: 15_000,
  });
const shot = (name) => page.screenshot({ path: `log/${name}.png` });

// resolution path
await page.goto(URL + '?tick=120', { waitUntil: 'networkidle' });
// deck renders on the worker's async snapshot reply — wait before shooting
await page.getByTestId('deploy-card-d-200').waitFor({ timeout: 15_000 });
await shot('m2-05-deck-seeded');
await page.getByTestId('sim-run').click();
await page.getByTestId('deploy-card-d-201').waitFor({ timeout: 15_000 });
await healthIs('degraded');
await siteIs('broken');
await shot('m2-06-incident-site-broken');
await page.getByTestId('flag-toggle-new-checkout').click();
await healthIs('ok');
await siteIs('ok');
await page.getByTestId('rollforward-api').click();
await page.waitForFunction(
  () => document.querySelector('#event-stream').textContent.includes('v2.0.1 serving'),
  null,
  { timeout: 15_000 }
);
await shot('m2-05-resolved');

// trap path
await page.goto(URL + '?tick=120', { waitUntil: 'networkidle' });
await page.getByTestId('sim-run').click();
await page.getByTestId('deploy-card-d-201').waitFor({ timeout: 15_000 });
await healthIs('degraded');
await page.getByTestId('rollback-d-201').click();
await healthIs('down');
await siteIs('down');
await shot('m2-06-catastrophic-outage');

await browser.close();
console.log('captured: log/m2-05-deck-seeded.png, m2-06-incident-site-broken.png, m2-05-resolved.png, m2-06-catastrophic-outage.png');
