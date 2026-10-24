/**
 * Moonlight — Stream F.4 (Night).
 *
 * Two layers, strictly separated:
 *
 *  1. A PURE model (`computeMoonlight`, `moonGlitterParams`, `moonTerminator`)
 *     with NO three.js import, headlessly unit-testable. This is the single
 *     source of truth for how bright the moon is, what colour it casts, and how
 *     big its glitter track should be.
 *
 *  2. A THIN three/TSL layer (`createMoonDisc`) that renders the visible moon
 *     disc. It consumes the pure model's outputs; it computes no policy of its
 *     own beyond the billboard phase shading.
 *
 * ## Conventions
 *
 * - Linear RGB internally, 0..1 per channel.
 * - Illuminance is RELATIVE: 1.0 == clear-sky sun at the zenith (matching
 *   `LightingState.sunIlluminance`). Night subsystems and exposure read this
 *   same relative scale.
 * - World space Y-up, right-handed, +X east, +Z south. `SkyState.moonDirection`
 *   points FROM the scene TOWARDS the moon (same convention as `sunDirection`).
 *
 * ## Physical basis and the documented artistic lift
 *
 * The real full moon at zenith delivers roughly 0.25 lux versus ~100 000 lux for
 * the noon sun — a ratio of ~2.5e-6 (commonly quoted as ~2.7e-6; see e.g. the
 * standard illuminance tables, Kyba et al. 2017, "How bright is moonlight"). At
 * that true relative value the moon would be numerically invisible against any
 * reasonable exposure, so we apply a deliberate, documented ARTISTIC LIFT: a
 * full moon at the zenith maps to a relative illuminance of
 * `FULL_MOON_ZENITH_RELATIVE` (0.02, inside the brief's 0.01–0.03 band). This is
 * a rendering-layer approximation, not the real photometry — labelled as such.
 *
 * Brightness vs phase is NOT linear in illuminated fraction: a half (quarter)
 * moon is only ~8–10% as bright as a full moon, not 50%, because of shadowing on
 * the rough lunar surface and the opposition surge near full phase (Whitford &
 * others; the empirical exponent on the fraction is well above 1). We model this
 * with `PHASE_BRIGHTNESS_EXPONENT` applied to the illuminated fraction. The brief
 * suggested ~1.3; the astronomy literature supports a steeper fall, so we use a
 * labelled approximation of 2.0 which puts a quarter moon at ~25% — still a
 * rendering compromise between the true ~8% and a flat linear law, chosen so the
 * moon remains usefully visible through most of its cycle. Monotone in fraction
 * either way, which is what the tests pin.
 */

import type { LightingState } from '../lighting/LightingState';

/** A SkyState-shaped input. We only read the moon fields, so we accept a subset. */
export interface MoonlightSkyInput {
  /** Unit vector FROM the scene TOWARDS the moon. */
  moonDirection: { x: number; y: number; z: number };
  /** Moon elevation above the horizon, radians. Negative below. */
  moonElevation: number;
  /** Illuminated fraction, 0 (new) .. 1 (full). */
  moonPhase: number;
}

/** Linear-RGB colour triple. */
export interface MoonColor {
  r: number;
  g: number;
  b: number;
}

/** Result of `computeMoonlight`. */
export interface Moonlight {
  /** Cool blue-white moon cast colour, linear RGB. */
  moonColor: MoonColor;
  /**
   * Relative illuminance on a surface facing the moon, same scale as
   * `LightingState.sunIlluminance` (1.0 == clear-sky zenith sun). Zero when the
   * moon is below the horizon; faded by overcast and by daylight.
   */
  moonIlluminance: number;
}

/** Glitter-track parameters so the water can mirror the sun glitter for the moon. */
export interface MoonGlitterParams {
  /** Specular intensity scale, 0 when no moonlight. */
  intensity: number;
  /** GGX roughness for the glitter lobe — slightly broader than the sun's. */
  roughness: number;
}

// ─── Tunable constants (all documented rendering-layer choices) ───────────────

/**
 * Relative illuminance of a full moon at the zenith, on the sun==1.0 scale.
 * ARTISTIC LIFT above the true ~2.7e-6 (see module header). 0.02 sits inside the
 * brief's 0.01–0.03 band.
 */
export const FULL_MOON_ZENITH_RELATIVE = 0.02;

/**
 * Exponent applied to the illuminated fraction to approximate the real,
 * faster-than-linear brightness falloff with phase. Labelled approximation
 * (see module header). 2.0 → quarter moon ≈ 25% of full.
 */
export const PHASE_BRIGHTNESS_EXPONENT = 2.0;

/** Cool blue-white moonlight tint, linear RGB (slightly blue of neutral). */
const MOON_TINT: Readonly<MoonColor> = { r: 0.78, g: 0.84, b: 1.0 };

/** Elevation over which the moon fades in above the horizon, radians (~2°). */
const HORIZON_FADE_RAD = 2 * (Math.PI / 180);

/** GGX roughness of the moon glitter lobe (broader/softer than the sun's 0.03). */
const MOON_GLITTER_ROUGHNESS = 0.08;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp01(x: number): number {
  // NaN-safe: a non-finite input collapses to 0 so moon illuminance / colour
  // never becomes NaN from a bad phase or overcast value.
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Smoothstep in [edge0, edge1]. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

// ─── Pure model ───────────────────────────────────────────────────────────────

/**
 * Compute the moon's cast colour and relative illuminance.
 *
 * - Zero below the horizon, with a smooth smoothstep fade over the first
 *   ~2° of elevation.
 * - Scaled by `illuminatedFraction ^ PHASE_BRIGHTNESS_EXPONENT` (full moon
 *   brightest, new moon ~0).
 * - Scaled by `sin(elevation)` so a moon near the horizon casts less than one
 *   overhead (the same cosine-of-zenith-angle law the sun obeys).
 * - Attenuated by overcast cloud and by daylight (via `LightingState.nightFactor`
 *   — the moon only matters once night has fallen).
 *
 * @param out Optional target to fill, to avoid allocation in the render loop.
 */
export function computeMoonlight(
  sky: MoonlightSkyInput,
  lighting: LightingState,
  out?: Moonlight,
): Moonlight {
  const result: Moonlight = out ?? { moonColor: { r: 0, g: 0, b: 0 }, moonIlluminance: 0 };

  const elevation = sky.moonElevation;

  // Horizon gate: 0 below horizon, smooth fade over the first HORIZON_FADE_RAD.
  const horizonFactor = smoothstep(0, HORIZON_FADE_RAD, elevation);

  if (horizonFactor <= 0) {
    result.moonColor.r = 0;
    result.moonColor.g = 0;
    result.moonColor.b = 0;
    result.moonIlluminance = 0;
    return result;
  }

  // Phase: faster-than-linear falloff (labelled approximation).
  const fraction = clamp01(sky.moonPhase);
  const phaseFactor = Math.pow(fraction, PHASE_BRIGHTNESS_EXPONENT);

  // Elevation law: brightness on a horizontal surface scales with sin(elevation).
  // (horizonFactor already handles the near-horizon fade; use it as a floor-safe
  // multiplier and sin(elevation) for the zenith-angle cosine law.)
  const elevationLaw = Math.max(0, Math.sin(elevation));

  // Overcast attenuation: fully overcast sky hides the moon almost entirely.
  const overcastFactor = 1 - 0.92 * clamp01(lighting.overcast);

  // Daylight attenuation: the moon only contributes once night has fallen.
  const nightFactor = clamp01(lighting.nightFactor);

  const illuminance =
    FULL_MOON_ZENITH_RELATIVE *
    phaseFactor *
    elevationLaw *
    horizonFactor *
    overcastFactor *
    nightFactor;

  result.moonColor.r = MOON_TINT.r;
  result.moonColor.g = MOON_TINT.g;
  result.moonColor.b = MOON_TINT.b;
  result.moonIlluminance = illuminance;
  return result;
}

/**
 * Glitter-track parameters mirroring the sun glitter, so the water can draw a
 * moon glint path. Intensity is proportional to moon illuminance (scaled up into
 * a usable specular range); roughness is a touch broader than the sun's because
 * a dim source reads as a softer, more diffuse streak.
 */
export function moonGlitterParams(moon: Moonlight): MoonGlitterParams {
  // Normalise illuminance against a full moon so a full moon gives ~1.0 intensity.
  const intensity = clamp01(moon.moonIlluminance / FULL_MOON_ZENITH_RELATIVE);
  return { intensity, roughness: MOON_GLITTER_ROUGHNESS };
}

/**
 * Describe the lit-fraction shape of the moon disc for a given illuminated
 * fraction (`SkyState.moonPhase`, 0..1). Returns the signed position of the
 * terminator across the disc, normalised to [-1, +1]:
 *
 * - `+1`  at new moon (fraction 0): terminator at the far limb, disc dark.
 * - ` 0`  at half moon (fraction 0.5): terminator down the centre.
 * - `-1`  at full moon (fraction 1): terminator past the near limb, disc lit.
 *
 * The relationship between illuminated fraction and terminator offset for a
 * sphere lit by a distant source is `fraction = (1 - cos θ) / 2` where θ is the
 * phase angle; the terminator's projected offset is `cos θ = 1 - 2·fraction`.
 * This is the exact geometric law (not an approximation) — the disc shader uses
 * it to place the light/dark boundary.
 */
export function moonTerminator(phase: number): number {
  const fraction = clamp01(phase);
  // cos(phaseAngle) = 1 - 2*fraction, which also IS the terminator offset.
  return 1 - 2 * fraction;
}
