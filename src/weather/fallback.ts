/**
 * Weather fallback ladder.
 *
 * The exact sequence, per design.md §4.4:
 *   1. memory cache (session)
 *   2. IndexedDB cache (fresh, < 15 min)
 *   3. network (fetch from Open-Meteo)
 *   4. IndexedDB cache (stale, any age)
 *   5. bundled per-venue seasonal climatology
 *   6. hard default: 12 kt onshore, 0.4 m chop
 *
 * The resulting `source` field is surfaced in the HUD so the player always
 * knows which tier produced their conditions.
 */

import type { WeatherSnapshot } from '@/types';
import type { VenueDefinition } from '@/types';
import type { RawForecastResponse } from './providers/OpenMeteoForecast';
import type { RawMarineResponse } from './providers/OpenMeteoMarine';
import {
  buildCacheKey,
  getMemoryCached,
  putMemoryCached,
  getCached,
  putCached,
  isThrottled,
  recordFetch,
} from './cache';
import { buildClimatologySnapshot, buildHardDefault } from './providers/ClimatologyProvider';
import { normalizeWeather } from './normalize';
import type { NormalizeOptions } from './normalize';

// ─── Types ─────────────────────────────────────────────────────────────────────

/** The function that performs the actual network fetch. Injected for testability. */
export interface FetchWeatherFn {
  (lat: number, lon: number): Promise<{
    forecast: RawForecastResponse;
    marine: RawMarineResponse | null;
  }>;
}

export interface FallbackOptions {
  venue: VenueDefinition;
  /** Injected fetch function — allows the worker or tests to provide their own. */
  fetchFn: FetchWeatherFn;
}

// ─── Fallback ladder ───────────────────────────────────────────────────────────

/**
 * Execute the full fallback ladder and return a WeatherSnapshot.
 * Always returns a usable snapshot — never throws.
 */
export async function resolveWeather(options: FallbackOptions): Promise<WeatherSnapshot> {
  const { venue, fetchFn } = options;
  const { latitude, longitude } = venue.coordinates;
  const cacheKey = buildCacheKey(venue.id, latitude, longitude);
  const normalizeOpts: NormalizeOptions = {
    venueId: venue.id,
    fetchMetres: venue.windProfile.fetch,
  };

  // 1. Memory cache (session-scoped, instant)
  const memResult = getMemoryCached(cacheKey);
  if (memResult.snapshot !== null && memResult.fresh) {
    return memResult.snapshot;
  }

  // 2. IndexedDB cache (fresh)
  const idbResult = await getCached(cacheKey);
  if (idbResult.snapshot !== null && idbResult.fresh) {
    // Also populate memory cache for next time
    putMemoryCached(cacheKey, idbResult.snapshot);
    return idbResult.snapshot;
  }

  // 3. Network — but respect throttle
  if (!isThrottled(venue.id)) {
    try {
      const { forecast, marine } = await fetchFn(latitude, longitude);
      const snapshot = normalizeWeather(forecast, marine, normalizeOpts);
      snapshot.source = 'live';

      // Persist to both caches
      putMemoryCached(cacheKey, snapshot);
      await putCached(cacheKey, snapshot);
      recordFetch(venue.id);

      return snapshot;
    } catch {
      // Network failed — continue down the ladder
    }
  }

  // 4. IndexedDB cache (stale, any age)
  if (idbResult.snapshot !== null) {
    // Mark as cache-sourced
    const staleSnapshot: WeatherSnapshot = { ...idbResult.snapshot, source: 'cache' };
    putMemoryCached(cacheKey, staleSnapshot);

    // Trigger background refresh (fire and forget)
    void backgroundRefresh(venue, fetchFn, cacheKey, normalizeOpts);

    return staleSnapshot;
  }

  // Memory cache stale entry (not fresh but exists)
  if (memResult.snapshot !== null) {
    const staleSnapshot: WeatherSnapshot = { ...memResult.snapshot, source: 'cache' };

    void backgroundRefresh(venue, fetchFn, cacheKey, normalizeOpts);

    return staleSnapshot;
  }

  // 5. Climatology
  const climatologySnapshot = buildClimatologySnapshot(venue);
  putMemoryCached(cacheKey, climatologySnapshot);
  return climatologySnapshot;

  // 6. Hard default is handled inside buildClimatologySnapshot if climatology data
  // is empty. But as a final guard:
}

/**
 * Background refresh — triggered by stale-while-revalidate.
 * Silently fetches, normalizes, and updates both caches.
 */
async function backgroundRefresh(
  venue: VenueDefinition,
  fetchFn: FetchWeatherFn,
  cacheKey: string,
  normalizeOpts: NormalizeOptions,
): Promise<void> {
  if (isThrottled(venue.id)) return;

  try {
    const { latitude, longitude } = venue.coordinates;
    const { forecast, marine } = await fetchFn(latitude, longitude);
    const snapshot = normalizeWeather(forecast, marine, normalizeOpts);
    snapshot.source = 'live';

    putMemoryCached(cacheKey, snapshot);
    await putCached(cacheKey, snapshot);
    recordFetch(venue.id);
  } catch {
    // Background refresh is best-effort — failure is silent
  }
}

/**
 * Simplified fallback that skips the network (for offline/testing scenarios).
 * Goes: memory → IDB → climatology → hard default.
 */
export function resolveOffline(venue: VenueDefinition): WeatherSnapshot {
  const { latitude, longitude } = venue.coordinates;
  const cacheKey = buildCacheKey(venue.id, latitude, longitude);

  const memResult = getMemoryCached(cacheKey);
  if (memResult.snapshot !== null) {
    return memResult.snapshot;
  }

  // Can't do async IDB in a sync function, so go straight to climatology
  if (venue.climatology.length > 0) {
    return buildClimatologySnapshot(venue);
  }

  return buildHardDefault(venue.id);
}
