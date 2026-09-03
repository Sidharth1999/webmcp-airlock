import { chromium } from 'playwright';
// AIRLOCK_PORT lets a worktree replay against its own dev server; 8917 stays the default.
const BASE = `http://localhost:${process.env.AIRLOCK_PORT ?? 8917}`;
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1512, height: 945 } });
p.on('pageerror', e => console.log('PAGEERROR', e.message));
await p.goto(`${BASE}/?template=retry-storm&run=1&mode=recovery&tick=60`);
const status = async () => JSON.parse(await p.evaluate(() => window.__airlock.invoke('airlock_status', {})));
for (let i = 0; i < 120 && !(await status()).incidentOpen; i++) await p.waitForTimeout(500);
const brief = (s) => { const api = s.services.find(x => x.id === 'api') ?? { health: '?', version: '?' }; const co = s.traffic?.byRoute?.['/checkout'] ?? { rps: 0, errRate: 0 }; return `api=${api.health} ${api.version} cap=${JSON.stringify(api.capacity)} | /checkout rps=${co.rps} admitted=${co.admittedRps ?? '-'} cap=${co.cap ?? '-'} err=${(co.errRate * 100).toFixed(1)}% | open=${s.incidentOpen}`; };
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
// the recovery: the wedged fleet rolls on the shed load and the incident closes
let s = await status();
for (let i = 0; i < 40 && s.incidentOpen; i++) { await p.waitForTimeout(500); s = await status(); }
console.log('\nRECOVERED', s.incidentOpen ? 'NO — still open' : 'yes');
console.log('\nEND   ', brief(s), '| header:', (await p.locator('#console header, header').first().innerText()).replace(/\s+/g, ' ').slice(0, 80));
await b.close();
// ---- phase 2: the correct order from a clean incident --------------------
{
  const b2 = await chromium.launch(); const p2 = await b2.newPage({ viewport: { width: 1512, height: 945 } });
  await p2.goto(`${BASE}/?template=retry-storm&run=1&mode=recovery&tick=60`);
  const st = async () => JSON.parse(await p2.evaluate(() => window.__airlock.invoke('airlock_status', {})));
  for (let i = 0; i < 120; i++) { const s = await st(); if (s.incidentOpen && s.services.find(x => x.id === 'api')?.version === '2.4.0') break; await p2.waitForTimeout(500); }
  const br = (s) => { const api = s.services.find(x => x.id === 'api') ?? { health: '?', version: '?' }; const co = s.traffic?.byRoute?.['/checkout'] ?? { rps: 0, errRate: 0 }; return `api=${api.health} ${api.version} cap=${JSON.stringify(api.capacity)} | /checkout rps=${co.rps} admitted=${co.admittedRps ?? '-'} cap=${co.cap ?? '-'} err=${(co.errRate * 100).toFixed(1)}% | open=${s.incidentOpen}`; };
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
