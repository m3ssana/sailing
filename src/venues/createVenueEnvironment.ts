/**
 * Venue → {@link Environment} wiring.
 *
 * `createVenueEnvironment` builds the physics/render environment for a venue
 * from a weather snapshot:
 *   1. builds the headless terrain (→ `depthAt` / `isLand`);
 *   2. generates the wind influence field from the same coastline geometry;
 *   3. wraps the snapshot in a {@link WeatherServiceImpl};
 *   4. calls the frozen {@link createEnvironment}.
 *
 * ## CONTRACT GAP (reported, adapted in this layer — not papered over)
 *
 * `EnvironmentConfig` (src/environment/Environment.ts) has NO field for a wind
 * influence / terrain field. Internally `createEnvironment` always builds its
 * wind field via `createWindField({ weatherService, seed, windProfile })` with
 * no `terrainField`, so it uses the neutral identity terrain field. There is
 * therefore no supported way to feed the generated `WindInfluenceFieldResult`
 * into the Environment through the frozen config.
 *
 * We adapt in the venues layer rather than editing the frozen type:
 *   - we still call `createEnvironment` for the full, correct Environment
 *     (wind/waves/current/sky/depth/land), AND
 *   - we ALSO generate the wind influence field and return it alongside, so a
 *     caller (or a later Environment extension) can consume it. The field's
 *     structural type (`WindInfluenceFieldResult`) already matches the
 *     `TerrainInfluenceField` the wind layer accepts, so the only missing piece
 *     is an `EnvironmentConfig.terrainField` passthrough.
 *
 * RECOMMENDATION for whoever owns src/environment: add an optional
 * `terrainField?: TerrainInfluenceField` to `EnvironmentConfig` and forward it to
 * `createWindField`. That is a purely additive change to a non-frozen file
 * (Environment.ts is implementation, not in src/types), and it is the clean fix.
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
   * The generated wind influence field. NOT yet consumed by `environment`
   * (see the contract-gap note at the top of this file); exposed so a caller or
   * a future Environment extension can wire it in.
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

  // 4. Call the frozen createEnvironment with venue wind/tide/current/depth.
  const environment = createEnvironment({
    weatherService,
    venue,
    seed,
    depthAt: (x, z) => terrain.depthAt(x, z),
    isLand: (x, z) => terrain.isLand(x, z),
    sessionStartEpochMs: nowMs,
  });

  return { environment, terrain, windInfluence };
}
