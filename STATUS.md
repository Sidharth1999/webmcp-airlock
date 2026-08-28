# STATUS — live audit log

**Updated:** 2026-08-28 (early-morning session) · **Milestone:** M2 in progress (6/7 — all Claude-side work done, only Sid's feel review open) · **Progress: M2 85.7% · overall 30.6%** (run `python3 tools/progress.py`; RUNBOOK rule: report both %s at every session start and milestone close)
**Full context:** war room artifact https://claude.ai/code/artifact/798206ed-bc4f-44fd-b48c-874de5dfdcc0 · memory: project_webmcp_challenge

## This session (2026-08-28 early morning)
- **M2-05 DONE** — human-playable console. Worker gained an `act` message (origin-tagged so act responses don't advance the tick counter); the control deck renders from World with keyed in-place updates (clicks never land on rebuilt nodes): flag toggle rows, per-service roll-forward rows (version + health live), deploy cards carrying the decision-grade metadata (note, migration·irreversible badge, canary Δ, diffstat, live/superseded/rolled-back status; Roll back disabled unless live). `migration-trap` is now the default template; header select swaps to baseline; `?tick=` paces the sim (tests run fast), `?dev=1` gates the old manual health buttons (dev-only as planned).
- **M2-06 DONE** — living site pane: "aperture supply co." storefront renders from World. Trap fires → red banner ("Checkout is failing — N% of payments erroring"), checkout button flips to Payment failed + shake, feed counts failing checkouts. Naive rollback → full 502 outage overlay. Resolution → heals to confirming orders. Thresholds: api down ⇒ outage; `/checkout` errRate > 5% ⇒ broken.
- **Smoke 16 → 26 gates, all GREEN**: added full resolution run through UI clicks ONLY (deck seeded pre-run → trap card w/ irreversible-migration badge → site broken → flag-off mitigates → roll-forward resolves, human actions threaded actor=human) and the trap path (rollback → health down + 502 + SchemaMismatch clue → roll-forward heals). 32 unit tests unchanged, green.
- Fixed the "Run sim" label wrap; sim status line moved to the Controls row (was clipped in the console header).
- Evidence screenshots: `log/m2-05-deck-seeded.png`, `m2-06-incident-site-broken.png`, `m2-06-catastrophic-outage.png`, `m2-05-resolved.png` (capture tool: `tools/capture-m2-states.mjs`, needs preview on 8918).
- **M2-close clean-context review DONE** (high effort, full c5a9d37^..HEAD diff): 10 findings. Fixed same-session, each behind a new test or smoke gate: reducer rejects rollbacks with no superseded predecessor (was half-applying); the trap now checks the WORLD applied the rollback, not just phase (a reducer-rejected rollback no longer fires it); roll-forward latched non-re-entrant (double-click shipped two d-202s); template re-seed fully resets pacer/deck/health/storefront (was leaking across scenarios); `?template=` validated against the registry (typo used to wedge the page); hidden tabs pause the pacer (append-only log no longer grinds in forgotten tabs — matters now the dev server is always-on); rollback button requires a revert target to enable; smoke deck-seeded race + capture-tool no-wait fixed; M2 ledger entries backfilled with observed-evidence per the file's own convention. Two architecture findings deferred BY DECISION (dated in PLAN): site-pane scenario binding → M4 template meta; engine-level rollforward semantics → M3 tool vocabulary. Unit tests 32 → 35, smoke 26 → 27 gates, all GREEN.
- **Always-on dev server**: 8917 now launchd-managed (`com.sidharth.webmcp-airlock-dev`, KeepAlive) so Sid can play the latest working tree anytime — see RUNBOOK (don't `npm run dev`).

## Observed facts (M0, Chrome 151 flagged + ChatGPT desktop)
- modelContext on document; registerTool/getTools/executeTool all present; ChatGPT desktop discovers + invokes tools on localhost (M0-01/02 evidence in log/)
- executeTool input must be a JSON STRING in Chrome 151 (pre-Aug-19-spec signature) — shim in src/webmcp/shim.ts (`executeToolCompat`)
- getTools returns RegisteredTool objects (passing a name throws); tools name-sorted; toolchange fires per registration
- Chrome flag requires full relaunch to take effect
- Port 8899 occupied; dev 8917, smoke/preview 8918, spike re-serves on 8919 when needed

## Current state
- Environment: node 20 ✓, gh authed ✓, Playwright ✓, Chrome 151 + WebMCP flag ENABLED ✓, ChatGPT desktop installed + logged in ✓ (M0-01/02 done in it), disk ✓
- Not yet: deploy CLI auth (deferred until needed), OPENAI_API_KEY (deferred to M4)
- Stealth intact: no git remotes, nothing deployed
- Untrusted prompt-injection log.line (schema supports via `untrusted?`) intentionally deferred to M3 when the readOnly log tool exists to surface it.

## Next actions (fresh session boots here)
1. M2-07: Sid's feel review #1 (~Sun 8/30) — he resolves the incident himself at http://localhost:8917 (npm run dev → Run sim); b-roll capture starts
2. M0-05/06/07 attended probes (spike on 8919 + ChatGPT desktop, ~10 min)
3. M3 start (after feel review): 8–12 tools wired to sim state, mode-gated registration, approval diff-cards — plus the synthetic-agent harness pulled forward (PLAN decision 2026-08-28 late)

## Blocked / waiting on Sid
- M2-07 feel review #1: resolve the flagship incident yourself; verdict in STATUS; b-roll starts
- M0-05/06/07 attended probe session (~10 min, ChatGPT desktop already logged in)

## Known issues
- (none)

## How to run/demo
- http://localhost:8917 is ALWAYS UP (launchd-managed dev server, see RUNBOOK — don't `npm run dev`) → **Run sim** (migration-trap is the default template, seed 20260828). Play it: watch d-201 land, checkout break in the site pane; flag-off then Roll forward = correct path; Roll back d-201 = the trap (502). `?template=baseline` for the benign arc, `?tick=120` for faster pacing, `?dev=1` for manual health buttons.
- `npm run smoke` → 27 gates (typecheck, lint-sim, 35 unit tests, build, 23 browser checks incl. full human playthrough of both paths) · `npm test` · `npm run lint:sim`
- `node tools/capture-m2-states.mjs` (with preview on 8918) → refreshes the four state screenshots in log/
