import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 860 } });
await p.goto('http://localhost:8917/?tick=100', { waitUntil: 'networkidle' });
await p.getByTestId('deploy-card-d-200').waitFor({ timeout: 15000 });
await p.getByTestId('mode-recovery').click();
const prop = JSON.parse(
  await p.evaluate(() => window.__airlock.invoke('propose_route_change', { id: 'checkout', target: 'web' }))
);
await p.locator(`[data-testid="approval-${prop.proposalSeq}"]`).waitFor();
await p.screenshot({ path: 'log/m3-04-dualkey-card.png' });
await b.close();
console.log('captured log/m3-04-dualkey-card.png');
