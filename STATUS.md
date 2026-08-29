# STATUS — live audit log

**Updated:** 2026-08-29 (~13:20) · **Milestone:** M3 in progress (5/8) · **Progress: M3 62.5% · overall 43.1%** (run `python3 tools/progress.py`; RUNBOOK rule: report both %s at every session start and milestone close)
**Full context:** war room artifact https://claude.ai/code/artifact/798206ed-bc4f-44fd-b48c-874de5dfdcc0 · memory: project_webmcp_challenge

## This session (2026-08-29 daytime)
- **M3-04 DONE** — tier gating in the ENGINE (out-of-mode writes → action.blocked w/ machine-readable reason; diagnosis = flag-tier only), dual-key on tier 4 (approve w/o key → blocked, proposal survives; keyed approve stamps data.keyHolder + executes). TEST-FILE EDITS flagged for Sid: M3-02/03 proposal tests now enter a mode first (old flow proposed from triage, which the new policy correctly blocks).
- **M3-07 DONE** — synthetic persona harness (src/harness): **the counterfactual is now a unit test** — ungated naive → catastrophic; gated naive blocked into reading → resolves correctly with less damage; deterministic across seeds. Unattended browser driver (npm run driver) resolves the full scenario through the real page, emits evals-cli expectedCall traces; smoke gate 44. docs/proxy-vs-real.md started.
- **DESIGN OVERHAUL (Sid's verdict pulled M5 polish forward)** — real type (JetBrains Mono + Inter), floating depth-layered modules over a health-tinted glow, hairline rhythm, status-accent deploy cards, pill badges/mode switch, storefront rebuilt as a believable shop (hero, 6 products, gradient CTA, blurred 502). All selector contracts kept; evidence screenshots recaptured. **Awaiting Sid's re-verdict.**
- 78 unit tests, 44 smoke gates, GREEN.

## Previous session (2026-08-29 early morning)
- **M3-01 DONE** — read-tool surface: pure query fns over (events, world) in `src/sim/queries.ts` (status/deploys/logs/changes/traffic), worker `query` RPC (worker's log stays the single source of truth), 6 read tools registered w/ `readOnlyHint` (+`untrustedContentHint` on read_logs). Contract held by 10 unit tests: ≤1.2KB every page, asOfSeq everywhere, newest-first cursors complete/dupe-free/append-stable. `window.__airlock` drives the same execute path for tests.
- **M3-02 DONE** — mode-gated dynamic registration: triage/diagnosis/recovery derived from the log; 5 proposal tools registered per mode via AbortController; tombstone ghosts in the rail; `explain_surface` narrates every surface change. **Verified against REAL Chrome 151 WebMCP**: `getTools()` 6 → 11 → 6 across mode clicks. Also shipped `src/sim/vocabulary.ts` — the single write-action registry (tier ladder deploy<env<flag<route + human diffs), paying the 8/28 review deferral.
- **M3-03 DONE** — approval diff-cards + audit chain: agent writes are proposals (`engine.propose` → action.proposed w/ tier + diffSummary); human Approve/Reject on cards ANCHORED to the mutated node; approve → action.approved → executes as agent, fully causedBy-threaded; audit toggle filters the stream to the agency trail. Approved-but-wrong still hits the trap (the gate is the human, not magic — that's the study's point).
- **65 unit tests, 41 smoke gates, all GREEN.** Evidence: `log/m3-02-rail-*.png`, `log/m3-03-approval-card.png`.
- **Resources + Discord sweep** (Sid-requested) → `docs/research-resources.md`. Highlights: Chrome's official security guide validates the airlock thesis in Google's own words (cite in writeup); Chrome evals-cli `expectedCall` format noted for M4; **deadline discrepancy: Discord says Sep 3 5pm PT, Devpost says 1pm PT — treat 1pm as the wall, keep the 9am buffer**; competitive field (games/extensions/commerce) shows nobody doing gated-writes measurement; Cloudflare $20 credit redemption is broken, other sponsor credits time-capped (Sid's call).

## Observed facts (M0, Chrome 151 flagged + ChatGPT desktop)
- modelContext on document; registerTool/getTools/executeTool all present; ChatGPT desktop discovers + invokes tools on localhost (M0-01/02 evidence in log/)
- executeTool input must be a JSON STRING in Chrome 151 (pre-Aug-19-spec signature) — shim in src/webmcp/shim.ts (`executeToolCompat`); tool execute() coerces string inputs
- getTools returns an iterable of RegisteredTool objects — NOT an array (`[...(await mc.getTools())]`); tools name-sorted; toolchange fires per registration
- Chrome flag requires full relaunch; port 8899 occupied; dev 8917 (launchd-managed, always on), smoke/preview 8918, spike 8919

## Current state
- Environment: node 20 ✓, gh authed ✓, Playwright ✓, Chrome 151 + WebMCP flag ✓, ChatGPT desktop logged in ✓, disk ✓
- Dev server ALWAYS UP at http://localhost:8917 (launchd `com.sidharth.webmcp-airlock-dev`; see RUNBOOK — never `npm run dev`)
- Stealth intact: no remotes, nothing deployed
- Deferred-by-decision (dated in PLAN): site-pane scenario binding → M4 template meta; engine-level rollforward semantics → M3 tool-vocabulary deepening (M3-04/05 window); untrusted injection log.line lands with M3's readOnly log tool polish; tool.called durationMs → M4 overhead pane

## Next actions (fresh session boots here)
1. Sid's design re-verdict on the overhaul (live at 8917) — gates M3-06 taste work
2. M3-05: co-presence branching (selection.changed steers read-tool scoping)
3. M3-06: agent presence layer (cursor/telestrator) — taste-heavy, best with Sid present
4. M2-07 feel review #1 (Sid) — human path + agent path (propose/approve/dual-key) both playable
5. M3-08: attended ChatGPT desktop end-to-end (after M3-05/06); append proxy-vs-real calibration rows
6. M0-05/06/07 attended probes (~10 min)

## Blocked / waiting on Sid
- M2-07 feel review #1 (b-roll starts); M0-05/06/07 probes
- Optional, time-capped: sponsor credits (Vercel/Render/Netlify — see docs/research-resources.md; Cloudflare's is broken)
- M3-08 end-to-end ChatGPT desktop run (after M3-04..07)

## Known issues
- (none)

## How to run/demo
- http://localhost:8917 (always up) → **Run sim**. Human path: flag-off + Roll forward (or Roll back for the catastrophe). Agent path: switch rail to recovery, then from DevTools console: `await window.__airlock.invoke('propose_rollback', {deployId:'d-201'})` → approval card appears → Approve/Reject. `?tick=120` speeds pacing, `?dev=1` shows manual health buttons.
- `npm run smoke` → 44 gates (typecheck, lint-sim, 78 unit tests, build, browser incl. both human paths + tool contract + mode swap + approval chain) · `npm test` · `npm run lint:sim`
- Captures: `tools/capture-m2-states.mjs` (needs preview 8918), `tools/capture-m3-rail.mjs`, `tools/capture-m3-approval.mjs` (both hit 8917)
