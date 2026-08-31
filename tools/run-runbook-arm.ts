// Runbook arm CLI: run the published static decision tree over the verified
// corpus and report per-variant, split by trained-on vs held-out.
// Usage: npm run runbook   (vite-node; no browser, no API, no tokens)
import { readFileSync, writeFileSync } from 'node:fs';
import { runRunbookArm, summarize, type RunbookArmResult } from '../src/study/runbook-arm';
import { TRAINING_SET } from '../src/study/runbook';
import type { Candidate } from '../src/study/compiler';

const corpus = JSON.parse(readFileSync('study/corpus.json', 'utf8')) as Array<{
  candidate: Candidate;
}>;

const results: RunbookArmResult[] = corpus.map((c) => runRunbookArm(c.candidate));

const trained = results.filter((r) => !r.heldOut);
const held = results.filter((r) => r.heldOut);

const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(0)}%`);

console.log('\n=== RUNBOOK ARM (static decision tree, token-free) ===');
console.log(`training set: ${TRAINING_SET.describe}\n`);

for (const [label, set] of [
  ['TRAINED ON', trained],
  ['HELD OUT  ', held],
] as const) {
  const s = summarize(set);
  console.log(
    `${label}  n=${String(s.total).padStart(2)}  correct ${String(s.correct).padStart(2)} (${pct(s.correct, s.total)})  ` +
      `trapped ${String(s.trapped).padStart(2)}  no-rule ${s.noRule}  mean damage ${s.meanDamage}`
  );
}

console.log('\n--- per variant ---');
for (const r of results) {
  const mark = r.correct ? 'WIN ' : r.trapped ? 'TRAP' : 'MISS';
  console.log(
    `${mark} ${r.heldOut ? '[held-out]' : '[trained] '} ${r.candidate.id.padEnd(42)} ` +
      `${r.rules.join('>').padEnd(34)} -> ${r.actions.join(' , ') || 'none'}`
  );
}

writeFileSync(
  'study/runbook-arm.json',
  JSON.stringify(
    {
      trainingSet: TRAINING_SET.describe,
      summary: {
        trainedOn: summarize(trained),
        heldOut: summarize(held),
        // Broken out per family so the held-out aggregate cannot be read as
        // padding: adding a third family enlarges the held-out set, and the
        // reader is entitled to see each family's contribution separately.
        heldOutByTemplate: Object.fromEntries(
          [...new Set(held.map((r) => r.candidate.templateId))].map((id) => [
            id,
            summarize(held.filter((r) => r.candidate.templateId === id)),
          ])
        ),
      },
      results: results.map((r) => ({
        id: r.candidate.id,
        heldOut: r.heldOut,
        rules: r.rules,
        actions: r.actions,
        why: r.decision.why,
        correct: r.correct,
        trapped: r.trapped,
        damage: r.metrics.damageRevenueLost,
      })),
    },
    null,
    1
  ) + '\n'
);
console.log('\n[runbook] wrote study/runbook-arm.json');
