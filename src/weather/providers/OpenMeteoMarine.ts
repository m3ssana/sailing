/**
 * Open-Meteo marine forecast provider.
 *
 * Fetches wave, swell, current, and sea surface data. Same resilience pattern
 * as the forecast provider: 5s timeout, 2 retries, exponential backoff.
 *
 * Critical: For inland-lake venues (e.g., Chicago/Lake Michigan) the marine API
 * may return null for all sea fields. The normalize layer synthesizes sea state
 * from wind speed and fetch length in that case — this provider just fetches.
 */

import { OpenMeteoFetchError } from './OpenMeteoForecast';

/** Shape of the raw marine current block. */
export interface RawMarineCurrent {
  time: string;
  interval: number;
  wave_height: number | null;
  wave_direction: number | null;
  wave_period: number | null;
  wind_wave_height: number | null;
  wind_wave_direction: number | null;
  wind_wave_period: number | null;
  swell_wave_height: number | null;
  swell_wave_direction: number | null;
  swell_wave_period: number | null;
  ocean_current_velocity: number | null;
  ocean_current_direction: number | null;
  sea_level_height_msl: number | null;
  sea_surface_temperature: number | null;
}

/** Shape of the raw marine hourly block. */
export interface RawMarineHourly {
  time: string[];
  wave_height: (number | null)[];
  wave_direction: (number | null)[];
  wave_period: (number | null)[];
  wind_wave_height: (number | null)[];
  wind_wave_direction: (number | null)[];
  wind_wave_period: (number | null)[];
  swell_wave_height: (number | null)[];
  swell_wave_direction: (number | null)[];
  swell_wave_period: (number | null)[];
  ocean_current_velocity: (number | null)[];
  ocean_current_direction: (number | null)[];
  sea_level_height_msl: (number | null)[];
  sea_surface_temperature: (number | null)[];
}

/** A single-coordinate marine response. */
export interface RawMarineResponse {
  latitude: number;
  longitude: number;
  generationtime_ms: number;
  utc_offset_seconds: number;
  timezone: string;
  timezone_abbreviation: string;
  current_units?: Record<string, string>;
  current?: RawMarineCurrent;
  hourly_units?: Record<string, string>;
  hourly?: RawMarineHourly;
}

/** Error shape (same as forecast). */
interface OpenMeteoError {
  error: true;
  reason: string;
}

const BASE_URL = 'https://marine-api.open-meteo.com/v1/marine';
const TIMEOUT_MS = 5000;
const MAX_RETRIES = 2;

/** Builds the marine query string. Accepts arrays for multi-coordinate batching. */
function buildMarineUrl(latitudes: number[], longitudes: number[]): string {
  const lat = latitudes.join(',');
  const lon = longitudes.join(',');

  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: [
      'wave_height', 'wave_direction', 'wave_period',
      'wind_wave_height', 'wind_wave_direction', 'wind_wave_period',
      'swell_wave_height', 'swell_wave_direction', 'swell_wave_period',
      'ocean_current_velocity', 'ocean_current_direction',
      'sea_level_height_msl', 'sea_surface_temperature',
    ].join(','),
    hourly: [
      'wave_height', 'wave_direction', 'wave_period',
      'wind_wave_height', 'wind_wave_direction', 'wind_wave_period',
      'swell_wave_height', 'swell_wave_direction', 'swell_wave_period',
      'ocean_current_velocity', 'ocean_current_direction',
      'sea_level_height_msl', 'sea_surface_temperature',
    ].join(','),
    cell_selection: 'sea',
    timezone: 'auto',
    past_hours: '1',
    forecast_hours: '12',
  });

  return `${BASE_URL}?${params.toString()}`;
}

function isOpenMeteoError(data: unknown): data is OpenMeteoError {
  return (
    typeof data === 'object' &&
    data !== null &&
    'error' in data &&
    (data as Record<string, unknown>)['error'] === true
  );
}

async function fetchWithRetry(url: string): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = 500 * Math.pow(3, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      const data: unknown = await response.json();

      if (isOpenMeteoError(data)) {
        throw new OpenMeteoFetchError(
          `Open-Meteo marine error: ${(data).reason}`,
          'api_error',
        );
      }

      if (!response.ok) {
        throw new OpenMeteoFetchError(
          `HTTP ${response.status}: ${response.statusText}`,
          'http_error',
        );
      }

      return data;
    } catch (err) {
      clearTimeout(timeoutId);

      if (err instanceof OpenMeteoFetchError && err.kind === 'api_error') {
        throw err;
      }

      lastError = err;
    }
  }

  const msg = lastError instanceof Error ? lastError.message : 'Unknown fetch error';
  throw new OpenMeteoFetchError(`Marine fetch failed after ${MAX_RETRIES + 1} attempts: ${msg}`, 'network_error');
}

/**
 * Fetch marine data for one or more coordinates.
 * Returns an array of responses even for a single coordinate (normalized).
 * Returns null for a coordinate where the marine API has no coverage (inland).
 */
export async function fetchMarine(
  latitudes: number[],
  longitudes: number[],
): Promise<(RawMarineResponse | null)[]> {
  const url = buildMarineUrl(latitudes, longitudes);

  try {
    const data = await fetchWithRetry(url);

    if (Array.isArray(data)) {
      return data as RawMarineResponse[];
    }

    return [data as RawMarineResponse];
  } catch (err) {
    // For marine data, a network failure is not fatal — the normalize layer
    // can synthesize sea state from wind. Return null for all coordinates.
    if (err instanceof OpenMeteoFetchError && err.kind === 'network_error') {
      return latitudes.map(() => null);
    }
    throw err;
  }
}

/**
 * Check whether a marine response has meaningful data or is all nulls.
 * Inland lakes produce responses where every sea field is null.
 */
export function hasMarineData(response: RawMarineResponse | null): boolean {
  if (response === null) return false;
  const current = response.current;
  if (current === undefined) return false;
  // If wave_height is null, the point has no marine coverage
  return current.wave_height !== null;
}
