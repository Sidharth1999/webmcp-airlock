# Architecture map — who owns what, and which tests hold the line

> For any cross-file change: find your files here, read the invariants,
> check the named tests still pass. Written 2026-08-29 (M3 close) so
> follow-on sessions inherit the contracts instead of re-deriving them.

## Data flow

```
templates (migration-trap, baseline)          src/sim/templates.ts, migration-trap.ts
        │ setup()/tick()/onAction() emit events
        ▼
Engine — append-only EventLog + pure reducer  src/sim/engine.ts, log.ts, reducer.ts
        │  act() = world mutation (sim/human/agent)
        │  propose()/decide() = the AIRLOCK for agent writes
        │  record() = meta events (tool.called, mode/selection/annotation)
        ├────────────► queries: pure fns of (events, world)   src/sim/queries.ts
        │                    └── read tools' entire info surface
        ├────────────► Worker wraps Engine for the page       src/sim/worker.ts
        │                    └── main.ts renders + forwards   src/main.ts
        ├────────────► WebMCP surface                          src/webmcp/tools.ts, shim.ts
        │                    └── mode-gated registration, tombstones,
        │                        window.__airlock same-path invoke
        ├────────────► synthetic personas (behavior loop)     src/harness/run.ts
        ├────────────► metrics: fold of the log               src/harness/metrics.ts
        └────────────► scenario compiler (M4): 4-probe
                       auto-verification over param spaces    src/study/compiler.ts
```

## Module contracts

| module | owns | must stay true | held by |
|---|---|---|---|
| log.ts / reducer.ts | event order, world fold | reducer is pure; world = replay(events) always | sim.test.ts |
| engine.ts | act/propose/decide/record/step | gating enforced in ENGINE not UI; decide() re-checks mode + dual-key at decision time; proposals survive blocks | airlock.test.ts |
| vocabulary.ts | the ONLY write-action registry (tier ladder deploy<env<flag<route) | no write off this registry is proposable | airlock.test.ts |
| modes.ts | mode derived from log; MODE_TIERS | mode is never stored, always derived | airlock.test.ts |
| queries.ts | read-tool responses | ≤1.2KB/page, asOfSeq, newest-first cursors dupe-free under appends AND selection changes | queries.test.ts |
| templates | scenario truth + answer key (meta.solutions/traps) | onAction reacts only to world-confirmed state (e.g. rollback trap checks reducer outcome) | migration-trap.test.ts |
| worker.ts | canonical log for the page | worker log is the single source of truth; main.ts never mutates world | smoke browser gates |
| main.ts | render + forward + approval cards + selection | only node clicks change selection; stream eviction preserves audit rows; re-seed = full reset via airlockTools.reset() | smoke gates |
| webmcp/tools.ts | registration lifetimes, tombstones | AbortController per mode-scoped tool; reset() clears tombstones; invoke() = same execute path as real WebMCP | tools.test.ts |
| harness/run.ts | persona policies over TOOL RESULTS only | personas never peek at engine internals; permissive operator = structure is the treatment | harness.test.ts |
| harness/metrics.ts | study numbers off the log | counts only agent-actor blocks as attempts; correctPath = declared solution subsequence, no trap executed | harness.test.ts |
| study/compiler.ts | corpus generation + verification | a candidate ships only if: breaks alone, stays broken, every solution resolves, every trap punishes, byte-identical replay | compiler.test.ts |

## Event vocabulary (docs/schema.md is normative)
scenario.seeded · traffic.tick · log.line · service.health · deploy.started/
finished · migration.applied · user.impact · action.proposed/approved/
rejected/blocked/executed · tool.called · mode.changed · selection.changed ·
annotation.added

Threading: `causedBy` chains proposal → approval → execution → consequences.
The audit view and the study metrics both ride this chain — never break it.

## Where M4 plugs in
- Campaign runner (M4-03, BUILT 2026-08-30): drives an LLM through the SAME
  loop shape as harness/run.ts — reads via runQuery, writes via
  propose+scripted-operator (gated arm) or act (ungated).
  Spec: docs/campaign-runner-spec.md.
  | module | owns | must stay true |
  |---|---|---|
  | study/campaign.ts | the run loop, the arms, cost math, resumability | pure of I/O — client AND store are injected, so every claim is a vitest test with no key; both arms get the identical tool surface (the gate is the treatment, not the menu) |
  | study/mock-client.ts | harness personas as tool calls | decides from tool RESULTS only, never engine internals; resets on an empty transcript |
  | study/openai-client.ts | the Responses API seam | stable prefix + verbatim echo of prior output items (cache ratio the cost projection assumes); usage read off the response, never estimated |
  | tools/run-campaign.ts | fs + network + CLI | the ONLY campaign file allowed to touch either |
- Curves (M4-04): computeMetrics over persisted campaign logs. No new
  metric sources — if a number isn't derivable from the event log, it
  doesn't go on screen (ratified consensus rule).
