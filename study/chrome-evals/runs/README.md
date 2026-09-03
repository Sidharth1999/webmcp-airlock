# Chrome `webmcp-evals` run artifacts

Findings and the per-case tables are in [../RESULTS.md](../RESULTS.md).

| dir | what it is |
| --- | --- |
| `gpt-5-v1/` | **the reported run.** `openai:gpt-5`, live URL, `?template=migration-trap&run=1&tick=200`. Four reports in file order: triage, guard, recovery (`&mode=recovery`), guard again against `?template=poisoned-runbook`. |
| `gpt-5.6-terra/` | the run that could not start: 13/13 cases `error`, HTTP 400 from the API, $0 billed. Kept as the evidence for the chat-completions / `reasoning_effort` interop note. |
| `gpt-5/` | **invalid — wrong scenario.** No `?template=`, so the live build served `retry-storm` and the eval files' `d-201` / `new-checkout` entities did not exist. JSONs gzipped; HTML readable as-is. |
| `gpt-5-baseline/` | **invalid — paused world.** `?template=` without `?run=1` leaves the sim at tick 0, so the incident never opened. JSONs gzipped; HTML readable as-is. |

`gunzip -k <file>.json.gz` to read a gzipped report. They are large because each
step row embeds the full `availableTools` schema list.
