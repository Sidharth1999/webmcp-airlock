Coming back to this after reading @mlmrx's comment properly, which landed before my last two and which I should have addressed first.

Agreed on all three points. `isTrusted` isn't a boundary, it's a description of one host's current implementation; WebDriver-level automation is trusted by design, and I said as much but then leaned on the check anyway. Security Considerations being non-normative means the rule needs a home in the processing model to mean anything. And "physical input" is the wrong line to draw, since a switch user's synthesized click is a user decision and an agent's is not.

So I'd narrow the ask to one thing: a way for a page to mark a control as a user decision, defined as agent-originated vs user-authorized, that a conforming UA is required to honour. The page-side check I shipped stays as a stopgap, labelled as one. Happy to keep the repro page up as long as it's useful, and to run it against other hosts if anyone wants numbers from more than one.
