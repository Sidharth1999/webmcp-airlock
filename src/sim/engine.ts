import { SimClock } from './clock';
import { EventLog } from './log';
import { initialWorld, reduce } from './reducer';
import { mulberry32, type Rng } from './rng';
import { getTemplate, type TemplateInstance } from './templates';
import type { Actor, Event, EventKind, SeedSpec, World } from './types';

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
