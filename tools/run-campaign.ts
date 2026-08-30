import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CANARY_RUNS,
  canaryExitCode,
  canaryVerdict,
  planSpecs,
  runCampaign,
} from '../src/study/campaign';
import type {
  Arm,
  CampaignModel,
  CampaignStore,
  LLMClient,
  RunRecord,
} from '../src/study/campaign-types';
import { MockClient, type MockPersona } from '../src/study/mock-client';
import { OpenAIClient } from '../src/study/openai-client';
import { loadPhrasings } from '../src/study/phrasings';
import type { Candidate } from '../src/study/compiler';
import type { VerifyReport } from '../src/study/compiler';

/**
 * M4-03 CLI. The only file in the campaign path that touches the filesystem
 * or the network — campaign.ts stays injectable and therefore testable.
 *
 *   npm run campaign -- --dry --campaign smoke        (MockClient, no key, no spend)
 *   npm run campaign -- --canary --campaign canary    (20 terra runs, hard gate)
 *   npm run campaign -- --full --campaign v1 --models terra --arms gated,ungated
 *
 * Every run is one JSON file under study/campaign/<name>/<runId>.json;
 * re-running the same campaign skips anything already status:'done'.
 */

const MODEL_ALIASES: Record<string, CampaignModel> = {
  luna: 'gpt-5.6-luna',
  terra: 'gpt-5.6-terra',
  sol: 'gpt-5.6-sol',
  'gpt-5.6-luna': 'gpt-5.6-luna',
  'gpt-5.6-terra': 'gpt-5.6-terra',
  'gpt-5.6-sol': 'gpt-5.6-sol',
};

function arg(name: string, fallback?: string): string | undefined {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--')) {
    return process.argv[i + 1];
  }
  return fallback;
}

const has = (name: string): boolean => process.argv.includes(`--${name}`);

function loadCorpus(path = 'study/corpus.json'): Candidate[] {
  const reports = JSON.parse(readFileSync(path, 'utf8')) as VerifyReport[];
  const accepted = reports.filter((r) => r.accepted).map((r) => r.candidate);
  if (accepted.length === 0) throw new Error(`${path}: no accepted candidates — run npm run corpus`);
  return accepted;
}

function fileStore(dir: string): CampaignStore {
  mkdirSync(dir, { recursive: true });
  return {
    load(runId) {
      const path = join(dir, `${runId}.json`);
      if (!existsSync(path)) return undefined;
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as RunRecord;
      } catch {
        return undefined; // a half-written record is a re-run, not a crash
      }
    },
    save(record) {
      writeFileSync(join(dir, `${record.spec.runId}.json`), JSON.stringify(record, null, 2));
    },
  };
}

function existingRecords(dir: string): RunRecord[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'summary.json')
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as RunRecord);
}

async function main(): Promise<void> {
  const dry = has('dry');
  const canary = has('canary');
  const name = arg('campaign', dry ? 'dry' : canary ? 'canary' : 'v1')!;
  const dir = join('study/campaign', name);

  const models = (arg('models', canary ? 'terra' : 'terra')!)
    .split(',')
    .map((m) => {
      const resolved = MODEL_ALIASES[m.trim()];
      if (!resolved) throw new Error(`unknown model: ${m} (use luna|terra|sol)`);
      return resolved;
    });
  const arms = arg('arms', 'gated,ungated')!.split(',').map((a) => a.trim()) as Arm[];
  const phrasings = loadPhrasings();
  const phrasingArg = arg('phrasings', 'all')!;
  const phrasingIds =
    phrasingArg === 'all' ? phrasings.map((p) => p.id) : phrasingArg.split(',').map((p) => p.trim());
  const candidates = loadCorpus();

  let specs = planSpecs(candidates, arms, phrasingIds, models);
  if (canary) {
    if (models.length !== 1 || models[0] !== 'gpt-5.6-terra') {
      throw new Error('the canary gate is defined on terra only (cost-projection.md)');
    }
    specs = specs.slice(0, CANARY_RUNS);
  }
  const limit = Number(arg('limit', '0'));
  if (limit > 0) specs = specs.slice(0, limit);

  const client: LLMClient = dry
    ? new MockClient((arg('persona', 'diligent') as MockPersona) ?? 'diligent')
    : new OpenAIClient(models[0]!);

  console.log(
    `[campaign] ${name}: ${specs.length} run(s) · models=${models.join(',')} · arms=${arms.join(',')} · phrasings=${phrasingIds.length} · client=${dry ? 'MOCK (no spend)' : 'OpenAI'}`
  );
  if (!dry && !process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set — run with --dry, or unlock the key first');
  }

  const store = fileStore(dir);
  const summary = await runCampaign(specs, client, store, {
    name,
    phrasings,
    ...(arg('max-turns') ? { maxTurns: Number(arg('max-turns')) } : {}),
    onRun(record, running) {
      console.log(
        `[campaign] ${record.spec.runId} ${record.spec.arm}/${record.spec.phrasingId} ` +
          `${record.status} · ${record.turns.length} turns · $${record.usage.costUsd.toFixed(4)} · ` +
          `correctPath=${record.metrics.correctPath} catastrophic=${record.metrics.catastrophic} ` +
          `blocked=${record.metrics.writesBlocked} · running $${running.totalCostUsd.toFixed(2)}`
      );
    },
  });

  const all = existingRecords(dir);
  const verdict = canary ? canaryVerdict(all.filter((r) => r.status !== 'error')) : undefined;
  writeFileSync(
    join(dir, 'summary.json'),
    JSON.stringify({ ...summary, ...(verdict ? { canary: verdict } : {}) }, null, 2)
  );

  console.log(
    `[campaign] done: ${summary.completed} completed, ${summary.skipped} skipped, ` +
      `${summary.errors} errors, $${summary.totalCostUsd.toFixed(2)} total ` +
      `($${summary.avgCostPerRunUsd.toFixed(4)}/run)`
  );
  if (verdict) {
    console.log(`[campaign] ${verdict.note}`);
    process.exit(canaryExitCode(verdict));
  }
}

main().catch((err) => {
  console.error('[campaign] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
