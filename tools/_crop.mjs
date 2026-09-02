import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: Number(process.argv[3] ?? 2300), height: 900 } });
await p.goto(process.argv[2], { waitUntil: 'networkidle' });
await p.waitForTimeout(9000);
await p.locator('.readout, #readout, .sit-readout').first().screenshot({ path: process.argv[4] }).catch(async () => {
  await p.screenshot({ path: process.argv[4], clip: { x:0, y:0, width: Number(process.argv[3] ?? 2300), height: 240 } });
});
console.log('ok', process.argv[4]);
await b.close();
