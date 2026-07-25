/**
 * Offline climatology fallback provider.
 *
 * Builds a WeatherSnapshot from the venue's bundled `climatology[]` array —
 * 12 months of averaged conditions. Used when both network and stale cache
 * are unavailable.
 *
 * The snapshot has no timeline (empty array) since climatology represents
 * static monthly averages, not evolving forecasts.
 */

import type { MonthlyClimate, WeatherSnapshot, WeatherKeyframe } from '@/types';
import type { VenueDefinition } from '@/types';
import { PHYSICS_CONSTANTS, UNITS } from '@/types';

/**
 * Select the climate entry closest to the current month.
 * Uses the system clock month when no override is provided.
 */
function selectMonthlyClimate(
  climatology: readonly MonthlyClimate[],
  month?: number,
): MonthlyClimate | undefined {
  const target = month ?? new Date().getMonth() + 1; // 1-indexed
  return climatology.find((c) => c.month === target);
}

/**
 * Compute air density from pressure (Pa) and temperature (°C) via ideal gas law:
 *   ρ = P / (R_d * T_K)
 * where R_d = 287.058 J/(kg·K).
 */
function computeAirDensity(pressurePa: number, tempC: number): number {
  const tempK = tempC + 273.15;
  return pressurePa / (PHYSICS_CONSTANTS.DRY_AIR_GAS_CONSTANT * tempK);
}

/**
 * Build a complete WeatherSnapshot from venue climatology.
 * All values are already in SI (m/s, radians) per the MonthlyClimate contract.
 */
export function buildClimatologySnapshot(
  venue: VenueDefinition,
  month?: number,
): WeatherSnapshot {
  const climate = selectMonthlyClimate(venue.climatology, month);

  // If no matching month found (should not happen with well-formed data),
  // fall through to the hard default layer above.
  if (climate === undefined) {
    return buildHardDefault(venue.id);
  }

  const gustCeiling = climate.meanWindSpeed * climate.gustFactor;

  // Stability: derive from gust spread. No sea temperature delta available
  // in climatology, so use only the gust-based component.
  const gustSpread = gustCeiling > 0
    ? Math.min(1, Math.max(0, (gustCeiling - climate.meanWindSpeed) / climate.meanWindSpeed))
    : 0;
  const stability = gustSpread;

  // Standard sea-level pressure and the mean air temp for density
  const pressurePa = 101325; // 1 atm, reasonable monthly average
  const density = computeAirDensity(pressurePa, climate.meanAirTemp);

  const keyframe: WeatherKeyframe = {
    offset: 0,
    wind: {
      trueSpeed: climate.meanWindSpeed,
      trueDirection: climate.prevailingDirection,
      gustCeiling,
      stability,
    },
    sea: {
      significantHeight: climate.meanWaveHeight,
      dominantPeriod: climate.meanWavePeriod,
      dominantDirection: climate.prevailingDirection,
      swell: {
        height: climate.meanWaveHeight * 0.6,
        period: climate.meanWavePeriod * 1.3,
        direction: climate.prevailingDirection,
      },
      windWave: {
        height: climate.meanWaveHeight * 0.4,
        period: climate.meanWavePeriod * 0.7,
        direction: climate.prevailingDirection,
      },
      surfaceTemp: climate.meanSeaTemp,
      tideHeight: 0,
    },
    current: { speed: 0, direction: 0 },
    sky: {
      cloudLow: climate.meanCloudCover * 0.4,
      cloudMid: climate.meanCloudCover * 0.35,
      cloudHigh: climate.meanCloudCover * 0.25,
      visibility: 15000,
      precipitation: 0,
      wmoCode: 0,
      solarRadiation: 500,
      isDay: true,
    },
    air: {
      temperature: climate.meanAirTemp,
      pressure: pressurePa,
      density,
    },
  };

  return {
    fetchedAt: Date.now(),
    source: 'climatology',
    venueId: venue.id,
    localTime: {
      iso: new Date().toISOString(),
      utcOffsetSeconds: 0,
    },
    wind: keyframe.wind,
    sea: keyframe.sea,
    current: keyframe.current,
    sky: keyframe.sky,
    air: keyframe.air,
    timeline: [keyframe],
    attribution: [
      'Climatological averages derived from venue data.',
    ],
  };
}

/**
 * Hard default: 12 kt onshore, 0.4 m chop.
 * This is the absolute last resort in the fallback ladder.
 */
export function buildHardDefault(venueId: string): WeatherSnapshot {
  // 12 knots = 12 * KNOTS_TO_MS
  const speed12kt = 12 * UNITS.KNOTS_TO_MS;
  // Onshore direction — use 180° (south, coming from) as a generic onshore.
  const onshoreDir = Math.PI; // π radians = 180°

  const pressurePa = 101325;
  const tempC = 18;
  const density = computeAirDensity(pressurePa, tempC);

  const keyframe: WeatherKeyframe = {
    offset: 0,
    wind: {
      trueSpeed: speed12kt,
      trueDirection: onshoreDir,
      gustCeiling: speed12kt * 1.3,
      stability: 0.3,
    },
    sea: {
      significantHeight: 0.4,
      dominantPeriod: 4,
      dominantDirection: onshoreDir,
      swell: { height: 0.2, period: 6, direction: onshoreDir },
      windWave: { height: 0.2, period: 3, direction: onshoreDir },
      surfaceTemp: 16,
      tideHeight: 0,
    },
    current: { speed: 0, direction: 0 },
    sky: {
      cloudLow: 0.3,
      cloudMid: 0.2,
      cloudHigh: 0.1,
      visibility: 20000,
      precipitation: 0,
      wmoCode: 0,
      solarRadiation: 600,
      isDay: true,
    },
    air: {
      temperature: tempC,
      pressure: pressurePa,
      density,
    },
  };

  return {
    fetchedAt: Date.now(),
    source: 'default',
    venueId,
    localTime: {
      iso: new Date().toISOString(),
      utcOffsetSeconds: 0,
    },
    wind: keyframe.wind,
    sea: keyframe.sea,
    current: keyframe.current,
    sky: keyframe.sky,
    air: keyframe.air,
    timeline: [keyframe],
    attribution: [],
  };
}
