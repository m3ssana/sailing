/**
 * ShoreLights — Stream F.4 (Night).
 *
 * PURE deterministic generation (`generateShoreLights`) with NO three.js, plus a
 * THIN three/TSL `createShoreLights` Points layer. Shore windows/street lights
 * (and the nav lights) are the ONLY emissive items the art direction permits at
 * night (docs/art-direction.md).
 *
 * ## Anchors — what the generation layer actually exports
 *
 * `src/generation/landmarks/SkylineGenerator` emits a merged `GeneratedModel`
 * with `meta.numBuildings` and `meta.maxHeight`, but NOT a per-building footprint
 * list — individual building positions are not exported. So this module does NOT
 * assume unreachable per-building data. Instead it accepts plain-data `anchors`:
 * world-space points with an optional height, which the caller derives from
 * whatever IS reachable (skyline cluster bounds/centre, coastline polyline
 * points, or landmark spawn positions). This keeps the import boundary clean
 * (render consumes plain data, not generation internals) and matches the honest
 * data available. Lights are scattered around each anchor.
 *
 * ## Aviation beacons (labelled scope)
 *
 * Anchors flagged `tall` (height above `beaconHeightThreshold`) get a single red
 * aviation beacon at their top. This is a cosmetic touch, not FAA/ICAO-accurate
 * beacon placement — labelled as such.
 */

import { createRandom, hashCombine } from '@core/math';

/** A placement anchor the caller supplies from reachable generation data. */
export interface ShoreAnchor {
  /** World position (x=east, y=up, z=south), metres. */
  x: number;
  y: number;
  z: number;
  /** Footprint radius to scatter lights within, metres. Default 20. */
  radius?: number;
  /** Structure height, metres. Drives window stacking and beacon eligibility. */
  height?: number;
}

/** A single generated shore light point. */
export interface ShoreLight {
  x: number;
  y: number;
  z: number;
  /** Linear-RGB colour (warm window/street, or red beacon). */
  color: { r: number; g: number; b: number };
  /** Base intensity 0..1. */
  intensity: number;
  /** Flicker phase (radians) so lights twinkle out of sync. */
  phase: number;
  /** True for red aviation beacons. */
  isBeacon: boolean;
}

/** Generation options. */
export interface ShoreLightOptions {
  /** Urban factor 0..1 (from `AmbienceParams.urban`) scaling light density. */
  density: number;
  /** Max lights per anchor at density 1. Default 24. */
  maxPerAnchor?: number;
  /** Height above which an anchor gets a red aviation beacon. Default 120 m. */
  beaconHeightThreshold?: number;
}

/** Warm window/street light colours (linear RGB), sampled per light. */
const WARM_COLORS: ReadonlyArray<{ r: number; g: number; b: number }> = [
  { r: 1.0, g: 0.78, b: 0.45 }, // incandescent window
  { r: 1.0, g: 0.85, b: 0.6 }, // warm white
  { r: 0.95, g: 0.9, b: 0.75 }, // pale sodium-ish
  { r: 1.0, g: 0.7, b: 0.35 }, // deep sodium street light
];

const BEACON_RED = { r: 1.0, g: 0.08, b: 0.08 };

/** Guaranteed fallback warm colour (avoids index-undefined non-null assertions). */
const DEFAULT_WARM = { r: 1.0, g: 0.8, b: 0.5 };

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Generate deterministic shore lights around a set of anchors.
 *
 * Deterministic in `(seed, anchors, density)` — same inputs always produce the
 * same lights (requirement 3.7 reproducibility). Density scales the number of
 * lights per anchor linearly with the urban factor.
 *
 * @param seed Deterministic seed.
 * @param anchors Placement anchors (from reachable generation data).
 * @param options Density + tuning.
 */
export function generateShoreLights(
  seed: number,
  anchors: readonly ShoreAnchor[],
  options: ShoreLightOptions,
): ShoreLight[] {
  const density = clamp01(options.density);
  const maxPerAnchor = options.maxPerAnchor ?? 24;
  const beaconThreshold = options.beaconHeightThreshold ?? 120;
  const rng = createRandom(hashCombine(seed, 0x5107e));
  const lights: ShoreLight[] = [];

  for (let ai = 0; ai < anchors.length; ai++) {
    const a = anchors[ai];
    if (a === undefined) continue;
    const radius = a.radius ?? 20;
    const height = a.height ?? 10;

    // Guard against non-finite anchor geometry: a NaN/Infinity position, radius,
    // or height would scatter NaN light positions through the Points buffer and
    // poison the whole cloud. Skip such anchors entirely (treat as "no data").
    if (
      !Number.isFinite(a.x) ||
      !Number.isFinite(a.y) ||
      !Number.isFinite(a.z) ||
      !Number.isFinite(radius) ||
      !Number.isFinite(height)
    ) {
      continue;
    }

    // Count scales with density. At least 1 light if any density at all.
    const count = Math.round(maxPerAnchor * density);
    for (let i = 0; i < count; i++) {
      // Scatter within the footprint disc, stacked up the height.
      const ang = rng.angle();
      const rr = Math.sqrt(rng.next()) * radius; // area-uniform disc
      const x = a.x + Math.cos(ang) * rr;
      const z = a.z + Math.sin(ang) * rr;
      // Window height: biased low (more ground-level/street lights than penthouse).
      const hy = a.y + rng.next() * rng.next() * height;
      const colorPick =
        WARM_COLORS[rng.int(0, WARM_COLORS.length)] ?? DEFAULT_WARM;
      lights.push({
        x,
        y: hy,
        z,
        color: { r: colorPick.r, g: colorPick.g, b: colorPick.b },
        intensity: 0.5 + rng.next() * 0.5,
        phase: rng.angle(),
        isBeacon: false,
      });
    }

    // Red aviation beacon on tall anchors (labelled cosmetic scope).
    if (height >= beaconThreshold) {
      lights.push({
        x: a.x,
        y: a.y + height,
        z: a.z,
        color: { r: BEACON_RED.r, g: BEACON_RED.g, b: BEACON_RED.b },
        intensity: 1.0,
        phase: rng.angle(),
        isBeacon: true,
      });
    }
  }

  return lights;
}
