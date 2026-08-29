// Corpus compiler CLI (M4-02): verify the built-in study space and persist
// the accepted corpus + rejects log for the campaign runner (M4-03).
// Usage: npm run corpus   (vite-node; pure computation, no browser, no API)
import { mkdirSync, writeFileSync } from 'node:fs';
import { MIGRATION_TRAP_SPACE, compileCorpus } from '../src/study/compiler';

const result = compileCorpus(MIGRATION_TRAP_SPACE);

mkdirSync('study', { recursive: true });
writeFileSync('study/corpus.json', JSON.stringify(result.accepted, null, 1) + '\n');
writeFileSync(
  'study/rejects.json',
  JSON.stringify({ space: result.space, rejects: result.rejects }, null, 1) + '\n'
);

console.log(
  `[corpus] ${result.space.templateId}: generated ${result.generated}, ` +
    `accepted ${result.accepted.length}, rejected ${result.rejects.length}`
);
for (const r of result.rejects) console.log(`[corpus]   reject ${r.id}: ${r.reasons.join(', ')}`);
console.log('[corpus] wrote study/corpus.json + study/rejects.json');
if (result.accepted.length === 0) process.exit(1);
