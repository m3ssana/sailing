/**
 * Weather timeline interpolation.
 *
 * `sampleAt(sessionTime)` produces a WeatherKeyframe by interpolating between
 * the forecast timeline entries. The critical design choices:
 *
 * 1. Directions use circularLerp — a 350° → 10° wind shift crosses north,
 *    never swings backwards through south. This is the #1 weather-sim bug.
 *
 * 2. Speeds use Catmull-Rom — a building breeze reads as a smooth curve, not
 *    piecewise-linear kinks at each hourly keyframe.
 *
 * 3. Wave height lags behind wind — the sea builds AFTER the breeze, as it
 *    actually does. The lag constant comes from the venue's fetch length.
 *
 * Time compression (1×–60×, default 8×) maps session seconds to forecast
 * seconds, so an hour of evolution plays out in a race-length session.
 */

import type { WeatherKeyframe, WindConditions, SeaConditions, CurrentConditions, SkyConditions, AirConditions } from '@/types';
import { circularLerp, catmullRom, lerp, clamp } from '@core/math';

// ─── Bracket search ────────────────────────────────────────────────────────────

interface Bracket {
  loIdx: number;
  hiIdx: number;
  t: number;
}

/**
 * Binary search to find the two keyframes bracketing the target offset,
 * plus the interpolation parameter t.
 */
function findBracket(timeline: readonly WeatherKeyframe[], offset: number): Bracket {
  const n = timeline.length;
  if (n === 0) return { loIdx: 0, hiIdx: 0, t: 0 };
  if (n === 1) return { loIdx: 0, hiIdx: 0, t: 0 };

  const first = timeline[0];
  const last = timeline[n - 1];
  if (first === undefined || last === undefined) return { loIdx: 0, hiIdx: 0, t: 0 };

  if (offset <= first.offset) return { loIdx: 0, hiIdx: 0, t: 0 };
  if (offset >= last.offset) return { loIdx: n - 1, hiIdx: n - 1, t: 0 };

  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const midFrame = timeline[mid];
    if (midFrame === undefined) break;
    if (midFrame.offset <= offset) lo = mid;
    else hi = mid;
  }

  const loFrame = timeline[lo];
  const hiFrame = timeline[hi];
  if (loFrame === undefined || hiFrame === undefined) return { loIdx: lo, hiIdx: hi, t: 0 };

  const span = hiFrame.offset - loFrame.offset;
  const t = span > 0 ? (offset - loFrame.offset) / span : 0;

  return { loIdx: lo, hiIdx: hi, t };
}

// ─── Catmull-Rom with edge clamping ────────────────────────────────────────────

/**
 * Get the keyframe index for Catmull-Rom's 4-point stencil,
 * clamping at timeline edges.
 */
function getStencilIndices(
  loIdx: number,
  hiIdx: number,
  length: number,
): { p0: number; p1: number; p2: number; p3: number } {
  return {
    p0: Math.max(0, loIdx - 1),
    p1: loIdx,
    p2: hiIdx,
    p3: Math.min(length - 1, hiIdx + 1),
  };
}

// ─── Field interpolation ───────────────────────────────────────────────────────

function interpolateWind(
  timeline: readonly WeatherKeyframe[],
  bracket: Bracket,
): WindConditions {
  const { loIdx, hiIdx, t } = bracket;
  const n = timeline.length;
  const { p0, p1, p2, p3 } = getStencilIndices(loIdx, hiIdx, n);

  const k0 = timeline[p0];
  const k1 = timeline[p1];
  const k2 = timeline[p2];
  const k3 = timeline[p3];

  if (k0 === undefined || k1 === undefined || k2 === undefined || k3 === undefined) {
    const fallback = timeline[loIdx];
    if (fallback === undefined) {
      return { trueSpeed: 0, trueDirection: 0, gustCeiling: 0, stability: 0 };
    }
    return fallback.wind;
  }

  // Speed: Catmull-Rom for smooth buildup/die
  const trueSpeed = Math.max(0, catmullRom(
    k0.wind.trueSpeed, k1.wind.trueSpeed, k2.wind.trueSpeed, k3.wind.trueSpeed, t,
  ));

  // Direction: shortest-arc circular interpolation
  const trueDirection = circularLerp(k1.wind.trueDirection, k2.wind.trueDirection, t);

  // Gust ceiling: Catmull-Rom
  const gustCeiling = Math.max(trueSpeed, catmullRom(
    k0.wind.gustCeiling, k1.wind.gustCeiling, k2.wind.gustCeiling, k3.wind.gustCeiling, t,
  ));

  // Stability: linear lerp is fine for a derived 0..1 value
  const stability = clamp(lerp(k1.wind.stability, k2.wind.stability, t), 0, 1);

  return { trueSpeed, trueDirection, gustCeiling, stability };
}

function interpolateSea(
  timeline: readonly WeatherKeyframe[],
  _bracket: Bracket,
  waveLagSeconds: number,
  forecastOffset: number,
): SeaConditions {
  // Wave height lags the wind — sample the sea state from an earlier point
  // in the timeline. This models the physical delay as waves build.
  const laggedOffset = forecastOffset - waveLagSeconds;
  const laggedBracket = findBracket(timeline, laggedOffset);

  const { loIdx, hiIdx, t } = laggedBracket;
  const n = timeline.length;
  const { p0, p1, p2, p3 } = getStencilIndices(loIdx, hiIdx, n);

  const k0 = timeline[p0];
  const k1 = timeline[p1];
  const k2 = timeline[p2];
  const k3 = timeline[p3];

  if (k0 === undefined || k1 === undefined || k2 === undefined || k3 === undefined) {
    const fallback = timeline[loIdx];
    if (fallback === undefined) {
      return {
        significantHeight: 0.4, dominantPeriod: 4, dominantDirection: 0,
        swell: { height: 0.2, period: 6, direction: 0 },
        windWave: { height: 0.2, period: 3, direction: 0 },
        surfaceTemp: 15, tideHeight: 0,
      };
    }
    return fallback.sea;
  }

  // Heights: Catmull-Rom
  const significantHeight = Math.max(0, catmullRom(
    k0.sea.significantHeight, k1.sea.significantHeight,
    k2.sea.significantHeight, k3.sea.significantHeight, t,
  ));

  const dominantPeriod = Math.max(0.5, catmullRom(
    k0.sea.dominantPeriod, k1.sea.dominantPeriod,
    k2.sea.dominantPeriod, k3.sea.dominantPeriod, t,
  ));

  // Directions: circular
  const dominantDirection = circularLerp(k1.sea.dominantDirection, k2.sea.dominantDirection, t);

  const swellHeight = Math.max(0, catmullRom(
    k0.sea.swell.height, k1.sea.swell.height, k2.sea.swell.height, k3.sea.swell.height, t,
  ));
  const swellPeriod = Math.max(0.5, lerp(k1.sea.swell.period, k2.sea.swell.period, t));
  const swellDir = circularLerp(k1.sea.swell.direction, k2.sea.swell.direction, t);

  const windWaveHeight = Math.max(0, catmullRom(
    k0.sea.windWave.height, k1.sea.windWave.height,
    k2.sea.windWave.height, k3.sea.windWave.height, t,
  ));
  const windWavePeriod = Math.max(0.5, lerp(k1.sea.windWave.period, k2.sea.windWave.period, t));
  const windWaveDir = circularLerp(k1.sea.windWave.direction, k2.sea.windWave.direction, t);

  const surfaceTemp = lerp(k1.sea.surfaceTemp, k2.sea.surfaceTemp, t);
  const tideHeight = lerp(k1.sea.tideHeight, k2.sea.tideHeight, t);

  return {
    significantHeight, dominantPeriod, dominantDirection,
    swell: { height: swellHeight, period: swellPeriod, direction: swellDir },
    windWave: { height: windWaveHeight, period: windWavePeriod, direction: windWaveDir },
    surfaceTemp, tideHeight,
  };
}

function interpolateCurrent(
  timeline: readonly WeatherKeyframe[],
  bracket: Bracket,
): CurrentConditions {
  const { loIdx, hiIdx, t } = bracket;
  const k1 = timeline[loIdx];
  const k2 = timeline[hiIdx];

  if (k1 === undefined || k2 === undefined) {
    return { speed: 0, direction: 0 };
  }

  // Current direction is TOWARDS — still uses circular interpolation
  return {
    speed: Math.max(0, lerp(k1.current.speed, k2.current.speed, t)),
    direction: circularLerp(k1.current.direction, k2.current.direction, t),
  };
}

function interpolateSky(
  timeline: readonly WeatherKeyframe[],
  bracket: Bracket,
): SkyConditions {
  const { loIdx, hiIdx, t } = bracket;
  const k1 = timeline[loIdx];
  const k2 = timeline[hiIdx];

  if (k1 === undefined || k2 === undefined) {
    const fallback = timeline[0];
    if (fallback === undefined) {
      return {
        cloudLow: 0.3, cloudMid: 0.2, cloudHigh: 0.1,
        visibility: 20000, precipitation: 0, wmoCode: 0,
        solarRadiation: 500, isDay: true,
      };
    }
    return fallback.sky;
  }

  return {
    cloudLow: lerp(k1.sky.cloudLow, k2.sky.cloudLow, t),
    cloudMid: lerp(k1.sky.cloudMid, k2.sky.cloudMid, t),
    cloudHigh: lerp(k1.sky.cloudHigh, k2.sky.cloudHigh, t),
    visibility: lerp(k1.sky.visibility, k2.sky.visibility, t),
    precipitation: lerp(k1.sky.precipitation, k2.sky.precipitation, t),
    wmoCode: t < 0.5 ? k1.sky.wmoCode : k2.sky.wmoCode,
    solarRadiation: lerp(k1.sky.solarRadiation, k2.sky.solarRadiation, t),
    isDay: t < 0.5 ? k1.sky.isDay : k2.sky.isDay,
  };
}

function interpolateAir(
  timeline: readonly WeatherKeyframe[],
  bracket: Bracket,
): AirConditions {
  const { loIdx, hiIdx, t } = bracket;
  const k1 = timeline[loIdx];
  const k2 = timeline[hiIdx];

  if (k1 === undefined || k2 === undefined) {
    const fallback = timeline[0];
    if (fallback === undefined) {
      return { temperature: 15, pressure: 101325, density: 1.225 };
    }
    return fallback.air;
  }

  return {
    temperature: lerp(k1.air.temperature, k2.air.temperature, t),
    pressure: lerp(k1.air.pressure, k2.air.pressure, t),
    density: lerp(k1.air.density, k2.air.density, t),
  };
}

// ─── Public API ────────────────────────────────────────────────────────────────

export interface InterpolationConfig {
  /**
   * Wave lag in seconds — how long it takes the sea to respond to wind changes.
   * Derived from venue fetch length: longer fetch → longer lag.
   * Typical range: 300s (short lake fetch) to 1800s (open ocean).
   */
  waveLagSeconds: number;
  /** Time compression factor. Session seconds × this = forecast seconds. */
  timeCompression: number;
}

/**
 * Sample the weather timeline at a given session time.
 *
 * Session time is multiplied by timeCompression to get the forecast offset.
 * This means a session running at 8× plays through an hour of forecast in
 * 7.5 minutes, which is a typical race duration.
 */
export function sampleTimeline(
  timeline: readonly WeatherKeyframe[],
  sessionTime: number,
  config: InterpolationConfig,
): WeatherKeyframe {
  const forecastOffset = sessionTime * config.timeCompression;
  const bracket = findBracket(timeline, forecastOffset);

  return {
    offset: forecastOffset,
    wind: interpolateWind(timeline, bracket),
    sea: interpolateSea(timeline, bracket, config.waveLagSeconds, forecastOffset),
    current: interpolateCurrent(timeline, bracket),
    sky: interpolateSky(timeline, bracket),
    air: interpolateAir(timeline, bracket),
  };
}

/**
 * Compute a wave lag constant from fetch length.
 * Empirical: ~1 minute per km of fetch, capped at 30 minutes.
 */
export function waveLagFromFetch(fetchMetres: number): number {
  // 60 seconds per 1000m of fetch, clamped [120, 1800]
  return clamp(fetchMetres * 0.06, 120, 1800);
}
