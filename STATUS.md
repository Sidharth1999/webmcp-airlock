# STATUS — live audit log

**Updated:** 2026-08-28 (late session) · **Milestone:** M2 in progress (2/7) · **Progress: M2 28.6% · overall 19.2%** (run `python3 tools/progress.py`; RUNBOOK rule: report both %s at every session start and milestone close)
**Full context:** war room artifact https://claude.ai/code/artifact/798206ed-bc4f-44fd-b48c-874de5dfdcc0 · memory: project_webmcp_challenge

## This session (2026-08-28 late)
- **M2-01 DONE** — event log + pure reducer per schema v1: `src/sim/{types,log,reducer}.ts`. EventLog enforces monotonic time + valid causedBy back-refs, exposes `chainOf()` (causality thread). Reducer is pure (deep-freeze-proof in tests), total over all 20 EventKinds (explicit no-ops for kinds that don't touch World yet — M2-03/M3 extend).
- **M2-02 DONE** — deterministic seeded sim: mulberry32 (`rng.ts`), SimClock (`clock.ts`, 1 tick = 1s sim-time), Engine (`engine.ts`, folds world incrementally, `(templateId, seed, params)` = full replay key carried in event 0 `scenario.seeded`), message-driven Worker (`worker.ts` — zero wall-clock; pacing lives on the main thread). Lint ban ACTIVE: `tools/lint-sim.mjs` (TS-AST walk) bans Date.now/Math.random/new Date/performance.now in src/sim; self-tested (fixture with violations must fail).
- `baseline` template (`templates.ts`): benign steady state + one scripted self-healing deploy blip — exists so determinism/causedBy tests run on a real stream before the flagship migration-trap (M2-04). causedBy threads verified: deploy.started → deploy.finished → user.impact / service.health flap.
- **20 unit tests green** (vitest, new devDep + @types/node): rng, log invariants, reducer purity/determinism/incremental==batch, damage-from-formula, deploy supersede, byte-identical replay (same seed, step-batching invariance, params in replay key), causedBy chains, lint self-test.
- Console pane now renders the live event stream (Run/Pause control, status line, styled kinds, damage lines in red); masthead health is sim-driven (worst service) once running. Visual check saved: `log/m2-console-stream.png` — full incident arc visible.
- `npm run smoke` now = typecheck + **lint-sim + unit tests** + build + preview + 12 Playwright checks (16 gates total) incl. in-page byte-identical digest + worker stream flowing. GREEN.

## Observed facts (M0, Chrome 151 flagged)
- modelContext on document; registerTool/getTools/executeTool all present
- executeTool input must be a JSON STRING in Chrome 151 (pre-Aug-19-spec signature) — shim lives in src/webmcp/shim.ts (`executeToolCompat`)
- getTools returns RegisteredTool objects (passing a name throws); tools name-sorted
- toolchange fires per registration
- Chrome flag requires full relaunch to take effect (bit us once)
- Port 8899 occupied by pre-existing service; dev serves on 8917, smoke/preview on 8918
- M0 spike server retired; for remaining M0 probes re-serve on **8919**: `python3 -m http.server 8919 --directory spike`

## Current state
- Environment: node 20 ✓, gh authed ✓, Playwright ✓, Chrome 151 + WebMCP flag ENABLED ✓, ChatGPT desktop DOWNLOADED (login/verify pending), disk ✓
- Not yet: deploy CLI auth (deferred until needed), OPENAI_API_KEY (deferred to M4)
- Stealth intact: no git remotes, nothing deployed
- Sim scaffolding note: page boots the Worker seeded-but-paused; smoke's hue test uses the manual masthead buttons BEFORE starting the sim (deterministic, no race). Manual health buttons become dev-only once M2-06 lands.

## Next actions (fresh session boots here)
1. M2-03: world systems — flags/env/routes state transitions (need event vocabulary inside action.executed per schema Tool I/O contract), cache/queue state, richer traffic/damage model
2. M2-04: flagship migration-trap scenario template (naive rollback catastrophic; flag-off + roll-forward correct; template declares solution set; both paths verified by scripted run)
3. Then M2-05 (human-playable console UI) + M2-06 (living site pane)
4. Remaining M0 probes when convenient (spike on 8919 + attended ChatGPT desktop)

## Blocked / waiting on Sid
- ChatGPT desktop: launch + log in once; then the M0 localhost retests (attended, ~10 min)
- M2-07 feel review #1 (~D3, Sun 8/30-ish): Sid resolves the flagship incident himself

## Known issues
- "Run sim" button label wraps to two lines in the console header — cosmetic, fix in M2-05 UI pass

## How to run/demo
- `npm run dev` → http://localhost:8917 → click **Run sim** (seed 20260828): watch the scripted deploy blip arc (deploy at 5s → degraded + user.impact → recovery at 11s)
- `npm run smoke` → full gate (typecheck, lint-sim, unit tests, build, 12 browser checks), exits 0 when green
- `npm test` → 20 unit tests · `npm run lint:sim` → determinism ban
