/**
 * Weather Web Worker.
 *
 * All fetch, parse, and normalize work runs off the main thread so it never
 * touches the frame budget. The main thread posts a request; the worker
 * fetches, normalizes, and posts back a WeatherSnapshot.
 *
 * Message protocol:
 *   Main → Worker: { type: 'fetch', venueId, lat, lon, fetchMetres }
 *   Worker → Main: { type: 'result', snapshot } | { type: 'error', message }
 */

import { fetchForecast } from './providers/OpenMeteoForecast';
import { fetchMarine, hasMarineData } from './providers/OpenMeteoMarine';
import { normalizeWeather } from './normalize';
import type { NormalizeOptions } from './normalize';

export interface WeatherWorkerRequest {
  type: 'fetch';
  venueId: string;
  lat: number;
  lon: number;
  fetchMetres: number;
}

export interface WeatherWorkerResult {
  type: 'result';
  snapshot: unknown; // Serialized WeatherSnapshot
}

export interface WeatherWorkerError {
  type: 'error';
  message: string;
}

export type WeatherWorkerMessage = WeatherWorkerResult | WeatherWorkerError;

// Worker entry point
const ctx = globalThis as unknown as Worker;

ctx.addEventListener('message', (event: MessageEvent<WeatherWorkerRequest>) => {
  const { type, venueId, lat, lon, fetchMetres } = event.data;

  if (type !== 'fetch') return;

  void handleFetch(venueId, lat, lon, fetchMetres);
});

async function handleFetch(
  venueId: string,
  lat: number,
  lon: number,
  fetchMetres: number,
): Promise<void> {
  try {
    // Fetch both endpoints in parallel
    const [forecastResults, marineResults] = await Promise.all([
      fetchForecast([lat], [lon]),
      fetchMarine([lat], [lon]).catch(() => [null]),
    ]);

    const forecast = forecastResults[0];
    if (forecast === undefined) {
      ctx.postMessage({ type: 'error', message: 'No forecast data returned' } satisfies WeatherWorkerError);
      return;
    }

    const marine = marineResults[0] ?? null;
    const hasMarine = hasMarineData(marine);

    const options: NormalizeOptions = { venueId, fetchMetres };
    const snapshot = normalizeWeather(forecast, hasMarine ? marine : null, options);

    ctx.postMessage({ type: 'result', snapshot } satisfies WeatherWorkerResult);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown worker error';
    ctx.postMessage({ type: 'error', message } satisfies WeatherWorkerError);
  }
}
