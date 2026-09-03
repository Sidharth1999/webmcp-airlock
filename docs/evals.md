# Every number, where it comes from, and what it does not show

One table. Each row names the command or file that produces the number, so a
reader can regenerate it rather than take it on trust. Dates are 2026.

| what | number | how to reproduce | caveat |
| --- | --- | --- | --- |
| unit and property tests | 229 passing, 14 files | `npm test` | vitest; includes 13 outcome/recovery tests added 09-02 |
| hit-tested Playwright gates against the real page | 131, green | `npm run smoke` (run alone; one gate samples a 900 ms transition on wall clock) | selectors and text are asserted on the built page on port 8918 |
| determinism | no `Date.now`, `Math.random`, `new Date` in `src/sim` | `npm run lint:sim` | same `(template, seed, params)` replays byte-identically |
| scenario corpus | 91 variants accepted across 4 families | `npm run corpus`; output `study/corpus.json` | a variant is accepted only if a scripted correct run beats doing nothing and every declared trap costs more than doing nothing, probed to the same horizon |
| ordering family, damage by course of action | nothing 154.10 · cap then ship 12.43 · full seven-step response 9.10 · ship then cap 170.61 · silence then ship 573.75, api down 24/24 | `study/corpus.json` (24 retry-storm variants, `damageRevenueLost`) | the simulator's own units; meaningful within a scenario only |
| real-model study, catastrophic outcomes | 0 gated, 0 ungated over 488 scored runs | `study/campaign/`, `npx vite-node tools/analyze-campaign.ts <campaign>`; summary in `docs/study-summary.md` | the model never called the flagship trap in either arm; does not show the gate prevents anything |
| real-model study, writes executed without a decision (gated arm) | 0 of 392 | same | structural (gated dispatch only executes via `engine.decide`) and measured; the operator is a script |
| real-model study, ordering family correct order | 4 of 24 gated vs 0 of 24 ungated | same, campaign `v2-order` | 25-turn cap hit by 13 gated vs 7 ungated runs; one-sided Fisher p ≈ 0.055 |
| real-model study, spend | $10.68 over 490 runs (`gpt-5.6-terra`, `gpt-5.6-luna`) | token usage × price table | not a billing readout |
| Chrome `webmcp-evals`, smoke (no model) | 24/24 steps against the live URL: 13 Triage, 11 Recovery | `study/chrome-evals/README.md` (commands) | exercises schemas and results through Chrome's own harness |
| Chrome `webmcp-evals`, real model | GPT-5: right tool and arguments 28/28 cases; 18/28 pass under the strict matcher; guard set: 0 production writes in Triage, injection refused | `study/chrome-evals/RESULTS.md`, runs in `study/chrome-evals/runs/` | 8 of 10 strict failures are the model reading before it proposes, which our descriptions ask for; `gpt-5.6-terra` cannot be driven by the CLI (chat-completions + reasoning models); $1.73 |
| Lighthouse 13.4 agentic browsing | 4/4; performance 100, accessibility 96, best practices 100 | `log/lighthouse/README.md` (exact invocation, before/after) | after-run is a local production build; the live URL's SEO score is intentionally low (`noindex`) |
| real host, live registration | tools discovered, invoked, surface shrinking and growing mid-session in ChatGPT's in-app browser on the deployed origin | STATUS.md, 2026-08-31 gate 1; 13 and 27 read from `document.modelContext` on the live URL 2026-09-02 | the 09-02 ChatGPT run also found two defects (silent no-ops, host-side clicks), both fixed the same night; the second is filed upstream as [webmcp#288](https://github.com/webmachinelearning/webmcp/issues/288) |
| recoverability after a mistake | all four families reach incident closed after the trap | `node tools/replay-traps-recover.mjs`, `tools/replay-chatgpt.mjs` (dev server on 8917) | added 09-02 after the real host run exposed dead-ends |
| tool surface reference | 27 tools, 13 / 17 / 27 by stage | `npm run docs:tools` → `docs/webmcp-surface.md` | generated from the registration path; cannot drift from the bundle |

What is deliberately absent: a benchmark score for "the agent does better
with the airlock". The study's design cannot support that claim yet, and the
reasons are written next to its numbers rather than rounded off.
