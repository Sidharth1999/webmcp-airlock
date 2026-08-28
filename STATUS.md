# STATUS — live audit log

**Updated:** 2026-08-28 (night) · **Milestone:** M0 (Spike) — starting
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

## Next actions
1. Build spike page (spike/index.html): registerTool hello-world + toolchange test + spike-list probes
2. Serve on localhost; Sid opens in ChatGPT desktop → observe invocation (M0 gate)
3. Draft trace schema → Sid sign-off
4. Record spike-list findings here as OBSERVED facts

## Blocked / waiting on Sid
- ChatGPT desktop: launch + log in once; then the M0 localhost test (attended, ~10 min)

## Known issues
- (none yet)

## How to run/demo
- Nothing runnable yet. First runnable artifact = spike page (M0).
