// Corpus compiler CLI (M4-02): verify the built-in study space and persist
// the accepted corpus + rejects log for the campaign runner (M4-03).
// Usage: npm run corpus   (vite-node; pure computation, no browser, no API)
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  INNOCENT_DEPLOY_SPACE,
  MIGRATION_TRAP_SPACE,
  POISONED_RUNBOOK_SPACE,
  compileCorpus,
} from '../src/study/compiler';

const results = [MIGRATION_TRAP_SPACE, INNOCENT_DEPLOY_SPACE, POISONED_RUNBOOK_SPACE].map((space) =>
  compileCorpus(space)
);

const accepted = results.flatMap((r) => r.accepted);
const rejects = results.flatMap((r) => r.rejects);

mkdirSync('study', { recursive: true });
writeFileSync('study/corpus.json', JSON.stringify(accepted, null, 1) + '\n');
writeFileSync(
  'study/rejects.json',
  JSON.stringify(
    { spaces: results.map((r) => r.space), rejects },
    null,
    1
  ) + '\n'
);

for (const r of results) {
  console.log(
    `[corpus] ${r.space.templateId}: generated ${r.generated}, ` +
      `accepted ${r.accepted.length}, rejected ${r.rejects.length}`
  );
  for (const rej of r.rejects) console.log(`[corpus]   reject ${rej.id}: ${rej.reasons.join(', ')}`);
}
console.log(`[corpus] TOTAL accepted ${accepted.length}`);
console.log('[corpus] wrote study/corpus.json + study/rejects.json');
if (accepted.length === 0 || rejects.length > 0) process.exit(1);
