# Trace & Event Schema — v1 (SIGNED OFF)

> **SIGNED OFF by Sid 2026-08-28** (interactive checklist, this session). All four items agreed with two amendments: `Deploy.note` added (item 2), `log.line` EventKind added (item 4). Dual-key `keyHolder` representation deferred to M3 as `data.keyHolder` on `action.approved` — non-breaking, no new kind. Schema changes from here require a dated amendment block + Sid ping.
> The foundational data model. Per RUNBOOK, no autonomous build sessions until Sid signs off.
> Design goals: (1) superset of both possible skins (deploy console is locked, but the schema shouldn't preclude richer sims), (2) deterministic replay, (3) decision-grade metadata in every read-tool response, (4) one stream feeds ALL consumers: UI, agent tools, eval harness, flight recorder, postmortem generator.

## Core principle: one append-only event log

Everything is an `Event` in one ordered log. The sim emits them; the UI renders them; read tools query them; the audit trail IS the log filtered to actor events; the flight recorder replays it; the postmortem is generated from it. No second source of truth anywhere.

```ts
type Event = {
  seq: number;            // monotonic, the ordering truth
  t: number;              // sim-time ms (deterministic, from seeded clock — never Date.now)
  kind: EventKind;
  actor: 'sim' | 'human' | 'agent' | 'system';
  data: Record<string, unknown>;   // kind-specific payload, see below
  causedBy?: number;      // seq of the causing event (the causality thread — powers "thread of agency" UI)
}

type EventKind =
  // world
  | 'deploy.started' | 'deploy.finished' | 'deploy.failed'
  | 'traffic.tick'            // periodic: {rps, errRate, p95, byRoute}
  | 'service.health'          // {service, status: ok|degraded|down, reason}
  | 'migration.applied'
  | 'cache.state' | 'queue.state'
  | 'user.impact'             // {usersErrored, ticketsOpened, revenueLostFormula: {rps, errRate, valuePerReq}}
  | 'log.line'                // {service, level: debug|info|warn|error, msg, untrusted?: boolean} — untrusted lines surface via readOnly log tool with untrustedContentHint; the seeded prompt-injection line lives here
  // actions (writes — always via tools, always gated)
  | 'action.proposed'         // {tool, input, tier, diffSummary, provenance?, requiresKey?} — creates a pending approval; provenance/requiresKey are set when the write's TARGET traces to untrusted content the page served the agent (src/sim/provenance.ts)
  | 'action.approved' | 'action.rejected'   // {by: 'human', proposalSeq}
  | 'action.executed'         // {tool, input, result} (durationMs: see 2026-08-29 amendment)
  | 'action.blocked'          // {tool, input, tier, reason, ...} — the counterfactual's key metric (reason enum: see 2026-08-29 amendment)
  // agent lifecycle
  | 'tool.called'             // every tool invocation incl. reads: {tool, input, resultBytes} (durationMs: see 2026-08-29 amendment)
  | 'mode.changed'            // {from, to, toolsAdded[], toolsRemoved[], reason}
  | 'selection.changed'       // {by: 'human', target: EntityRef} — co-presence branching source
  // meta
  | 'scenario.seeded'         // {templateId, seed, params} — replay key
  | 'annotation.added'        // telestrator strokes, human or agent
```

## Entities (world state, derived from events by pure reducer)

```ts
type World = {
  services: Service[];        // {id, name, deps: id[], health, version}
  deploys: Deploy[];          // see below — the decision-grade core
  flags: Flag[];              // {id, name, state: on|off|pct, touchedByDeploy?}
  envVars: EnvVar[];          // {key, valueRedacted, changedAt}
  routes: Route[];            // {id, path, target, tier: 'dns'|'route'}
  migrations: Migration[];    // {id, appliedByDeploy, reversible: boolean}
  traffic: TrafficState;
  damage: DamageState;        // counters derived ONLY from user.impact events (formula visible)
}

type Deploy = {
  id: string;
  service: string;
  version: string;
  at: number;
  author: string;                    // sim persona
  changedAreas: string[];            // human-legible: ['checkout', 'session-cache']
  containsMigration: boolean;        // THE flagship-scenario bit
  migrationReversible?: boolean;
  flagsTouched: string[];
  diffstat: {files: number, plus: number, minus: number};
  canaryDelta?: {errRate: number, p95: number};   // decision-grade: what canary saw
  note?: string;                     // sim persona's commit message — scenario flavor + red herrings live here
  status: 'live' | 'rolled_back' | 'superseded';
}
```

## Tool I/O contract

- Every read tool returns terse JSON derived from the event log/world, ≤1.2KB, paginated via `{cursor}` if needed, always including `asOfSeq` so the agent can reason about staleness.
- Every write tool goes `action.proposed` → (approval UI) → `action.approved` → `action.executed`, each a separate event; `causedBy` chains them. Ungated variant (for the study) skips proposal/approval — same events minus the gate, so the SAME metrics compute for both arms.
- Blocked calls emit `action.blocked` with a machine-readable reason — this is what "dangerous writes attempted vs blocked" counts.

## Determinism rules

- Sim runs in a Worker off a seeded PRNG (mulberry32) + sim-clock; NO Date.now()/Math.random() anywhere in sim code (lint-enforced).
- `(templateId, seed, params)` fully determines the event stream → byte-identical replays → flight recorder + split-screen race + eval harness all come free.

## Metrics (all derived from the log, never stored separately)

- writesAttempted / writesBlocked / writesApproved (by tier)
- timeToRecovery: first `service.health: degraded` → all services ok
- correctPath: scenario template declares its solution set; executed action sequence matched against it
- damage$: Σ user.impact via the visible formula
- agentOverhead: Σ tool.called durations, result bytes (meta-observability pane)

## Sign-off checklist for Sid — COMPLETED 2026-08-28
- [x] One event log as single source of truth — **agreed as written**
- [x] Deploy metadata fields sufficient for "the obvious move is wrong" scenarios — **agreed + `note` field added**
- [x] causedBy threading enough for the thread-of-agency UI — **agreed, single-parent; rare multi-cause named in `data`**
- [x] Anything missing queryable by the agent — **`log.line` kind added (SPEC's untrusted injection line requires it); dual-key `keyHolder` deferred to M3 as `data.keyHolder` on `action.approved`**

---

## Amendment — 2026-08-29 (M3 close, residual review)

Aligning the document with what the code actually emits (the drift was
caught by the M3-close review; the code side was already consistent and
smoke-tested, so the DOC moves to match the code, not vice versa):

- **`action.blocked` reason enum (normative, actual):**
  `'invalid-input'` (malformed write input, blocked before any proposal;
  carries `detail`) · `'not-available-in-mode'` (tier not allowed by the
  current mode — emitted at propose time with actor `agent`, and at
  approval time with actor `human` when the mode moved after proposal;
  approval-time blocks carry `proposalSeq`) · `'dual-key-required'`
  (approval without the key, actor `human`, carries `proposalSeq`; raised
  either by tier 4 or, since 2026-08-31, by `requiresKey` on the proposal,
  in which case the block also carries `escalatedBy: 'untrusted-evidence'`).
  The draft values `'not-registered-in-mode'` / `'diagnosis-gate'` were
  never emitted by any build and are dead — do not filter on them.
- **Metrics note:** only `actor === 'agent'` blocks count as new write
  attempts; human-actor blocks belong to an already-counted proposal
  (src/harness/metrics.ts).
- **`durationMs`** on `action.executed` / `tool.called` remains
  UNIMPLEMENTED by decision (deferred to the M4 overhead pane — recorded
  in STATUS deferred-by-decision since M2 close). The draft metric
  `agentOverhead = Σ tool.called durations` is therefore not yet
  computable; `toolBytes` is the implemented overhead measure.
