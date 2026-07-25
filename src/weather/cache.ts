/**
 * Weather cache — IndexedDB-backed with stale-while-revalidate.
 *
 * Key: (venueId, rounded coords to 2 decimals).
 * TTL: 15 minutes. Stale entries of any age are still usable as a fallback.
 *
 * Strategy:
 * 1. Return cached immediately if fresh (< 15 min).
 * 2. If stale, return it AND trigger a background refresh.
 * 3. Per-venue 15-minute throttle prevents redundant network calls.
 *
 * The `idb` package provides the IndexedDB wrapper (already in package.json).
 */

import type { WeatherSnapshot } from '@/types';
import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';

const DB_NAME = 'sailing-weather-cache';
const DB_VERSION = 1;
const STORE_NAME = 'snapshots';
const TTL_MS = 15 * 60 * 1000; // 15 minutes

/** Stored entry in IndexedDB. */
interface CacheEntry {
  key: string;
  snapshot: WeatherSnapshot;
  storedAt: number;
}

/**
 * Declaring the schema to `idb` is what makes `db.get()` return a typed
 * `CacheEntry | undefined` instead of `any`. Without it, every read silently
 * becomes untyped and a shape change in `CacheEntry` would fail at runtime
 * rather than at compile time.
 */
interface WeatherCacheDB extends DBSchema {
  [STORE_NAME]: {
    key: string;
    value: CacheEntry;
  };
}

/** Round coordinates to 2 decimal places for cache key stability. */
function roundCoord(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Build a cache key from venue ID and coordinates. */
export function buildCacheKey(venueId: string, lat: number, lon: number): string {
  return `${venueId}:${roundCoord(lat)}:${roundCoord(lon)}`;
}

// ─── Database initialization ───────────────────────────────────────────────────

let dbPromise: Promise<IDBPDatabase<WeatherCacheDB>> | null = null;

function getDb(): Promise<IDBPDatabase<WeatherCacheDB>> {
  if (dbPromise === null) {
    dbPromise = openDB<WeatherCacheDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      },
    });
  }
  return dbPromise;
}

// ─── Public API ────────────────────────────────────────────────────────────────

export interface CacheResult {
  snapshot: WeatherSnapshot | null;
  fresh: boolean;
}

/**
 * Retrieve a cached snapshot. Returns null if nothing is stored.
 * `fresh` indicates whether the entry is within TTL.
 */
export async function getCached(key: string): Promise<CacheResult> {
  try {
    const db = await getDb();
    const entry: CacheEntry | undefined = await db.get(STORE_NAME, key);

    if (entry === undefined) {
      return { snapshot: null, fresh: false };
    }

    const age = Date.now() - entry.storedAt;
    return {
      snapshot: entry.snapshot,
      fresh: age < TTL_MS,
    };
  } catch {
    // IndexedDB may be unavailable (private browsing, quota exceeded)
    return { snapshot: null, fresh: false };
  }
}

/**
 * Store a snapshot in the cache.
 */
export async function putCached(key: string, snapshot: WeatherSnapshot): Promise<void> {
  try {
    const db = await getDb();
    const entry: CacheEntry = {
      key,
      snapshot,
      storedAt: Date.now(),
    };
    await db.put(STORE_NAME, entry);
  } catch {
    // Silently fail — cache is a best-effort optimization
  }
}

/**
 * Remove all entries from the cache. Useful for testing or manual reset.
 */
export async function clearCache(): Promise<void> {
  try {
    const db = await getDb();
    await db.clear(STORE_NAME);
  } catch {
    // Silently fail
  }
}

// ─── In-memory session cache ───────────────────────────────────────────────────

const memoryCache = new Map<string, { snapshot: WeatherSnapshot; storedAt: number }>();

/**
 * Get from memory cache (fastest path, survives only the current session).
 */
export function getMemoryCached(key: string): CacheResult {
  const entry = memoryCache.get(key);
  if (entry === undefined) {
    return { snapshot: null, fresh: false };
  }
  const age = Date.now() - entry.storedAt;
  return {
    snapshot: entry.snapshot,
    fresh: age < TTL_MS,
  };
}

/**
 * Store in memory cache.
 */
export function putMemoryCached(key: string, snapshot: WeatherSnapshot): void {
  memoryCache.set(key, { snapshot, storedAt: Date.now() });
}

/**
 * Clear the memory cache.
 */
export function clearMemoryCache(): void {
  memoryCache.clear();
}

// ─── Throttle ──────────────────────────────────────────────────────────────────

const lastFetchTime = new Map<string, number>();

/**
 * Check whether a fetch for this venue is throttled (within the last 15 minutes).
 * Returns true if the fetch should be skipped.
 */
export function isThrottled(venueId: string): boolean {
  const last = lastFetchTime.get(venueId);
  if (last === undefined) return false;
  return Date.now() - last < TTL_MS;
}

/**
 * Record that a fetch was performed for this venue.
 */
export function recordFetch(venueId: string): void {
  lastFetchTime.set(venueId, Date.now());
}

/**
 * Reset throttle state (for testing).
 */
export function resetThrottles(): void {
  lastFetchTime.clear();
}
