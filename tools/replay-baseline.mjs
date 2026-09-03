import { chromium } from 'playwright';
const b = await chromium.launch();
async function run(template, steps) {
  const p = await b.newPage({ viewport: { width: 1512, height: 945 } });
  p.on('pageerror', e => console.log('PAGEERROR', e.message));
  await p.goto(`http://localhost:8917/?template=${template}&run=1&mode=recovery&tick=60`);
  const st = async () => JSON.parse(await p.evaluate(() => window.__airlock.invoke('airlock_status', {})));
  await p.waitForFunction(async () => JSON.parse(await window.__airlock.invoke('airlock_status', {})).incidentOpen, null, { timeout: 60000 });
  await p.waitForTimeout(1500);
  const br = (s) => `open=${s.incidentOpen} ` + s.services.map(x => `${x.id}=${x.health}@${x.version}`).join(' ') + ` err=${(s.traffic.errRate * 100).toFixed(1)}%`;
  console.log(`\n=== ${template}: ${br(await st())}`);
  const deploys = JSON.parse(await p.evaluate(() => window.__airlock.invoke('list_deploys', {}))).deploys;
  const live = deploys.find(d => d.status === 'live');
  const changes = JSON.parse(await p.evaluate(() => window.__airlock.invoke('list_changes', {})));
  console.log('  live deploy', live?.id, live?.service, live?.version, '| flags', JSON.stringify(changes.flags ?? changes).slice(0, 160));
  for (let [tool, input] of steps) {
    if (typeof input === 'function') input = input({ live, changes });
    const before = await p.locator('[data-obs-for]').count();
    const r = JSON.parse(await p.evaluate(([t, i]) => window.__airlock.invoke(t, i), [tool, input]));
    if (r.status !== 'proposed') { console.log(`  ${tool} ${JSON.stringify(input)} -> ${JSON.stringify(r).slice(0, 160)}`); continue; }
    await p.waitForSelector(`[data-testid="approve-${r.proposalSeq}"]`, { timeout: 15000 });
    const key = p.locator(`[data-testid="ask-${r.proposalSeq}"] input[type=checkbox], .approval-card input[type=checkbox]`).first();
    if (await key.count()) { try { await key.check({ timeout: 2000 }); } catch {} }
    await p.click(`[data-testid="approve-${r.proposalSeq}"]`);
    try { await p.waitForFunction((n) => document.querySelectorAll('[data-obs-for]').length > n, before, { timeout: 20000 }); } catch { console.log('  (no observation landed)'); }
    await p.waitForTimeout(3000);
    const obs = await p.locator('[data-obs-for]').last().locator('.tl-title').innerText().catch(() => '?');
    console.log(`  ${tool} ${JSON.stringify(input)}\n     ledger: ${obs.replace(/\s+/g, ' ').slice(0, 170)}\n     world : ${br(await st())}`);
  }
  await p.waitForTimeout(8000);
  console.log('  END   ', br(await st()));
  await p.close();
}
await run('poisoned-runbook', [ ['propose_flag_change', { id: 'checkout-v3', state: 'off' }] ]);
await run('innocent-deploy', [ ['propose_env_change', { key: 'CACHE_TTL', value: '3600' }] ]);
await b.close();
