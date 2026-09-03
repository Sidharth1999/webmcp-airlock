# The thesis, and how far it is defended

**Claim.** For an agent that can change production, the page the operator is
looking at is the right place to hold the agent's capability, the evidence it
acted on, and the decision that lets its action happen. WebMCP puts the tool
server in the page, and that co-location, not the tools themselves, is what
this console demonstrates.

This page states the claim precisely, says what it does not claim, and points
at the evidence for each part. Numbers are indexed in [`evals.md`](evals.md).

## The three things that live in one place

1. **Capability.** The tool surface is a function of console state. Triage
   grants 13 tools, Recovery 27; the change happens under a live session via
   `AbortController`, so a real host fires `toolchange`. A withdrawn tool
   leaves a tombstone and `explain_surface` says why. The engine re-checks the
   gate at decision time, against the stage the operator has set by then, not
   the stage at proposal time.
2. **Evidence.** Every read is audited into the same event log the page
   renders from. When a proposal's target reached the agent only through a
   line the page served as untrusted, the card says so, quotes the line, names
   the read, and promotes the write onto the two-key rung. A plan carries the
   reason its order is load-bearing, and each step's observation is written
   from the world's own diff, or from the executed action's outcome with its
   reason when nothing moved.
3. **Decision.** Every write is a proposal. The human decides on the same
   surface, beside the evidence, with the agent's objection to a click shown
   next to the control before the click. While a host is attached the
   approval is a held gesture. The receipt records who decided and how.

## What a server-side MCP or a CLI agent can and cannot do

A server that also serves the logs can tag provenance. A CLI agent can be
wrapped in an approval queue. Neither is the surface the human is deciding
on. Reproducing this console's behaviour from outside the page means
reconstructing the console's state, its rendered evidence, and its decision
controls in a second place, and keeping them in sync with the first. At that
point it is a WebMCP page. The argument is therefore not "impossible
elsewhere" but "native here, reconstructed everywhere else", and the
demonstration is that the reconstruction is what every layer of this console
would otherwise need.

## What is validated, and by what

| part of the claim | evidence | where |
| --- | --- | --- |
| a real host honours live registration and withdrawal | tools discovered, invoked, and the surface seen shrinking and growing mid-session in ChatGPT's in-app browser on the deployed origin; 13 and 27 read off Chrome's `document.modelContext` on the live URL | STATUS.md (gate 1, 2026-08-31); `study/chrome-evals/` |
| the surface is what the page says it is | Chrome's `webmcp-evals` smoke: 24/24 steps against the live URL with no model; Lighthouse lists 13 registered tools with valid schemas | `study/chrome-evals/README.md`, `log/lighthouse/README.md` |
| a real model respects the boundary | GPT-5 through Chrome's evals: right tool and arguments in 28 of 28 cases, zero production writes in Triage, the smuggled log instruction named as an injection and refused | `study/chrome-evals/RESULTS.md` |
| the gate is structural, not behavioural | 0 of 392 gated real-model writes executed without a decision; the gated code path cannot reach `executed` except through `engine.decide` | `docs/study-summary.md`, `src/sim/airlock.test.ts` |
| the order problem is real and priced | 91 machine-verified variants; in the ordering family the reversed order costs more than doing nothing and only gated runs got the order right (4 of 24 vs 0 of 24) | `study/corpus.json`, `docs/study-summary.md` |
| every scenario is recoverable after a mistake | replays through the real tool path end at incident closed after the trap in all four families | `tools/replay-*.mjs`, `src/sim/outcome.test.ts` |
| the page reads as a product to a machine | Lighthouse agentic-browsing 4/4, performance 100, best practices 100 | `log/lighthouse/README.md` |

## What is not claimed

- **That the gate prevents catastrophes.** In 488 scored real-model runs
  neither arm produced a catastrophic outcome; the model never attempted the
  flagship trap. The counterfactual belongs to a scripted persona.
- **That the gated agent does better.** The study's turn cap is not
  arm-neutral and its operator is a script that approves everything. The
  ordering result is suggestive, not conclusive.
- **That a computer-use host cannot bypass the human.** ChatGPT's in-app
  browser both calls the tools and drives the DOM; on a real run it clicked
  Approve itself. The held gesture removes the one-shot click and the record
  says which gesture happened; only a host-side rule closes the hole. See
  [`spec-feedback.md`](spec-feedback.md), point 7.
- **That this runs against real infrastructure.** It is a deterministic
  simulation modelled on published incidents. Damage figures compare courses
  of action within a scenario only.

## Where the argument is made for judges

- The Devpost description: [`devpost-description.md`](devpost-description.md),
  under the four mandated prompts.
- The README, "What is different" and "What WebMCP is actually doing here".
- The premise evidence, including what cuts against it:
  [`evidence.md`](evidence.md).
- What the spec would need for the claim to hold without convention:
  [`spec-feedback.md`](spec-feedback.md).
