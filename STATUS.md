# STATUS — live audit log

**Updated:** 2026-08-28 (evening session) · **Milestone:** M1 nearly closed (4/5) → M2 next · **Progress: M0 68.8% · M1 80% · overall 11.9%** (run `python3 tools/progress.py`; RUNBOOK rule: report both %s at every session start and milestone close)
**Full context:** war room artifact https://claude.ai/code/artifact/798206ed-bc4f-44fd-b48c-874de5dfdcc0 · memory: project_webmcp_challenge

## This session (2026-08-28 evening)
- **SCHEMA v1 SIGNED OFF by Sid** (interactive checklist): all 4 items agreed. Amendments: `Deploy.note` (commit-message flavor field), `log.line` EventKind (SPEC's untrusted prompt-injection line requires it — was a real gap); dual-key `keyHolder` deferred to M3 as `data.keyHolder` on `action.approved`. **Autonomous build is now unblocked.**
- features.json populated M1–M7 (43 entries total) — progress % now meaningful across the whole plan
- M1 built: Vite + vanilla TS scaffold (stack decision recorded in PLAN), tokens.css (registered @property health-hue, oklch, ok=195/degraded=80/down=25, spring family, actor colors), console shell (masthead + #console/#site-pane/#tool-rail), webmcp/shim.ts (modelContext feature-detect + Chrome-151 JSON-string executeTool shim)
- `npm run smoke` GREEN: typecheck, build, preview on 8918, three regions hit-tested, hue animation verified INCLUDING mid-transition samples (113→56→36→28), zero page errors

## Observed facts (M0, Chrome 151 flagged)
- modelContext on document; registerTool/getTools/executeTool all present
- executeTool input must be a JSON STRING in Chrome 151 (pre-Aug-19-spec signature) — shim lives in src/webmcp/shim.ts (`executeToolCompat`)
- getTools returns RegisteredTool objects (passing a name throws); tools name-sorted
- toolchange fires per registration
- Chrome flag requires full relaunch to take effect (bit us once)
- Port 8899 occupied by pre-existing service; dev serves on 8917, smoke/preview on 8918

## Current state
- Environment: node 20 ✓, gh authed ✓, Playwright ✓ (chromium headless shell 151 installed for repo), Chrome 151 + WebMCP flag ENABLED ✓, ChatGPT desktop DOWNLOADED (login/verify pending), disk 92G free ✓
- Not yet: deploy CLI auth (deferred until a deploy is actually needed), OPENAI_API_KEY (deferred to M4)
- Stealth intact: no git remotes, nothing deployed

## Next actions (fresh session boots here)
1. M1-05: fresh-session RUNBOOK boot test (a clean session/subagent follows RUNBOOK verbatim to green smoke) — closes M1
2. M2-01/02: event log + pure reducer per signed schema v1, seeded Worker sim (mulberry32 + sim-clock, lint ban on Date.now/Math.random in sim code)
3. Then M2-03 world systems → M2-04 flagship migration-trap template
4. Remaining M0 probes when convenient: M0-05 airlock iframe, M0-06 in-flight semantics, M0-07 readOnlyHint retest with a scary-looking write
5. ChatGPT desktop evidence continues to land in log/m0-*.png

## Blocked / waiting on Sid
- ChatGPT desktop: launch + log in once; then the M0 localhost retests (attended, ~10 min)
- M2-07 feel review #1 (D3): Sid resolves the flagship incident himself

## Known issues
- (none)

## How to run/demo
- `npm run dev` → http://localhost:8917 (console shell + health-hue token demo in masthead)
- `npm run smoke` → full e2e sanity, exits 0 when green
