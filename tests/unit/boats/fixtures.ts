/**
 * Shared fixtures for the boats tests: a synthetic WeatherSnapshot /
 * WeatherService and a minimal VenueDefinition, used to construct the REAL
 * Environment from `src/environment` (createEnvironment) with a real layered
 * WindField — not a stub. The wave field is supplied explicitly per test
 * (flat for rest/sailing tests, a real CPU Gerstner field for the soak test).
 *
 * Conventions: SI, radians. Wind direction is the bearing the wind blows FROM.
 * World +X east, +Z south, bearing θ → (sin θ, 0, −cos θ).
 */

import type {
  AirConditions,
  CurrentConditions,
  Environment,
  SeaConditions,
  SkyConditions,
  VenueDefinition,
  WaveField,
  WeatherKeyframe,
  WeatherService,
  WeatherSnapshot,
  WindConditions,
} from '@/types';
import { PHYSICS_CONSTANTS, UNITS } from '@/types';
import { createEnvironment } from '@/environment';

/** Wind blowing FROM the north (0 rad) at a given speed, with a gust ceiling. */
function windConditions(speedMs: number): WindConditions {
  return {
    trueSpeed: speedMs,
    trueDirection: 0, // FROM north → air moves towards +Z (south). bearing 0.
    gustCeiling: speedMs * 1.3,
    stability: 0.3, // moderately stable → low oscillation, so tests are steady.
  };
}

function seaConditions(hs: number, period: number): SeaConditions {
  return {
    significantHeight: hs,
    dominantPeriod: period,
    dominantDirection: 0,
    swell: { height: hs * 0.6, period, direction: 0 },
    windWave: { height: hs * 0.8, period: Math.max(period - 2, 2), direction: 0 },
    surfaceTemp: 18,
    tideHeight: 0,
  };
}

function currentConditions(): CurrentConditions {
  return { speed: 0, direction: 0 };
}

function skyConditions(): SkyConditions {
  return {
    cloudLow: 0.2,
    cloudMid: 0.1,
    cloudHigh: 0.1,
    visibility: 20000,
    precipitation: 0,
    wmoCode: 1,
    solarRadiation: 500,
    isDay: true,
  };
}

function airConditions(): AirConditions {
  return {
    temperature: 18,
    pressure: 101325,
    density: PHYSICS_CONSTANTS.AIR_DENSITY_REFERENCE,
  };
}

/**
 * Build a synthetic WeatherSnapshot for a steady breeze.
 * @param windKnots steady true wind speed, knots.
 * @param hs significant wave height, metres (0 for flat water).
 * @param period dominant wave period, seconds.
 */
export function makeSnapshot(windKnots: number, hs = 0, period = 6): WeatherSnapshot {
  const speedMs = windKnots * UNITS.KNOTS_TO_MS;
  const wind = windConditions(speedMs);
  const sea = seaConditions(hs, period);
  const current = currentConditions();
  const sky = skyConditions();
  const air = airConditions();

  // A flat timeline: the same conditions at every offset, so sampleAt() is
  // steady over the whole test regardless of session time.
  const keyframe = (offset: number): WeatherKeyframe => ({
    offset,
    wind,
    sea,
    current,
    sky,
    air,
  });

  return {
    fetchedAt: Date.UTC(2024, 5, 21, 15, 0, 0), // midday-ish, northern summer.
    source: 'sandbox',
    venueId: 'test-bay',
    localTime: { iso: '2024-06-21T15:00:00Z', utcOffsetSeconds: 0 },
    wind,
    sea,
    current,
    sky,
    air,
    timeline: [keyframe(-3600), keyframe(0), keyframe(3600), keyframe(7200), keyframe(14400)],
    attribution: ['synthetic-test'],
  };
}

/** A minimal WeatherService over a fixed snapshot (steady conditions). */
export function makeWeatherService(snapshot: WeatherSnapshot): WeatherService {
  // sampleAt returns the offset-0 keyframe for all times (steady breeze).
  const steady = snapshot.timeline.find((k) => k.offset === 0) ?? snapshot.timeline[0];
  if (steady === undefined) {
    throw new Error('snapshot has no timeline keyframes');
  }
  return {
    snapshot,
    sampleAt: () => steady,
    timeCompression: 1,
  };
}

/** A minimal flat-ocean VenueDefinition (seawater, deep, open fetch). */
export function makeVenue(): VenueDefinition {
  return {
    id: 'test-bay',
    name: 'Test Bay',
    region: 'Nowhere',
    coordinates: { latitude: 41.5, longitude: -71.3 },
    timezone: 'UTC',
    difficulty: 1,
    blurb: 'A flat synthetic bay for physics tests.',
    bounds: { min: { x: -5000, y: -5000 }, max: { x: 5000, y: 5000 } },
    coastlineFile: 'none.json',
    coastlineAttribution: 'synthetic',
    relief: 'flat',
    maxElevation: 0,
    maxDepth: 50,
    freshwater: false,
    landmarks: [],
    traffic: [],
    water: {
      colorShallow: { r: 0.1, g: 0.3, b: 0.3 },
      colorDeep: { r: 0.0, g: 0.1, b: 0.2 },
      turbidity: 0.2,
      extinctionDepth: 15,
    },
    windProfile: {
      shearExponent: 0.11,
      oscillationScale: 0.2, // low → steady wind for deterministic tests.
      gustScale: 0.2,
      fetch: 50000,
    },
    tide: {
      amplitude: 0,
      phaseOffsetHours: 0,
      currentStrength: 0,
      currentAxis: { x: 1, y: 0 },
    },
    courses: [],
    climatology: [],
    grade: {
      exposure: 0,
      contrast: 0,
      saturation: 1,
      shadowTint: { r: 0, g: 0, b: 0 },
      highlightTint: { r: 1, g: 1, b: 1 },
      palette: [{ r: 0.5, g: 0.5, b: 0.5 }],
    },
    ambience: { surf: 0.2, gullDensity: 0, urban: 0, harbour: 0, riggingResonance: 200 },
    spawn: { position: { x: 0, y: 0 }, heading: 0 },
  };
}

/**
 * Build the REAL Environment from createEnvironment with a synthetic snapshot.
 * @param windKnots steady true wind speed (FROM north), knots.
 * @param waveField optional wave field; defaults to the flat stub inside
 *   createEnvironment when omitted.
 */
export function makeEnvironment(windKnots: number, waveField?: WaveField): Environment {
  const snapshot = makeSnapshot(windKnots);
  const weatherService = makeWeatherService(snapshot);
  const venue = makeVenue();
  return createEnvironment({
    weatherService,
    venue,
    seed: 1234,
    ...(waveField !== undefined ? { waveField } : {}),
  });
}
