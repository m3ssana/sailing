/**
 * Weather normalization — raw Open-Meteo JSON to WeatherSnapshot.
 *
 * This is the only place where unit conversions happen. Everything downstream
 * is SI + radians, period. The following conversions occur:
 * - Wind speed: knots → m/s
 * - All directions: degrees → radians
 * - Pressure: hPa → Pa (Open-Meteo returns hPa in the JSON)
 * - Temperature: Celsius stays Celsius (it's already the SI-adjacent unit we use)
 *
 * Air density is computed from pressure and temperature via the ideal gas law.
 * Stability is derived from the gust spread and air/sea temperature delta.
 *
 * For inland-lake venues where the marine API returns nulls, sea state is
 * synthesized from wind speed and the venue's fetch length using a simplified
 * JONSWAP-like empirical relationship.
 */

import type {
  WeatherSnapshot,
  WeatherKeyframe,
  SeaConditions,
  CurrentConditions,
  SkyConditions,
} from '@/types';
import type { RawForecastResponse, RawForecastHourly } from './providers/OpenMeteoForecast';
import type { RawMarineResponse, RawMarineHourly } from './providers/OpenMeteoMarine';
import { PHYSICS_CONSTANTS, UNITS } from '@/types';
import { clamp } from '@core/math';

// ─── Unit conversion helpers ───────────────────────────────────────────────────

function knotsToMs(knots: number): number {
  return knots * UNITS.KNOTS_TO_MS;
}

function degToRad(deg: number): number {
  return deg * UNITS.DEG_TO_RAD;
}

/**
 * Open-Meteo returns pressure in hPa; we store in Pa.
 * Guarded: some responses use Pa already depending on params, but with
 * the default units config it's hPa.
 */
function hPaToPa(hPa: number): number {
  return hPa * 100;
}

// ─── Derived quantities ────────────────────────────────────────────────────────

/**
 * Air density from the ideal gas law: ρ = P / (R_d × T_K).
 * Using the specific gas constant for dry air. The humidity correction is
 * at most ~2% and Open-Meteo doesn't give us dew point in the forecast params
 * we request, so dry-air is appropriate.
 */
function computeAirDensity(pressurePa: number, tempC: number): number {
  const tempK = tempC + 273.15;
  if (tempK <= 0) return PHYSICS_CONSTANTS.AIR_DENSITY_REFERENCE;
  return pressurePa / (PHYSICS_CONSTANTS.DRY_AIR_GAS_CONSTANT * tempK);
}

/**
 * Derive wind stability from the gust spread and air/sea temperature delta.
 *
 * Physical reasoning: gusty conditions with cold air over warmer water create
 * convective instability — the boundary layer mixes aggressively, producing
 * sharp gusts and large direction shifts. Stable conditions (warm air, gentle
 * gradients) produce smooth, steady flow.
 *
 * stability = 0 (very stable) .. 1 (very unstable)
 */
function computeStability(
  trueSpeed: number,
  gustCeiling: number,
  airTemp: number,
  seaTemp: number,
): number {
  // Gust-based component: how much stronger are gusts relative to mean?
  const gustComponent = trueSpeed > 0.1
    ? clamp((gustCeiling - trueSpeed) / trueSpeed, 0, 1)
    : 0;

  // Thermal component: cold air over warm water → unstable
  // Range roughly -10 to +10 °C difference in practice
  const tempDelta = seaTemp - airTemp; // positive = unstable
  const thermalComponent = clamp((tempDelta + 2) / 12, 0, 1);

  // Blend: gust evidence is stronger than thermal, 70/30
  return clamp(gustComponent * 0.7 + thermalComponent * 0.3, 0, 1);
}

// ─── Inland-lake wave synthesis ────────────────────────────────────────────────

/**
 * Synthesize sea state from wind speed and fetch length using the
 * Sverdrup-Munk-Bretschneider empirical relations (simplified).
 *
 * H_s ≈ 0.00051 × U^2 × sqrt(F/g)   (fetch-limited)
 * T_p ≈ 0.077 × (F × U / g^2)^0.33
 *
 * where U is wind speed (m/s), F is fetch (m), g is gravity.
 * These are deliberately conservative — real fetch-limited waves on lakes
 * are typically smaller than open-ocean waves at the same wind.
 */
function synthesizeSeaFromWind(
  windSpeedMs: number,
  windDirectionRad: number,
  fetchMetres: number,
): SeaConditions {
  const g = PHYSICS_CONSTANTS.GRAVITY;
  const U = Math.max(0.1, windSpeedMs);
  const F = Math.max(100, fetchMetres);

  // Significant wave height (fetch-limited empirical)
  const Hs = Math.min(3.0, 0.00051 * U * U * Math.sqrt(F / g));

  // Peak period
  const Tp = Math.min(8.0, 0.077 * Math.pow((F * U) / (g * g), 0.33));

  return {
    significantHeight: Hs,
    dominantPeriod: Tp,
    dominantDirection: windDirectionRad, // wind-waves align with wind direction
    swell: {
      height: 0, // no swell on inland lakes
      period: 0,
      direction: windDirectionRad,
    },
    windWave: {
      height: Hs,
      period: Tp,
      direction: windDirectionRad,
    },
    surfaceTemp: 15, // will be overridden if available
    tideHeight: 0,
  };
}

// ─── Timeline building ─────────────────────────────────────────────────────────

/** Parse an ISO time string to epoch ms. */
function parseIsoTime(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * Build the timeline array from hourly and minutely_15 data.
 * Minutely_15 is preferred where present (higher resolution), with hourly
 * filling the rest of the timeline.
 */
function buildTimeline(
  forecast: RawForecastResponse,
  marine: RawMarineResponse | null,
  baseTimeMs: number,
  fetchMetres: number,
  hasMarine: boolean,
): WeatherKeyframe[] {
  const keyframes: WeatherKeyframe[] = [];
  const hourly = forecast.hourly;
  const minutely = forecast.minutely_15;

  // Determine which time arrays to merge. Minutely_15 gives 15-min resolution
  // for wind; hourly gives all other parameters.
  // Strategy: Build keyframes at minutely_15 resolution where available,
  // interpolating hourly fields; otherwise fall back to hourly resolution.

  if (minutely !== undefined && minutely.time.length > 0) {
    // Build from minutely_15 — wind fields at 15-min resolution
    for (let i = 0; i < minutely.time.length; i++) {
      const timeStr = minutely.time[i];
      if (timeStr === undefined) continue;

      const timeMs = parseIsoTime(timeStr);
      const offsetSec = (timeMs - baseTimeMs) / 1000;

      const windSpeed = minutely.wind_speed_10m[i];
      const windDir = minutely.wind_direction_10m[i];
      const windGust = minutely.wind_gusts_10m[i];

      if (windSpeed === null || windSpeed === undefined) continue;
      if (windDir === null || windDir === undefined) continue;

      const speedMs = knotsToMs(windSpeed);
      const gustMs = knotsToMs(windGust ?? windSpeed * 1.3);
      const dirRad = degToRad(windDir);

      // Find matching hourly index for other fields
      const hourlyIdx = findNearestHourlyIndex(hourly.time, timeMs);
      const hourlyData = extractHourlyAtIndex(hourly, hourlyIdx);
      const marineData = hasMarine && marine !== null && marine.hourly !== undefined
        ? extractMarineHourlyAtIndex(marine.hourly, hourlyIdx)
        : null;

      const airTemp = hourlyData.temperature;
      const pressurePa = hPaToPa(hourlyData.pressure);
      const seaTemp = marineData !== null ? marineData.seaTemp : 15;

      const stability = computeStability(speedMs, gustMs, airTemp, seaTemp);

      const sea = hasMarine && marineData !== null
        ? buildSeaFromMarine(marineData, dirRad)
        : synthesizeSeaFromWind(speedMs, dirRad, fetchMetres);

      // Override sea surface temp if available from marine
      if (marineData !== null && marineData.seaTemp > 0) {
        sea.surfaceTemp = marineData.seaTemp;
      }

      keyframes.push({
        offset: offsetSec,
        wind: { trueSpeed: speedMs, trueDirection: dirRad, gustCeiling: gustMs, stability },
        sea,
        current: hasMarine && marineData !== null
          ? { speed: marineData.currentSpeed, direction: degToRad(marineData.currentDir) }
          : { speed: 0, direction: 0 },
        sky: {
          cloudLow: (hourlyData.cloudLow ?? 0) / 100,
          cloudMid: (hourlyData.cloudMid ?? 0) / 100,
          cloudHigh: (hourlyData.cloudHigh ?? 0) / 100,
          visibility: hourlyData.visibility,
          precipitation: hourlyData.precipitation,
          wmoCode: hourlyData.weatherCode,
          solarRadiation: hourlyData.solarRadiation,
          isDay: hourlyData.solarRadiation > 10,
        },
        air: {
          temperature: airTemp,
          pressure: pressurePa,
          density: computeAirDensity(pressurePa, airTemp),
        },
      });
    }
  }

  // If minutely_15 gave us nothing (or was absent), use hourly
  if (keyframes.length === 0) {
    for (let i = 0; i < hourly.time.length; i++) {
      const timeStr = hourly.time[i];
      if (timeStr === undefined) continue;

      const timeMs = parseIsoTime(timeStr);
      const offsetSec = (timeMs - baseTimeMs) / 1000;

      const windSpeed = hourly.wind_speed_10m[i];
      const windDir = hourly.wind_direction_10m[i];
      const windGust = hourly.wind_gusts_10m[i];

      if (windSpeed === null || windSpeed === undefined) continue;
      if (windDir === null || windDir === undefined) continue;

      const speedMs = knotsToMs(windSpeed);
      const gustMs = knotsToMs(windGust ?? windSpeed * 1.3);
      const dirRad = degToRad(windDir);

      const hourlyData = extractHourlyAtIndex(hourly, i);
      const marineData = hasMarine && marine !== null && marine.hourly !== undefined
        ? extractMarineHourlyAtIndex(marine.hourly, i)
        : null;

      const airTemp = hourlyData.temperature;
      const pressurePa = hPaToPa(hourlyData.pressure);
      const seaTemp = marineData !== null ? marineData.seaTemp : 15;

      const stability = computeStability(speedMs, gustMs, airTemp, seaTemp);

      const sea = hasMarine && marineData !== null
        ? buildSeaFromMarine(marineData, dirRad)
        : synthesizeSeaFromWind(speedMs, dirRad, fetchMetres);

      if (marineData !== null && marineData.seaTemp > 0) {
        sea.surfaceTemp = marineData.seaTemp;
      }

      keyframes.push({
        offset: offsetSec,
        wind: { trueSpeed: speedMs, trueDirection: dirRad, gustCeiling: gustMs, stability },
        sea,
        current: hasMarine && marineData !== null
          ? { speed: marineData.currentSpeed, direction: degToRad(marineData.currentDir) }
          : { speed: 0, direction: 0 },
        sky: {
          cloudLow: (hourlyData.cloudLow ?? 0) / 100,
          cloudMid: (hourlyData.cloudMid ?? 0) / 100,
          cloudHigh: (hourlyData.cloudHigh ?? 0) / 100,
          visibility: hourlyData.visibility,
          precipitation: hourlyData.precipitation,
          wmoCode: hourlyData.weatherCode,
          solarRadiation: hourlyData.solarRadiation,
          isDay: hourlyData.solarRadiation > 10,
        },
        air: {
          temperature: airTemp,
          pressure: pressurePa,
          density: computeAirDensity(pressurePa, airTemp),
        },
      });
    }
  }

  return keyframes;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

interface HourlyExtract {
  temperature: number;
  pressure: number;
  cloudLow: number | null;
  cloudMid: number | null;
  cloudHigh: number | null;
  visibility: number;
  precipitation: number;
  weatherCode: number;
  solarRadiation: number;
}

function extractHourlyAtIndex(hourly: RawForecastHourly, idx: number): HourlyExtract {
  return {
    temperature: hourly.temperature_2m[idx] ?? 15,
    pressure: hourly.pressure_msl[idx] ?? 1013.25,
    cloudLow: hourly.cloud_cover_low[idx] ?? null,
    cloudMid: hourly.cloud_cover_mid[idx] ?? null,
    cloudHigh: hourly.cloud_cover_high[idx] ?? null,
    visibility: hourly.visibility[idx] ?? 20000,
    precipitation: hourly.precipitation[idx] ?? 0,
    weatherCode: hourly.weather_code[idx] ?? 0,
    solarRadiation: hourly.shortwave_radiation[idx] ?? 0,
  };
}

interface MarineHourlyExtract {
  waveHeight: number;
  waveDir: number;
  wavePeriod: number;
  windWaveHeight: number;
  windWaveDir: number;
  windWavePeriod: number;
  swellHeight: number;
  swellDir: number;
  swellPeriod: number;
  currentSpeed: number;
  currentDir: number;
  tideHeight: number;
  seaTemp: number;
}

function extractMarineHourlyAtIndex(
  hourly: RawMarineHourly,
  idx: number,
): MarineHourlyExtract | null {
  const waveHeight = hourly.wave_height[idx];
  // If primary wave data is null, no marine coverage
  if (waveHeight === null || waveHeight === undefined) return null;

  return {
    waveHeight,
    waveDir: hourly.wave_direction[idx] ?? 0,
    wavePeriod: hourly.wave_period[idx] ?? 5,
    windWaveHeight: hourly.wind_wave_height[idx] ?? waveHeight * 0.5,
    windWaveDir: hourly.wind_wave_direction[idx] ?? (hourly.wave_direction[idx] ?? 0),
    windWavePeriod: hourly.wind_wave_period[idx] ?? (hourly.wave_period[idx] ?? 5) * 0.7,
    swellHeight: hourly.swell_wave_height[idx] ?? waveHeight * 0.5,
    swellDir: hourly.swell_wave_direction[idx] ?? (hourly.wave_direction[idx] ?? 0),
    swellPeriod: hourly.swell_wave_period[idx] ?? (hourly.wave_period[idx] ?? 5) * 1.3,
    currentSpeed: hourly.ocean_current_velocity[idx] ?? 0,
    currentDir: hourly.ocean_current_direction[idx] ?? 0,
    tideHeight: hourly.sea_level_height_msl[idx] ?? 0,
    seaTemp: hourly.sea_surface_temperature[idx] ?? 15,
  };
}

function buildSeaFromMarine(data: MarineHourlyExtract, _fallbackDirRad: number): SeaConditions {
  return {
    significantHeight: data.waveHeight,
    dominantPeriod: data.wavePeriod,
    dominantDirection: degToRad(data.waveDir),
    swell: {
      height: data.swellHeight,
      period: data.swellPeriod,
      direction: degToRad(data.swellDir),
    },
    windWave: {
      height: data.windWaveHeight,
      period: data.windWavePeriod,
      direction: degToRad(data.windWaveDir),
    },
    surfaceTemp: data.seaTemp,
    tideHeight: data.tideHeight,
  };
}

/** Find the hourly index nearest to a given epoch ms. */
function findNearestHourlyIndex(times: string[], targetMs: number): number {
  let bestIdx = 0;
  let bestDist = Infinity;

  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (t === undefined) continue;
    const dist = Math.abs(parseIsoTime(t) - targetMs);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }

  return bestIdx;
}

// ─── Main normalization entry point ────────────────────────────────────────────

export interface NormalizeOptions {
  venueId: string;
  /** Fetch length for wind-wave synthesis on inland lakes. */
  fetchMetres: number;
}

/**
 * Normalize raw forecast + marine responses into a WeatherSnapshot.
 *
 * The marine response may be null (inland lake) — in that case, sea state is
 * synthesized from the wind using the venue's fetch length.
 */
export function normalizeWeather(
  forecast: RawForecastResponse,
  marine: RawMarineResponse | null,
  options: NormalizeOptions,
): WeatherSnapshot {
  const { venueId, fetchMetres } = options;
  const current = forecast.current;
  const marineCurrent = marine !== null ? marine.current : undefined;

  // Determine if we have real marine data
  const hasMarine = marine !== null && marineCurrent !== undefined && marineCurrent.wave_height !== null;

  // Base time for offset calculation
  const baseTimeMs = parseIsoTime(current.time);

  // Current wind — convert knots to m/s, degrees to radians
  const windSpeedMs = knotsToMs(current.wind_speed_10m);
  const windDirRad = degToRad(current.wind_direction_10m);
  const gustMs = knotsToMs(current.wind_gusts_10m);

  // Air
  const tempC = current.temperature_2m;
  const pressurePa = hPaToPa(current.pressure_msl);
  const density = computeAirDensity(pressurePa, tempC);

  // Sea temp for stability calculation
  const seaTemp = hasMarine && marineCurrent !== undefined && marineCurrent.sea_surface_temperature !== null
    ? marineCurrent.sea_surface_temperature
    : 15;

  const stability = computeStability(windSpeedMs, gustMs, tempC, seaTemp);

  // Sea conditions
  const sea: SeaConditions = hasMarine && marineCurrent !== undefined
    ? {
      significantHeight: marineCurrent.wave_height ?? 0.5,
      dominantPeriod: marineCurrent.wave_period ?? 5,
      dominantDirection: degToRad(marineCurrent.wave_direction ?? 0),
      swell: {
        height: marineCurrent.swell_wave_height ?? 0,
        period: marineCurrent.swell_wave_period ?? 0,
        direction: degToRad(marineCurrent.swell_wave_direction ?? 0),
      },
      windWave: {
        height: marineCurrent.wind_wave_height ?? 0,
        period: marineCurrent.wind_wave_period ?? 0,
        direction: degToRad(marineCurrent.wind_wave_direction ?? 0),
      },
      surfaceTemp: seaTemp,
      tideHeight: marineCurrent.sea_level_height_msl ?? 0,
    }
    : synthesizeSeaFromWind(windSpeedMs, windDirRad, fetchMetres);

  // Current — direction is TOWARDS (as returned by the API, which matches our convention)
  const currentConditions: CurrentConditions = hasMarine && marineCurrent !== undefined
    ? {
      speed: (marineCurrent.ocean_current_velocity ?? 0),
      direction: degToRad(marineCurrent.ocean_current_direction ?? 0),
    }
    : { speed: 0, direction: 0 };

  // Sky
  const sky: SkyConditions = {
    cloudLow: current.cloud_cover / 100,
    cloudMid: 0, // current block only has total cloud_cover
    cloudHigh: 0,
    visibility: current.visibility,
    precipitation: current.precipitation,
    wmoCode: current.weather_code,
    solarRadiation: 0, // not in current block
    isDay: current.is_day === 1,
  };

  // Build timeline
  const timeline = buildTimeline(forecast, marine, baseTimeMs, fetchMetres, hasMarine);

  return {
    fetchedAt: Date.now(),
    source: 'live',
    venueId,
    localTime: {
      iso: current.time,
      utcOffsetSeconds: forecast.utc_offset_seconds,
    },
    wind: {
      trueSpeed: windSpeedMs,
      trueDirection: windDirRad,
      gustCeiling: gustMs,
      stability,
    },
    sea,
    current: currentConditions,
    sky,
    air: {
      temperature: tempC,
      pressure: pressurePa,
      density,
    },
    timeline,
    attribution: [
      'Weather data by Open-Meteo (https://open-meteo.com/)',
      'Data source: DWD (Deutscher Wetterdienst)',
    ],
  };
}
