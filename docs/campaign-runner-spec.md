# M4-03 campaign runner — design spec (implement against this)

> Decided 2026-08-29 by the M3-close session so implementation is
> mechanical. Deviations from this spec are architecture decisions —
> record them in PLAN.md, don't improvise silently.
> Types are already stubbed in `src/study/campaign-types.ts`; implement
> to those signatures.

## Goal
Drive a real LLM agent through the SAME loop shape as the synthetic
harness (src/harness/run.ts), gated vs ungated, across study/corpus.json ×
prompt phrasings, persisting one JSON record per run. Fully buildable and
dry-runnable WITHOUT an API key via MockClient.

## Non-negotiables (from RUNBOOK + cost projection)
1. **No key, no spend, still testable**: `LLMClient` is an interface; the
   loop, bridge, persistence, and metrics are proven with MockClient in
   vitest before any real call.
2. **Resumable**: runId = `sha256(candidateId|arm|phrasingId|model|seed)`
   first 16 hex chars. A run whose file exists with status:'done' is
   SKIPPED. A crashed campaign never re-pays finished runs.
3. **Usage captured per API response** (input, cached input, output
   tokens) and rolled up per run — the canary gate reads these fields,
   never estimates.
4. **Canary discipline** (cost-projection.md): `--canary` runs exactly 20
   terra runs and hard-exits nonzero if avg cost/run > $0.40.
5. **Turn cap 25** per run; a capped run persists with status:'capped'
   (that's data, not an error).
6. Determinism where it's ours: engine seeded from the candidate; the only
   nondeterminism in a record is the LLM's own output.

## File layout
- `src/study/campaign-types.ts` — types (already written, do not weaken)
- `src/study/campaign.ts` — `runOne(spec, client)`, pure of I/O except via
  injected client; returns RunRecord
- `src/study/openai-client.ts` — real LLMClient over OpenAI Responses API
  (key from `process.env.OPENAI_API_KEY`, never committed; models:
  gpt-5.6-luna / -terra / -sol)
- `src/study/mock-client.ts` — scripted client replaying the naive and
  diligent policies as tool-call responses (proves the loop end-to-end)
- `study/phrasings.json` — 4 system-prompt variants, DATA not code:
  {id, system} — vary tone/verbosity/urgency, never the facts
- `tools/run-campaign.ts` (vite-node; npm script "campaign") — CLI:
  `--models terra --arms gated,ungated --phrasings all --canary|--full
  --campaign <name>`; writes `study/campaign/<name>/<runId>.json` and a
  running `summary.json` (counts, cost so far, canary verdict)

## The loop (mirror run.ts, one LLM turn ≈ one persona turn)
1. Fresh Engine from the candidate (templateId, seed, params).
2. `engine.step(2)` per turn — the world does not wait for the agent.
3. Tool surface: reuse READ_TOOLS/WRITE_TOOLS **specs from
   src/webmcp/tools.ts** mapped to OpenAI tool-definition format — one
   source of truth for names/descriptions/schemas; description text is the
   study variable later, so keep the mapping trivial.
4. Tool dispatch:
   - reads → `runQuery(engine.events, engine.world, q)` + record
     tool.called (same as harness `read()`)
   - writes, gated arm → `engine.propose`; blocked ⇒ return the same
     blocked JSON the page returns (status/reason/note from tools.ts);
     proposed ⇒ scripted permissive operator approves immediately
     (`engine.decide(seq,'approve','operator')` — key always turned;
     STRUCTURE is the treatment, same policy as the harness)
   - writes, ungated arm → `engine.act(tool, input, 'agent')` directly
5. Stop when: status query shows resolved and the model stops calling
   tools, or turn cap. Then `engine.step(4)` settle +
   `computeMetrics(engine.events, template.meta)`.
6. Persist RunRecord: spec, transcript (every message + tool I/O), usage
   rollup, metrics, status, timings, cost (computed from usage × the price
   table in cost-projection.md — put prices in campaign-types.ts PRICES so
   there is exactly one place to correct them at key unlock).

## Tests Opus writes FIRST (ratchet order)
1. mock gated diligent run resolves: correctPath=true, catastrophic=false
2. mock ungated naive run goes catastrophic (the counterfactual, through
   the campaign path this time)
3. resumability: pre-existing done record ⇒ client never called
4. usage rollup + cost math against a fixture with known token counts
5. canary verdict: fixture avg > $0.40 ⇒ nonzero exit path
6. phrasing loading: 4 variants, ids unique, system text non-empty

## Explicitly out of scope for M4-03
Curves/plots (M4-04) · description optimization sweeps (uses this runner
later) · any Anthropic-side arms · touching src/sim or src/webmcp beyond
importing their exports (if the bridge needs an export added, add the
export + a test, nothing else).
