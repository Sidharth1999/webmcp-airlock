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
  Approve itself, and with the held gesture in place the next morning it
  moved the response stage instead to unlock more tools. On a one-file page
  it pressed a button labelled "Unlock" and left "Unlock (operator only)"
  alone, every event `isTrusted:false`. The console now refuses synthetic
  activation of human-only controls while a host is attached; input injected
  below the DOM would still pass, so only a host-side rule closes the hole. See
  [`spec-feedback.md`](spec-feedback.md), point 7, filed upstream as
  [webmachinelearning/webmcp#288](https://github.com/webmachinelearning/webmcp/issues/288).
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

## Sources

The premise review that settled these is [`evidence.md`](evidence.md),
written before the build, including what cuts against the project. The
citations it rests on, with the claim each supports:

- **Agents with production access do destroy things, with permission systems on.** Nine documented incidents in fourteen months, most with a permission system switched on and talked past: https://adversa.ai/blog/ai-coding-agent-incidents/. The Replit case, a production database and its backups gone in nine seconds, whose postmortem names "absent destructive-action gates": https://mondoo.com/blog/5-lessons-from-9-seconds-ai-agent-deleted-production-database
- **Diagnosis is the cost; the click is not.** The middle of an incident, where someone works out what to do, eats most of the clock: https://rootly.com/incident-response/metrics · https://iwconnect.com/incident-diagnosis-time/
- **On-call engineers stitch across several surfaces, and coordination dominates duration.** https://incident.io/blog/sre-tools-reliability-practices-2026 · https://arxiv.org/abs/2008.11192
- **Mitigation happens in a console, and the kill switch beats the rollback.** Flag changes propagate in about 200 ms and "disabling a feature via a flag takes less time than rolling back a deployment": https://launchdarkly.com/blog/using-feature-flags-during-incident-management/ · https://upstat.io/blog/feature-flags-kill-switches. Rollback is a first-class UI action in production tooling: https://vercel.com/docs/instant-rollback · https://www.aviator.co/blog/how-to-manage-rollouts-and-rollbacks-using-argocd/
- **Stage-gated capability is an established access pattern, not an invention.** Just-in-time access and break-glass: grant the minimum, unlock as the incident escalates, "record every action from request to revocation in a full audit trail": https://www.ibm.com/think/topics/just-in-time-access · https://hoop.dev/blog/incident-response-break-glass-access-the-key-to-fast-secure-emergency-system-recovery
- **The platform's own security guidance asks for this shape.** Chrome's WebMCP guide: "it's impossible to guarantee safety inside of a large language model"; mark reads `readOnlyHint`, mark external payloads `untrustedContentHint`, keep descriptions within budget: https://developer.chrome.com/docs/ai/webmcp/secure-tools. Chrome's evals guidance and CLI, which this repo runs against the live URL: https://developer.chrome.com/docs/ai/webmcp/evals
- **The retry-storm scenario is a documented failure class.** Metastable failures, where a trigger clears and the system sustains the outage on its own feedback: see [`sre-mess-research.md`](sre-mess-research.md) for the incident write-ups the four scenarios are modelled on.
