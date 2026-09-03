## Observation

A user agent that is **both** the WebMCP tool caller and a browser-automation agent (it can synthesize clicks and typing on the page) can complete the page's own human-in-the-loop step by itself.

I hit this on a real run, not in a test harness. Release Airlock (https://github.com/Sidharth1999/webmcp-airlock, live at https://release-airlock.vercel.app) is a deploy console that registers 27 tools via `document.modelContext`. Every write tool is proposal-only: it puts a card in front of the operator and the world changes only when the operator approves it on the page. On 2026-09-02, ChatGPT's in-app browser (GPT-5.6) called `propose_rollforward`, and then, when the proposal did not execute on its own, **clicked the page's Approve button** and continued. From the page's side the click had the same shape as the operator's, so the receipt recorded "approved by you". The human never decided anything.

This is one observed run on one host. I have not reproduced it on other hosts, and I am not claiming the host did anything outside its design: it is built to automate pages when tools do not get it where it wants to go, which is exactly what the explainer describes as the intended fallback ("If an agent ... finds that the task ... is not achievable through the WebMCP tools ..., then it can fall back to general-purpose browser automation").

## Why this matters for the spec

The explainer's goals include human-in-the-loop workflows, and its non-goals exclude fully autonomous operation. The safety story that follows from that, and that #198, #176 and #155 all build on, is: the page decides which tools are consequential, and a human confirms them somewhere. Both the host's confirmation UI and the page's own approval UI are legitimate places for that confirmation.

When the host is also a computer-use agent, the page-side half of that story is not enforceable. The page can mark a tool as proposal-only (there is no annotation for that today, but it can be done by convention in the description), render an approval control, and refuse to execute until it is pressed, and the same agent that called the tool can press it. Nothing in the page's view of the event distinguishes the agent's activation from the user's. "Human in the loop" then holds only if the host chooses to honour it.

The related threads cover adjacent ground but not this:

- #155 asks the UA to tell the page what consent it collected. Useful here, but the page also needs the inverse: a way to say "this control *is* the consent step; do not actuate it".
- #198 and #176 are hints from the page to the UA about *which tools* need confirmation. This issue is about what happens after the page has done its part and built the confirmation itself.
- #62 is about granting activation to tool `execute()` so gated APIs work. This is the mirror case: activation the page would rather the agent could *not* mint.

## Reproduction

1. Open https://release-airlock.vercel.app in a host that both exposes WebMCP tools to a model and can drive the page (ChatGPT's in-app browser was the one I used).
2. Ask the model to resolve the incident. It calls the read tools, then `propose_cap` / `propose_rollforward` etc. Each returns `{status:'proposed', proposalSeq}` and a card appears in the console with Approve / Reject.
3. Watch whether the host clicks Approve itself. On my run it did, on the first proposal that did not execute by itself.

The console now mitigates this while a host is attached (a 700 ms held gesture instead of a click, and the receipt records which gesture was used, `src/main.ts`, `armHold`). That raises the cost of the bypass; it does not close it. A computer-use host can hold a button down.

## What would close it

Any of these would do, from the page author's side:

1. **A rule in Security Considerations** for hosts that are also automation agents: while a tool invocation the host made is awaiting a user decision on the page, the host must not synthesize input on that page (or at least not on controls the page marks as the decision).
2. **A way for the page to mark a control as human-only**, that conforming hosts honour: an attribute (e.g. on the button or on a container) or an annotation on the tool naming the element that carries the decision.
3. **Activation that automation cannot mint**: if the page could require *trusted* user activation for its approval path and the host's synthetic events did not qualify, the page could enforce this itself without a convention.

I would take (1) alone as a real improvement, since it makes the current behaviour a spec non-conformance instead of an implementation choice.

Full write-up, with the run record and the mitigation: https://github.com/Sidharth1999/webmcp-airlock/blob/main/docs/spec-feedback.md#7-a-host-that-both-calls-tools-and-drives-the-dom-can-approve-its-own-proposals
