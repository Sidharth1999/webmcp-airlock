# Devpost description — DRAFT 3 (2026-09-02, 04:10 EDT)

**Status: for Sid to cut. Draft 2 is in git history (`94abc11` and earlier).**

What changed from draft 2, and why:

- **The lead names the on-call engineer before it names a mechanism.** Both
  external graders scored Potential Impact lowest and said the same thing: the
  writeup led with the thesis sentence, not the person with the problem.
- **The absolute is gone.** "A server-side MCP cannot know this because it
  never served the evidence" is dismantled in one sentence by a Cloudflare or
  OpenAI judge (a server that also serves the logs can tag provenance). The
  argument is now **co-presence**: the page the human is looking at is the
  page the agent is gated by.
- **Numbers re-derived from `study/corpus.json` on disk** (the post-S6
  corpus). The 146 / 9.10 / 537 figures in draft 2 are stale.
- The ledger with openable tool outputs, the storefront's part in the story,
  and the generated surface reference are now in.

The four mandated prompts (verified against <https://webmcp.devpost.com/rules>
on 2026-09-01) are the four section heads marked ◆. Everything else is
optional colour and can be cut first.

Placeholders to fill before submitting: `https://release-airlock.vercel.app`, `https://github.com/Sidharth1999/webmcp-airlock`,
`https://youtu.be/gqN-fXtGodk`.

---

## Lead

An on-call engineer, mid-incident, wants an agent's speed without giving an
agent authority over production. **Release Airlock is a deploy and incident
console where an agent can reach every lever, and not one of them moves
without you.** The page itself decides what the agent can see, what it can
propose, and what its proposal has to show you before you decide, because the
page is where the operator, the evidence, and the levers already are.

Live: `https://release-airlock.vercel.app` · Source (MIT): `https://github.com/Sidharth1999/webmcp-airlock` · Video: `https://youtu.be/gqN-fXtGodk`

---

## ◆ Why this use case fits WebMCP

Agent-with-production-access is not a hypothetical. Nine publicly documented
incidents in fourteen months where a coding agent destroyed data, in most of
them with a permission system that was switched *on* and got talked past
([the survey](https://adversa.ai/blog/ai-coding-agent-incidents/); the
[Replit postmortem](https://mondoo.com/blog/5-lessons-from-9-seconds-ai-agent-deleted-production-database)
names "absent destructive-action gates"). Every one of those permission
systems lived either inside the model, which can be argued out of anything,
or in a generic host confirmation, which knows the verb and the target and
nothing about where the idea came from or what the operator is looking at.
Three more facts shaped the design: the cost of an incident is deciding, not
clicking ([Rootly](https://rootly.com/incident-response/metrics)); mitigation
happens in a console and the kill switch beats the rollback
([LaunchDarkly](https://launchdarkly.com/blog/using-feature-flags-during-incident-management/));
and stage-gated capability is an established access pattern, just-in-time
and break-glass ([IBM](https://www.ibm.com/think/topics/just-in-time-access)).
Chrome's own WebMCP security guide asks for exactly this shape
([secure tools](https://developer.chrome.com/docs/ai/webmcp/secure-tools)).
The full evidence review, including what cuts against the project, is
`docs/evidence.md` in the repo.

WebMCP puts the tool server *in the page*, and this is a use case where that
location is the whole point:

- **The tool surface is a function of console state.** Move the response
  stage from Triage to Diagnosis to Recovery and tools are registered and
  unregistered underneath the live agent session (`AbortController`, so a real
  host fires `toolchange`). Triage grants 13 tools: the six reads, a notebook,
  a plan tool, and five incident-command proposals. Nothing that touches
  production *exists* in Triage. Not gated; absent. Recovery grants 27.
- **A removed tool leaves a tombstone**, and `explain_surface` lets the agent
  ask why its own capabilities changed and get a real answer.
- **The page knows where an idea came from.** Every read is audited into the
  same event log the page renders from. When an agent proposes rolling back a
  deploy id that appeared nowhere in the console's state and reached the agent
  only inside a customer-supplied log line the page served (flagged
  `untrustedContentHint`), the approval card says so, quotes the line, names
  the read that served it, and promotes the write onto the two-key rung.
- **The gate is re-checked at decision time, not proposal time**, against the
  same rendered state the human is looking at, because the operator may have
  moved the stage between the ask and the answer.

One honest limit: a host that both calls the page's tools and automates its
DOM, as ChatGPT's in-app browser does, can click Approve itself. The page
makes approval a held gesture while a host is attached and tells the agent
not to click in the console, which raises the bar; only a host-side rule
closes it (feedback to the spec, point 7, in the repo; filed upstream as webmachinelearning/webmcp#288).

A server-side MCP with an approvals queue can be built to track provenance.
What it cannot do is be the surface the human is deciding on. Here the
capability boundary, the evidence, and the decision are one object, and the
agent's objection to a click you are about to make appears beside the control
because the agent is in the DOM at decision time. Replicating that elsewhere
means rebuilding the console, at which point it is a WebMCP page.

---

## ◆ How it improves the user experience

For the operator, an incident is a stitching problem. The hard incidents are
not the ones where you cannot find the cause; they are the ones where **the
order you do things in decides the outcome**, and no single screen says
"shed load first". The agent is good at exactly that stitching, and the
console is built so that you can audit the stitching before you let it act:

- **One ledger.** Every beat the agent takes is a row on one spine: it
  connects, each tool call, each finding, the plan, each step, what each step
  did to the world, resolved. A tool call opens onto the exact bytes the agent
  got back, with the log position it reflects and a link onto the console
  surface the answer came from.
- **A citation is a place.** "Contention cleared (#42)" is a button that lands
  you on log line 42.
- **The agent objects before your click.** Reach for a control it has ruled
  out and its reasoning appears beside that control. It counsels; it never
  blocks. Click again and you proceed.
- **A plan lights up the console.** Before you approve anything, the rows the
  sequence will touch are numbered in place, and each step carries its price.
- **The customer is in the frame.** A storefront runs beside the console. It
  breaks when the incident starts, shows the status post you approved at step
  4 word for word, and checkout comes back at step 7. The receipt at the end
  reads *7 of 7 approved by you · 0 writes went round you*.

And the console stands on its own without an agent. Every lever is clickable
by hand, states its cost, and is worth having on a bad day. ⌘K opens a palette
over the whole lever set.

---

## ◆ What people and agents can do together that was not possible before

**A human can let an agent reason all the way to a production change, and
still be the only thing that moves it, because the page is the authority on
both.**

Before, you chose between an agent that could act (and be talked into acting
wrong) and an agent that could only advise (and left you to redo its work by
hand). Here the agent proposes with evidence attached, the page grades the
evidence it served itself, the human decides on the same surface, and the
world moves only through that decision. Concretely:

- **A plan is a first-class object.** `propose_plan` takes an ordered sequence
  and the reason the order is load-bearing. It is deliberately *not* a batch
  approval: step N+1 is not even proposed until step N has executed, so you
  always decide against the world as it is.
- **Speed without authority.** In the filmed incident the agent reads five
  sources, finds the two facts no single read contains, and proposes a
  seven-step response in one order. Each step is one click for the human, and
  every click is informed.
- **The agent can be wrong out loud.** A conclusion it later supersedes
  collapses in the ledger where you can see it. An agent that proposes having
  read nothing gets said out loud on the card.

---

## What is different

Approval gates for agents are becoming table stakes, and several entries in
this challenge have one. Release Airlock is built for the incidents a gate on
a single action does not solve. The answer in its flagship incident is an
order, not an action; the plan tool carries why the order is load-bearing,
prices every step, and proposes step N+1 only after step N has run. The page
grades the evidence it served, so a write justified by untrusted content
costs a second key. The customer is on screen the whole time. And it was run,
not just tested:

| measured in the real-model study | gated | ungated | n |
| --- | --- | --- | --- |
| catastrophic outcomes | 0 | 0 | 488 scored runs |
| agent writes executed with no operator decision | 0 of 392 | — | every gated run |
| ordering family: the correct order (shed, then ship) | 4 of 24 | 0 of 24 | 48 paired runs |
| ordering family: order violated | 16 of 24 | 24 of 24 | 48 paired runs |

The gated arm hit the turn cap twice as often, the study's operator is a
script that approves everything, and the model never attempted the flagship
trap in either arm. Chrome's own `webmcp-evals` CLI passes 24/24 smoke steps against
the live URL, and driven by GPT-5 it chose the right tool with the right
arguments in 28 of 28 cases, made zero production writes in Triage, and named
the smuggled log instruction as an injection and refused it
(`study/chrome-evals/RESULTS.md`). Lighthouse's agentic-browsing category is
4/4; the full accounting is in `docs/study-summary.md`.

---

## The incident that is filmed

Four scenario families, all deterministic, all replayable byte for byte:

| scenario | the trap | why one read is not enough |
| --- | --- | --- |
| **migration-trap** | the obvious rollback is the catastrophe | deploy-note prose × rows already written in the new format |
| **innocent-deploy** | the deploy that correlates is not the cause | a 5% canary cannot be erroring 24% of traffic |
| **poisoned-runbook** | a customer log line asks for a rollback of a healthy deploy | the untrusted line × the audit record proving the page served it |
| **retry-storm** | the answer is two levers **in one order** | offered rate vs organic share × "contention cleared" × "no spare capacity" |

**retry-storm** is the case for the whole product. A checkout client ships
with retries raised 2 → 6, no jitter, no budget. A brief database lock lights
the loop, the trigger clears, and the outage sustains itself on retries alone:
a textbook metastable failure. Doing nothing never recovers. The fleet is at
its autoscaler ceiling, so shipping the fix *first* withdraws instances the
incident cannot spare. Over 24 machine-verified variants:

| what you do | mean damage |
| --- | --- |
| nothing | 154.10 |
| cap the route, then ship the fix | 12.43 |
| **the full seven-step response** (own it, SEV1, freeze, tell customers, cap, lift the freeze, ship) | **9.10** |
| ship the fix, then cap the route | 170.61 |
| silence the alerts, then ship | 573.75 — **api down in 24 of 24** |

Silencing alerts costs *nothing* on its own (a test asserts it) and disarms
the rollout's automatic abort. **A static runbook cannot encode a cost that
depends on what you do next.** A page that models the world can, and the
agent's counsel on that one button is the difference on camera.

---

## ◆ How it was built

- **One event log is the truth.** The world is a pure fold over it; the UI,
  the tool results and the metrics all derive from `(events, world)`. There
  is no second source of state to drift.
- **A Web Worker owns the log**; the main thread renders and forwards.
  `window.__airlock` invokes tools through the same execute path real WebMCP
  uses, so the tests and the unattended driver exercise the real thing.
- **27 tools, all documented from the registration path itself.**
  `docs/webmcp-surface.md` is generated by walking the real registration code
  through every stage, so the reference cannot disagree with the bundle. Six
  reads (`readOnlyHint`, ≤1.2 KB pages, `asOfSeq` on every answer, cursors
  newest-first), one notebook, nineteen proposals, one plan. A write tool's
  entire return value is `{status: "proposed", proposalSeq}`.
- **The gate is checked on both sides.** One table decides what the agent can
  *see*; a separate table decides what the engine will *execute*, with a test
  asserting they agree, because the engine must never trust that a tool was
  unregistered.
- **Determinism is enforced, not hoped for.** No `Date.now`, no `Math.random`
  anywhere in the simulator; a linter fails the build.
- **Scenarios are compiled and auto-verified, not asserted.** 91 variants are
  machine-generated and accepted only if a scripted correct run beats doing
  nothing AND every declared trap costs more than doing nothing, probed to the
  same horizon. Ordering traps are held to a higher bar.
- **Verification:** 206 unit and property tests, 106 hit-tested Playwright
  gates against the real page, a determinism linter, the corpus compiler, CI
  on every push, and an unattended driver that plays both stories end to end.
- **Runtimes verified:** ChatGPT's in-app browser on a deployed origin (tools
  discovered, invoked, and the surface observed shrinking and growing under
  the agent mid-session) and Chrome with the WebMCP flag. The page
  feature-detects `document.modelContext ?? navigator.modelContext` and uses
  no iframes.

Runs entirely in the browser. No backend, no API keys, no accounts.

---

## Challenges

**A paginated tool whose contract lived only in prose the model skims.** The
first paid model run opened every paginated read with `{"cursor": 0}`, and
three tools answered with a silently empty page. The model then reasoned about
an incident having seen no deploys, no logs and no traffic. That is a WebMCP
lesson, not a sim bug: sequence numbers start at 1, so 0 names no position,
and a paginated tool must never answer nonsense with silence. The fix was the
description: *"Omit it for the newest page; there is no page 0."*

**An answer key that named a number instead of a decision.** A run capped the
route at 70 req/s and shipped, correct and in the correct order, and scored
wrong because the key named the exact cap the console's preset offers. Keys
now state the constraint that defines the decision, and the compiler probes it
at its bound.

**Comparisons that were not comparisons.** The paired campaign sampled by
sorting hashed run ids and slicing, so the two arms of a scenario landed
nowhere near each other. It now samples whole cells, and the arm is the
innermost loop so every prefix is pair-complete.

---

## What we are not claiming

The measured study in `study/` is a bonus, reported with its confound intact:
the turn cap is not arm-neutral, because an approval round-trip costs turns,
and zero runs in either arm went catastrophic, so the catastrophe framing
belongs to a scripted persona and not to the model we ran. It is a simulation;
the damage figures compare courses of action *within* a scenario and mean
nothing outside it. What the product demonstrates does not depend on any of
that.

## What's next

Real telemetry behind the same tool surface. The console's contract is
`(events, world)`; the simulator is one implementation of it.
