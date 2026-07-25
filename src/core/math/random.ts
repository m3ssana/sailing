/**
 * Seeded randomness and hashing.
 *
 * `Math.random()` is banned in simulation code. Every stochastic element — gust
 * phases, wave component phases, procedural geometry detail, AI variation — must
 * be reproducible from `(seed, …)` so replays reproduce, golden-run tests are
 * stable, and the same weather snapshot always yields the same wind field
 * (requirement 3.7).
 */

/**
 * xmur3 string hash, used to derive seeds from stable identifiers such as
 * `venueId` so a venue's character is consistent across sessions.
 */
export function hashString(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Combine several integers into one seed. Order matters. */
export function hashCombine(...values: number[]): number {
  let h = 2166136261 >>> 0;
  for (const value of values) {
    // Fold the full 32 bits of each input so nearby values diverge.
    let v = value | 0;
    v = Math.imul(v ^ (v >>> 16), 2246822507);
    v = Math.imul(v ^ (v >>> 13), 3266489909);
    h = Math.imul(h ^ v, 16777619);
    h = (h << 7) | (h >>> 25);
  }
  return h >>> 0;
}

/** Deterministic pseudo-random source. */
export interface Random {
  /** Uniform in `[0, 1)`. */
  next(): number;
  /** Uniform in `[min, max)`. */
  range(min: number, max: number): number;
  /** Integer in `[min, max)`. */
  int(min: number, max: number): number;
  /** Standard normal, mean 0 and variance 1. */
  normal(): number;
  /** Uniform angle in `[0, 2π)`. */
  angle(): number;
  /** True with the given probability. */
  chance(probability: number): boolean;
  /** Pick an element uniformly. Returns undefined for an empty array. */
  pick<T>(items: readonly T[]): T | undefined;
  /** Fork an independent stream, so consumers cannot disturb each other. */
  fork(label: string): Random;
}

/**
 * mulberry32 — small, fast, and good enough for procedural content and
 * simulation noise. Not cryptographic, which is fine: nothing here is a secret.
 */
export function createRandom(seed: number): Random {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Box-Muller generates two normals per pair of uniforms; cache the spare.
  let spareNormal: number | null = null;

  const random: Random = {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => Math.floor(min + next() * (max - min)),
    normal: () => {
      if (spareNormal !== null) {
        const value = spareNormal;
        spareNormal = null;
        return value;
      }
      // Guard against log(0).
      let u = next();
      while (u === 0) u = next();
      const v = next();
      const magnitude = Math.sqrt(-2 * Math.log(u));
      spareNormal = magnitude * Math.sin(2 * Math.PI * v);
      return magnitude * Math.cos(2 * Math.PI * v);
    },
    angle: () => next() * Math.PI * 2,
    chance: (probability) => next() < probability,
    pick: <T>(items: readonly T[]): T | undefined =>
      items.length === 0 ? undefined : items[Math.floor(next() * items.length)],
    fork: (label) => createRandom(hashCombine(seed, hashString(label))),
  };

  return random;
}

/**
 * Deterministic value noise in 1D, useful for slow drifts such as wind
 * oscillation phase. Continuous and smooth, with period 2^32.
 */
export function valueNoise1D(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = hashCombine(seed, i) / 4294967296;
  const b = hashCombine(seed, i + 1) / 4294967296;
  // Smoothstep the fraction so the derivative is continuous at integer bounds.
  const t = f * f * (3 - 2 * f);
  return a + (b - a) * t;
}

/** Deterministic value noise in 2D. */
export function valueNoise2D(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;

  const h = (px: number, py: number): number => hashCombine(seed, px, py) / 4294967296;

  const a = h(ix, iy);
  const b = h(ix + 1, iy);
  const c = h(ix, iy + 1);
  const d = h(ix + 1, iy + 1);

  const tx = fx * fx * (3 - 2 * fx);
  const ty = fy * fy * (3 - 2 * fy);

  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  return top + (bottom - top) * ty;
}

/**
 * Fractional Brownian motion over 2D value noise. Cheap layered detail for
 * terrain relief and gust structure.
 */
export function fbm2D(
  x: number,
  y: number,
  seed: number,
  octaves = 4,
  lacunarity = 2,
  gain = 0.5,
): number {
  let sum = 0;
  let amplitude = 1;
  let frequency = 1;
  let normalization = 0;

  for (let i = 0; i < octaves; i++) {
    sum += amplitude * valueNoise2D(x * frequency, y * frequency, hashCombine(seed, i));
    normalization += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }

  return normalization === 0 ? 0 : sum / normalization;
}
