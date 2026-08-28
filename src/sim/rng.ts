// mulberry32 — the repo's ONLY randomness source for sim code.
// Math.random is lint-banned in src/sim (tools/lint-sim.mjs).

export type Rng = () => number; // uniform [0, 1)

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Deterministic jitter around a base value: base * (1 ± spread). */
export function jitter(rng: Rng, base: number, spread: number): number {
  return base * (1 + (rng() * 2 - 1) * spread);
}
