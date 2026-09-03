import { chromium } from 'playwright';
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1512, height: 945 } });
p.on('pageerror', e => console.log('PAGEERROR', e.message));
await p.goto('http://localhost:8917/?template=retry-storm&run=1&mode=recovery&tick=60');
const status = async () => JSON.parse(await p.evaluate(() => window.__airlock.invoke('airlock_status', {})));
await p.waitForFunction(async () => JSON.parse(await window.__airlock.invoke('airlock_status', {})).incidentOpen, null, { timeout: 60000 });
const brief = (s) => { const api = s.services.find(x => x.id === 'api'); const co = s.traffic.byRoute['/checkout'] ?? { rps: 0, errRate: 0 }; return `api=${api.health} ${api.version} cap=${JSON.stringify(api.capacity)} | /checkout rps=${co.rps} admitted=${co.admittedRps ?? '-'} cap=${co.cap ?? '-'} err=${(co.errRate * 100).toFixed(1)}% | open=${s.incidentOpen}`; };
console.log('START ', brief(await status()));
async function act(tool, input) {
  const before = await p.locator('[data-obs-for]').count();
  const r = JSON.parse(await p.evaluate(([t, i]) => window.__airlock.invoke(t, i), [tool, input]));
  if (r.status !== 'proposed') { console.log(`\n${tool} ${JSON.stringify(input)} -> ${JSON.stringify(r).slice(0, 200)}`); return; }
  await p.waitForSelector(`[data-testid="approve-${r.proposalSeq}"]`, { timeout: 15000 });
  await p.click(`[data-testid="approve-${r.proposalSeq}"]`);
  await p.waitForFunction((n) => document.querySelectorAll('[data-obs-for]').length > n, before, { timeout: 20000 });
  await p.waitForTimeout(1500);
  const obs = await p.locator('[data-obs-for]').last().locator('.tl-title').innerText();
  const s = await status();
  console.log(`\n${tool} ${JSON.stringify(input)}\n  ledger: ${obs.replace(/\s+/g, ' ').slice(0, 220)}\n  recent: ${JSON.stringify(s.recentOutcomes?.[0] ?? null).slice(0, 220)}\n  world : ${brief(s)}`);
}
await act('propose_rollforward', { service: 'api' });
await act('propose_scale', { service: 'api', replicas: 9 });
await act('propose_rollforward', { service: 'api' });
await act('propose_rollback', { deployId: 'd-511' });
await act('propose_restart', { service: 'api' });
console.log('\n--- now the correct order ---');
await act('propose_rate_limit', { route: 'r-checkout', rps: 150 });
await act('propose_rollforward', { service: 'api' });
await p.waitForTimeout(6000);
const s = await status();
console.log('\nEND   ', brief(s), '| header:', (await p.locator('#console header, header').first().innerText()).replace(/\s+/g, ' ').slice(0, 80));
await b.close();
// ---- phase 2: the correct order from a clean incident --------------------
{
  const b2 = await chromium.launch(); const p2 = await b2.newPage({ viewport: { width: 1512, height: 945 } });
  await p2.goto('http://localhost:8917/?template=retry-storm&run=1&mode=recovery&tick=60');
  const st = async () => JSON.parse(await p2.evaluate(() => window.__airlock.invoke('airlock_status', {})));
  await p2.waitForFunction(async () => { const s = JSON.parse(await window.__airlock.invoke('airlock_status', {})); return s.incidentOpen && s.services.find(x => x.id === 'api').version === '2.4.0'; }, null, { timeout: 60000 });
  const br = (s) => { const api = s.services.find(x => x.id === 'api'); const co = s.traffic.byRoute['/checkout'] ?? { rps: 0, errRate: 0 }; return `api=${api.health} ${api.version} cap=${JSON.stringify(api.capacity)} | /checkout rps=${co.rps} admitted=${co.admittedRps ?? '-'} cap=${co.cap ?? '-'} err=${(co.errRate * 100).toFixed(1)}% | open=${s.incidentOpen}`; };
  console.log('\n=== PHASE 2 clean incident:', br(await st()));
  async function act2(tool, input) {
    const before = await p2.locator('[data-obs-for]').count();
    const r = JSON.parse(await p2.evaluate(([t, i]) => window.__airlock.invoke(t, i), [tool, input]));
    await p2.waitForSelector(`[data-testid="approve-${r.proposalSeq}"]`, { timeout: 15000 });
    await p2.click(`[data-testid="approve-${r.proposalSeq}"]`);
    await p2.waitForFunction((n) => document.querySelectorAll('[data-obs-for]').length > n, before, { timeout: 20000 });
    await p2.waitForTimeout(2500);
    const obs = await p2.locator('[data-obs-for]').last().locator('.tl-title').innerText();
    console.log(`\n${tool} ${JSON.stringify(input)}\n  ledger: ${obs.replace(/\s+/g, ' ').slice(0, 200)}\n  world : ${br(await st())}`);
  }
  await act2('propose_rate_limit', { route: 'r-checkout', rps: 150 });
  await act2('propose_rollforward', { service: 'api' });
  await p2.waitForTimeout(8000);
  console.log('\nEND2  ', br(await st()));
  await b2.close();
}
