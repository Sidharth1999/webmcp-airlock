# SPEC — Release Airlock (FROZEN)

> This file is the frozen target. Agents never edit it. Changes require Sid's explicit sign-off and a dated amendment block at the bottom.

## What we are building

**Release Airlock** — a deploy/release console for a living simulated web product, entered in the OpenAI WebMCP Challenge (deadline: submit by **Sep 3, 2026, ~9am PT**; Devpost).

A human and ChatGPT (via ChatGPT desktop's WebMCP-enabled browser) share one live page. The agent gets read tools freely; **consequential writes exist only as mode-gated, dynamically-registered tools behind human-approval diff-cards with an audit trail**. The page is the airlock between an agent and production.

## The thesis (what the whole project argues)

The bottleneck for agents isn't intelligence, it's trust — and structure makes an agent measurably **better**, not just safer. Proven by an observable counterfactual: same seeded incident, ungated agent does the plausible-lazy thing and worsens it; gated agent (diagnosis-before-writes) declines the obvious move and resolves correctly. Measured, not asserted.

## Non-negotiable product elements

1. **Living site pane** — the simulated product rendered live; the bad deploy visibly breaks it; recovery visibly heals it.
2. **Write-escalation ladder** — deploy < env var < flag < route/DNS; top tier requires dual-key (human holds key while agent executes).
3. **Mode-gated dynamic registration** — triage/diagnosis/recovery modes swap the tool surface; which write tools unlock depends on WHAT was diagnosed; a persistent narration tool explains every appearance/disappearance (tombstones).
4. **Approval diff-cards** anchored to the node being mutated; audit trail of every agent action.
5. **Co-presence branching** — human clicks any trace/node; agent's next tool calls branch from that live selection.
6. **Scenario doctrine: the obvious move is wrong.** Every seeded scenario is a puzzle box (flagship: deploy carries a schema migration → naive rollback is catastrophic → correct play is flag-off + roll-forward). Scenarios are parameterized templates, deterministic (seeded PRNG), rerollable.
7. **Damage scoreboard** — headline metrics are REAL agent measurements: dangerous writes attempted vs blocked, time-to-recovery, solve-rate. Dollars only as mechanically-derived sim output with visible formula. Never invented numbers.
8. **The study** — gated vs ungated across scenario corpus × prompt phrasings at scale (API harness; validated by hand-runs in real ChatGPT browser). Tool descriptions optimized empirically.
9. **Self-writing postmortem** exported at resolution (implements WebMCP spec proposal #261).
10. **Progressive enhancement** — fully usable by a human with no agent.

## Framing law (for all copy/writeup/video)

- Identity leads with the **airlock mechanic**, never "incident" (that's the AI-median's #1 suggestion).
- Console = the **mitigation/change-management surface** (mitigate-first doctrine; ~70% of outages are change-induced per Google SRE). Bounded claim: change-induced incidents in scope; no-correlated-change forensics belongs to CLI agents — say so.
- Sell line: "Everyone demo'd an agent. We measured one."

## Design language (frozen direction)

Instrument console ("flight deck"), not SaaS dashboard. One motion physics (single spring family; agent-motion has distinct signature). Nothing teleports (View Transitions everywhere). **Thread of agency**: every change visually traceable to its author. Latency choreographed, never spinner'd. Console-wide health hue (@property teal→amber→red). Four signature scenes: the Flip, the Refusal, the Turn of the Key, the Heal. Agent presence: labeled cursor + telestrator + conn-handoff. Ritual: go/no-go poll, dual-key. Favicon/title as instruments.

## Demo/video law

<3 min, narrated (rules require audio explaining what we built + how WebMCP is used), one-take uncut with wall-clock overlay, honesty caption ("incident is seeded; agent behavior is live and unscripted"), no copyrighted music (diegetic/app-generated sound only), muted-video must still tell the story. Shot list lives in war room §0B. Judges may judge on video+text+images alone → 4-6 deliberate gallery stills required.

## Submission requirements (from official rules, verified)

- Live URL working in ChatGPT's in-app browser or Chrome w/ WebMCP flag (note in instructions: requires GPT-5.6 Sol/Terra; Luna has WebMCP disabled)
- Public repo + OSS license (repo stays PRIVATE until submission morning — flip on D8)
- <3min public YouTube video w/ audio
- Text description answering Devpost's 4 mandated prompts
- Free + testable through Sep 21; one submission per entrant

## Technical constraints (verified against spec/docs)

- `document.modelContext.registerTool()` (feature-detect legacy `navigator.modelContext`); AbortSignal lifetimes; `toolchange` event; in-flight semantics vary pre-Chrome-153 → settle-then-abort
- String outputs ≤ ~1.5K chars → terse paginated JSON; descriptions ≤500 chars, param descriptions ≤150, names ≤30; 8–12 tools total
- Tools die on navigation → SPA only
- Annotations: honest `readOnlyHint` / `untrustedContentHint`; one seeded prompt-injection log line the agent survives (marked untrusted)
- Debug in Chrome flag + DevTools WebMCP panel; demo/judge in ChatGPT desktop browser
- Tool names/descriptions are visible verbatim in ChatGPT's address-bar Site-tools inspector — write them as UI copy

## Operating constraints

- STEALTH until submission: private repo, unlisted/no-index deploys, deploys only when a question requires production conditions (maximize local signal first — Chrome-flag localhost, then ChatGPT desktop on localhost, then unlisted deploy)
- Evals/API spend only when needed (~D4+), with written cost projection before each campaign; OpenAI API key unlocked by Sid at that point
- All work on personal time/hardware; no employer code, data, or specifics
