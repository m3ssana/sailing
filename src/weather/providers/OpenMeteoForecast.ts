/**
 * Open-Meteo atmospheric forecast provider.
 *
 * Fetches wind, temperature, pressure, cloud, and visibility data from the
 * keyless public Open-Meteo API. Handles single-coordinate responses (object)
 * and multi-coordinate batch responses (array) transparently.
 *
 * 5s timeout, 2 retries with exponential backoff, Open-Meteo error shape
 * detection. NO API key.
 */

/** Shape of the raw current block from Open-Meteo forecast. */
export interface RawForecastCurrent {
  time: string;
  interval: number;
  wind_speed_10m: number;
  wind_direction_10m: number;
  wind_gusts_10m: number;
  temperature_2m: number;
  pressure_msl: number;
  cloud_cover: number;
  visibility: number;
  precipitation: number;
  weather_code: number;
  is_day: number;
}

/** Shape of the raw minutely_15 block. */
export interface RawForecastMinutely15 {
  time: string[];
  wind_speed_10m: (number | null)[];
  wind_direction_10m: (number | null)[];
  wind_gusts_10m: (number | null)[];
}

/** Shape of the raw hourly block. */
export interface RawForecastHourly {
  time: string[];
  wind_speed_10m: (number | null)[];
  wind_direction_10m: (number | null)[];
  wind_gusts_10m: (number | null)[];
  temperature_2m: (number | null)[];
  pressure_msl: (number | null)[];
  cloud_cover_low: (number | null)[];
  cloud_cover_mid: (number | null)[];
  cloud_cover_high: (number | null)[];
  visibility: (number | null)[];
  precipitation: (number | null)[];
  weather_code: (number | null)[];
  shortwave_radiation: (number | null)[];
}

/** A single-coordinate forecast response. */
export interface RawForecastResponse {
  latitude: number;
  longitude: number;
  generationtime_ms: number;
  utc_offset_seconds: number;
  timezone: string;
  timezone_abbreviation: string;
  elevation: number;
  current_units: Record<string, string>;
  current: RawForecastCurrent;
  minutely_15_units?: Record<string, string>;
  minutely_15?: RawForecastMinutely15;
  hourly_units: Record<string, string>;
  hourly: RawForecastHourly;
}

/** Error shape returned by Open-Meteo on HTTP 400. */
export interface OpenMeteoError {
  error: true;
  reason: string;
}

const BASE_URL = 'https://api.open-meteo.com/v1/forecast';
const TIMEOUT_MS = 5000;
const MAX_RETRIES = 2;

/** Builds the forecast query string. Accepts arrays for multi-coordinate batching. */
function buildForecastUrl(latitudes: number[], longitudes: number[]): string {
  const lat = latitudes.join(',');
  const lon = longitudes.join(',');

  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    current: [
      'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
      'temperature_2m', 'pressure_msl', 'cloud_cover', 'visibility',
      'precipitation', 'weather_code', 'is_day',
    ].join(','),
    minutely_15: [
      'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
    ].join(','),
    hourly: [
      'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
      'temperature_2m', 'pressure_msl', 'cloud_cover_low', 'cloud_cover_mid',
      'cloud_cover_high', 'visibility', 'precipitation', 'weather_code',
      'shortwave_radiation',
    ].join(','),
    wind_speed_unit: 'kn',
    timezone: 'auto',
    past_hours: '1',
    forecast_hours: '12',
  });

  return `${BASE_URL}?${params.toString()}`;
}

/** Detects Open-Meteo error objects. */
function isOpenMeteoError(data: unknown): data is OpenMeteoError {
  return (
    typeof data === 'object' &&
    data !== null &&
    'error' in data &&
    (data as Record<string, unknown>)['error'] === true
  );
}

/**
 * Fetches with timeout and exponential backoff retries.
 * Throws on unrecoverable errors; returns parsed JSON on success.
 */
async function fetchWithRetry(url: string): Promise<unknown> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 500ms, 1500ms
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
          `Open-Meteo error: ${(data).reason}`,
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
        // API errors won't resolve with retries
        throw err;
      }

      lastError = err;
    }
  }

  const msg = lastError instanceof Error ? lastError.message : 'Unknown fetch error';
  throw new OpenMeteoFetchError(`Forecast fetch failed after ${MAX_RETRIES + 1} attempts: ${msg}`, 'network_error');
}

export class OpenMeteoFetchError extends Error {
  readonly kind: 'network_error' | 'api_error' | 'http_error';
  constructor(message: string, kind: 'network_error' | 'api_error' | 'http_error') {
    super(message);
    this.name = 'OpenMeteoFetchError';
    this.kind = kind;
  }
}

/**
 * Fetch forecast data for one or more coordinates.
 * Returns an array of responses even for a single coordinate (normalized).
 */
export async function fetchForecast(
  latitudes: number[],
  longitudes: number[],
): Promise<RawForecastResponse[]> {
  const url = buildForecastUrl(latitudes, longitudes);
  const data = await fetchWithRetry(url);

  // Multi-coordinate: Open-Meteo returns a JSON array
  if (Array.isArray(data)) {
    return data as RawForecastResponse[];
  }

  // Single-coordinate: wrap in array
  return [data as RawForecastResponse];
}
