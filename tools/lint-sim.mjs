// Determinism lint for sim code (schema v1 rule): no wall-clock, no ambient
// randomness in src/sim. Bans Date.now, Math.random, new Date, performance.now.
// Usage: node tools/lint-sim.mjs [dir]   (default: src/sim; exits 1 on violation)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const dir = process.argv[2] ?? 'src/sim';

const BANNED_CALLS = new Set(['Date.now', 'Math.random', 'performance.now']);

function tsFiles(d) {
  return readdirSync(d, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => join(e.parentPath ?? e.path, e.name));
}

const violations = [];

for (const file of tsFiles(dir)) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      const text = node.getText(source);
      if (BANNED_CALLS.has(text)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        violations.push(`${file}:${line + 1} — ${text} is banned in sim code (use SimClock / mulberry32)`);
      }
    }
    if (ts.isNewExpression(node) && node.expression.getText(source) === 'Date') {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push(`${file}:${line + 1} — new Date is banned in sim code (use SimClock)`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

if (violations.length > 0) {
  console.error(`[lint-sim] ${violations.length} violation(s):`);
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log(`[lint-sim] ok — ${dir} is wall-clock/Math.random free`);
