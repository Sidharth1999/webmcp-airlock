# Proxy-vs-real deltas log

> M3-07 requirement (PLAN decision 2026-08-28 late): the tiered proxies —
> (1) scripted Playwright driver, (2) synthetic persona harness, (3)
> Claude-as-agent-proxy — stand in for the real ChatGPT runtime, which is
> attended and 8–22s/turn. Every observed difference between a proxy and the
> real runtime gets a dated row here; calibration runs (M3-08, M4) append.

## Structural deltas (known by construction)

| # | Area | Proxy behavior | Real runtime (observed/expected) | Risk to validity |
|---|------|----------------|----------------------------------|------------------|
| 1 | Tool invocation path | `window.__airlock.invoke()` — our execute() called directly | Chrome 151 `executeTool` passes input as a JSON **string** (M0-observed); our `coerceInput` bridges both | Low — same execute body; string coercion unit-tested |
| 2 | Tool discovery | Personas/driver call tools by name, never "discover" them | ChatGPT reads names + descriptions from `getTools()`; descriptions steer selection | **High for description tuning** — only real/LLM runs exercise selection; evals-cli `expectedCall` traces from the driver seed those evals |
| 3 | Timing | Driver ~200ms/turn; harness instant (engine-direct, sim-time only) | 8–22s/turn observed in M0 — damage accrues during agent thinking | Medium — sim-time damage model is turn-based in harness (`step(2)` per turn); calibrate turns-per-real-minute at M3-08 |
| 4 | Reasoning | Personas are fixed policies (naive/diligent) | LLM behavior varies per phrasing/seed; may do neither policy | Medium — personas bound the space (lazy floor / careful ceiling); the study (M4) samples real variance via API |
| 5 | Mode escalation | Operator model auto-escalates on request | Real human may refuse or question; ChatGPT must ASK in prose | Low for plumbing; the ritual is choreographed in the demo anyway |
| 6 | getTools shape | n/a (no discovery) | Returns an **iterable of RegisteredTool**, not an array (observed 2026-08-29, M3-02 verification) | None — page-side only |

## Calibration rows (append per real run)

| Date | Scenario/seed | Proxy prediction | Real ChatGPT behavior | Delta + action |
|------|---------------|------------------|-----------------------|----------------|
| — | — | — | pending M3-08 attended run | — |
