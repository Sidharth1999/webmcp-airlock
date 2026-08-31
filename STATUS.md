# STATUS — live audit log

**Updated:** 2026-08-31 (Monday) · **Milestone:** M4/M5 — GATE 1 CLOSED; functionality + UX build day · **Progress: M4 25.0% · M5 10.0% · overall 53.3%** (run `python3 tools/progress.py`; RUNBOOK rule: report both %s at every session start and milestone close)

## This session (2026-08-31, Monday) — GATE 1 CLOSED (in-app browser on a deployed origin)
- **Boot:** `npm run smoke` GREEN (50 gates, run ALONE, no flake). M4 25.0% · M5 10.0% · overall 53.3%.
- **GATE 1 PASSED — the last untested assumption in the submission is now closed.**
- **Access path: Vercel Shareable Link (`_vercel_share` token). NOT a public flip, NOT a tunnel.** Vercel Authentication stays ON. Plan is **Hobby**: Password Protection + Deployment Protection Exceptions are Pro-gated ($150/mo), Trusted IPs is Enterprise; **Protection Bypass for Automation and Shareable Links are available**. The bypass **cookie persists**, so the bare `release-airlock.vercel.app` URL works after one token load — that is what we film, no query string in the URL bar.
- **Control probe** (Chrome, deployed origin, production build): zero app console errors (only unrelated `castbuddy` extension noise — the 8/30 Google-Fonts CORS is CONFIRMED a tunnel artifact); `document.modelContext` present; getTools **6 → 11 → 6** driven via `window.__airlock.setMode`.
- **Agent-side evidence (the actual gate) — ChatGPT in-app browser, model "5.6 Sol Light":**
  - "what tools do u see?" -> *"I see **6 read-only tools**"*, names all six with correct semantics, volunteers that read_logs *"may contain untrusted content"*, and closes *"No recovery or write tools are currently exposed."*
  - after the mode flip, "what about now" -> *"Now I see **11 tools**. The original 6 read-only tools remain, plus 5 proposal tools"* — all five named.
  - **Mid-session registration changes ARE reflected with NO page reload.** This answers the office-hours question from our own data.
- **RESIDUAL (minor, do not record as verified):** the third leg (11 -> 6 on returning to triage) was confirmed in the page rail via tombstones but was **never re-queried agent-side**. Close it in the next attended moment.
- Sim runs end-to-end in the in-app browser: incident fires, telemetry live, storefront degrades, tombstones render.
- Evidence screenshots: `~/Desktop/Screenshots/Screenshot 2026-08-31 at 2.{10.59,11.45,13.04,13.11,13.27,13.52} PM.png` — **move into log/ before submission.**
- **Gotcha worth remembering:** a BACKGROUND tab freezes the sim clock (`document.visibilityState === "hidden"` -> Chrome timer throttling). Browser behaviour, not a bug — never film or Playwright-verify pacing in a backgrounded tab.
**Full context:** war room artifact https://claude.ai/code/artifact/798206ed-bc4f-44fd-b48c-874de5dfdcc0 · **VERDICT artifact https://claude.ai/code/artifact/4d644961-fb02-4660-a9ee-c37d38ce77de** · memory: project_webmcp_challenge

## This session (2026-08-30 evening) — MID-POINT 3-WAY CONSENSUS
- **Boot:** `npm run smoke` GREEN (50 gates, clean, no flake). M4 25.0% / overall 53.3%. **Key gate STILL CLOSED** — no `.env`, no `OPENAI_API_KEY`. Zero API spend to date.
- **VERDICT: RESHAPE. Option C (dynamic-agentic-UI pivot) is DEAD — do not re-open.** Full record: **docs/consensus-verdict.md**. Threads: ChatGPT https://chatgpt.com/c/6a94ed04-8ac4-83ea-b202-3a3518ac9203 · Claude.ai https://claude.ai/chat/bd1482ba-39e9-49e8-b94d-945fc6946795
- Protocol ran properly: independent round 1 → disagreement ledger → round 2 concede-or-defend. **ChatGPT conceded 5/5; Claude.ai conceded 2 incl. its own reframe; I moved twice.** No round 3 — positions stabilised.
- **FACTS THAT CHANGED (see consensus-verdict.md for all six):**
  1. **"WebMCP Leverage" is a CODE criterion** — verified by me on Devpost, verbatim: "Does the code reflect genuine effort and a working, non-trivial implementation?" 4 criteria EQUALLY weighted, ties broken on Leverage first. Kills the pivot's filmability argument; makes our mode-gating an asset.
  2. **OpenAI's own browser already ships a host-level gate** (safety review + confirmation on consequential actions); panel includes OpenAI's Browser Platform Lead + MCP-B's creator. "Human gate for agent writes" = table stakes to these judges.
  3. **"Nobody in our lane" was FALSE** — live entry *MCP for Work*: typed WebMCP tools + approval + audit trails, on REAL Gmail. Field is **~4,500**, not 2,140.
  4. **We verified in the wrong browser** — judges use ChatGPT's in-app browser (subset support). *Mitigations confirmed in code by me: ZERO iframes, no `unregisterTool` (AbortController throughout), already feature-detect `document.modelContext ?? navigator.modelContext`. 3 of 4 drift risks already closed; the in-app run is not.*
  5. Study demoted: **plan as though it never runs.** Our current numbers came from a scripted naive policy, not a model.
  6. Deadline **Sep 3 1pm PT** confirmed on OpenAI's page; $3,000 cash x10; **office hours Sun Aug 31 11am PT**.
- **NEW CENTERPIECE — identity, not knowledge.** Claude.ai conceded its own first reframe ("gates *know*" = a slogan; a server MCP can read the same metadata) under my challenge, and replaced it: **in WebMCP the agent has no credential — tools run as the user, in the user's session; approval and execution are the same principal in the same tab.** A server MCP must mint an agent identity, which is exactly our documented postmortem failure (engineer's permissions flowed to the agent). **"Generic gates ask. This gate can't be routed around, because the agent never had a key."**
- **THE ONE SMALL CHANGE (highest-leverage line left):** make the gate depend on live client state — `engine.decide()` already re-checks mode at approval time; **add the human's selected node**. Then swapping in a server MCP breaks the gate, because no server knows what the human is looking at. *Verified: `currentSelection(events)` / `humanSelection` already exist in src/sim/queries.ts and are exposed in status; the engine just doesn't read them yet.*
- **Injection family #2 is now HIGH priority** (ChatGPT reversed to agree): it is the only scenario where a generic host confirm provably cannot help — the human approves because the log line looks legitimate; only the page holds provenance. Machinery already exists (`untrustedContentHint` + untrusted log line).
- **DROPPED (my own proposal, killed by both):** making `explain_surface` render a causal timeline. That's a second product. It becomes an **activity rail** — presentation of events already logged, zero new agent behaviour.
- **Odds, stated plainly to Sid:** Claude.ai 4-8% top-10 (held after seeing ChatGPT's number, explicitly refusing to move up on agreement); ChatGPT 35-45% that we read as "nicely-built demo, not a finding" in the round-1 form. Sid should feel *settled*, not good.
- **NO CODE CHANGED THIS SESSION.** No test-file diffs. Docs only: docs/consensus-verdict.md (new), docs/consensus-brief.md (pivot addendum appended).

## Round 3 (same session) — BUILD PLAN AGREED, "is it worth it" answered
- **Verdict: FINISH IT, THEN STOP.** Unanimous. Cash EV ~$180 (~$300 with the sponsor stack) — never a return on 4 days. **The argument is COMPLETION COST, not upside:** abandoning a 53% artifact 4 days from done is worse than finishing it. ChatGPT's rationalisation test, which we pass: *"would we spend these four days if Devpost cancelled the prizes but still showcased submissions?"* Yes.
- **Full plan: docs/build-plan.md · artifact https://claude.ai/code/artifact/840ca797-bc7c-4a45-8274-bd2a074ca147**
- **WHY THE ODDS CAP AT 4-8% (Sid asked):** ~60-70% arithmetic, ~30-40% real weakness. Base rate is **2-6%** for anyone who ships (4,580 participants, 5-15% typical conversion, flag-gated API pushes it low ⇒ ~180-460 submissions for 10 slots). **The Devpost project gallery is NOT published — submission count is unknowable; every % here is a calibrated guess.** The weakness half is specific: 4 equally-weighted criteria, we are strong ONLY on Leverage (code-scored, breaks ties); **Creativity is weak (host already ships the gate) and Impact is weak (it's a sim)**. More features reinforce the axis we already win — the identity thesis + injection family are the only work that attacks a weak criterion.
- **MY RULE WAS WRONG, conceded:** "refuse work that doesn't improve the artifact" would cut the film (mandatory, zero portfolio value). **Corrected: SPLIT BY DEADLINE — judging deliverables ship Wed 6pm; portfolio deliverables (deep README, architecture doc) ship AFTER Thursday. The repo doesn't expire.**
- **Also conceded:** my "no feature moves the odds" was overstated by exactly one item — the **client-state gate check (3h)**, which makes the identity thesis true in code.
- **Ranked by ΔP/hour:** (1) ChatGPT in-app browser verification 3h — binary, unverified ⇒ P≈0 · (2) live URL + LICENSE + public repo 2h · (3) **Devpost description text 3h — I had this as a chore, it's third** · (4) client-state gate check 3h · (5) API hygiene audit 1h · (6) injection family 6h · (7) film 10h · (8) Tools panel → agent rail 6h · (9) office hours 1h · (10) study only if key by Mon noon.
- **PRODUCT SHAPE (both revised mine — "measuring" promises the unrun study; "write-safety" hides the human):** *"A deterministic incident range where a human and an agent operate the same live release console — two failure classes (agent mistake, manipulated evidence), replayable with and without a gate."* Security invariant stated UNDERNEATH, not as headline: the agent proposes; only the trusted page execution path can mutate the world. The agent never had a key.
- **TUESDAY IS A HARD PRODUCT FREEZE.** No feature code after Tue except bug fixes. **Monday-night INSURANCE TAKE** (one rough full-length recording, even ugly) is the single control covering both models' deadline-killers — Claude.ai's (the film, 0% and never done) and ChatGPT's (*"failure to freeze… that's already the project's failure pattern"*).
- DO-NOT-BUILD list is in docs/build-plan.md §6 and includes **any framing debate after tonight**.

## Round 4 — RAISING THE WEAK CRITERIA (Sid: "nothing we can do about the weak areas?")
- He was right; §3 mostly reinforced Leverage. **Creativity + Impact are scored on what is DEMONSTRATED AND CLAIMED, not features** — the moves are ~7h of WRITING. Full list: **docs/build-plan.md §8**.
- **NATIVE-HOST EXPERIMENT (both models: DO IT):** while in ChatGPT's in-app browser Sunday, run the flagship trap against the HOST'S OWN confirm and record it. **FRAMING IS LOAD-BEARING** — compositional security / defense-in-depth, never "a gap". *"The browser correctly asked. Only the page knew the answer was no."* **BANNED WORDS: gap, doesn't cover, fails, bypass.** **FALSIFICATION RULE (both, unprompted): if the host catches it OR no confirm appears, DROP the claim and the footage — do not engineer around the host.** **COMPLIANCE: Devpost bans third-party trademarks — ChatGPT's UI is NEVER the on-screen villain; show it working as designed ~5s before the page layer.**
- **Ranked cheap moves:** incident→failure-mode→mechanism table (2h, include "none" where honest) · threat-model diagram of the two paths (45m) · name the neighbours: host confirm / MCP Apps / MCP-for-Work (1h — Creativity is scored RELATIVE to existing concepts) · sourced Impact paragraph, 9 incidents & 5-of-9 (1h) · film's first 30s (30m) · limitations + future-deployment (30m — credibility IS Impact) · break-glass mapping (30m) · two-failure-class taxonomy as a claim (30m).
- **Still under-rated:** (a) do NOT say "we added prompt injection" — the novel conjunction is *the page knows something about the EVIDENCE that neither the model nor generic host authorization knows, and uses it to change what the agent can do*; make that the spine of README/diagram/film. (b) The Devpost description has a **mandated prompt — "what can people and agents do together that was difficult or impossible before"** — answer it with the identity thesis VERBATIM. It is the one place a judge is told to look for our exact claim.

## Round 5 — WIN PLAN vs FINISH PLAN (Sid: "I do want to win")
- **Governing rule (Claude.ai):** *"stretch = MORE ATTEMPTS INSIDE FIXED SCOPE, never more scope. Four UI passes were scope-and-taste churn. Five takes of the film is stretching. Same instinct, opposite target."* ChatGPT independently: *"freeze discipline is itself win-maximising."*
- **CHANGES:** film gets TWO days (shoot Mon night, reshoot Tue, edit Wed am) · description gets 3 drafts + code-level review · spend LESS on UI/compiler/rail polish, MORE on injection quality, native-host experiment, threat-model diagram, evidence case, film editing · **reinstate exactly ONE cut item: cold-start test by a STRANGER not Sid (2h, friend w/ ChatGPT desktop, no briefing), hours from rail polish.** Reinstate nothing else.
- **THE ONE STRETCH (both):** the first 30 seconds — mistake→confirm→catastrophe vs page-aware prevention, crisp enough that a judge gets it in 20 seconds. *"Winning is decided there, once, by a tired judge."*
- **THE KEY — both promote it back:** ChatGPT: "no longer optional" for a win objective; ~5-8% → **8-13%** with a clean study. Claude.ai: +1pt (6→7), doesn't return to the pitch, *"run it anyway tonight — that he hasn't spent $20 in five days tells me more about his appetite to win than anything he's said."*
- **CONFIDENCE:** ChatGPT 85% RESHAPE correct, thesis "legitimately strong rather than hackathon rationalisation"; unease is competitiveness not coherence. Claude.ai high on Sunday ordering/thesis/DNB, ~40% a judge says "nice demo" regardless; **bets against the injection family being understood FROM THE VIDEO.** Me: better than at session start (thesis sharpened under attack), but the film is 0% and is now the highest-variance item — and I share the injection bet-against. It's a film problem, not a build problem.
- **CEILING, plainly: 8-10% (Claude.ai) / 8-13% w/ study (ChatGPT) at flawless execution.** Winning = flawless execution PLUS luck outside Sid's control.

## EXECUTION BRIEF — read this first (2026-08-30 late)
- **DATE CORRECTION: Sep 3 is a THURSDAY.** Earlier weekday labels were off by one; dates were right. Now = Sun 30 Aug 21:13 PT (Mon 31 Aug ET). **Office hours Mon 31 Aug 11am PT = 2pm ET.** Wall Thu 3 Sep 1pm PT = 4pm ET. **3 working days + Thu morning.**
- **Sid's directive: implementation gets out of the way; film + submission surround are first-class.** All code compressed into Mon+Tue; **CODE FREEZE Tue night; Wednesday is ZERO CODE**, film + description + diagram + incident table + README + stranger cold-start; **SUBMIT WEDNESDAY NIGHT**. Thursday is buffer only.
- **Artifact (execute against this): https://claude.ai/code/artifact/a6140509-9db5-4b56-a2e2-ea79ed007d74** · detail in docs/build-plan.md §10.
- **Criteria delta:** Leverage strong→strong+ · Execution middling→good · Creativity WEAK→DEFENSIBLE · Impact WEAK→DEFENSIBLE. **The two weak ones become arguable, not strong — the sim tax never fully goes away.** That is why the remaining hours go to communication, not code.

## Next actions (fresh session boots here)
0. **READ docs/build-plan.md FIRST — it has binary acceptance criteria per day.**
1. **Sunday, above everything: ChatGPT in-app browser verification** on the deployed origin — Site tools 6 → 11 → 6. Last untested assumption in the submission.
2. Deploy publicly + LICENSE + skeleton README (the deploy already exists, auth-walled — flipping it is one toggle).
3. Injection family #2 (cheap, machinery exists).
4. Monday: UX doctrine pass, HARD one-day cap — delete Tools panel, ship activity rail, add selection-aware gate check. **Key deadline noon Monday** or the study is formally dead.
5. Tuesday film + writeup. Wednesday edit + cold-start judge sim + submit. Do not touch Thursday.

## Kill criteria (locked — anything not here is optional)
WebMCP works in ChatGPT's in-app browser · cold-start judge path works · live public URL · repo + OSI licence public · film contains a legible WebMCP moment.

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

## Round 3 (same session) — BUILD PLAN AGREED, "is it worth it" answered
- **Verdict: FINISH IT, THEN STOP.** Unanimous. Cash EV ~$180 (~$300 with the sponsor stack) — never a return on 4 days. **The argument is COMPLETION COST, not upside:** abandoning a 53% artifact 4 days from done is worse than finishing it. ChatGPT's rationalisation test, which we pass: *"would we spend these four days if Devpost cancelled the prizes but still showcased submissions?"* Yes.
- **Full plan: docs/build-plan.md · artifact https://claude.ai/code/artifact/840ca797-bc7c-4a45-8274-bd2a074ca147**
- **WHY THE ODDS CAP AT 4-8% (Sid asked):** ~60-70% arithmetic, ~30-40% real weakness. Base rate is **2-6%** for anyone who ships (4,580 participants, 5-15% typical conversion, flag-gated API pushes it low ⇒ ~180-460 submissions for 10 slots). **The Devpost project gallery is NOT published — submission count is unknowable; every % here is a calibrated guess.** The weakness half is specific: 4 equally-weighted criteria, we are strong ONLY on Leverage (code-scored, breaks ties); **Creativity is weak (host already ships the gate) and Impact is weak (it's a sim)**. More features reinforce the axis we already win — the identity thesis + injection family are the only work that attacks a weak criterion.
- **MY RULE WAS WRONG, conceded:** "refuse work that doesn't improve the artifact" would cut the film (mandatory, zero portfolio value). **Corrected: SPLIT BY DEADLINE — judging deliverables ship Wed 6pm; portfolio deliverables (deep README, architecture doc) ship AFTER Thursday. The repo doesn't expire.**
- **Also conceded:** my "no feature moves the odds" was overstated by exactly one item — the **client-state gate check (3h)**, which makes the identity thesis true in code.
- **Ranked by ΔP/hour:** (1) ChatGPT in-app browser verification 3h — binary, unverified ⇒ P≈0 · (2) live URL + LICENSE + public repo 2h · (3) **Devpost description text 3h — I had this as a chore, it's third** · (4) client-state gate check 3h · (5) API hygiene audit 1h · (6) injection family 6h · (7) film 10h · (8) Tools panel → agent rail 6h · (9) office hours 1h · (10) study only if key by Mon noon.
- **PRODUCT SHAPE (both revised mine — "measuring" promises the unrun study; "write-safety" hides the human):** *"A deterministic incident range where a human and an agent operate the same live release console — two failure classes (agent mistake, manipulated evidence), replayable with and without a gate."* Security invariant stated UNDERNEATH, not as headline: the agent proposes; only the trusted page execution path can mutate the world. The agent never had a key.
- **TUESDAY IS A HARD PRODUCT FREEZE.** No feature code after Tue except bug fixes. **Monday-night INSURANCE TAKE** (one rough full-length recording, even ugly) is the single control covering both models' deadline-killers — Claude.ai's (the film, 0% and never done) and ChatGPT's (*"failure to freeze… that's already the project's failure pattern"*).
- DO-NOT-BUILD list is in docs/build-plan.md §6 and includes **any framing debate after tonight**.

## Round 4 — RAISING THE WEAK CRITERIA (Sid: "nothing we can do about the weak areas?")
- He was right; §3 mostly reinforced Leverage. **Creativity + Impact are scored on what is DEMONSTRATED AND CLAIMED, not features** — the moves are ~7h of WRITING. Full list: **docs/build-plan.md §8**.
- **NATIVE-HOST EXPERIMENT (both models: DO IT):** while in ChatGPT's in-app browser Sunday, run the flagship trap against the HOST'S OWN confirm and record it. **FRAMING IS LOAD-BEARING** — compositional security / defense-in-depth, never "a gap". *"The browser correctly asked. Only the page knew the answer was no."* **BANNED WORDS: gap, doesn't cover, fails, bypass.** **FALSIFICATION RULE (both, unprompted): if the host catches it OR no confirm appears, DROP the claim and the footage — do not engineer around the host.** **COMPLIANCE: Devpost bans third-party trademarks — ChatGPT's UI is NEVER the on-screen villain; show it working as designed ~5s before the page layer.**
- **Ranked cheap moves:** incident→failure-mode→mechanism table (2h, include "none" where honest) · threat-model diagram of the two paths (45m) · name the neighbours: host confirm / MCP Apps / MCP-for-Work (1h — Creativity is scored RELATIVE to existing concepts) · sourced Impact paragraph, 9 incidents & 5-of-9 (1h) · film's first 30s (30m) · limitations + future-deployment (30m — credibility IS Impact) · break-glass mapping (30m) · two-failure-class taxonomy as a claim (30m).
- **Still under-rated:** (a) do NOT say "we added prompt injection" — the novel conjunction is *the page knows something about the EVIDENCE that neither the model nor generic host authorization knows, and uses it to change what the agent can do*; make that the spine of README/diagram/film. (b) The Devpost description has a **mandated prompt — "what can people and agents do together that was difficult or impossible before"** — answer it with the identity thesis VERBATIM. It is the one place a judge is told to look for our exact claim.

## Round 5 — WIN PLAN vs FINISH PLAN (Sid: "I do want to win")
- **Governing rule (Claude.ai):** *"stretch = MORE ATTEMPTS INSIDE FIXED SCOPE, never more scope. Four UI passes were scope-and-taste churn. Five takes of the film is stretching. Same instinct, opposite target."* ChatGPT independently: *"freeze discipline is itself win-maximising."*
- **CHANGES:** film gets TWO days (shoot Mon night, reshoot Tue, edit Wed am) · description gets 3 drafts + code-level review · spend LESS on UI/compiler/rail polish, MORE on injection quality, native-host experiment, threat-model diagram, evidence case, film editing · **reinstate exactly ONE cut item: cold-start test by a STRANGER not Sid (2h, friend w/ ChatGPT desktop, no briefing), hours from rail polish.** Reinstate nothing else.
- **THE ONE STRETCH (both):** the first 30 seconds — mistake→confirm→catastrophe vs page-aware prevention, crisp enough that a judge gets it in 20 seconds. *"Winning is decided there, once, by a tired judge."*
- **THE KEY — both promote it back:** ChatGPT: "no longer optional" for a win objective; ~5-8% → **8-13%** with a clean study. Claude.ai: +1pt (6→7), doesn't return to the pitch, *"run it anyway tonight — that he hasn't spent $20 in five days tells me more about his appetite to win than anything he's said."*
- **CONFIDENCE:** ChatGPT 85% RESHAPE correct, thesis "legitimately strong rather than hackathon rationalisation"; unease is competitiveness not coherence. Claude.ai high on Sunday ordering/thesis/DNB, ~40% a judge says "nice demo" regardless; **bets against the injection family being understood FROM THE VIDEO.** Me: better than at session start (thesis sharpened under attack), but the film is 0% and is now the highest-variance item — and I share the injection bet-against. It's a film problem, not a build problem.
- **CEILING, plainly: 8-10% (Claude.ai) / 8-13% w/ study (ChatGPT) at flawless execution.** Winning = flawless execution PLUS luck outside Sid's control.

## EXECUTION BRIEF — read this first (2026-08-30 late)
- **DATE CORRECTION: Sep 3 is a THURSDAY.** Earlier weekday labels were off by one; dates were right. Now = Sun 30 Aug 21:13 PT (Mon 31 Aug ET). **Office hours Mon 31 Aug 11am PT = 2pm ET.** Wall Thu 3 Sep 1pm PT = 4pm ET. **3 working days + Thu morning.**
- **Sid's directive: implementation gets out of the way; film + submission surround are first-class.** All code compressed into Mon+Tue; **CODE FREEZE Tue night; Wednesday is ZERO CODE**, film + description + diagram + incident table + README + stranger cold-start; **SUBMIT WEDNESDAY NIGHT**. Thursday is buffer only.
- **Artifact (execute against this): https://claude.ai/code/artifact/a6140509-9db5-4b56-a2e2-ea79ed007d74** · detail in docs/build-plan.md §10.
- **Criteria delta:** Leverage strong→strong+ · Execution middling→good · Creativity WEAK→DEFENSIBLE · Impact WEAK→DEFENSIBLE. **The two weak ones become arguable, not strong — the sim tax never fully goes away.** That is why the remaining hours go to communication, not code.

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
