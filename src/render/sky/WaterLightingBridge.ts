/**
 * WaterLightingBridge — pushes the live sky/lighting into the ocean water
 * material's uniforms so the water reflects the current sky (Stream F.1).
 *
 * The water material (src/render/ocean/WaterMaterial.ts) exposes `sunDirection`
 * (a Vector3 uniform), `sunColor`, `skyColor`, `skyHorizonColor` (Color
 * uniforms). This module writes them from a `SkyState` + `LightingState`,
 * premultiplying the sun colour by its relative illuminance so the reflected
 * sun dims at sunset and under overcast exactly as the rest of the scene does.
 *
 * It does NOT rewrite WaterMaterial — it only sets `.value` on the existing
 * uniform handles, matching their shapes (Vector3 for the direction, Color for
 * the three colours).
 *
 * Conventions: Linear RGB; Y-up; sun direction points FROM scene TOWARDS sun.
 */

import type { SkyState } from '@/types';
import type { LightingState } from '@render/lighting/LightingState';
import type { WaterMaterialResult } from '@render/ocean/WaterMaterial';

/** Minimal structural shape of the uniform values we mutate. */
interface Vector3Like {
  x: number;
  y: number;
  z: number;
}
interface ColorLike {
  r: number;
  g: number;
  b: number;
}

/**
 * Apply the current lighting to a water material's uniforms.
 *
 * @param water     The `uniforms` object returned by `buildWaterMaterial`.
 * @param sky       Current sky state (provides the sun direction).
 * @param lighting  Current lighting state (sun/sky colours + illuminance).
 */
export function applyLightingToWater(
  water: WaterMaterialResult['uniforms'],
  sky: SkyState,
  lighting: LightingState,
): void {
  // Sun direction (Vector3). Water reflects toward the sun for glitter.
  const sunDir = water.sunDirection.value as Vector3Like;
  sunDir.x = sky.sunDirection.x;
  sunDir.y = sky.sunDirection.y;
  sunDir.z = sky.sunDirection.z;

  // Sun colour premultiplied by relative illuminance (0 at night / overcast →
  // no reflected sun; full clear-day sun → the extinction-reddened colour).
  const sunCol = water.sunColor.value as ColorLike;
  const k = lighting.sunIlluminance;
  sunCol.r = lighting.sunColor.r * k;
  sunCol.g = lighting.sunColor.g * k;
  sunCol.b = lighting.sunColor.b * k;

  // Sky zenith colour (used for the overhead reflection fallback).
  const skyCol = water.skyColor.value as ColorLike;
  skyCol.r = lighting.zenithColor.r;
  skyCol.g = lighting.zenithColor.g;
  skyCol.b = lighting.zenithColor.b;

  // Sky horizon colour (grazing-angle reflection + fog tie-in).
  const horizonCol = water.skyHorizonColor.value as ColorLike;
  horizonCol.r = lighting.horizonColor.r;
  horizonCol.g = lighting.horizonColor.g;
  horizonCol.b = lighting.horizonColor.b;
}
