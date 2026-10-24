/**
 * Environment fixture for the assist closed-loop tests — a steady synthetic
 * breeze FROM the north over flat water, built from the REAL Environment
 * (createEnvironment), identical in spirit to tests/unit/boats/fixtures.ts.
 *
 * Conventions: SI/radians. Wind direction is the bearing the wind blows FROM.
 * World +X east, +Z south; bearing θ → (sinθ, 0, −cosθ).
 */

import type {
  AirConditions,
  CurrentConditions,
  Environment,
  SeaConditions,
  SkyConditions,
  VenueDefinition,
  WeatherKeyframe,
  WeatherService,
  WeatherSnapshot,
  WindConditions,
} from '@/types';
import { PHYSICS_CONSTANTS, UNITS } from '@/types';
import { createEnvironment } from '@/environment';

function windConditions(speedMs: number): WindConditions {
  return { trueSpeed: speedMs, trueDirection: 0, gustCeiling: speedMs * 1.3, stability: 0.3 };
}
function seaConditions(): SeaConditions {
  return {
    significantHeight: 0, dominantPeriod: 6, dominantDirection: 0,
    swell: { height: 0, period: 6, direction: 0 },
    windWave: { height: 0, period: 4, direction: 0 },
    surfaceTemp: 18, tideHeight: 0,
  };
}
function skyConditions(): SkyConditions {
  return {
    cloudLow: 0.2, cloudMid: 0.1, cloudHigh: 0.1, visibility: 20000,
    precipitation: 0, wmoCode: 1, solarRadiation: 500, isDay: true,
  };
}
function airConditions(): AirConditions {
  return { temperature: 18, pressure: 101325, density: PHYSICS_CONSTANTS.AIR_DENSITY_REFERENCE };
}
function currentConditions(): CurrentConditions {
  return { speed: 0, direction: 0 };
}

export function makeSnapshot(windKnots: number): WeatherSnapshot {
  const wind = windConditions(windKnots * UNITS.KNOTS_TO_MS);
  const sea = seaConditions();
  const current = currentConditions();
  const sky = skyConditions();
  const air = airConditions();
  const keyframe = (offset: number): WeatherKeyframe => ({ offset, wind, sea, current, sky, air });
  return {
    fetchedAt: Date.UTC(2024, 5, 21, 15, 0, 0),
    source: 'sandbox',
    venueId: 'assist-bay',
    localTime: { iso: '2024-06-21T15:00:00Z', utcOffsetSeconds: 0 },
    wind, sea, current, sky, air,
    timeline: [keyframe(-3600), keyframe(0), keyframe(3600), keyframe(7200), keyframe(14400)],
    attribution: ['synthetic-test'],
  };
}

function makeWeatherService(snapshot: WeatherSnapshot): WeatherService {
  const steady = snapshot.timeline.find((k) => k.offset === 0) ?? snapshot.timeline[0];
  if (steady === undefined) throw new Error('snapshot has no timeline keyframes');
  return { snapshot, sampleAt: () => steady, timeCompression: 1 };
}

function makeVenue(): VenueDefinition {
  return {
    id: 'assist-bay', name: 'Assist Bay', region: 'Nowhere',
    coordinates: { latitude: 41.5, longitude: -71.3 }, timezone: 'UTC',
    difficulty: 1, blurb: 'Flat synthetic bay for assist tests.',
    bounds: { min: { x: -5000, y: -5000 }, max: { x: 5000, y: 5000 } },
    coastlineFile: 'none.json', coastlineAttribution: 'synthetic',
    relief: 'flat', maxElevation: 0, maxDepth: 50, freshwater: false,
    landmarks: [], traffic: [],
    water: {
      colorShallow: { r: 0.1, g: 0.3, b: 0.3 }, colorDeep: { r: 0, g: 0.1, b: 0.2 },
      turbidity: 0.2, extinctionDepth: 15,
    },
    windProfile: { shearExponent: 0.11, oscillationScale: 0.2, gustScale: 0.2, fetch: 50000 },
    tide: { amplitude: 0, phaseOffsetHours: 0, currentStrength: 0, currentAxis: { x: 1, y: 0 } },
    courses: [], climatology: [],
    grade: {
      exposure: 0, contrast: 0, saturation: 1,
      shadowTint: { r: 0, g: 0, b: 0 }, highlightTint: { r: 1, g: 1, b: 1 },
      palette: [{ r: 0.5, g: 0.5, b: 0.5 }],
    },
    ambience: { surf: 0.2, gullDensity: 0, urban: 0, harbour: 0, riggingResonance: 200 },
    spawn: { position: { x: 0, y: 0 }, heading: 0 },
  };
}

/** Build a flat-water Environment with a steady breeze FROM north. */
export function makeEnvironment(windKnots: number): Environment {
  const snapshot = makeSnapshot(windKnots);
  return createEnvironment({
    weatherService: makeWeatherService(snapshot),
    venue: makeVenue(),
    seed: 4321,
  });
}
