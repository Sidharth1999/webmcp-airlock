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

const writeTrace = (scenario, outcome, made) => {
  mkdirSync('log/driver-runs', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const trace = {
    ranAt: stamp,
    url: URL,
    scenario,
    outcome,
    // evals-cli expectedCall shape: what a tool-selection eval would assert
    expectedCall: made.map(({ functionName, arguments: args }) => ({ functionName, arguments: args })),
    calls: made,
  };
  const path = `log/driver-runs/${stamp}-${scenario}.json`;
  writeFileSync(path, JSON.stringify(trace, null, 2));
  console.log(`[driver] trace → ${path} (${made.length} tool calls)`);
};
writeTrace('migration-trap', 'resolved', calls);
await page.close();

// ==========================================================================
// SCENARIO 2 — the ORDERING story, unattended, through the plan object.
//
// The first scenario proves the airlock plumbing on a one-action answer.
// This one exists because retry-storm's answer is a SEQUENCE: cap /checkout
// to buy headroom, THEN ship the fix. Backwards is worse than doing nothing
// (the fleet is at its autoscaler ceiling, so a rolling replacement withdraws
// instances the incident cannot spare), and no single read says "shed first".
//
// Everything here goes through the same two doors as scenario 1: agent turns
// via window.__airlock.invoke, human turns via hit-tested clicks. The point
// being proved is the one the plan object exists for — STEP 2 IS NOT
// PROPOSED UNTIL STEP 1 HAS EXECUTED, and the run cannot fake that, because
// it waits on the step's own state before it can click anything.
// ==========================================================================
const ord = await browser.newPage({ viewport: { width: 1440, height: 860 } });
const ordCalls = [];
const ordInvoke = async (name, input = {}) => {
  const text = await ord.evaluate(([n, i]) => window.__airlock.invoke(n, i), [name, input]);
  ordCalls.push({ functionName: name, arguments: input, result: JSON.parse(text) });
  return JSON.parse(text);
};

console.log('[driver] scenario 2: retry-storm (the answer is an ORDER)');
await ord.goto(URL + '?template=retry-storm&tick=120', { waitUntil: 'networkidle' });
await ord.getByTestId('sim-run').click();
let ordStatus;
for (let i = 0; i < 80; i++) {
  ordStatus = await ordInvoke('airlock_status');
  if (ordStatus.incidentOpen) break;
  await ord.waitForTimeout(200);
}
if (!ordStatus.incidentOpen) throw new Error('retry-storm incident never opened');

// the stitch: offered rate on /checkout far above its organic share, the
// trigger already gone, and the fleet with no spare capacity. Three reads.
const traffic = await ordInvoke('traffic_history');
const ordDeploys = await ordInvoke('list_deploys');
const amplifier = ordDeploys.deploys.find((d) => d.status === 'live' && /retr/i.test(d.note ?? ''));
if (!amplifier) throw new Error('driver expected a live deploy whose note describes retries');
// The incident opens before the story is fully told: the trigger clearing and
// the autoscaler topping out arrive a few ticks later, and BOTH are needed —
// "the load is retries" is not readable from any one of them. So the agent
// keeps watching rather than concluding early, which is the behaviour the
// scenario is built to require.
let cleared;
let ceiling;
for (let i = 0; i < 80 && (!cleared || !ceiling); i++) {
  const page = await ordInvoke('read_logs');
  for (const l of page.lines ?? []) {
    if (!cleared && /cleared/i.test(l.msg)) cleared = l;
    if (!ceiling && /ceiling|no spare capacity/i.test(l.msg)) ceiling = l;
  }
  if (!cleared || !ceiling) await ord.waitForTimeout(250);
}
if (!cleared || !ceiling) {
  throw new Error(
    `driver never saw the retry-storm tells: cleared=${!!cleared} ceiling=${!!ceiling}`
  );
}
void traffic;
console.log(
  `[driver] stitched: ${amplifier.id} amplifies, trigger cleared (#${cleared.seq}), no spare capacity (#${ceiling.seq})`
);

// the agent says what it worked out, in the operator's console, before asking
await ordInvoke('record_finding', {
  summary: `The load on /checkout is retries, not customers: the db reported contention cleared (#${cleared.seq}) and the fleet is at its autoscaler ceiling (#${ceiling.seq}).`,
  ruledOut: `Shipping the fix first. A rolling replacement withdraws instances this incident cannot spare while the amplifier is still serving.`,
});

await ord.getByTestId('mode-recovery').click();
const plan = await ordInvoke('propose_plan', {
  reason: `The fleet is at its autoscaler ceiling with no spare instances (#${ceiling.seq}), so a rolling replacement withdraws capacity this incident cannot spare. Headroom has to exist before the fix ships.`,
  steps: [
    { tool: 'propose_rate_limit', input: { route: 'r-checkout', rps: 150 }, because: 'buys headroom now — it rejects real customers and fixes nothing' },
    { tool: 'propose_rollforward', input: { service: 'api' }, because: '2.4.2 is staged and green' },
  ],
});
if (plan.status !== 'planned') throw new Error(`plan rejected: ${JSON.stringify(plan)}`);
await ord.getByTestId(`plan-${plan.planId}`).waitFor({ timeout: 10_000 });

// THE GATE, asserted rather than assumed: with step 1 still pending, step 2
// must not have been put to the human at all.
const stepTwoBefore = await ord.getByTestId(`plan-step-${plan.planId}-1`).getAttribute('data-state');
if (stepTwoBefore !== 'pending') {
  throw new Error(`step 2 was proposed before step 1 ran (state=${stepTwoBefore})`);
}
const cardsBefore = await ord.locator(`[data-testid="plan-${plan.planId}"] .approval-card`).count();
if (cardsBefore !== 1) throw new Error(`a plan put ${cardsBefore} decisions to the human at once`);

// human turn: approve step 1 by clicking it, exactly as an operator would
await ord.locator('.pl-step[data-state="live"] .ap-approve').click();
await ord.waitForFunction(
  (id) => document.querySelector(`[data-testid="plan-step-${id}-1"]`)?.dataset.state === 'live',
  plan.planId,
  { timeout: 15_000 }
);
console.log('[driver] step 1 executed — and only now is step 2 proposed');
await ord.locator('.pl-step[data-state="live"] .ap-approve').click();
await ord.waitForFunction(
  (id) => document.querySelector(`[data-testid="plan-${id}"]`)?.dataset.state === 'complete',
  plan.planId,
  { timeout: 15_000 }
);

// The last step lands before its effect does — a rolling replacement takes
// ticks — so the run watches for the recovery rather than reading the world
// the instant it clicked. Reporting "resolved" off the click would be a lie.
let ordFinal;
for (let i = 0; i < 60; i++) {
  ordFinal = await ordInvoke('airlock_status');
  if (!ordFinal.incidentOpen) break;
  await ord.waitForTimeout(300);
}
if (ordFinal.incidentOpen) {
  throw new Error(
    `retry-storm did not recover after the plan ran in order (api=${ordFinal.services?.find((x) => x.id === 'api')?.health})`
  );
}
console.log(
  `[driver] resolved in order: shed then shipped · api ${ordFinal.services?.find((x) => x.id === 'api')?.health} · incident closed`
);
writeTrace('retry-storm', 'resolved', ordCalls);
await ord.close();

await browser.close();
console.log('[driver] GREEN');
