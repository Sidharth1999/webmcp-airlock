# STATUS — live audit log

**Updated:** 2026-08-28 (overnight session, ~2:40am) · **Milestone:** M2 in progress (4/7) · **Progress: M2 57.1% · overall 24.9%** (run `python3 tools/progress.py`; RUNBOOK rule: report both %s at every session start and milestone close)
**Full context:** war room artifact https://claude.ai/code/artifact/798206ed-bc4f-44fd-b48c-874de5dfdcc0 · memory: project_webmcp_challenge

## This session (2026-08-28 overnight, continued after a usage-limit cut)
- **M2-01 DONE** — event log + pure reducer per schema v1 (`src/sim/{types,log,reducer}.ts`): EventLog enforces monotonic time + valid causedBy, exposes `chainOf()`; reducer pure (deep-freeze-proof), total over all 20 EventKinds.
- **M2-02 DONE** — mulberry32 + SimClock + Engine (replay key in event 0, byte-identical proven incl. step-batching invariance) + message-driven Worker (zero wall-clock). Determinism lint ACTIVE and self-tested (`tools/lint-sim.mjs`: bans Date.now/Math.random/new Date/performance.now in src/sim).
- **M2-03 DONE** — world systems via the `action.executed` vocabulary (PLAN decision 2026-08-28): flag.set / env.set (values stored REDACTED) / route.set / deploy.rollback (revert-to-superseded semantics); deploy.finished materializes flagsTouched flags; Engine.act() = external-action entry; templates react via onAction().
- **M2-04 DONE** — flagship `migration-trap` template (`src/sim/migration-trap.ts`): d-201 ships checkout-v2 flag + irreversible sessions migration; declared answer key in meta (solutions: flag-off → roll-forward; trap: rollback). **Both paths verified by scripted runs**: rollback → api DOWN + web degraded ripple + >3× damage vs doing nothing, flag-off can't rescue it; correct path mitigates (damage stops, recovery event threads causedBy to the human action) then resolves on d-202. Errors concentrate on /checkout (decision-grade byRoute); clue log lines drip causedBy-threaded to the deploy. Deterministic under a scripted act() schedule across seeds.
- **32 unit tests green** (2 files); `npm run smoke` = 16 gates GREEN. Console pane renders the live stream (Run/Pause); visual check at `log/m2-console-stream.png`.
- **RECORD CORRECTION (Sid caught it):** ChatGPT desktop is INSTALLED + LOGGED IN and M0-01/02 were verified IN ChatGPT desktop on localhost — evidence `log/m0-01-live-invocation.png`, `m0-01-tool-discovery.png`, `m0-02-toolchange-flip.png` (01:37 8/28). Prior STATUS "login/verify pending" was stale carry-forward. Only the attended M0-05/06/07 probe session remains.

## Observed facts (M0, Chrome 151 flagged + ChatGPT desktop)
- modelContext on document; registerTool/getTools/executeTool all present; ChatGPT desktop discovers + invokes tools on localhost (M0-01/02 evidence in log/)
- executeTool input must be a JSON STRING in Chrome 151 (pre-Aug-19-spec signature) — shim in src/webmcp/shim.ts (`executeToolCompat`)
- getTools returns RegisteredTool objects (passing a name throws); tools name-sorted; toolchange fires per registration
- Chrome flag requires full relaunch to take effect
- Port 8899 occupied; dev 8917, smoke/preview 8918, spike re-serves on 8919 when needed

## Current state
- Environment: node 20 ✓, gh authed ✓, Playwright ✓, Chrome 151 + WebMCP flag ENABLED ✓, **ChatGPT desktop installed + logged in ✓** (M0-01/02 done in it), disk ✓
- Not yet: deploy CLI auth (deferred until needed), OPENAI_API_KEY (deferred to M4)
- Stealth intact: no git remotes, nothing deployed
- Sim scaffolding: page boots Worker seeded-but-paused (baseline template); smoke's hue test uses manual masthead buttons BEFORE starting the sim (no race). Manual health buttons become dev-only in M2-06.
- Untrusted prompt-injection log.line (schema supports via `untrusted?`) intentionally deferred to M3 when the readOnly log tool exists to surface it.

## Next actions (fresh session boots here)
1. M2-05: human-playable console UI — surface act() verbs (flag toggle, rollback, roll-forward) as console controls on the migration-trap template; Playwright hit-tested full resolution through UI clicks only
2. M2-06: living site pane — simulated product visibly breaks when the trap fires, heals on resolution (Playwright-asserted)
3. M2-07: Sid's feel review #1 (~Sun 8/30) + b-roll start
4. M0-05/06/07 attended probes (spike on 8919 + ChatGPT desktop, ~10 min)
5. At M2 close: clean-context review pass of the full M2 diff (RUNBOOK rule)

## Blocked / waiting on Sid
- M0-05/06/07 attended probe session (~10 min, ChatGPT desktop already logged in)
- M2-07 feel review #1: resolve the flagship incident yourself; b-roll starts

## Known issues
- "Run sim" button label wraps to two lines in the console header — cosmetic, fix in M2-05 UI pass

## How to run/demo
- `npm run dev` → http://localhost:8917 → **Run sim** (baseline seed 20260828): scripted deploy blip arc. Trap template runs headless for now (`migration-trap` wired to UI in M2-05); see scripted runs in `src/sim/migration-trap.test.ts`
- `npm run smoke` → 16 gates (typecheck, lint-sim, 32 unit tests, build, 12 browser checks) · `npm test` · `npm run lint:sim`
