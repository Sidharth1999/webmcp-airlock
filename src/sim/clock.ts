// Sim-clock: sim-time advances only by explicit ticks, never wall time.
// Date.now is lint-banned in src/sim (tools/lint-sim.mjs).

export const TICK_MS = 1000; // one tick = 1s of sim time

export class SimClock {
  private ms = 0;

  get now(): number {
    return this.ms;
  }

  advance(ticks = 1): number {
    this.ms += ticks * TICK_MS;
    return this.ms;
  }
}
