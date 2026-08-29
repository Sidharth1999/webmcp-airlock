import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 860 } });
await p.goto('http://localhost:8917/?tick=100', { waitUntil: 'networkidle' });
await p.getByTestId('sim-run').click();
await p.getByTestId('deploy-card-d-201').waitFor({ timeout: 15000 });
await p.getByTestId('sim-run').click(); // pause for a stable shot
await p.getByTestId('mode-recovery').click();
const prop = JSON.parse(
  await p.evaluate(() => window.__airlock.invoke('propose_rollback', { deployId: 'd-201' }))
);
await p.locator(`[data-testid="approval-${prop.proposalSeq}"]`).waitFor();
await p.screenshot({ path: 'log/m3-03-approval-card.png' });
await b.close();
console.log('captured log/m3-03-approval-card.png');
