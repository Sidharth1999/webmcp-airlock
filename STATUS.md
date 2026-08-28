# STATUS — live audit log

**Updated:** 2026-08-28 ~1:50am · **Milestone:** M0 nearly closed → M1 next · **Progress: M0 56% · overall ~4.5%** (run `python3 tools/progress.py`; RUNBOOK rule: report both %s at every session start and milestone close)
**Full context:** war room artifact https://claude.ai/code/artifact/798206ed-bc4f-44fd-b48c-874de5dfdcc0 · memory: project_webmcp_challenge

## Observed facts (M0, Chrome 151 flagged)
- modelContext on document; registerTool/getTools/executeTool all present
- executeTool input must be a JSON STRING in Chrome 151 (pre-Aug-19-spec signature) - shim required; page-side eval path CONFIRMED (write mutated counter)
- getTools returns RegisteredTool objects (passing a name throws); tools name-sorted
- toolchange fires per registration
- Chrome flag requires full relaunch to take effect (bit us once)
- Port 8899 occupied by pre-existing service; spike serves on 8917

## Current state
- Repo scaffolded (SPEC/PLAN/RUNBOOK/STATUS + features.json + init.sh). No app code yet.
- Environment: node 20 ✓, gh authed ✓, Playwright ✓, Chrome 151 + WebMCP flag ENABLED ✓, ChatGPT desktop DOWNLOADED (login/verify pending), disk 92G free ✓
- Not yet: deploy CLI auth (deferred until a deploy is actually needed), OPENAI_API_KEY (deferred to M4)

## Next actions (fresh session boots here)
1. GATE: Sid reviews docs/schema.md sign-off checklist (4 items at bottom) — blocks autonomous build
2. Populate features.json with M1–M7 entries from PLAN (progress % becomes meaningful)
3. M1: Vite scaffold + design tokens (health-hue system) + console layout shell + `npm run smoke`
4. Remaining M0 probes when convenient: M0-05 airlock iframe, M0-06 in-flight, M0-07 readOnlyHint with a scary-looking write
5. ChatGPT desktop evidence: log/m0-*.png; executeTool needs JSON-string input shim (see features.json observed notes)

## Blocked / waiting on Sid
- ChatGPT desktop: launch + log in once; then the M0 localhost test (attended, ~10 min)

## Known issues
- (none yet)

## How to run/demo
- Nothing runnable yet. First runnable artifact = spike page (M0).
