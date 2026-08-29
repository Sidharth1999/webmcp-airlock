import { SimClock } from './clock';
import { EventLog } from './log';
import { initialWorld, reduce } from './reducer';
import { mulberry32, type Rng } from './rng';
import { getTemplate, type TemplateInstance } from './templates';
import type { Actor, Event, EventKind, SeedSpec, World } from './types';
import { writeAction } from './vocabulary';

/** Meta kinds external callers may record; the reducer no-ops all of them. */
const RECORDABLE: ReadonlySet<EventKind> = new Set([
  'tool.called',
  'mode.changed',
  'selection.changed',
  'annotation.added',
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
    const ctx = this.ctx();
    const event = ctx.emit('action.executed', actor, { tool, input, result: { ok: true } }, causedBy);
    this.template.onAction?.(this.ctx(), event);
    return event;
  }

  /**
   * Record a meta/lifecycle event (tool.called, mode.changed,
   * selection.changed, annotation.added) into the log. World is unaffected
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
   * diff of what would change. Approval → execution lands in M3-03.
   */
  propose(tool: string, input: Record<string, unknown>, causedBy?: number): Event {
    const spec = writeAction(tool); // throws on unknown tools: nothing off-vocabulary is proposable
    const ctx = this.ctx();
    return ctx.emit(
      'action.proposed',
      'agent',
      {
        tool,
        input,
        tier: spec.tier,
        tierName: spec.tierName,
        diffSummary: spec.describe(input, this.worldState),
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
  decide(proposalSeq: number, decision: 'approve' | 'reject'): Event[] {
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
    if (decision === 'approve') {
      const approved = ctx.emit('action.approved', 'human', { by: 'human', proposalSeq }, proposalSeq);
      const { tool, input } = proposal.data as { tool: string; input: Record<string, unknown> };
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
