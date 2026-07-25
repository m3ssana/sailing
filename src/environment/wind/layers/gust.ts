/**
 * Gust layer: THE ONE THAT MATTERS MOST.
 *
 * A 2D noise field advecting DOWNWIND at ~1.2× mean wind speed, sampled in a
 * wind-aligned coordinate frame so puffs elongate along the wind and stay
 * coherent across it. That anisotropy is what makes gusts readable on the water
 * before they arrive — which is the core skill of competitive sailing.
 *
 * Magnitude is mapped into [trueSpeed × 0.8, gustCeiling]. Each gust also
 * carries a small direction bias: veer in the puff, back in the lull. This is
 * the shift pattern that real sailors learn to play.
 *
 * The field is deterministic in (seed, snapshot) per requirement 3.7.
 */

import type { Radians, Seed, SessionTime } from '@/types';
import { fbm2D, hashCombine, hashString } from '@core/math';
import { clamp, lerp } from '@core/math';

/** Gust field advection speed relative to mean wind. */
const ADVECTION_FACTOR = 1.2;

/**
 * Anisotropy: puffs stretch 3x along the wind axis vs across it.
 * This elongation is what makes them visible as bands on the water and is why
 * a sailor looking upwind can read the pressure approaching.
 */
const ALONG_WIND_SCALE = 0.005; // Spatial frequency along wind (low = stretched)
const ACROSS_WIND_SCALE = 0.015; // Spatial frequency across wind (higher = narrow)

/** Number of noise octaves — more gives finer gust edges. */
const OCTAVES = 3;

/**
 * Direction bias in puffs/lulls. Real observations show ~5-8° veer in puffs
 * for midlatitude sea breezes. We use stability to modulate this.
 */
const MAX_DIRECTION_BIAS_RAD = 8 * (Math.PI / 180);

export interface GustConfig {
  readonly seed: number;
  /** Venue gust scale multiplier. */
  readonly gustScale: number;
}

export function createGustConfig(
  venueId: string,
  fetchedAt: number,
  seed: Seed,
  gustScale: number,
): GustConfig {
  return {
    seed: hashCombine(hashString(venueId), fetchedAt | 0, seed, 0x67757374),
    gustScale,
  };
}

/**
 * Sample the gust field at a world position and time.
 *
 * @param x World east coordinate (metres)
 * @param z World south coordinate (metres)
 * @param t Session time (seconds)
 * @param baseSpeed Mean wind speed at this instant (m/s)
 * @param baseDirection Meteorological direction (bearing wind blows FROM, radians)
 * @param gustCeiling Upper bound on speed from the forecast (m/s)
 * @param stability Atmospheric stability 0..1
 * @param config Deterministic gust configuration
 * @param out Result: gustFactor (relative to mean), directionBias (radians)
 */
export function sampleGust(
  x: number,
  z: number,
  t: SessionTime,
  baseSpeed: number,
  baseDirection: Radians,
  gustCeiling: number,
  stability: number,
  config: GustConfig,
  out: { gustFactor: number; directionBias: number },
): { gustFactor: number; directionBias: number } {
  // Transform to wind-aligned coordinates. The wind blows FROM baseDirection,
  // so the downwind direction (where gusts travel) is baseDirection + π.
  // In world space: bearing θ → direction (sinθ, 0, -cosθ).
  // We need the projection of (x, z) onto wind-aligned axes.
  const sinDir = Math.sin(baseDirection);
  const cosDir = Math.cos(baseDirection);

  // Along-wind axis (downwind direction): the direction air moves towards.
  // Air moves FROM baseDirection, so moves towards baseDirection + π.
  // Unit vector: (-sinDir, cosDir) in the (x, z) plane.
  const alongX = -sinDir;
  const alongZ = cosDir;

  // Across-wind axis (perpendicular, 90° clockwise of along): (cosDir, sinDir)
  const acrossX = cosDir;
  const acrossZ = sinDir;

  // Project world position onto wind-aligned frame.
  const alongPos = x * alongX + z * alongZ;
  const acrossPos = x * acrossX + z * acrossZ;

  // Advect the noise field downwind at 1.2× mean wind speed.
  // The field moves in the downwind direction, so we subtract the advection
  // from the along-wind coordinate to create the travelling-puff illusion.
  const advection = baseSpeed * ADVECTION_FACTOR * t;
  const advectedAlong = (alongPos - advection) * ALONG_WIND_SCALE;
  const scaledAcross = acrossPos * ACROSS_WIND_SCALE;

  // fBm noise in 2D, seeded deterministically.
  const rawNoise = fbm2D(advectedAlong, scaledAcross, config.seed, OCTAVES, 2, 0.5);

  // rawNoise is in [0, 1] with mean ~0.5. Map to gust factor.
  // gustFactor = 1 means "at the mean wind". Above 1 is a puff, below 1 is a lull.
  // The range is [baseSpeed * 0.8, gustCeiling], expressed as a factor of baseSpeed.
  const minFactor = 0.8;
  const maxFactor = baseSpeed > 0 ? gustCeiling / baseSpeed : 1.4;

  // Sharpen the puffs when instability is high: concentrate energy in the peaks.
  // Stable conditions have broad, gentle variation; unstable have sharp puffs
  // separated by wider lulls — matching real observations.
  const sharpness = lerp(1.0, 2.0, stability);
  const shaped = Math.pow(rawNoise, 1 / sharpness);

  // Apply venue gust scale: widens or narrows the range around 1.
  const deviation = (shaped - 0.5) * 2; // [-1, 1]
  const scaledDeviation = deviation * config.gustScale;
  const factor = lerp(1.0, scaledDeviation > 0 ? maxFactor : minFactor, Math.abs(scaledDeviation));

  out.gustFactor = clamp(factor, minFactor, maxFactor);

  // Direction bias: veer in puffs (factor > 1), back in lulls (factor < 1).
  // This is the shift-in-the-puff pattern that makes "play the gusts" tactical.
  const biasScale = lerp(0.4, 1.0, stability); // More bias when unstable.
  out.directionBias = (out.gustFactor - 1.0) * MAX_DIRECTION_BIAS_RAD * biasScale;

  return out;
}

/**
 * Sample just the gust factor for the ocean surface visualization grid.
 * Cheaper than the full sample — no direction bias computation.
 */
export function sampleGustFactor(
  x: number,
  z: number,
  t: SessionTime,
  baseSpeed: number,
  baseDirection: Radians,
  gustCeiling: number,
  stability: number,
  config: GustConfig,
): number {
  const sinDir = Math.sin(baseDirection);
  const cosDir = Math.cos(baseDirection);

  const alongX = -sinDir;
  const alongZ = cosDir;
  const acrossX = cosDir;
  const acrossZ = sinDir;

  const alongPos = x * alongX + z * alongZ;
  const acrossPos = x * acrossX + z * acrossZ;

  const advection = baseSpeed * ADVECTION_FACTOR * t;
  const advectedAlong = (alongPos - advection) * ALONG_WIND_SCALE;
  const scaledAcross = acrossPos * ACROSS_WIND_SCALE;

  const rawNoise = fbm2D(advectedAlong, scaledAcross, config.seed, OCTAVES, 2, 0.5);

  const minFactor = 0.8;
  const maxFactor = baseSpeed > 0 ? gustCeiling / baseSpeed : 1.4;

  const sharpness = lerp(1.0, 2.0, stability);
  const shaped = Math.pow(rawNoise, 1 / sharpness);

  const deviation = (shaped - 0.5) * 2;
  const scaledDeviation = deviation * config.gustScale;
  const factor = lerp(1.0, scaledDeviation > 0 ? maxFactor : minFactor, Math.abs(scaledDeviation));

  return clamp(factor, minFactor, maxFactor);
}
