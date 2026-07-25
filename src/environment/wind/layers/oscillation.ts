/**
 * Wind oscillation layer: three incommensurate sinusoids (~40s/130s/420s) plus
 * low-frequency noise. Reproduces the slow wandering of the mean wind that lets
 * a skilled sailor play headers and lifts over minutes.
 *
 * Amplitude scales with snapshot.wind.stability: ±3° on a stable sea breeze
 * (stability ≈ 0) up to ±20° on an unstable offshore (stability ≈ 1).
 *
 * Phase is seeded from hashCombine(hashString(venueId), fetchedAt, seed) so the
 * pattern is deterministic (requirement 3.7) and venue-characteristic.
 */

import type { Radians, Seed, SessionTime } from '@/types';
import { hashCombine, hashString, valueNoise1D } from '@core/math';
import { lerp } from '@core/math';

const DEG = Math.PI / 180;

/**
 * The three sinusoid periods are incommensurate (their ratio is irrational
 * within floating-point precision), so the pattern never exactly repeats.
 * This is the same principle radio telescopes use to avoid periodic artifacts.
 */
const PERIOD_A = 41.3; // seconds — fast micro-shifts
const PERIOD_B = 131.7; // seconds — medium oscillation
const PERIOD_C = 421.9; // seconds — slow trend

/** Amplitude in radians at stability 0 (stable) and 1 (unstable). */
const MIN_AMPLITUDE = 3 * DEG;
const MAX_AMPLITUDE = 20 * DEG;

/** Low-frequency noise adds non-periodic wander on top of the sinusoids. */
const NOISE_FREQUENCY = 0.003; // cycles per second
const NOISE_AMPLITUDE_FRACTION = 0.4; // fraction of total amplitude

export interface OscillationConfig {
  readonly phaseA: number;
  readonly phaseB: number;
  readonly phaseC: number;
  readonly noiseSeed: number;
  /** Venue-specific multiplier on amplitude. */
  readonly oscillationScale: number;
}

/**
 * Create an oscillation config from deterministic inputs. Same (venueId,
 * fetchedAt, seed) always yields the same phases.
 */
export function createOscillationConfig(
  venueId: string,
  fetchedAt: number,
  seed: Seed,
  oscillationScale: number,
): OscillationConfig {
  const base = hashCombine(hashString(venueId), fetchedAt | 0, seed);
  return {
    phaseA: (hashCombine(base, 1) / 4294967296) * Math.PI * 2,
    phaseB: (hashCombine(base, 2) / 4294967296) * Math.PI * 2,
    phaseC: (hashCombine(base, 3) / 4294967296) * Math.PI * 2,
    noiseSeed: hashCombine(base, 4),
    oscillationScale,
  };
}

/**
 * Sample the direction oscillation at a given time.
 * Returns a signed angular offset in radians to add to the base direction.
 */
export function sampleOscillation(
  config: OscillationConfig,
  stability: number,
  t: SessionTime,
): Radians {
  // Amplitude increases with instability.
  const rawAmplitude = lerp(MIN_AMPLITUDE, MAX_AMPLITUDE, stability);
  const amplitude = rawAmplitude * config.oscillationScale;

  // Three incommensurate sinusoids with different phase offsets.
  // Weights sum to 1, biased towards the slower components because those are
  // the shifts that carry tactical significance (the fast one is just texture).
  const sinA = Math.sin((t / PERIOD_A) * Math.PI * 2 + config.phaseA) * 0.2;
  const sinB = Math.sin((t / PERIOD_B) * Math.PI * 2 + config.phaseB) * 0.35;
  const sinC = Math.sin((t / PERIOD_C) * Math.PI * 2 + config.phaseC) * 0.45;

  const sinTotal = sinA + sinB + sinC;

  // Low-frequency value noise for non-periodic drift.
  const noise = (valueNoise1D(t * NOISE_FREQUENCY, config.noiseSeed) - 0.5) * 2;

  return amplitude * (sinTotal * (1 - NOISE_AMPLITUDE_FRACTION) + noise * NOISE_AMPLITUDE_FRACTION);
}

/**
 * Speed oscillation: smaller relative variation than direction, correlated
 * with direction shifts (a lift often brings more pressure, which is what makes
 * "sail the shifts" work). Returns a multiplicative factor near 1.0.
 */
export function sampleOscillationSpeed(
  config: OscillationConfig,
  stability: number,
  t: SessionTime,
): number {
  // Speed variation is about 40% of the direction amplitude, expressed as a
  // fraction of the mean. A 10° oscillation corresponds to ~7% speed variation.
  const amplitudeFraction = lerp(0.03, 0.12, stability) * config.oscillationScale;

  // Correlated with the C (slowest) sinusoid — puffs arrive with lifts.
  const sinC = Math.sin((t / PERIOD_C) * Math.PI * 2 + config.phaseC);
  const noise = (valueNoise1D(t * NOISE_FREQUENCY * 0.7, config.noiseSeed + 1000) - 0.5) * 2;

  return 1 + amplitudeFraction * (sinC * 0.7 + noise * 0.3);
}
