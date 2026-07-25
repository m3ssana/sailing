/**
 * Weather pipeline — public API.
 *
 * Consumers should import from '@weather/' to get the service, fallback ladder,
 * and interpolation. The providers are internal implementation details.
 */

export { WeatherServiceImpl } from './WeatherService';
export { normalizeWeather } from './normalize';
export type { NormalizeOptions } from './normalize';
export { sampleTimeline, waveLagFromFetch } from './interpolate';
export type { InterpolationConfig } from './interpolate';
export { resolveWeather, resolveOffline } from './fallback';
export type { FetchWeatherFn, FallbackOptions } from './fallback';
export {
  buildCacheKey,
  getCached,
  putCached,
  clearCache,
  getMemoryCached,
  putMemoryCached,
  clearMemoryCache,
  isThrottled,
  recordFetch,
  resetThrottles,
} from './cache';
export { fetchForecast, OpenMeteoFetchError } from './providers/OpenMeteoForecast';
export { fetchMarine, hasMarineData } from './providers/OpenMeteoMarine';
export { buildClimatologySnapshot, buildHardDefault } from './providers/ClimatologyProvider';
