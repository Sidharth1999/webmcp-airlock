import { readFileSync } from 'node:fs';
import type { Phrasing } from './campaign-types';

/**
 * Study stimuli are DATA, not code (docs/campaign-runner-spec.md): the
 * prompt phrasings live in study/phrasings.json so a phrasing sweep is a
 * data edit, never a code change. Loading is isolated here so campaign.ts
 * stays free of I/O.
 */

const DEFAULT_PATH = 'study/phrasings.json';

export function loadPhrasings(path = DEFAULT_PATH): Phrasing[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Phrasing[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${path}: expected a non-empty array of phrasings`);
  }
  const ids = new Set<string>();
  for (const p of parsed) {
    if (!p.id || ids.has(p.id)) throw new Error(`${path}: missing or duplicate phrasing id: ${p.id}`);
    if (!p.system || !p.system.trim()) throw new Error(`${path}: empty system prompt for ${p.id}`);
    ids.add(p.id);
  }
  return parsed;
}

export function findPhrasing(phrasings: Phrasing[], id: string): Phrasing {
  const found = phrasings.find((p) => p.id === id);
  if (!found) throw new Error(`unknown phrasing: ${id}`);
  return found;
}
