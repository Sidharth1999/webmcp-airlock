# Devpost description — DRAFT 2 (2026-09-01, night)

**Status: a draft for Sid to cut, not copy.**

## The required fields, VERIFIED against the live rules (2026-09-01)

Draft 1 said the repo recorded ONE mandated prompt while M6-03's check said
four, and asked for the live form to be checked. Checked, at
<https://webmcp.devpost.com/rules>. **M6-03 is right and there are four**, only
one of which was written down here:

| # | The prompt | covered below by |
| --- | --- | --- |
| 1 | Why the use case fits WebMCP | *Why this belongs in the page* |
| 2 | How it improves the user experience | *What it does* |
| 3 | **What humans and agents can accomplish together that was not possible before** | the mandated-prompt section — thesis verbatim |
| 4 | WebMCP implementation details | *How it was built* |

Also required, and none of it is prose:

- **A working live URL** the judges can open in Chrome with WebMCP enabled, or
  in ChatGPT's in-app browser. **BLOCKED by the stealth rule until submission.**
- **A public repo** — GitHub, GitLab or Bitbucket — with complete source, and
  an **open source licence file**, with the licence *visible in the repo's
  About section*. `LICENSE` exists (MIT, Sidharth Ramanan). The About-section
  visibility is a GitHub setting, so it has to be checked after the repo is
  pushed, not before.
- **The video, ≤3 minutes**, publicly visible on YouTube, with audio covering
  what was built and how WebMCP was used, and no third-party trademarks or
  copyrighted music. (Which is why the host layer is shown working as designed
  for ~5 seconds and is never the on-screen antagonist.)
- **Deadline: Thursday 3 September 2026, 1:00pm PDT.**

### Two placeholders that must not ship
`README.md` still contains `<LIVE-URL>` (line 87) and `<REPO-URL>` (line 92).
Both are blocked on the same thing — the repo going public and the app being
deployed — so they cannot be filled tonight. They are the last two edits before
submission.

## The framing law
STATUS says it twice: do NOT sell this as "we added prompt injection". The
novel conjunction is the identity thesis, and it leads.

The thesis, verbatim, per the standing instruction that it appears in the first
three sentences and answers the mandated prompt word for word:

> **The page knows something about the evidence that neither the model nor
> generic host authorization knows, and uses that knowledge to change what the
> agent can do.**

---

## Lead — first three sentences

Release Airlock is a deploy console where an agent can reach every lever and
not one of them moves without you. **The page knows something about the
evidence that neither the model nor generic host authorization knows, and uses
that knowledge to change what the agent can do.** A generic "the agent wants to
roll back a deploy — allow?" dialog cannot know that the deploy id in that
request appeared nowhere in the console's own state and reached the agent only
inside a customer-supplied log line the page itself served; the page knows,
because the page served it, and it raises the bar on that write accordingly.

---

## What can people and agents do together that was difficult or impossible before?

*(the mandated prompt — thesis verbatim, then the demonstration)*

**The page knows something about the evidence that neither the model nor
generic host authorization knows, and uses that knowledge to change what the
agent can do.**

Before WebMCP, a page could show a human a lever or hide it. Authorization for
an agent's action lived either inside the model (which can be talked out of it)
or in a host-level confirmation (which knows the verb and the target, and
nothing about where the idea came from). Neither of those is where the
knowledge is.

The knowledge is in the page. This console audits every read into the same
event log it renders from, so it can answer a question no other layer can:
**did this proposal's target reach the agent through content the page itself
served as untrusted?** When the answer is yes, the approval card quotes the
line, names the log position, says which read served it — and promotes an
otherwise ordinary tier-1 rollback onto the two-key rung. The human is
informed, never overruled: engage the key and you can still do it.

That is one page-native check. There are three more in the same family:

- **The tool surface is a function of console state.** Moving the response
  stage from Triage to Diagnosis to Recovery registers and unregisters tools
  underneath a live agent session. Nothing that touches production *exists* in
  triage — it is absent, not merely refused — and a removed tool leaves a
  tombstone the agent can ask about via `explain_surface`.
- **The gate is re-checked at decision time, not at proposal time**, because
  the operator may have moved the stage between the ask and the answer.
- **A plan is a first-class object.** An agent can propose an ordered sequence
  with the reason the order is load-bearing — and step N+1 is not proposed
  until step N has *executed*, so the human always decides against the world as
  it is rather than the world the plan predicted.

None of that is expressible from the server side, because the server never
served the evidence and does not know what the operator is looking at.

---

## Why this use case belongs in the page
*(mandated prompt 1 — why the use case fits WebMCP)*

Deploy and incident tooling is the case where "who is allowed to do what"
changes minute to minute, and where the cost of a wrong action is asymmetric:
a rollback is cheap on Tuesday and takes the store down mid-migration. That
authority is a property of the PAGE'S STATE — which incident stage you are in,
which build is live, whether a migration has already written rows — and it is
knowledge that lives nowhere else. A backend MCP server would have to
re-derive it and then keep it in sync with the UI, and the two would drift.
WebMCP removes the second copy: the same state that decides which buttons a
human sees decides which verbs an agent has.

That is the whole reason this is a web page and not an API. **Stage change →
visible controls change → callable tools change**, from one source, with no
policy layer in between that can disagree with the screen.

## What it does

An on-call engineer's deploy console for a store that is currently failing
checkout. Every lever is clickable by hand and every lever states what it
costs. An agent connected through WebMCP gets six read tools, a notebook to
write its conclusions into, and twenty tools that **cannot execute anything** —
their entire effect is to put a card in front of the operator.

Four scenarios, each built so that no single read gives the answer:

- **migration-trap** — the obvious rollback is the catastrophe. Deploy-note
  prose says the old code path reads only the v1 layout; a different read says
  43,857 rows are already written in v2. Neither says "do not roll back".
- **innocent-deploy** — the deploy that correlates is not the deploy that
  caused it. A 5% canary cannot be erroring 24% of traffic.
- **poisoned-runbook** — a customer-supplied log line asks for a healthy deploy
  to be rolled back, and the page can prove it served that line.
- **retry-storm** — the answer is two levers **in one order.**

retry-storm is the case for the whole product. A checkout client shipped with
retries raised 2 → 6, no jitter, no budget. A brief database lock lights the
loop, **the trigger then clears, and the outage sustains itself on retries
alone** — a textbook metastable failure. Doing nothing never recovers. The
fleet is at its autoscaler ceiling, so shipping the fix first withdraws
instances the incident cannot spare. Measured over 24 machine-verified
variants:

| what you do | mean damage |
| --- | --- |
| nothing | 146.23 |
| **cap the route, then ship the fix** | **9.10** |
| ship the fix, then cap the route | 170.61 |
| silence the alerts, then ship | 537.34 — **api down in 24 of 24** |

Silencing alerts costs *nothing* on its own — a test asserts it — and disarms
the rollout's automatic abort. **A static runbook cannot encode a cost that
depends on what you do next.** A page that models the world can.

---

## How it was built

- **One event log is the truth.** The world is a pure fold over it; the UI, the
  tool results and the metrics all derive from `(events, world)`. There is no
  second source of state to drift.
- **A Web Worker owns the log**; the main thread renders and forwards.
  `window.__airlock` invokes tools through the same execute path real WebMCP
  uses, so the tests and the unattended driver exercise the real thing rather
  than a mock.
- **Determinism is enforced, not hoped for.** No `Date.now`, no `Math.random`
  anywhere in the simulator — a linter fails the build. Same seed, byte-
  identical replay.
- **The gate is checked on both sides.** One table decides what the agent can
  *see*; a separate table decides what the engine will *execute*, with a test
  asserting they agree — because the engine must never trust that a tool was
  unregistered.
- **Scenarios are compiled and auto-verified, not asserted.** 91 variants are
  machine-generated and accepted only if a scripted correct run beats doing
  nothing AND every declared trap costs more than doing nothing, both probed to
  the same horizon. Ordering traps are held to a higher bar: an ordering
  violation must be catastrophic, or cost more than both doing nothing and
  doing the same work in the right order.
- **Verification:** 187 unit and property tests, 85 hit-tested Playwright gates
  against the real page, a determinism linter, the corpus compiler, and an
  unattended driver that plays both stories end to end.

Runs entirely in the browser. No backend, no API keys, no accounts.

---

## Challenges

**Paginated tools whose contract lives only in prose the model skims.** The
first paid model run opened every paginated read with `{"cursor": 0}` — a
perfectly natural reading of "start at the beginning" — and three tools
answered with a **silently empty page**. The model then reasoned about the
incident having seen no deploys, no logs and no traffic. That is a WebMCP
lesson, not a bug in our sim: sequence numbers start at 1, so 0 names no
position, and a paginated tool must never answer nonsense with silence. The
real fix was the tool description: *"Omit it for the newest page; there is no
page 0."*

**Answer keys that name a number instead of a decision.** A run capped the
route at 70 req/s and then shipped — the correct answer, in the correct order —
and scored as wrong, because the key named the exact cap our console's preset
happens to offer. A key may now state the *constraint* that defines the
decision, and the compiler probes it at its bound. Levers whose value IS the
decision stay literal: an env var means the opposite thing at 60 and at 3600.

**Comparisons that were not comparisons.** The paired campaign sampled by
sorting hashed run ids and slicing, so the two arms of a scenario landed
nowhere near each other: forty runs on *different* scenarios, compared as if
that were a comparison. It now samples whole cells, and the arm is the
innermost loop so every prefix is pair-complete.

---

## What we learned, and what we are NOT claiming

The measured study is a bonus, not the claim, and it is reported with its
confound intact. A paired gated-vs-ungated campaign over the ordering family
favours the gate — but **the turn cap is not arm-neutral**: an approval
round-trip costs turns, so an equal cap hands the gated arm less thinking
budget, and the runs that ran out are exactly the ones excluded from the
scoring. Our own analyzer prints that warning, along with a second: **zero runs
in either arm went catastrophic**, so the catastrophe framing belongs to a
scripted persona and is not something this model exhibited. We are not
publishing it as one.

What the product demonstrates does not depend on any of that.

---

## What's next

Real telemetry behind the same tool surface. The console's contract is
`(events, world)`; the simulator is one implementation of it.
