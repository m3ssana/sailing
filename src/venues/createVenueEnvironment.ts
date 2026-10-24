/**
 * Venue → {@link Environment} wiring.
 *
 * `createVenueEnvironment` builds the physics/render environment for a venue
 * from a weather snapshot:
 *   1. builds the headless terrain (→ `depthAt` / `isLand`);
 *   2. generates the wind influence field from the same coastline geometry;
 *   3. wraps the snapshot in a {@link WeatherServiceImpl};
 *   4. calls the frozen {@link createEnvironment}, INJECTING the generated wind
 *      influence field through `EnvironmentConfig.terrainField`.
 *
 * ## Former contract gap — now CLOSED
 *
 * `EnvironmentConfig` (src/environment/Environment.ts) previously had no field
 * for a wind influence / terrain field, so the generated `WindInfluenceFieldResult`
 * could not reach the Environment and was merely returned alongside, unconsumed.
 * `EnvironmentConfig` now carries an optional, backward-compatible
 * `terrainField?: TerrainInfluenceField` that `createEnvironment` forwards to
 * `createWindField`; `WindInfluenceFieldResult` structurally matches that type,
 * so we pass the generated field straight through here. The venue's lee/gap/bend
 * wind effects now modulate the simulated wind. The field is STILL also returned
 * in `windInfluence` (the return shape is unchanged) for the render layer and
 * tests.
 */

import type { Environment, Seed } from '@/types';
import type { VenueDefinition, WeatherSnapshot } from '@/types';
import { createEnvironment } from '@environment/index';
import { WeatherServiceImpl } from '@weather/index';
import { generateWindInfluenceField } from '@generation/wind/WindInfluenceField';
import type { WindInfluenceFieldResult } from '@generation/wind/WindInfluenceField';
import { buildVenueTerrain } from './buildVenueTerrain';
import type { VenueTerrain } from './buildVenueTerrain';
import { geometryForVenue } from './geometry';

/** What `createVenueEnvironment` returns: the Environment plus venue artefacts. */
export interface VenueEnvironment {
  /** The frozen Environment, ready for physics/render/AI to sample. */
  environment: Environment;
  /** The built terrain (heightfield, land mask, samplers). */
  terrain: VenueTerrain;
  /**
   * The generated wind influence field. It is now INJECTED into `environment`
   * (via `EnvironmentConfig.terrainField`) so it modulates the simulated wind,
   * AND exposed here for the render layer and tests.
   */
  windInfluence: WindInfluenceFieldResult;
}

/** Options controlling the venue-environment build. */
export interface CreateVenueEnvironmentOptions {
  /** Deterministic seed (default 0). */
  seed?: Seed;
  /** Terrain grid resolution per axis (default from buildVenueTerrain). */
  terrainResolution?: number;
  /** Wind influence field resolution per axis (default 128 for headless use). */
  windResolution?: number;
}

/**
 * Build a complete venue environment from a weather snapshot.
 *
 * @param venue The venue definition.
 * @param weatherSnapshot A normalized weather snapshot (from the weather layer).
 * @param nowMs Session-start epoch ms, used for tide phase alignment. If the
 *   snapshot already carries `fetchedAt`, that is the natural default, but an
 *   explicit `nowMs` lets a caller align the tide to "now".
 */
export function createVenueEnvironment(
  venue: VenueDefinition,
  weatherSnapshot: WeatherSnapshot,
  nowMs: number,
  options: CreateVenueEnvironmentOptions = {},
): VenueEnvironment {
  const seed = options.seed ?? 0;

  // 1. Terrain → depth / land samplers.
  const terrain = buildVenueTerrain(venue, options.terrainResolution, seed);

  // 2. Wind influence field from the same coastline geometry. The reference
  //    wind bearing uses the venue's current climatology prevailing direction so
  //    the lee/gap/bend effects align with the dominant local flow. We use the
  //    snapshot's own wind direction when available (the live forecast), else a
  //    neutral southerly.
  const { coastlines } = geometryForVenue(venue.id);
  const windInfluence = generateWindInfluenceField({
    bounds: venue.bounds,
    coastlines: [...coastlines],
    relief: venue.relief,
    maxElevation: venue.maxElevation,
    resolution: options.windResolution ?? 128,
    referenceWindDirection: weatherSnapshot.wind.trueDirection,
    seed,
  });

  // 3. Wrap the snapshot in a WeatherService.
  const weatherService = new WeatherServiceImpl(weatherSnapshot, venue.windProfile.fetch);

  // 4. Call the frozen createEnvironment with venue wind/tide/current/depth, now
  //    INJECTING the generated wind influence field through the additive
  //    `EnvironmentConfig.terrainField` passthrough (its structural type matches
  //    the wind layer's `TerrainInfluenceField`), so the venue's lee/gap/bend
  //    wind effects reach the Environment's wind field. (This closes the former
  //    contract gap — the field used to be returned alongside, unconsumed.)
  const environment = createEnvironment({
    weatherService,
    venue,
    seed,
    terrainField: windInfluence,
    depthAt: (x, z) => terrain.depthAt(x, z),
    isLand: (x, z) => terrain.isLand(x, z),
    sessionStartEpochMs: nowMs,
  });

  return { environment, terrain, windInfluence };
}
