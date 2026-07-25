/**
 * Unified seeded noise API for procedural generators.
 *
 * Wraps the `simplex-noise` package and `@core/math`'s fbm2D into a single
 * consistent interface. Every generator uses this instead of touching noise
 * primitives directly, ensuring:
 * - All noise is seeded (deterministic from the same seed)
 * - Common patterns (ridged, billow, domain warp) are named and reusable
 * - No generator accidentally uses Math.random()
 *
 * Engine-agnostic — no three.js.
 */

import { createNoise2D, createNoise3D } from 'simplex-noise';
import { createRandom, fbm2D, hashCombine } from '@core/math';

// ─── Seeded noise source factory ─────────────────────────────────────────────

export interface NoiseSource2D {
  /** Raw simplex noise in [-1, 1]. */
  sample(x: number, y: number): number;
  /** Fractional Brownian motion (layered noise). */
  fbm(x: number, y: number, octaves?: number, lacunarity?: number, gain?: number): number;
  /** Ridged noise — abs(noise) inverted. Creates sharp ridges. */
  ridged(x: number, y: number, octaves?: number, lacunarity?: number, gain?: number): number;
  /** Billow noise — abs(noise). Creates puffy, cloud-like shapes. */
  billow(x: number, y: number, octaves?: number, lacunarity?: number, gain?: number): number;
  /** Domain warp — distort coordinates before sampling. */
  domainWarp(
    x: number,
    y: number,
    warpStrength: number,
    octaves?: number,
    lacunarity?: number,
    gain?: number,
  ): number;
}

export interface NoiseSource3D {
  /** Raw simplex noise in [-1, 1]. */
  sample(x: number, y: number, z: number): number;
}

/**
 * Create a seeded 2D noise source with all standard patterns.
 *
 * Uses simplex-noise for high-quality gradient noise (much better spectral
 * properties than value noise for terrain and cloud shapes) and @core/math's
 * fbm2D for the value-noise variant when hash-based reproducibility is needed
 * across platforms.
 */
export function createNoiseSource2D(seed: number): NoiseSource2D {
  const rng = createRandom(seed);
  const simplex = createNoise2D(() => rng.next());

  const sample = (x: number, y: number): number => simplex(x, y);

  const fbmSimplex = (
    x: number,
    y: number,
    octaves = 4,
    lacunarity = 2,
    gain = 0.5,
  ): number => {
    let sum = 0;
    let amplitude = 1;
    let frequency = 1;
    let normalization = 0;

    for (let i = 0; i < octaves; i++) {
      sum += amplitude * simplex(x * frequency, y * frequency);
      normalization += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }

    return normalization === 0 ? 0 : sum / normalization;
  };

  const ridged = (
    x: number,
    y: number,
    octaves = 4,
    lacunarity = 2,
    gain = 0.5,
  ): number => {
    let sum = 0;
    let amplitude = 1;
    let frequency = 1;
    let normalization = 0;

    for (let i = 0; i < octaves; i++) {
      // Ridged: 1 - |noise| produces sharp ridges at zero-crossings
      const value = 1 - Math.abs(simplex(x * frequency, y * frequency));
      sum += amplitude * value * value; // Square for sharper ridges
      normalization += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }

    return normalization === 0 ? 0 : sum / normalization;
  };

  const billow = (
    x: number,
    y: number,
    octaves = 4,
    lacunarity = 2,
    gain = 0.5,
  ): number => {
    let sum = 0;
    let amplitude = 1;
    let frequency = 1;
    let normalization = 0;

    for (let i = 0; i < octaves; i++) {
      // Billow: |noise| produces puffy, cumulus-like shapes
      sum += amplitude * Math.abs(simplex(x * frequency, y * frequency));
      normalization += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }

    return normalization === 0 ? 0 : sum / normalization;
  };

  const domainWarp = (
    x: number,
    y: number,
    warpStrength: number,
    octaves = 4,
    lacunarity = 2,
    gain = 0.5,
  ): number => {
    // Use offset seeds for the warp field so it's independent of the main noise
    const warpSeed1 = hashCombine(seed, 7919);
    const warpSeed2 = hashCombine(seed, 6271);
    const warpRng1 = createRandom(warpSeed1);
    const warpRng2 = createRandom(warpSeed2);
    const warpNoise1 = createNoise2D(() => warpRng1.next());
    const warpNoise2 = createNoise2D(() => warpRng2.next());

    // Displace coordinates by noise
    const dx = warpNoise1(x, y) * warpStrength;
    const dy = warpNoise2(x, y) * warpStrength;

    return fbmSimplex(x + dx, y + dy, octaves, lacunarity, gain);
  };

  return {
    sample,
    fbm: fbmSimplex,
    ridged,
    billow,
    domainWarp,
  };
}

/**
 * Create a seeded 3D noise source (for volumetric effects).
 */
export function createNoiseSource3D(seed: number): NoiseSource3D {
  const rng = createRandom(seed);
  const simplex = createNoise3D(() => rng.next());

  return {
    sample: (x: number, y: number, z: number) => simplex(x, y, z),
  };
}

/**
 * Value-noise FBM from @core/math, re-exported here so generators have one
 * import point. Useful when cross-platform bit-exact reproducibility matters
 * more than spectral quality (the value noise uses integer hashing, which is
 * bit-identical everywhere, unlike floating-point simplex evaluation).
 */
export { fbm2D as valueNoiseFbm2D };
