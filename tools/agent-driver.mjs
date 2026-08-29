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

// --- agent: reads reveal the trap ----------------------------------------
const deploys = await invoke('list_deploys');
const suspect = deploys.deploys.find(
  (d) => d.status === 'live' && d.migration && d.migration.reversible === false
);
if (!suspect) throw new Error('driver expected an irreversible-migration deploy');
await invoke('read_logs');
console.log(`[driver] found ${suspect.id}: irreversible migration — flag-off + roll-forward plan`);

// --- human: escalate to diagnosis (mode pill click) -----------------------
await page.getByTestId('mode-diagnosis').click();

// --- agent proposes mitigation; human approves via the card ---------------
const flagProp = await invoke('propose_flag_change', { id: 'new-checkout', state: 'off' });
if (flagProp.status !== 'proposed') throw new Error(`flag proposal: ${JSON.stringify(flagProp)}`);
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
