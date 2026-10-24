/**
 * Visibility & aerial perspective — Stream F.2 (Weather visuals).
 *
 * Pure model (headlessly unit-testable, NO three.js) plus a thin TSL mirror.
 *
 * ## Physics
 *
 * Horizontal visibility `V` (the meteorological "visual range") is defined by
 * the **Koschmieder relation**: an object is just distinguishable from the
 * horizon sky when its apparent contrast falls to the threshold ε = 0.02
 * (Koschmieder 1924; WMO Guide to Meteorological Instruments, §9.1). For a
 * black target against a uniformly lit haze,
 *
 *     ε = exp(-β · V)   ⇒   β = -ln(ε) / V = 3.912 / V
 *
 * where β is the extinction coefficient (1/m). Apparent contrast at an arbitrary
 * distance `d` is then `C(d) = exp(-β · d)`, so transmittance (how much of the
 * original radiance survives) and apparent contrast are the same exponential
 * here. We expose both names because the render layer treats them differently
 * (one scales radiance, the other drives the haze blend).
 *
 * The demo requirement ("the next mark vanishes into haze at the reported
 * visibility distance") falls straight out of this: at `d == V`, C = ε = 0.02.
 *
 * ## Conventions
 *
 * - All distances in metres (SI). Visibility is clamped to a documented
 *   [50 m, 80 km] range — 50 m is dense fog (the lower end Open-Meteo reports),
 *   80 km is the practical upper limit of the Koschmieder model before Rayleigh
 *   scattering alone dominates (clean-air visual range).
 * - Colours are linear RGB (never sRGB) — consistent with LightingState.
 */

import type { RGB } from '@/types';
import type { LightingState } from '@render/lighting/LightingState';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Koschmieder contrast threshold — the eye's limit of distinguishability. */
export const CONTRAST_THRESHOLD = 0.02;

/** -ln(0.02) = 3.912023..., the Koschmieder numerator. */
export const KOSCHMIEDER_CONSTANT = -Math.log(CONTRAST_THRESHOLD);

/** Minimum clamped visibility, metres (dense fog). */
export const MIN_VISIBILITY = 50;

/** Maximum clamped visibility, metres (clean-air visual range). */
export const MAX_VISIBILITY = 80_000;

// ─── Pure model ────────────────────────────────────────────────────────────────

/** Clamp visibility to the documented valid range [50 m, 80 km]. */
export function clampVisibility(visibility: number): number {
  if (!Number.isFinite(visibility)) return MAX_VISIBILITY;
  return Math.min(MAX_VISIBILITY, Math.max(MIN_VISIBILITY, visibility));
}

/**
 * Extinction coefficient β = 3.912 / V (1/m) from the Koschmieder relation.
 * Visibility is clamped first.
 */
export function extinction(visibility: number): number {
  return KOSCHMIEDER_CONSTANT / clampVisibility(visibility);
}

/**
 * Transmittance T(d) = exp(-β · d): the fraction of original radiance that
 * survives over distance `d`. Monotone decreasing in `d`, 1 at d = 0.
 */
export function transmittance(distance: number, visibility: number): number {
  const d = Math.max(0, distance);
  return Math.exp(-extinction(visibility) * d);
}

/**
 * Apparent contrast of a black target against the haze at distance `d`.
 * Equal to the transmittance here (Koschmieder, black target). At `d == V`
 * this is exactly the contrast threshold 0.02.
 */
export function apparentContrast(distance: number, visibility: number): number {
  return transmittance(distance, visibility);
}

/**
 * A convenient "fog far distance" — the distance at which contrast has dropped
 * to ε (i.e. the clamped visibility itself). Exposed so the renderer can set a
 * far-fog / depth-fade parameter directly from visibility.
 */
export function fogFarDistance(visibility: number): number {
  return clampVisibility(visibility);
}

/**
 * Exponential aerial perspective: blend `color` towards `fogColor` with the
 * Koschmieder transmittance, optionally attenuated by a mild height falloff
 * (haze is densest near the surface).
 *
 * `out` is written in place and returned (allocation-free by contract).
 *
 * Height falloff: when `heightMetres` and `heightFalloff` are supplied, the
 * effective extinction is scaled by exp(-height / heightFalloff), so objects
 * high above the water (clouds, hilltops) fade less than those near sea level.
 * This is a rendering-layer approximation of a stratified haze layer, NOT a
 * physical radiative-transfer solution — labelled as such.
 *
 * @param color       Source linear RGB (the object's own colour).
 * @param fogColor    Linear RGB the object fades towards (LightingState.fogColor).
 * @param distance    View distance, metres.
 * @param visibility  Horizontal visibility, metres (clamped internally).
 * @param out         Destination RGB (written in place).
 * @param heightMetres   Optional height above water of the sample point.
 * @param heightFalloff  Optional scale height of the haze layer, metres
 *                       (default 1500 m when heightMetres is given).
 */
export function aerialPerspective(
  color: RGB,
  fogColor: RGB,
  distance: number,
  visibility: number,
  out: RGB,
  heightMetres?: number,
  heightFalloff = 1500,
): RGB {
  const d = Math.max(0, distance);
  let beta = extinction(visibility);
  if (heightMetres !== undefined && heightFalloff > 0) {
    beta *= Math.exp(-Math.max(0, heightMetres) / heightFalloff);
  }
  const t = Math.exp(-beta * d); // 1 at d=0, → 0 at large d
  out.r = color.r * t + fogColor.r * (1 - t);
  out.g = color.g * t + fogColor.g * (1 - t);
  out.b = color.b * t + fogColor.b * (1 - t);
  return out;
}

// ─── TSL mirror (thin; mirrors the pure model) ──────────────────────────────────

// Isolated so the pure model above never touches three.js. These imports are
// only pulled in when the TSL helpers are referenced from the render layer.
import * as THREE from 'three/webgpu';
import { Fn, float, vec3, uniform } from 'three/tsl';
import type { TSLNode } from 'three/tsl';

/** Live uniforms backing the TSL aerial-perspective node. */
export interface VisibilityUniforms {
  /** Extinction coefficient β (1/m). */
  beta: TSLNode & { value: unknown };
  /** Fog colour (linear RGB). */
  fogColor: TSLNode & { value: unknown };
  /** Push the latest visibility + lighting into the uniforms. */
  update(visibility: number, lighting: LightingState): void;
}

/** Create the uniform bundle for aerial perspective. */
export function createVisibilityUniforms(): VisibilityUniforms {
  const uBeta = uniform(extinction(MAX_VISIBILITY));
  const uFog = uniform(new THREE.Color(0.6, 0.75, 0.9));
  return {
    beta: uBeta,
    fogColor: uFog,
    update(visibility: number, lighting: LightingState): void {
      (uBeta as { value: unknown }).value = extinction(visibility);
      const c = uFog.value as THREE.Color;
      c.r = lighting.fogColor.r;
      c.g = lighting.fogColor.g;
      c.b = lighting.fogColor.b;
    },
  };
}

/**
 * TSL node mirroring {@link aerialPerspective}: blends `colorNode` towards the
 * fog colour by `1 - exp(-β · distance)`. Mirrors the pure model exactly
 * (ignoring height falloff, which the material can layer on separately).
 */
export function applyAerialPerspectiveNode(
  colorNode: TSLNode,
  distanceNode: TSLNode,
  uniforms: VisibilityUniforms,
): TSLNode {
  return Fn(() => {
    const t = uniforms.beta.mul(distanceNode).negate().exp();
    const fog = vec3(uniforms.fogColor);
    return colorNode.mul(t).add(fog.mul(float(1).sub(t)));
  })();
}
