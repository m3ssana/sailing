/**
 * Environment compositor: implements the frozen Environment interface by
 * composing wind, waves, current, and sky subsystems.
 *
 * Constructed once per venue entry from a weather snapshot and venue definition,
 * then sampled every frame by physics, rendering, and AI.
 */

import type {
  CurrentField,
  Environment,
  Metres,
  Seed,
  SessionTime,
  SkyState,
  WaveField,
  WindField,
} from '@/types';
import type { VenueDefinition } from '@/types';
import type { WeatherService } from '@/types';
import { PHYSICS_CONSTANTS } from '@/types';
import { createWindField } from './wind';
import { createCurrentField } from './CurrentField';
import { computeSkyStateForVenue, createSkyState } from './SkyState';

export interface EnvironmentConfig {
  weatherService: WeatherService;
  venue: VenueDefinition;
  seed: Seed;
  /** External wave field (owned by another agent). If absent, a flat stub is used. */
  waveField?: WaveField;
  /** Depth field callback. If absent, uniform depth from venue.maxDepth is used. */
  depthAt?: (x: number, z: number) => Metres;
  /** Land query callback. If absent, everything is water. */
  isLand?: (x: number, z: number) => boolean;
  /** Session start epoch for tide phase alignment. Defaults to snapshot.fetchedAt. */
  sessionStartEpochMs?: number;
}

/**
 * Create a flat-water stub implementing WaveField, used when the wave module
 * is not yet available. No allocation in sample paths.
 */
function createFlatWaveField(): WaveField {
  return {
    height: () => 0,
    displacement: (_x, _z, _t, out) => {
      if (out) {
        out.x = 0;
        out.y = 0;
        out.z = 0;
        return out;
      }
      return { x: 0, y: 0, z: 0 };
    },
    normal: (_x, _z, _t, out) => {
      if (out) {
        out.x = 0;
        out.y = 1;
        out.z = 0;
        return out;
      }
      return { x: 0, y: 1, z: 0 };
    },
    orbitalVelocity: (_x, _z, _y, _t, out) => {
      if (out) {
        out.x = 0;
        out.y = 0;
        out.z = 0;
        return out;
      }
      return { x: 0, y: 0, z: 0 };
    },
    components: [],
    params: {
      windSpeed: 0,
      windDirection: 0,
      fetch: 1000,
      significantHeight: 0,
      swellHeight: 0,
      swellPeriod: 8,
      swellDirection: 0,
      peakEnhancement: 3.3,
      directionalSpread: 20,
      depth: 50,
      currentVelocity: { x: 0, y: 0 },
      seed: 0,
    },
  };
}

export function createEnvironment(config: EnvironmentConfig): Environment {
  const { weatherService, venue, seed } = config;
  const snapshot = weatherService.snapshot;
  const sessionStartEpochMs = config.sessionStartEpochMs ?? snapshot.fetchedAt;

  // Wind field.
  const wind: WindField = createWindField({
    weatherService,
    seed,
    windProfile: venue.windProfile,
  });

  // Wave field (stub if not provided).
  const waves: WaveField = config.waveField ?? createFlatWaveField();

  // Depth query.
  const defaultDepth = venue.maxDepth;
  const depthAt = config.depthAt ?? ((_x: number, _z: number) => defaultDepth);

  // Land query.
  const isLand = config.isLand ?? ((_x: number, _z: number) => false);

  // Current field.
  const currentFieldResult = createCurrentField({
    weatherService,
    tideProfile: venue.tide,
    depthAt,
    referenceDepth: defaultDepth * 0.5,
    sessionStartEpochMs,
  });
  const current: CurrentField = currentFieldResult;

  // Sky state: pre-allocate a single SkyState and reuse it.
  const _skyState = createSkyState();
  const lat = venue.coordinates.latitude;
  const lon = venue.coordinates.longitude;

  function skyAt(t: SessionTime): SkyState {
    // Interpolate cloud cover from the weather timeline.
    const kf = weatherService.sampleAt(t);
    return computeSkyStateForVenue(
      lat,
      lon,
      snapshot.fetchedAt,
      t,
      kf.sky.cloudLow,
      kf.sky.cloudMid,
      kf.sky.cloudHigh,
      _skyState,
    );
  }

  const waterDensity = venue.freshwater
    ? PHYSICS_CONSTANTS.FRESHWATER_DENSITY
    : PHYSICS_CONSTANTS.WATER_DENSITY;

  return {
    wind,
    waves,
    current,
    skyAt,
    depthAt,
    isLand,
    waterDensity,
    snapshot,
  };
}
