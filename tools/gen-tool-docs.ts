/**
 * npm run docs:tools — regenerate docs/webmcp-surface.md from the tool specs.
 *
 * The reference is GENERATED, never hand-edited: every name, description,
 * schema and annotation below is read from src/webmcp/tools.ts through the
 * same `createAirlockTools` path the page uses, against a fake modelContext
 * that records what gets registered and what gets aborted. The per-stage
 * surface is therefore observed, not transcribed — and cross-checked against
 * MODE_WRITE_TOOLS so the doc cannot drift from the grant table.
 *
 * Output is deterministic (no dates), so a regenerate with no source change
 * is a no-op diff.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAirlockTools, READ_TOOLS, WRITE_TOOLS } from '../src/webmcp/tools';
import type { ModelContextLike, ToolDescriptor } from '../src/webmcp/shim';
import { DUAL_KEY_TIER, MODES, MODE_WRITE_TOOLS, type Mode } from '../src/sim/modes';
import { WRITE_ACTIONS } from '../src/sim/vocabulary';

// ---- observe the surface through the real registration path -------------

const descriptors = new Map<string, ToolDescriptor>();
const live = new Set<string>();
const fakeContext: ModelContextLike = {
  registerTool(tool, opts) {
    descriptors.set(tool.name, tool);
    live.add(tool.name);
    opts?.signal?.addEventListener('abort', () => live.delete(tool.name));
  },
};

const tools = createAirlockTools(
  async () => ({}),
  async () => ({ seq: 0, outcome: 'proposed' as const }),
  () => {},
  () => {},
  fakeContext
);

/** Which tools are on the surface in each stage, as the host would see it. */
const surface: Record<Mode, string[]> = { triage: [], diagnosis: [], recovery: [] };
for (const mode of MODES) {
  tools.setMode(mode);
  surface[mode] = [...live].sort();
}

// The doc must agree with the grant table, or it is not a reference.
const ALWAYS = [...READ_TOOLS.map((t) => t.name), 'record_finding', 'propose_plan'];
for (const mode of MODES) {
  const expected = [...ALWAYS, ...MODE_WRITE_TOOLS[mode]].sort();
  const got = surface[mode];
  if (JSON.stringify(expected) !== JSON.stringify(got)) {
    throw new Error(`surface for ${mode} disagrees with MODE_WRITE_TOOLS:\n  got ${got}\n  want ${expected}`);
  }
}

const stagesFor = (name: string): string =>
  MODES.filter((m) => surface[m].includes(name))
    .map((m) => m)
    .join(' · ');

// ---- rendering ------------------------------------------------------------

type Schema = {
  type?: string;
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
};

const esc = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** `{ deployId*: string, percent: number }` — `*` marks required. */
function schemaSummary(schema: Schema): string {
  const props = schema.properties ?? {};
  const req = new Set(schema.required ?? []);
  const keys = Object.keys(props);
  if (keys.length === 0) return '_none_';
  const parts = keys.map((k) => {
    const p = props[k]!;
    const star = req.has(k) ? '*' : '';
    if (p.type === 'array' && p.items?.properties) {
      return `${k}${star}: ${schemaSummary(p.items)}[]`;
    }
    return `${k}${star}: ${p.type ?? 'any'}`;
  });
  return `{ ${parts.join(', ')} }`;
}

/** Every parameter description, verbatim, one bullet per parameter. */
function paramLines(schema: Schema, prefix = ''): string[] {
  const props = schema.properties ?? {};
  const req = new Set(schema.required ?? []);
  const out: string[] = [];
  for (const [k, p] of Object.entries(props)) {
    const name = `${prefix}${k}`;
    const tag = req.has(k) ? 'required' : 'optional';
    out.push(`- \`${name}\` (${p.type ?? 'any'}, ${tag}) — ${p.description ?? ''}`);
    if (p.items?.properties) out.push(...paramLines(p.items, `${name}[].`));
  }
  return out;
}

function annotations(d: ToolDescriptor): string {
  const a = d.annotations ?? {};
  const set = Object.entries(a)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${String(v)}`);
  return set.length ? set.join('<br>') : '_none_';
}

function mapsTo(name: string): string {
  const w = WRITE_TOOLS.find((t) => t.name === name);
  if (!w) return '—';
  const action = WRITE_ACTIONS[w.action];
  if (!action) return `\`${w.action}\``;
  const key = action.tier >= DUAL_KEY_TIER ? ' · **dual key**' : '';
  return `\`${w.action}\`<br>tier ${action.tier} · ${action.tierName}${key}`;
}

const HEAD = '| tool | description | input | annotations | stages | maps to |\n| --- | --- | --- | --- | --- | --- |';

function row(name: string, maps: string): string {
  const d = descriptors.get(name);
  if (!d) throw new Error(`no descriptor registered for ${name}`);
  return [
    `\`${d.name}\``,
    esc(d.description),
    `\`${schemaSummary((d.inputSchema ?? {}) as Schema)}\``,
    annotations(d),
    stagesFor(name),
    maps,
  ].join(' | ');
}

function table(names: string[], maps: (n: string) => string): string {
  return [HEAD, ...names.map((n) => `| ${row(n, maps(n))} |`)].join('\n');
}

const incidentCommand = MODE_WRITE_TOOLS.triage;
const production = WRITE_TOOLS.map((t) => t.name).filter((n) => !incidentCommand.includes(n));
const readNames = READ_TOOLS.map((t) => t.name);

const counts = {
  reads: readNames.length,
  writes: WRITE_TOOLS.length,
  total: descriptors.size,
};

// Chrome's registration budgets (see the header comment in tools.ts).
const overBudget: string[] = [];
for (const d of descriptors.values()) {
  if (d.name.length > 30) overBudget.push(`${d.name}: name ${d.name.length} > 30`);
  if (d.description.length > 500) overBudget.push(`${d.name}: description ${d.description.length} > 500`);
  for (const line of paramLines((d.inputSchema ?? {}) as Schema)) {
    const desc = line.split(' — ')[1] ?? '';
    if (desc.length > 150) overBudget.push(`${d.name}: a param description is ${desc.length} > 150`);
  }
}
if (overBudget.length) {
  console.error('[docs:tools] over Chrome budget:\n  ' + overBudget.join('\n  '));
}

const lines: string[] = [];
const push = (...ls: string[]) => lines.push(...ls);

push(
  '# The WebMCP surface',
  '',
  '<!-- GENERATED by `npm run docs:tools` (tools/gen-tool-docs.ts) from src/webmcp/tools.ts. Do not edit by hand. -->',
  '',
  `Release Airlock registers **${counts.total} tools** on \`document.modelContext\`: ` +
    `${counts.reads} reads that answer live, a notebook the agent writes its own conclusions into, ` +
    `${counts.writes} proposal tools, and a plan tool. Every string below is read from the tool ` +
    'descriptors themselves, through the same `createAirlockTools` path the page uses — this file is ' +
    'a function of the source, regenerated by `npm run docs:tools`, and the generator fails if the ' +
    'observed surface disagrees with the grant table (`MODE_WRITE_TOOLS`).',
  '',
  '## How to read it',
  '',
  '- **The surface is a function of console state.** Reads, the notebook and the plan tool are ' +
    'registered once and never leave. Proposal tools are registered per response stage — ' +
    `${MODES.map((m) => `**${m}** (${surface[m].length} tools)`).join(' → ')} — each with its own ` +
    '`AbortController`, so moving the stage unregisters and registers tools underneath a live ' +
    'agent session and a real host fires `toolchange`. A tool that leaves is tombstoned and ' +
    '`explain_surface` says why.',
  '- **A write tool cannot execute anything.** Its only successful return is ' +
    '`{ status: "proposed", proposalSeq, note }`: an approval card in front of the operator, and the ' +
    'world unchanged. The engine re-checks the stage, the tier and the dual key **at decision time**, ' +
    'not at proposal time. A client that ignores the surface and calls a write outside its stage gets ' +
    '`{ status: "blocked", blockedSeq, reason }` and an `action.blocked` row in the audit log.',
  '- **Reads are never gated** — the airlock gates consequence, not observability. Every read answers ' +
    'with `asOfSeq` (the log position it reflects); paginated reads are newest-first via `cursor` and ' +
    'pages stay under 1.2KB.',
  `- **Tier** is the risk ladder, 1 (lowest) to ${DUAL_KEY_TIER}; the word after it is the domain the lever ` +
    `is attached to. Tier ${DUAL_KEY_TIER} needs the operator to hold the dual key while the write ` +
    'executes. **maps to** is the simulator action key the proposal becomes; the approval card also ' +
    "carries that lever's stated cost from the vocabulary.",
  '- **Annotations** are the WebMCP hints as registered. `untrustedContentHint` marks the one read whose ' +
    'payload can carry external text; the page audits every read into its own event log, so a proposal ' +
    'whose target only ever appeared inside that untrusted text is detected and promoted to the dual key.',
  '- In the **input** column `*` marks a required field. Parameter descriptions, verbatim, are in the ' +
    'appendix.',
  '',
  '## Reads',
  '',
  table(readNames, mapsTo),
  '',
  '## Notebook',
  '',
  'Present in every stage. Changes nothing in the world and needs no approval — the airlock gates ' +
    'actions, not speech. Returns `{ status: "recorded" }`. `advisesAgainst` is what lets the agent ' +
    'object before the operator\'s click: reach for that control and its reasoning appears beside it.',
  '',
  table(['record_finding'], mapsTo),
  '',
  '## Incident-command proposals',
  '',
  'Granted from **triage** on: a page can let an agent help run the incident long before it lets one ' +
    'touch production.',
  '',
  table(incidentCommand, mapsTo),
  '',
  '## Production proposals',
  '',
  'Absent in triage — not refused, *not registered*. **diagnosis** adds the reversible levers; ' +
    '**recovery** adds the ones that move data, move customers, or cannot be undone in the moment.',
  '',
  table(production, mapsTo),
  '',
  '## Plan',
  '',
  'Present wherever writes are. A plan is a claim on the record, never a grant: the tool records the ' +
    'ordered intent and its reason, proposes **step 1 only**, and step N+1 is not proposed until step N ' +
    'has executed. Every step is shape-checked against its proposal tool and the current stage before ' +
    'anything is recorded. Returns `{ status: "planned", planId, steps, note }`.',
  '',
  table(['propose_plan'], mapsTo),
  '',
  '## Surface by stage',
  '',
  '| stage | tools | proposal tools registered |',
  '| --- | --- | --- |',
  ...MODES.map(
    (m) =>
      `| ${m} | ${surface[m].length} | ${MODE_WRITE_TOOLS[m].map((n) => `\`${n}\``).join(', ')} |`
  ),
  '',
  '## Appendix — parameter descriptions, verbatim',
  ''
);

for (const name of [...readNames, 'record_finding', ...incidentCommand, ...production, 'propose_plan']) {
  const d = descriptors.get(name)!;
  const params = paramLines((d.inputSchema ?? {}) as Schema);
  push(`### \`${name}\``, '');
  push(...(params.length ? params : ['- _no input_']), '');
}

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../docs/webmcp-surface.md');
writeFileSync(out, lines.join('\n').trimEnd() + '\n');
console.log(`[docs:tools] wrote ${out}: ${counts.total} tools, ${MODES.length} stages`);
