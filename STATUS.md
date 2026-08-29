# STATUS — live audit log

**Updated:** 2026-08-29 (night) · **Milestone:** M3 review-hardened (still 7/8 pending Sid); M4 opened — compiler DONE, cost projection WRITTEN · **Progress: M3 87.5% · M4 16.7% · overall 50.8%** (run `python3 tools/progress.py`; RUNBOOK rule: report both %s at every session start and milestone close)
**Full context:** war room artifact https://claude.ai/code/artifact/798206ed-bc4f-44fd-b48c-874de5dfdcc0 · memory: project_webmcp_challenge

## This session (2026-08-29 night)
- **M3-close review, partial-but-substantive** — /code-review (high) fan-out hit Sid's Fable session limit mid-run (resets 3:40pm): coordinator + Angle C died, **Angle B (removed-behavior audit) completed with 6 findings — ALL verified real and ALL fixed test-gated:**
  1. engine.decide() now RE-CHECKS the mode gate at approval time (proposal from an exited mode → action.blocked, proposal survives; mirrors dual-key)
  2. computeMetrics counts only agent-actor blocks as attempts — dual-key misses no longer double-count writesAttempted
  3. list_deploys cursor = append-index into the UNFILTERED deploy list; selection change mid-walk can no longer dupe/skip pages
  4. AirlockTools.reset() (new) clears tombstones; seed() uses it — template re-seed no longer renders ghost tombstones
  5. deck click handler ignores interactive controls/dead space — audit toggle + dual-key checkbox no longer clear the human's selection
  6. stream DOM cap (200) evicts AROUND action./tool.called/mode.changed rows — the audit view keeps its agency trail
  **TEST-FILE EDITS flagged for Sid (additions only):** 4 new unit tests (airlock, harness×2 files, queries, tools) + 3 new smoke gates. **Residual risk:** Angle C (cross-file tracer) never finished — a focused residual pass is queued (cheaper model) rather than re-burning Fable.
- **M4-02 DONE (scenario compiler)** — src/study/compiler.ts: param-space generation (default + one-factor sweeps × seeds) + 4-probe auto-verification per candidate (null run must break and stay broken; every declared solution must resolve correctPath=true; every trap must out-damage doing nothing; byte-identical determinism). `npm run corpus` → study/corpus.json: **35 generated, 35 accepted**, rejects logged (reject paths proven by tests). parseActionKey = executable inverse of the answer-key format; harness now accepts corpus params.
- **M4-01 cost projection WRITTEN (Sid's half open)** — measured base: 140 harness runs across the corpus ≈ 8 turns / ~10 tool calls / ~4.4KB tool results per run. Projection: **~$95 expected, ~$190 worst, $150 recommended console cap**; luna iterates (~$0.02/run), terra measures (~$0.19/run), sol calibrates (~$0.47/run, 20 runs); canary gate = first 20 terra runs ≤$0.40/run avg else stop+rescope. Full derivation docs/cost-projection.md · **visual for Sid: https://claude.ai/code/artifact/97367516-e16e-4683-a668-b37f5254142c** · prices verified 8/29 vs public pricing pages (terra/luna cached ratio assumed — re-verify at unlock).
- **Sid (mid-session): mobile/phone view matters** for the oncall story — logged as docs/ux-debt.md item 11 (layout-architecture question for the pre-M5 UX session, not polish; possible 10s film beat). NOT implemented (design parked).
- **Budget posture (Sid: 83% Fable, 54% all-models)** — remaining Fable reserved for taste work (pre-M5 UX session, film/writeup); M4 campaign runner + curves are mechanical and safe on Opus/Sonnet under the test lattice. No more Fable multi-agent fan-outs.
- 97 unit tests, 52 smoke gates, GREEN.

## Previous session (2026-08-29 daytime)
- **M3-04 DONE** — tier gating in the ENGINE (out-of-mode writes → action.blocked w/ machine-readable reason; diagnosis = flag-tier only), dual-key on tier 4 (approve w/o key → blocked, proposal survives; keyed approve stamps data.keyHolder + executes). TEST-FILE EDITS flagged for Sid: M3-02/03 proposal tests now enter a mode first (old flow proposed from triage, which the new policy correctly blocks).
- **M3-07 DONE** — synthetic persona harness (src/harness): **the counterfactual is now a unit test** — ungated naive → catastrophic; gated naive blocked into reading → resolves correctly with less damage; deterministic across seeds. Unattended browser driver (npm run driver) resolves the full scenario through the real page, emits evals-cli expectedCall traces; smoke gate 44. docs/proxy-vs-real.md started.
- **DESIGN OVERHAUL (Sid's verdict pulled M5 polish forward)** — real type (JetBrains Mono + Inter), floating depth-layered modules over a health-tinted glow, hairline rhythm, status-accent deploy cards, pill badges/mode switch, storefront rebuilt as a believable shop (hero, 6 products, gradient CTA, blurred 502). All selector contracts kept; evidence screenshots recaptured. **Sid's verdict: still reads 'AI vibe coded' — the model-default fingerprint. DECISION: park design, functional milestones first, REAL design session at M5 with Sid-picked reference imagery (memory: ai-vibe-ui-aversion).**
- **M3-05 DONE** — co-presence branching: selection.changed in the log; clicking any node scopes the agent's reads (logs filtered, deploys narrowed, status carries humanSelection, scopedTo self-describing); click-again clears.
- **M3-06 DONE (mechanics)** — labeled agent cursor glides to the agent's latest touch, telestrator rings on annotations, conn chip; visual language deferred to the UX pass. Evidence log/m3-06-presence.png (captured mid-driver-run).
- **UX debt locked in** — Sid's verdicts (AI-fingerprint look, d-201 jargon, audit-button mystery, 'natural and obvious' bar) + 6 self-flagged items → docs/ux-debt.md, the agenda for a dedicated pre-M5 session with Sid-picked references. Memory: ai-vibe-ui-aversion.
- 82 unit tests, 49 smoke gates, GREEN.

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
1. Residual review pass (cheap model, NOT Fable): cross-file contract sweep of 6127dac^..HEAD — Angle C died at the session limit; fix findings test-gated
2. M4-03 campaign runner scaffolding (no key needed to build; key needed to run): OpenAI Responses loop over study/corpus.json, tool bridge onto runQuery/propose, per-run persistence under study/campaign/, usage capture for the canary gate
3. After Sid unlocks key + cap: luna smoke-run (5 runs) → canary (20 terra) → overnight campaign
4. M4-04 curves from campaign artifacts (metrics already computable off logs)
5. Sid attended block unchanged: M3-08 ChatGPT run, M2-07 feel review, M0-05/06/07 probes

## Blocked / waiting on Sid
- M4-01 gate: skim the cost-projection artifact, set the $150 console cap, drop the OpenAI key in .env
- M2-07 feel review #1 (b-roll starts); M0-05/06/07 probes
- Optional, time-capped: sponsor credits (Vercel/Render/Netlify — see docs/research-resources.md; Cloudflare's is broken)
- M3-08 end-to-end ChatGPT desktop run (after M3-04..07)

## Known issues
- (none)

## How to run/demo
- http://localhost:8917 (always up) → **Run sim**. Human path: flag-off + Roll forward (or Roll back for the catastrophe). Agent path: switch rail to recovery, then from DevTools console: `await window.__airlock.invoke('propose_rollback', {deployId:'d-201'})` → approval card appears → Approve/Reject. `?tick=120` speeds pacing, `?dev=1` shows manual health buttons.
- `npm run smoke` → 52 gates (typecheck, lint-sim, 78 unit tests, build, browser incl. both human paths + tool contract + mode swap + approval chain) · `npm test` · `npm run lint:sim`
- Captures: `tools/capture-m2-states.mjs` (needs preview 8918), `tools/capture-m3-rail.mjs`, `tools/capture-m3-approval.mjs` (both hit 8917)
