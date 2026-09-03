import { SimClock } from './clock';
import { EventLog } from './log';
import { initialWorld, reduce } from './reducer';
import { mulberry32, type Rng } from './rng';
import { currentMode, DUAL_KEY_TIER, MODE_ACTIONS } from './modes';
import { provenanceOf } from './provenance';
import { getTemplate, type TemplateInstance } from './templates';
import type { Actor, Event, EventKind, SeedSpec, World } from './types';
import { WRITE_ACTIONS, writeAction } from './vocabulary';

/** Meta kinds external callers may record; the reducer no-ops all of them. */
const RECORDABLE: ReadonlySet<EventKind> = new Set([
  'tool.called',
  'mode.changed',
  'selection.changed',
  'annotation.added',
  // the agent's own read of the incident: recorded, world untouched
  'finding.recorded',
  // the agent's ordered intent. It mutates nothing and authorizes nothing —
  // every step still arrives as its own action.proposed and its own gate.
  'plan.proposed',
] as EventKind[]);

export interface SimCtx {
  rng: Rng;
  /** current sim-time ms */
  now: number;
  /** 1-based tick index (0 during setup) */
  tick: number;
  world: World;
  emit(kind: EventKind, actor: Actor, data: Record<string, unknown>, causedBy?: number): Event;
}

/**
 * Deterministic sim engine: (templateId, seed, params) fully determines the
 * event stream — byte-identical replays (schema v1 determinism rules).
 */
export class Engine {
  readonly spec: SeedSpec;
  private log = new EventLog();
  private clock = new SimClock();
  private rng: Rng;
  private worldState = initialWorld();
  private template: TemplateInstance;
  private tickIndex = 0;

  constructor(spec: { templateId: string; seed: number; params?: Record<string, unknown> }) {
    const factory = getTemplate(spec.templateId);
    this.spec = {
      templateId: spec.templateId,
      seed: spec.seed,
      params: { ...factory.defaultParams, ...spec.params },
    };
    this.rng = mulberry32(this.spec.seed);
    this.template = factory.create(this.spec.params);
    const ctx = this.ctx();
    ctx.emit('scenario.seeded', 'system', { ...this.spec });
    this.template.setup(ctx);
  }

  private ctx(): SimCtx {
    const self = this;
    return {
      rng: this.rng,
      get now() {
        return self.clock.now;
      },
      get tick() {
        return self.tickIndex;
      },
      get world() {
        return self.worldState;
      },
      emit: (kind, actor, data, causedBy) => {
        const event = this.log.append({ t: this.clock.now, kind, actor, data, causedBy });
        this.worldState = reduce(this.worldState, event);
        return event;
      },
    };
  }

  /**
   * External action (human console click or agent tool call) entering the
   * stream. Emits action.executed and lets the template react. Determinism
   * still holds: replay = same (templateId, seed, params) + same act()
   * schedule. The proposed/approved gate for agent writes wraps this in M3.
   */
  act(
    tool: string,
    input: Record<string, unknown>,
    actor: 'human' | 'agent' = 'human',
    causedBy?: number
  ): Event {
    // validate BEFORE anything is emitted: a malformed write must never
    // enter the log half-applied (the reducer trusts validated events)
    const spec = WRITE_ACTIONS[tool];
    const invalid = spec?.validate(input);
    if (invalid) throw new Error(`invalid input for ${tool}: ${invalid}`);
    const ctx = this.ctx();
    // AN ORG-WIDE FREEZE NEEDS AN INCIDENT COMMANDER. Freezing every team's
    // deploys is the highest-blast-radius thing on the incident-command row —
    // real response tools make it a commander action, and it is the reason
    // `incident.acknowledge` exists as a lever rather than as a label. The
    // gate is what makes acknowledging a STEP: skip it and the freeze never
    // lands, so the other team ships into your incident.
    if (tool === 'deploy.freeze' && (input as { frozen?: boolean }).frozen === true
        && !this.worldState.incident.acknowledgedBy) {
      return ctx.emit(
        'action.blocked',
        actor,
        {
          tool,
          input,
          tier: spec!.tier,
          tierName: spec!.tierName,
          reason: 'incident-unowned',
          detail: 'a deploy freeze is an incident-commander action — acknowledge the incident first',
        },
        causedBy
      );
    }
    // A STATUS PAGE POST NEEDS A SEVERITY. Every real status page is keyed to
    // one: it decides what customers are promised and who is standing by. This
    // is what makes `incident.severity` a step rather than a badge — without
    // it the page stays silent and customers file tickets instead.
    if (tool === 'statuspage.post' && !this.worldState.incident.severity) {
      return ctx.emit(
        'action.blocked',
        actor,
        {
          tool,
          input,
          tier: spec!.tier,
          tierName: spec!.tierName,
          reason: 'no-severity',
          detail: 'declare a severity before telling customers — the page is keyed to one',
        },
        causedBy
      );
    }
    // THE FREEZE IS A GATE, NOT A LABEL. `deploy.freeze`'s own cost copy
    // promises it stops anyone shipping into an active incident "including
    // the fix you are about to ship" — that sentence was decoration while
    // `deploysFrozen` was read by nothing but two UI labels. Enforced HERE,
    // in act(), so the console click, the agent's approved write and the
    // compiler's scripted probe hit one wall rather than three policies.
    // The lever that LIFTS the freeze is never frozen by itself.
    if (spec && spec.tierName === 'deploy' && tool !== 'deploy.freeze' && this.worldState.incident.deploysFrozen) {
      return ctx.emit(
        'action.blocked',
        actor,
        {
          tool,
          input,
          tier: spec.tier,
          tierName: spec.tierName,
          reason: 'deploys-frozen',
          detail: 'deploys are frozen for this incident — lift the freeze before shipping',
        },
        causedBy
      );
    }
    const event = ctx.emit('action.executed', actor, { tool, input, result: { ok: true } }, causedBy);
    this.template.onAction?.(this.ctx(), event);
    return event;
  }

  /**
   * Record a meta/lifecycle event (tool.called, mode.changed,
   * selection.changed, annotation.added, finding.recorded) into the log. World is unaffected
   * (reducer no-ops these); determinism rule matches act(): replay = same
   * schedule of external inputs.
   */
  record(kind: EventKind, actor: Actor, data: Record<string, unknown>, causedBy?: number): Event {
    if (!RECORDABLE.has(kind)) throw new Error(`record() does not accept kind: ${kind}`);
    return this.ctx().emit(kind, actor, data, causedBy);
  }

  /**
   * Agent write path, step 1 of the airlock: a PROPOSAL, not an execution.
   * Emits action.proposed with the vocabulary's tier and a human-readable
   * diff of what would change. A write whose tier the current mode does not
   * allow emits action.blocked instead (machine-readable reason) — blocked
   * attempts are IN the log because "dangerous writes attempted vs blocked"
   * is the study's headline metric. Enforced here, not in the UI: the
   * ungated arm and scripted drivers hit the same wall.
   */
  propose(tool: string, input: Record<string, unknown>, causedBy?: number): Event {
    const spec = writeAction(tool); // throws on unknown tools: nothing off-vocabulary is proposable
    const ctx = this.ctx();
    // malformed input blocks BEFORE a proposal exists — blocked, not thrown,
    // because a schema-violating agent attempt is study data (and the agent
    // gets a machine-readable reason to correct itself)
    const invalid = spec.validate(input);
    if (invalid) {
      return ctx.emit(
        'action.blocked',
        'agent',
        { tool, input, tier: spec.tier, tierName: spec.tierName, reason: 'invalid-input', detail: invalid },
        causedBy
      );
    }
    const mode = currentMode(this.log.all);
    if (!MODE_ACTIONS[mode].has(tool)) {
      return ctx.emit(
        'action.blocked',
        'agent',
        {
          tool,
          input,
          tier: spec.tier,
          tierName: spec.tierName,
          reason: 'not-available-in-mode',
          mode,
        },
        causedBy
      );
    }
    // PROVENANCE (family #2): does this write's target trace to untrusted
    // content the page served the agent? If so the proposal is promoted to
    // the dual-key rung whatever its nominal tier — the human may still do
    // it, but not with one reflexive click, and the card says where the idea
    // came from. This is the check a generic host confirm cannot make: it
    // never served the evidence.
    const taint = provenanceOf(this.log.all, input);
    return ctx.emit(
      'action.proposed',
      'agent',
      {
        tool,
        input,
        tier: spec.tier,
        tierName: spec.tierName,
        diffSummary: spec.describe(input, this.worldState),
        ...(taint ? { provenance: taint, requiresKey: true } : {}),
      },
      causedBy
    );
  }

  /**
   * The human decides a pending proposal (airlock step 2, M3-03).
   * approve → action.approved (causedBy: proposal) then the write executes
   * as the AGENT's action (causedBy: approval) — the full thread of agency:
   * proposed → approved → executed. reject → action.rejected, world untouched.
   */
  decide(
    proposalSeq: number,
    decision: 'approve' | 'reject',
    keyHolder?: string,
    via?: string
  ): Event[] {
    const proposal = this.log.all.find((e) => e.seq === proposalSeq);
    if (!proposal || proposal.kind !== 'action.proposed') {
      throw new Error(`no proposal at seq ${proposalSeq}`);
    }
    const alreadyDecided = this.log.all.some(
      (e) =>
        (e.kind === 'action.approved' || e.kind === 'action.rejected') &&
        (e.data as { proposalSeq?: number }).proposalSeq === proposalSeq
    );
    if (alreadyDecided) throw new Error(`proposal ${proposalSeq} already decided`);

    const before = this.log.length;
    const ctx = this.ctx();
    const { tool, input, tier, requiresKey } = proposal.data as {
      tool: string;
      input: Record<string, unknown>;
      tier: number;
      requiresKey?: boolean;
    };
    if (decision === 'approve') {
      // the mode may have moved since the proposal was minted: the gate is
      // re-checked at the moment of execution, not just at proposal time.
      // Blocked, the proposal stays pending — re-entering the mode and
      // approving again works (same shape as the dual-key miss below).
      const mode = currentMode(this.log.all);
      if (!MODE_ACTIONS[mode].has(tool)) {
        ctx.emit(
          'action.blocked',
          'human',
          { tool, input, tier, reason: 'not-available-in-mode', mode, proposalSeq },
          proposalSeq
        );
        return this.log.all.slice(before) as Event[];
      }
      // top-tier writes need the dual key: the human must HOLD the key while
      // the agent's write executes. An approval without it is blocked — the
      // proposal stays pending, so engaging the key and approving again works.
      if ((tier === DUAL_KEY_TIER || requiresKey) && !keyHolder) {
        ctx.emit(
          'action.blocked',
          'human',
          {
            tool,
            input,
            tier,
            reason: 'dual-key-required',
            ...(tier !== DUAL_KEY_TIER && requiresKey ? { escalatedBy: 'untrusted-evidence' } : {}),
            proposalSeq,
          },
          proposalSeq
        );
        return this.log.all.slice(before) as Event[];
      }
      const approved = ctx.emit(
        'action.approved',
        'human',
        // `via` is the GESTURE the page saw — hold, click, key — recorded so
        // the receipt can say how an approval arrived rather than assume
        { by: 'human', proposalSeq, ...(keyHolder ? { keyHolder } : {}), ...(via ? { via } : {}) },
        proposalSeq
      );
      this.act(tool, input, 'agent', approved.seq);
    } else {
      ctx.emit('action.rejected', 'human', { by: 'human', proposalSeq }, proposalSeq);
    }
    return this.log.all.slice(before) as Event[];
  }

  /** Advance n ticks; returns the events emitted by this call. */
  step(n = 1): Event[] {
    const before = this.log.length;
    for (let i = 0; i < n; i++) {
      this.clock.advance();
      this.tickIndex++;
      this.template.tick(this.ctx());
    }
    return this.log.all.slice(before) as Event[];
  }

  get events(): readonly Event[] {
    return this.log.all;
  }

  get world(): World {
    return this.worldState;
  }

  chainOf(seq: number): Event[] {
    return this.log.chainOf(seq);
  }
}
