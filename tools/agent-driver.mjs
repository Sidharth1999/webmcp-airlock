#!/usr/bin/env node
/**
 * Scripted agent driver (M3-07): the PLUMBING loop. Plays the flagship
 * scenario end-to-end through the REAL page — agent turns via
 * window.__airlock.invoke (the same execute path WebMCP uses), human turns
 * via hit-tested UI clicks (mode pills, approval cards). Headless and
 * unattended. Writes a trace to log/driver-runs/, including an
 * evals-cli-compatible expectedCall sequence (see docs/research-resources.md).
 *
 * Usage: node tools/agent-driver.mjs [baseURL]   (default http://localhost:8918/)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://localhost:8918/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
const calls = [];

const invoke = async (name, input = {}) => {
  const text = await page.evaluate(
    ([n, i]) => window.__airlock.invoke(n, i),
    [name, input]
  );
  calls.push({ functionName: name, arguments: input, result: JSON.parse(text) });
  return JSON.parse(text);
};

const healthIs = (s) =>
  page.waitForFunction((x) => document.documentElement.dataset.health === x, s, { timeout: 20_000 });

console.log(`[driver] run against ${URL}`);
await page.goto(URL + '?tick=50', { waitUntil: 'networkidle' });
await page.getByTestId('deploy-card-d-200').waitFor({ timeout: 15_000 });
await page.getByTestId('sim-run').click();

// --- agent: triage — watch until the incident opens -----------------------
let status;
for (let i = 0; i < 60; i++) {
  status = await invoke('airlock_status');
  if (status.incidentOpen) break;
  await page.waitForTimeout(200);
}
if (!status.incidentOpen) throw new Error('incident never opened');
console.log('[driver] incident open — agent begins diagnosis reads');

// --- agent: reads reveal the trap (TWO tools, no single decisive field) ---
// De-structuring audit (docs/sre-mess-research.md): there is no `reversible`
// enum to branch on. list_deploys carries prose saying the pre-deploy code
// path cannot read the new layout; only list_changes proves that layout is
// already in traffic. The tell is the relationship between them.
const deploys = await invoke('list_deploys');
const migrated = deploys.deploys.filter(
  (d) => d.status === 'live' && d.migration && typeof d.migration.note === 'string'
);
const changes = await invoke('list_changes');
let suspect = null;
for (const d of migrated) {
  const m = (changes.migrations ?? []).find((x) => x.byDeploy === d.id);
  if (!m) continue;
  const prose = `${d.migration.note} ${m.note ?? ''}`;
  if (/reads v1|v1 layout only|cannot read|only v1/i.test(prose) && m.writtenInNewFormat > 0) {
    suspect = { id: d.id, rows: m.writtenInNewFormat };
    break;
  }
}
if (!suspect) throw new Error('driver expected a layout-migration deploy already in traffic');
await invoke('read_logs');
console.log(
  `[driver] found ${suspect.id}: ${suspect.rows} rows already in the new layout, old code path cannot read them — flag-off + roll-forward plan`
);

// --- human: escalate to diagnosis (mode pill click) -----------------------
await page.getByTestId('mode-diagnosis').click();

// --- agent proposes mitigation; human approves via the card ---------------
const flagProp = await invoke('propose_flag_change', { id: 'new-checkout', state: 'off' });
if (flagProp.status !== 'proposed') throw new Error(`flag proposal: ${JSON.stringify(flagProp)}`);
// presence evidence (M3-06): agent cursor + proposal card mid-run
await page.getByTestId(`approval-${flagProp.proposalSeq}`).waitFor({ timeout: 10_000 });
await page.evaluate(() => window.__annotate({ type: 'deploy', id: 'd-201' }));
await page.waitForTimeout(400);
await page.screenshot({ path: 'log/m3-06-presence.png' });
await page.getByTestId(`approve-${flagProp.proposalSeq}`).click();
await healthIs('ok');
console.log('[driver] mitigation approved + executed — health green');

// --- human: recovery; agent ships the fix; human approves -----------------
await page.getByTestId('mode-recovery').click();
const fwdProp = await invoke('propose_rollforward', { service: 'api' });
if (fwdProp.status !== 'proposed') throw new Error(`rollforward proposal: ${JSON.stringify(fwdProp)}`);
await page.getByTestId(`approve-${fwdProp.proposalSeq}`).click();
await page.waitForFunction(
  () => document.querySelector('#event-stream').textContent.includes('v2.0.1 serving'),
  null,
  { timeout: 20_000 }
);
const finalStatus = await invoke('airlock_status');
if (finalStatus.incidentOpen) throw new Error('scenario did not resolve');
console.log('[driver] resolved: d-202 serving, incident closed');

// --- trace out ------------------------------------------------------------
mkdirSync('log/driver-runs', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const trace = {
  ranAt: stamp,
  url: URL,
  outcome: 'resolved',
  // evals-cli expectedCall shape: what a tool-selection eval would assert
  expectedCall: calls.map(({ functionName, arguments: args }) => ({ functionName, arguments: args })),
  calls,
};
const path = `log/driver-runs/${stamp}.json`;
writeFileSync(path, JSON.stringify(trace, null, 2));
console.log(`[driver] trace → ${path} (${calls.length} tool calls)`);

await browser.close();
console.log('[driver] GREEN');
