/**
 * Stream F shared contract — the lighting state every sky/weather/post/night
 * subsystem reads. Pure data + pure helpers; NO three.js (this file is the
 * bridge between the headless-testable models and the TSL layers).
 *
 * Produced by `computeLightingState` (src/render/sky/LightingModel.ts, task F.1)
 * once per frame (or whenever SkyState / SkyConditions change) and consumed by:
 *   - F.1 SkyDome / EnvironmentProbe / WaterMaterial hooks (sun/sky colours)
 *   - F.2 cloud shading, fog / aerial perspective (fogColor, overcast)
 *   - F.3 shadow light intensity, exposure, bloom threshold
 *   - F.4 night blend (nightFactor drives star/moon/nav-light/shore-light fade)
 *
 * Conventions (see .kiro/steering/sailing-conventions.md):
 *  - Linear RGB, 0..1 per channel for colours (never sRGB).
 *  - World space Y-up, right-handed, +X east, +Z south. Directions point FROM
 *    the scene TOWARDS the body (same as SkyState.sunDirection).
 *  - Illuminance is RELATIVE: 1.0 == clear-sky sun at the zenith. Absolute lux
 *    never appears in the render layer; exposure maps relative -> display.
 */

import type { RGB, Vec3 } from '@/types';

/** Lighting derived from sun position + live weather. All fields are plain numbers. */
export interface LightingState {
  /** Direct sun colour after atmospheric extinction (reddens near the horizon). */
  sunColor: RGB;
  /** Relative direct-sun illuminance on a surface facing the sun. 0 at night/overcast. */
  sunIlluminance: number;
  /** Colour of the sky dome at the zenith (for ambient / reflections). */
  zenithColor: RGB;
  /** Colour of the sky dome at the horizon (for fog and reflections). */
  horizonColor: RGB;
  /** Hemispherical sky ambient colour (cosine-weighted average of the dome). */
  ambientColor: RGB;
  /** Relative ambient illuminance on an upward-facing surface. */
  ambientIlluminance: number;
  /** Colour distant objects fade towards (aerial perspective / fog). */
  fogColor: RGB;
  /** 0 = clear sky, 1 = fully overcast (combined low/mid/high effective cover). */
  overcast: number;
  /**
   * 0 = full daylight .. 1 = full night, smooth through twilight.
   * See `nightFactorFromSunElevation`. Night subsystems fade in on this.
   */
  nightFactor: number;
  /** Suggested tone-mapping exposure multiplier (rises at night / under overcast). */
  exposure: number;
}

/** Plain-data unit direction, re-exported for brevity in Stream F modules. */
export type Direction = Vec3;

/** Allocate a LightingState initialised to a neutral clear-day value. */
export function createLightingState(): LightingState {
  return {
    sunColor: { r: 1, g: 0.96, b: 0.9 },
    sunIlluminance: 1,
    zenithColor: { r: 0.2, g: 0.4, b: 0.8 },
    horizonColor: { r: 0.6, g: 0.75, b: 0.9 },
    ambientColor: { r: 0.35, g: 0.5, b: 0.8 },
    ambientIlluminance: 0.2,
    fogColor: { r: 0.6, g: 0.75, b: 0.9 },
    overcast: 0,
    nightFactor: 0,
    exposure: 1,
  };
}

const DEG = Math.PI / 180;

/**
 * Night blend from sun elevation (radians).
 *
 * 0 when the sun is at or above the horizon (-0.833° accounts for refraction +
 * solar radius, the standard sunrise/sunset definition), rising smoothly to 1
 * at -12° (nautical twilight: horizon no longer distinguishable, stars fully
 * visible). Civil twilight (-6°) therefore lands near 0.5.
 *
 * Reference: standard astronomical twilight definitions (civil -6°, nautical
 * -12°, astronomical -18°); smoothstep is the rendering-layer blend.
 */
export function nightFactorFromSunElevation(sunElevation: number): number {
  const hi = -0.833 * DEG;
  const lo = -12 * DEG;
  const t = Math.min(1, Math.max(0, (sunElevation - hi) / (lo - hi)));
  return t * t * (3 - 2 * t);
}
