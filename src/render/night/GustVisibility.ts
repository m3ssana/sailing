/**
 * GustVisibility — Stream F.4 (Night). PURE, no three.js.
 *
 * The demo requirement (7.17): at night "gust patches are noticeably harder to
 * read than by day". Real sailors read an approaching puff as a darker patch on
 * the water; at night that visual cue nearly vanishes, and the moon only
 * partially restores it.
 *
 * This module produces a multiplier applied to the gust DARKENING that
 * `WaterMaterial`'s `gustIntensity` uniform drives — it does NOT edit
 * `WaterMaterial`. The caller multiplies the raw gust intensity by
 * `gustContrastScale(...)` (or calls `effectiveGustIntensity`) and writes the
 * result to `WaterMaterial`'s `gustIntensity` uniform each frame:
 *
 * ```ts
 * water.uniforms.gustIntensity.value =
 *   effectiveGustIntensity(rawGust, lighting, moonIlluminance);
 * ```
 *
 * ## Behaviour (all pinned by tests)
 *
 * - 1.0 by full day (`nightFactor` 0) — gust patches read fully.
 * - ≤ 0.35 at deep night (`nightFactor` 1) under NO moon.
 * - Partially restored by moonlight (a full moon lifts the night floor).
 * - Monotone decreasing in `nightFactor`, monotone increasing in moonlight.
 */

/** Minimal lighting input. */
export interface GustLighting {
  /** 0 = day .. 1 = night. */
  nightFactor: number;
}

/** Contrast floor at deep night with no moon (gusts barely readable). */
export const DEEP_NIGHT_NO_MOON_FLOOR = 0.3;

/** Reference full-moon relative illuminance (matches Moonlight.FULL_MOON_ZENITH_RELATIVE). */
const FULL_MOON_REFERENCE = 0.02;

/** Fraction of lost day contrast that a full moon restores. */
const MOON_RESTORE_FRACTION = 0.5;

function clamp01(x: number): number {
  // NaN-safe: non-finite input (NaN / ±Infinity) collapses to 0 rather than
  // poisoning every downstream multiply with NaN.
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Multiplier in (0, 1] applied to gust darkening.
 *
 * At `nightFactor = 0` returns 1.0 regardless of moon. As night falls the scale
 * drops toward `DEEP_NIGHT_NO_MOON_FLOOR` (0.3, i.e. ≤ 0.35 as required) with no
 * moon; moonlight lifts the floor back up by up to `MOON_RESTORE_FRACTION` of the
 * lost contrast.
 *
 * @param lighting Night factor.
 * @param moonIlluminance Relative moon illuminance (0 .. ~0.02 full).
 */
export function gustContrastScale(lighting: GustLighting, moonIlluminance: number): number {
  const night = clamp01(lighting.nightFactor);

  // Moon factor 0..1 (full moon → 1). Clamp so brighter-than-full can't overshoot.
  const moon = clamp01(moonIlluminance / FULL_MOON_REFERENCE);

  // Night floor without moon, then lifted by moonlight.
  const noMoonFloor = DEEP_NIGHT_NO_MOON_FLOOR;
  const lostContrast = 1 - noMoonFloor; // 0.7
  const nightFloor = noMoonFloor + moon * MOON_RESTORE_FRACTION * lostContrast;

  // Blend from full day contrast (1.0) to the (moon-lifted) night floor.
  return 1 - night * (1 - nightFloor);
}

/**
 * The gust intensity to write into `WaterMaterial.uniforms.gustIntensity`,
 * i.e. the raw gust intensity scaled down by the night contrast factor.
 *
 * @param rawIntensity Daytime gust intensity 0..1 from the wind gust field.
 * @param lighting Night factor.
 * @param moonIlluminance Relative moon illuminance.
 */
export function effectiveGustIntensity(
  rawIntensity: number,
  lighting: GustLighting,
  moonIlluminance: number,
): number {
  return clamp01(rawIntensity) * gustContrastScale(lighting, moonIlluminance);
}
