# Evidence base — is the Release Airlock the right thing to build?

> Written 2026-08-30 because Sid asked the honest question: the 3-AI alignment
> at the start agreed this was a good project, but agreement is not evidence.
> This file is the evidence, INCLUDING the parts that cut against us.
> Feeds the M6-03 Devpost writeup. Every claim here is sourced; anything we
> cannot source does not go in the submission.

## VERDICT: premise validated, with one honest gap. Build it.

---

## 1. Are agents actually given production write access, and does it go wrong?

**Yes, repeatedly and recently.** Nine publicly documented incidents in fourteen
months (Jun 2025 – Jul 2026) where a coding agent destroyed data.
Source: https://adversa.ai/blog/ai-coding-agent-incidents/

| date | tool | destroyed | permission system |
|---|---|---|---|
| Jun 2025 | Cursor (YOLO) | developer's entire machine | off by design |
| Jul 2025 | Replit | SaaStr production DB, 2,400+ records | **ON — ignored** |
| Oct 2025 | Claude Code | Ubuntu/WSL2 home directory | **ON — failed to detect** |
| Nov 2025 | Gemini CLI | folder of files | harness error |
| Nov 2025 | Google Antigravity | D: drive partition | off |
| Dec 2025 | Cursor Plan Mode | ~70 git files + remote processes | **ON — safety mode broken** |
| Dec 2025 | Claude Code | Mac home directory | not stated |
| Dec 2025 | Amazon Kiro | AWS production region, **13h outage** | **ON — bypassed** |
| Jul 2026 | Claude Code | Supabase production DB | **ON — autonomous mode** |

- **PocketOS, 25 Apr 2026:** an agent deleted a production database *and its
  backups* in **nine seconds**. The postmortem names the missing controls as
  overprivileged tokens, shared blast radius, missing environment isolation, and
  **"absent destructive-action gates."**
  https://mondoo.com/blog/5-lessons-from-9-seconds-ai-agent-deleted-production-database
- **Scale:** IBM surveyed ~2,000 C-suite technology leaders; enterprises averaged
  **54 AI-agent incidents in 2025, 17% of them high-severity.**

## 2. Is the control we built the control practitioners actually ask for?

**Yes — nearly verbatim.** The prevention list from the incident survey includes
**"Irreversibility category: require manual approval for `rm -rf`, `DROP TABLE`,
force pushes."** That is our tier ladder plus our flagship trap: a migration
whose irreversibility is exactly why the obvious rollback is catastrophic.

Chrome's own WebMCP security guide independently asks for the same shape —
"it's impossible to guarantee safety inside of a large language model" — and
recommends `readOnlyHint`, `untrustedContentHint`, tight output budgets and
origin scoping, all of which the build already implements
(docs/research-resources.md).

## 3. The finding that makes the STUDY worth more than the demo

**Permission systems were ACTIVE in 5 of the 9 incidents and failed anyway** —
through shell-expansion gaps, a broken safety mode, permission inheritance, and
misread flags. Case #8 is the sharpest: a **two-person approval gate for
production pushes was bypassed** because an engineer's elevated permissions
flowed through to the agent.

This does **not** undercut the airlock — it is the strongest argument for it.
It says the open question is not *whether* to gate but **how a gate must be
designed to actually hold**, and nobody is measuring that. That is precisely
what M4 measures, and it is why our own design is deliberately honest that an
**approved-but-wrong action still hits the trap — the gate is the human, not
magic.** "Everyone demo'd an agent. We measured one" is the correct pitch.

## 4. Honest counter-evidence (do NOT overclaim in the writeup)

**(a) Incident response is not one console.** Studies and practitioner accounts
show coordination happens in **Slack**, on-call engineers **jump between ~five
dashboards**, and a large share of incident duration is communication and
alignment rather than the technical fix.
https://arxiv.org/abs/2008.11192 · https://incident.io/blog/sre-tools-reliability-practices-2026

→ **Scope correction:** we are NOT the incident command centre. We are the
**write surface** — the place where a change is actually made (deploy, flag,
env, route). That surface *is* consolidated in real products (Vercel,
LaunchDarkly, Kubernetes dashboards, cloud consoles), and a gate belongs where
the write happens. Claim that, not "we run your incident."

**(b) The strongest gap: every documented harm above is CLI/IDE-side** — Cursor,
Claude Code, Replit, Gemini CLI, Kiro — **not** browser-side. We are betting
that WebMCP makes browser agents consequential in the same way. That is a
forward bet, not a validated present.

→ **Honest framing:** do not claim browser agents are causing outages today.
Claim that the CLI incidents show exactly what happens when consequential
agent actions have no gate, and that WebMCP is about to hand agents the same
power inside web apps — where the human already is. The airlock is the control
that the CLI world learned it needed, built for the surface that is arriving.

## 5. Claims we must NOT make
- ~~"70% of outages are change-induced"~~ — **unsourced.** It has been floating
  in our doctrine since 08-28 with no citation. **CUT IT** unless a real source
  is found. An unsourced statistic in a judged submission is a live risk.
- No invented dollar figures. $ only ever as mechanically derived sim output
  with the formula visible (ratified 08-28).
- Do not claim browser-agent production incidents exist. See 4(b).

---

## 6. Why WebMCP specifically — and why this is NOT a CLI or a Playwright demo

> Sid, 2026-08-30: it must not be reducible to "plug MCPs into Claude Code and
> let it investigate" or "let an agent click around your frontend". This is the
> **WebMCP Leverage** criterion, which is the judges' FIRST tiebreak. Carry it
> through the writeup, the film narration, and every design decision.

The test to apply to any feature: **could this be done as well with CLI+MCP, or
by an agent driving the UI?** If yes, it is not leverage.

| | CLI agent + MCP servers | Playwright / computer-use | **WebMCP (ours)** |
|---|---|---|---|
| Who decides what the agent may do | the **user**, in client config, statically per session | nobody — anything a human can click | **the APP, live, from its own state** |
| Capability changes with situation | no — the server list is fixed at launch | no — the whole UI is always clickable | **yes — mode-gated registration; tools appear/disappear as the incident escalates, and `toolchange` fires** |
| What an action *means* | server-defined, opaque to the host app | a click; no semantics at all | **declared: tier, reversibility, diff, `readOnlyHint`, `untrustedContentHint`** |
| Where approval happens | a y/n prompt in the terminal, to the same person who launched the agent | there is no gate; the agent just clicks the destructive button | **a diff card anchored to the node being mutated, in the surface the operator is already using** |
| Can the gate be measured | not really — no typed action vocabulary | no — clicks aren't tiered | **yes — every attempt is a typed, logged event; that's what makes M4 possible** |

**The four load-bearing claims:**

1. **The application is the policy authority.** Only WebMCP lets the *page*
   decide, at runtime, which tools exist at all. Our modes (triage → diagnosis →
   recovery) mean the agent's capability is a function of application state, not
   of what a user wired up. A CLI MCP server's tool list is static config; in
   Playwright every button is always reachable. **Verified against real Chrome
   151: `getTools()` returns 6 → 11 → 6 as the incident escalates and de-escalates.**
2. **Human and agent share one surface.** Approval is not a terminal prompt — it
   is a diff card anchored to the deploy being rolled back, in the operator's own
   view. Co-presence (human selects a node → the agent's reads scope to it) is
   only possible when both parties are in the same live document.
3. **Actions carry semantics the gate can reason about.** A rollback is tier 1, a
   route change is tier 4 and needs the dual key, a migration is flagged
   irreversible. Pixels cannot be tiered; a click cannot declare its blast radius.
   This is also what makes the trap legible: the agent can *know* the rollback is
   irreversible before proposing it.
4. **It degrades to a normal web app.** With no agent present the page is fully
   usable by a human — which is the honest test that we built a product, not a
   harness.

**Corollary for scope (see §4a):** because the leverage is in *gating
consequential writes on the surface where they happen*, investigation-heavy
features are the wrong place to spend — CLI+MCP genuinely beats the browser at
log spelunking, and Sid's round-3 premise check already killed that lane. Stay
on the write surface.

---

## 7. PIVOT CHECK — does mitigation actually happen in a UI like ours?

> Sid, 2026-08-30: *"We can't be building some app that isn't practical or
> realistic to how people actually manage incidents. Does it happen on a UI like
> ours or not, at least mitigation?"* The right question, and the one §4a made
> urgent. Answer below.

### VERDICT: NO PIVOT. Mitigation is the part that DOES happen in a web console.

The §4a counter-evidence (Slack, ~5 dashboards, communication overhead) is about
**coordination and diagnosis**. Those genuinely do not happen in one console —
which is why Sid's round-3 premise check already killed the investigation lane.
**Mitigation is a different act, and it is overwhelmingly a console action.**

**1. The fastest documented mitigation is flipping a feature flag — in a dashboard.**
LaunchDarkly's own incident-management guidance: *"The engineer identifies the
correct switch, toggles it through the feature flag dashboard, and documents the
action in the incident timeline."* Flag changes propagate in ~200ms, and
*"disabling a feature via a flag takes less time than rolling back a deployment."*
https://launchdarkly.com/blog/using-feature-flags-during-incident-management/ ·
https://upstat.io/blog/feature-flags-kill-switches

**2. The second-fastest is an instant rollback — also from a console.**
Vercel ships **Instant Rollback** explicitly for *"swift recovery from production
incidents"*, pointing traffic at a previous deployment within seconds.
ArgoCD offers *"manual rollbacks through the UI or CLI"* — the UI is first-class.
https://vercel.com/docs/instant-rollback ·
https://www.aviator.co/blog/how-to-manage-rollouts-and-rollbacks-using-argocd/

**3. Our flagship scenario's answer key IS the documented best practice.**
`flag.set new-checkout=off` → `deploy.rollforward api` is mitigate-first,
then-ship-the-fix. That is not a scenario we invented to be clever; it is what
the practice literature says to do.

**4. The trap is the failure mode of the alternative.** Automated rollback
triggers exist and fire without a human when error rates spike. In our scenario
that automation is exactly what goes catastrophic — rolling back a deployment
whose migration is irreversible. **Automation without judgment fires the trap;
the airlock is what puts judgment in the path.** Use this in the writeup.

### What this DOES change (sharpening, not pivoting)
- **Call it the mitigation / write surface.** Never "incident management" or
  "incident command centre" — that space is Slack + PagerDuty + incident.io and
  we would lose that comparison on sight.
- **Lead with the flag kill-switch**, not the rollback. It is the canonical fast
  mitigation, it is what our correct path uses first, and it is unambiguously a
  console action.
- **Diagnosis stays deliberately thin.** Read tools exist to inform the decision,
  not to compete with log tooling.

### Residual honesty
In reality flags, deploys, env and routes often live in *separate* products
(LaunchDarkly + Vercel + Cloudflare). Consolidating them in one console is a
simulation convenience — defensible, because internal platform consoles
(Backstage-style) do exactly this, but do not claim every org has one pane.

---

## 8. Is the work complex enough to need an agent — and is dynamic tool registration a REAL pattern?

> Sid, 2026-08-30: *"the fixes on these consoles are complex enough that agent
> assistance makes sense, right? If it's just pressing rollback then that's
> stupid to need an agent for. And also whether there are genuine flows that
> require changing the toolset available to agents."* Both answered YES, with
> evidence, and both sharpen the pitch.

### 8a. The click is trivial. The DECISION is the whole cost.

The measured shape of an incident:
- **Diagnosis is 2–3× longer than detection and repair COMBINED.**
- It *"eats 30 to 45 minutes per enterprise incident"* and is *"the largest
  controllable portion of Mean Time To Resolve."*
- *"Detection and resolution are usually fast, while the middle part — where
  someone is figuring out what to do — eats most of the clock."*
  https://iwconnect.com/incident-diagnosis-time/ · https://rootly.com/incident-response/metrics

So "just press rollback" is precisely backwards as an objection. **Pressing
rollback takes one second; working out that rollback is the right button — and
in our scenario, that it is the WRONG one — is the 30–45 minutes.** That gap is
exactly what an agent compresses, and exactly where an agent being confidently
wrong is most expensive. The value and the danger live in the same place, which
is the entire argument for gating rather than automating.

Our own scenario is this in miniature: the naive agent presses the obvious
button and makes it catastrophic; the diligent one reads the deploy's migration
metadata first and takes the other path. Same tools, same one-second click,
opposite outcomes — the difference is entirely in the decision.

**Resolves the §4a scope tension.** Diagnosis splits in two:
- *log forensics / spelunking* → CLI+MCP genuinely wins. Out of scope, killed by
  Sid's round-3 premise check. Keep it out.
- *change correlation* — "what shipped recently, is reverting it safe, what's the
  blast radius" → lives in the **release console's own data**, which is exactly
  what our read tools expose (`list_deploys` with reversibility + canary deltas,
  `list_changes`, `traffic_history`). That is the diagnosis we serve, and it is
  the diagnosis that decides the mitigation.

### 8b. Mode-gated tool registration = just-in-time access, an established pattern

Our modes are not a demo mechanic. They are **JIT privilege elevation applied to
an agent's tool surface** — a mainstream enterprise access-control pattern:

| JIT / break-glass, as practised | our airlock |
|---|---|
| temporary, time-bound elevation only when needed | triage → diagnosis → recovery, derived from the log |
| granted *"typically after approval"* | tier 4 requires the dual key held at execution |
| *"permissions automatically return to baseline"* when the task ends | leaving a mode **unregisters** those tools (AbortController), leaving tombstones |
| *"record every action from request to revocation in a full audit trail"* | every surface change is a `mode.changed` event; `explain_surface` narrates it |
| break-glass exists because *"normal workflows are blocked"* during an incident | writes are blocked in triage and unlock only as the incident escalates |

Sources: https://www.ibm.com/think/topics/just-in-time-access ·
https://hoop.dev/blog/incident-response-break-glass-access-the-key-to-fast-secure-emergency-system-recovery

**Frame it this way in the writeup: "just-in-time access, for agents."** It is an
idea reviewers already accept for humans, applied to a new principal.

**And it is the sharpest WebMCP-leverage argument we have (see §6).** A CLI MCP
client's tool list is fixed at session start — the *application* cannot revoke an
agent's capability mid-incident. Only WebMCP lets the page add and remove tools
live, and we verified it end-to-end in real Chrome 151: **`getTools()` returns
6 → 11 → 6** as the incident escalates and de-escalates. Time-boxed, auto-revoked
agent capability is *not implementable* in the CLI story, and is meaningless in
the Playwright story where every button is always clickable.
