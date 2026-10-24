/**
 * Headless terrain build for a venue.
 *
 * Runs the frozen {@link TerrainBuilder} generator (engine-agnostic, no GPU,
 * no three.js) on a venue's coastline + bathymetry and wraps its heightfield /
 * land mask into the `depthAt(x,z)` and `isLand(x,z)` callbacks the physics
 * {@link Environment} needs.
 *
 * TerrainBuilder emits:
 *   - `heightfield`: signed elevation, +above water / −below (metres);
 *   - `landMask`: 1 = land, 0 = water;
 *   - `shoreDistance`, `mesh`, `bounds`, `resolution`.
 *
 * We sample the grids with nearest-cell lookup (bilinear would over-smooth the
 * land/water boundary the mask encodes). `depthAt` returns POSITIVE-DOWN depth
 * as the Environment contract requires (`−heightfield` in water, 0 on land).
 */

import type { GeneratedTerrain, Metres, Seed } from '@/types';
import type { VenueDefinition } from '@/types';
import { TerrainBuilder } from '@generation/terrain/TerrainBuilder';
import { geometryForVenue } from './geometry';

/** Default grid resolution for a venue terrain build. */
export const DEFAULT_TERRAIN_RESOLUTION = 256;

/** The physics-facing fields a built venue terrain exposes. */
export interface VenueTerrain {
  /** The raw generator output. */
  terrain: GeneratedTerrain;
  /** Positive-down water depth at a world position (0 on land). */
  depthAt(x: number, z: number): Metres;
  /** True when the world position is over land. */
  isLand(x: number, z: number): boolean;
  /** Signed elevation (+above/−below water) at a world position. */
  elevationAt(x: number, z: number): Metres;
}

/** Clamp a world coordinate to the nearest grid column/row index. */
function cellIndex(world: number, min: number, extent: number, resolution: number): number {
  if (extent <= 0) return 0;
  const t = (world - min) / extent;
  const idx = Math.floor(t * resolution);
  return idx < 0 ? 0 : idx >= resolution ? resolution - 1 : idx;
}

/**
 * Build the venue terrain headlessly and return samplers.
 *
 * @param venue The venue definition (supplies bounds, relief, maxElevation,
 *   maxDepth, id → geometry).
 * @param resolution Grid resolution per axis (default {@link DEFAULT_TERRAIN_RESOLUTION}).
 * @param seed Deterministic seed (default 0).
 */
export function buildVenueTerrain(
  venue: VenueDefinition,
  resolution: number = DEFAULT_TERRAIN_RESOLUTION,
  seed: Seed = 0,
): VenueTerrain {
  const { coastlines, depthContours } = geometryForVenue(venue.id);

  const terrain = TerrainBuilder.generate(
    {
      bounds: venue.bounds,
      coastlines: [...coastlines],
      depthContours: [...depthContours],
      relief: venue.relief,
      maxElevation: venue.maxElevation,
      maxDepth: venue.maxDepth,
      resolution,
      seed,
    },
    seed,
  );

  const { bounds } = terrain;
  const widthX = bounds.max.x - bounds.min.x;
  const widthZ = bounds.max.y - bounds.min.y;
  const res = terrain.resolution;

  // Vec2.x → world X (col), Vec2.y → world Z (row); the heightfield is row-major.
  function idxOf(x: number, z: number): number {
    const col = cellIndex(x, bounds.min.x, widthX, res);
    const row = cellIndex(z, bounds.min.y, widthZ, res);
    return row * res + col;
  }

  function elevationAt(x: number, z: number): Metres {
    return terrain.heightfield[idxOf(x, z)] ?? 0;
  }

  function isLand(x: number, z: number): boolean {
    return (terrain.landMask[idxOf(x, z)] ?? 0) === 1;
  }

  function depthAt(x: number, z: number): Metres {
    const elev = terrain.heightfield[idxOf(x, z)] ?? 0;
    // Positive-down depth: water cells have negative elevation → depth = −elev.
    // Land cells → 0 depth.
    return elev < 0 ? -elev : 0;
  }

  return { terrain, depthAt, isLand, elevationAt };
}
