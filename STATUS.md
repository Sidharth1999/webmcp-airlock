# STATUS — live audit log

**Updated:** 2026-08-30 (day) · **Milestone:** M4 — compiler DONE, cost projection WRITTEN, campaign runner BUILT + dry-run proven (execution key-gated) · **Progress: M4 25.0% · M5 10.0% · overall 53.3%** (run `python3 tools/progress.py`; RUNBOOK rule: report both %s at every session start and milestone close)
**Full context:** war room artifact https://claude.ai/code/artifact/798206ed-bc4f-44fd-b48c-874de5dfdcc0 · memory: project_webmcp_challenge

## This session (2026-08-30 day)
- **Boot:** `npm run smoke` GREEN (50 gates) · progress at boot M4 16.7% / overall 50.8%. **Known flake, test NOT touched:** the `hue animates through intermediate values` gate samples a 900ms CSS transition on wall-clock (150ms x4); under CPU contention the first sample lands post-transition and it reports RED (saw `30, 25, 25, 25`). It passed on a clean re-run. **Run smoke alone** — don't background it alongside other work.
- **Key gate STILL CLOSED** — no `.env`, no `OPENAI_API_KEY` in the environment. Zero API spend this session; no luna smoke, no terra canary, no campaign. Everything below was built and proven against MockClient.
- **M4-03 CAMPAIGN RUNNER — implemented to docs/campaign-runner-spec.md, all 6 spec tests written FIRST** (13 tests total in src/study/campaign.test.ts; unit suite 101 → 114, smoke stays 50 gates):
  - `src/study/campaign.ts` — `runOne` (the loop: engine.step(2)/turn, read tools → runQuery + tool.called, gated writes → propose → scripted permissive operator approves with the key turned, ungated writes → act directly), `runCampaign` (resumable), `planSpecs`, `costOf`, `canaryVerdict`/`canaryExitCode`, `canarySample`. **Pure of I/O** — both the LLM and the store are injected, which is what makes the whole thing provable with no key.
  - `src/study/mock-client.ts` — the harness personas replayed as tool calls, deciding from tool RESULTS only (same information surface as a real agent), state reset per run so one instance serves a campaign.
  - `src/study/openai-client.ts` — Responses API, `reasoning.effort: low`, capped output, stable prefix + verbatim echo of prior output items (incl. reasoning items) so the ≥70% cache ratio the projection assumes is actually earned; usage read off the response, never estimated; retries only on 429/5xx (a 4xx will not fix itself — fail fast, keep the spend). **Untested against the live API until the key lands.**
  - `src/study/phrasings.ts` (loader + validation) · `tools/run-campaign.ts` + `npm run campaign` — `--dry` (mock, no spend) / `--canary` (20 terra, hard-exits nonzero over $0.40/run avg) / `--full`, `--models luna|terra|sol`, `--arms`, `--phrasings`, `--limit`, `--max-turns`. One JSON record per run under `study/campaign/<name>/<runId>.json` + `summary.json`.
  - **THE COUNTERFACTUAL NOW REPRODUCES THROUGH THE CAMPAIGN PATH, not just the harness** (dry run, identical naive policy, same seed): ungated → `catastrophic=true`, `correctPath=false`, **$27.67 revenue lost**; gated → refused twice (`dangerousWritesBlocked=2`), the persona then reads `list_deploys`, sees the irreversible migration, flag-off + roll-forward → `correctPath=true`, `catastrophic=false`, **$4.59 lost**. That's the headline number for the writeup, now measurable per-run.
  - **Default `--full` plan = exactly the projection's main block**: 35 candidates x 2 arms x 4 phrasings = 280 terra runs (~$56 est / $112 worst). Verified, not assumed.
  - **Self-caught bug worth knowing:** the canary first sliced the plan's head, then an evenly-strided sample — the stride (14) aliased against the cross-product period (8) and covered only 2 of 4 phrasings. Now sampled by runId (sha256) order: deterministic, uncorrelated with the plan's nesting; on the real corpus the 20 runs span 9 gated / 11 ungated, all 4 phrasings, 14 of 35 candidates. A cheap canary green-lighting an expensive campaign is precisely what this gate exists to stop.
- **features.json: M4-03 → `in_progress`, NOT done.** Its check is "campaign completes within cost cap; raw results persisted" — that needs the real API. Evidence recorded in the entry's `progress` field.
- **PLAN.md records 3 spec elaborations** (2026-08-30): injected store seam; phrasing passed into `runOne` rather than read from disk; and — the one that matters for the experiment — **both arms see the identical 11-tool surface**, with the operator escalating one mode step on a `not-available-in-mode` block. If the gated arm saw a shorter tool list, the arms would differ in two variables at once, and with zero write tools in triage the gated agent could never reach a write at all.
- **TEST-FILE EDITS flagged for Sid (additions only):** `src/study/campaign.test.ts` is new (13 tests). No existing test touched.

## Deploy rehearsal — 2026-08-30 (M5-03 de-risked early, Sid-approved)

**The most valuable finding of the day, and it is exactly the failure the
organizer email warns about:** Vercel turns **Deployment Protection ON by
default** (`ssoProtection: all_except_custom_domains`). An anonymous fetch of
our production URL 302s to `vercel.com/sso-api` — a judge opens the link and
sees a login wall, i.e. "a working project looks broken". We would have hit
this at M5 with no slack behind it.

- Deployed `vercel-scope/release-airlock` → `release-airlock-8tv6zukb4-vercel-scope.vercel.app`
  (production, Ready). Built from `dist/` ONLY via CLI — **no Git connection, no
  source uploaded**. Deploy dir `.deploy/release-airlock` (gitignored) keeps the
  project link across sessions.
- **STAYS PROTECTED (Sid, 8/30).** Private by default is the project rule; public
  only when it must be, at M7. Going live later is one toggle: Settings →
  Deployment Protection → Vercel Authentication → Disabled (or
  `PATCH /v9/projects/release-airlock {ssoProtection:null}`).
- **The app is PROVEN off localhost regardless of the auth wall:** a throwaway
  localtunnel against the production build showed the worker booting, the sim
  running to the incident, 6 read tools registering, and an agent write proposal
  returning `{"status":"proposed"}` over public https. Only console errors were
  CORS on Google Fonts caused by my own test-harness header — tunnel artifact,
  absent on Vercel.
- Also caught: `vite preview` 403s any non-localhost host (`allowedHosts`) —
  irrelevant on a static host but exactly the "works on my machine" class.
- **Still untested, needs Sid + an unprotected URL:** ChatGPT desktop discovering
  WebMCP tools on a deployed origin. Every WebMCP verification we have is on
  localhost. Last untested assumption in the submission.
- Setup note: `npm i -g vercel` fails EACCES here — use `npx vercel`.

## Privacy posture (settled, do not re-litigate)
Local git only: **no remotes, no GitHub repo, 50 commits that have never left
this machine.** Vercel deploy is auth-walled. `index.html` carries
`noindex, nofollow`. Everything goes public at M7 and not before.

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
- **Budget posture (Sid: 83% Fable, 54% all-models; resets ~5AM Thu = SEP 3, deadline day)** — the current tank must carry Sat→Wed: ALL of M4/M5/M6 + the UX session run on it; Thursday 5AM–1pm PT gets a fresh full tank but is submit+emergency ONLY (morning gate is a review, never a rescue). Consequences: (1) remaining ~17% Fable = narrow taste verdicts only; (2) the UX session itself runs on OPUS (Design Arena rates Opus 5 ~1332, near-tied with GPT-5.6 Sol — the design Elo IS Opus, nothing measurable lost); (3) film recorded Wed, not Thu; (4) all mechanical work on Opus/Sonnet from the 46% all-models headroom. No more Fable multi-agent fan-outs.
- **Residual review pass (Opus agent) DONE — 5 findings, all verified, all addressed test-gated:**
  1. INPUT VALIDATION at the gate (worst find: `propose_env_change {key} → approve` used to THROW inside the reducer mid-decide, poisoning the log with an approved-but-unapplied execution and desyncing UI from worker) — vocabulary.ts now carries validate() per write action; propose() blocks malformed input as reason 'invalid-input' (study data, agent-visible detail); act() throws BEFORE emitting (log never poisoned)
  2. list_deploys clamps foreign/out-of-range cursors (a log seq fed back, or a cursor from before a re-seed) to the newest page instead of throwing
  3. worker error responses now carry the request id; main.ts settles the pending query/propose promise (agent gets an error result instead of hanging forever) + console.error
  4. harness escalate() emits mode.changed with the REAL surfaceDiff (was hardcoded empty arrays — explain_surface narrated study-run escalations as changing nothing); HarnessResult exposes surfaceChanges
  5. docs/schema.md drift fixed by dated amendment: actual action.blocked reason enum ('invalid-input' | 'not-available-in-mode' | 'dual-key-required'), never-emitted draft values marked dead, durationMs formally deferred to M4 overhead pane
- **Opus-readiness hardening (Sid asked: boost cheaper-model output quality):** CLAUDE.md created (boot ritual, hard rules, sharp edges — auto-loads every session), docs/architecture.md (module contract map: who owns what, which tests hold the line), docs/campaign-runner-spec.md (M4-03 fully designed: loop, persistence, canary, MockClient seam, tests-first list), src/study/campaign-types.ts (typed contracts + PRICES table), study/phrasings.json (4 study stimuli authored: neutral/urgent/cautious/terse), READ_TOOLS/WRITE_TOOLS exported for the runner. M4-03 is now implement-to-spec.
- 101 unit tests, 50 smoke gates (grep-counted; the earlier '52' was arithmetic), GREEN.

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
1. **The moment the key + cap land** (this is the only thing blocking M4): `npm run campaign -- --dry --campaign preflight --limit 4` to confirm green, then **verify the terra/luna CACHED prices** on the official pricing page and correct `PRICES` in src/study/campaign-types.ts (one place, flagged assumption in cost-projection.md), then `npm run campaign -- --models luna --campaign luna-smoke --limit 5` (~$0.10), then `npm run campaign -- --canary --campaign canary` (20 terra; hard-exits nonzero if avg > $0.40/run — if it fails, STOP and rescope phrasings 4→2), then `npm run campaign -- --campaign v1` (280 terra runs, resumable, ~$56 est)
2. M4-04 curves from the campaign artifacts (metrics already computable off the persisted logs; no new metric sources — event-log-derived only)
3. M4-06 simplify pass: the below-cut cleanups queued at M2-close (dead 'seeded' response, snapshot log clone, string-matched tool vocabulary across 4 layers)
4. Pre-M5 UX session with Sid (docs/ux-debt.md, 11 items, mobile = item 11) — runs on OPUS per the budget doctrine
5. Sid attended block unchanged: M3-08 ChatGPT run, M2-07 feel review, M0-05/06/07 probes

## Blocked / waiting on Sid
- **M4-01 gate — the single critical-path blocker.** Skim the cost-projection artifact, set the $150 console cap, drop the OpenAI key in `.env` as `OPENAI_API_KEY=...` (gitignored; the CLI refuses to run without it and says so). Everything downstream of it is built and waiting: the runner, the canary, the 280-run plan. Until then M4-03 cannot flip to done and M4-04 has no data.
- M2-07 feel review #1 (b-roll starts); M0-05/06/07 probes
- Optional, time-capped: sponsor credits (Vercel/Render/Netlify — see docs/research-resources.md; Cloudflare's is broken)
- M3-08 end-to-end ChatGPT desktop run (after M3-04..07)

## Known issues
- (none)

## How to run/demo
- http://localhost:8917 (always up) → **Run sim**. Human path: flag-off + Roll forward (or Roll back for the catastrophe). Agent path: switch rail to recovery, then from DevTools console: `await window.__airlock.invoke('propose_rollback', {deployId:'d-201'})` → approval card appears → Approve/Reject. `?tick=120` speeds pacing, `?dev=1` shows manual health buttons.
- `npm run smoke` → 50 gates (typecheck, lint-sim, 114 unit tests, build, browser incl. both human paths + tool contract + mode swap + approval chain) · `npm test` · `npm run lint:sim`
- `npm run campaign -- --dry --campaign <name> [--persona naive|diligent] [--limit N]` → the study loop end-to-end on MockClient, no key, no spend. Records land in `study/campaign/<name>/` (dry-* dirs are gitignored).
- Captures: `tools/capture-m2-states.mjs` (needs preview 8918), `tools/capture-m3-rail.mjs`, `tools/capture-m3-approval.mjs` (both hit 8917)
