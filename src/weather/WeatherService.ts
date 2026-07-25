/**
 * WeatherService implementation.
 *
 * Owns the current WeatherSnapshot and exposes `sampleAt(sessionTime)` for the
 * rest of the engine. Handles time compression (1×–60×, default 8×) so an hour
 * of forecast evolution plays out in a race-length session.
 *
 * This is the single entry point for all weather consumers. It does NOT perform
 * fetching or caching — that is the cache/fallback layer's job. This service
 * receives snapshots and serves interpolated conditions.
 */

import type { WeatherSnapshot, WeatherKeyframe, SessionTime, WeatherService } from '@/types';
import { clamp } from '@core/math';
import { sampleTimeline, waveLagFromFetch } from './interpolate';
import type { InterpolationConfig } from './interpolate';

const MIN_COMPRESSION = 1;
const MAX_COMPRESSION = 60;
const DEFAULT_COMPRESSION = 8;

/**
 * Concrete implementation of the WeatherService interface.
 *
 * Construct with a snapshot and venue fetch length. Call `updateSnapshot()` when
 * new data arrives from the cache/fallback layer (e.g., after a background refresh).
 */
export class WeatherServiceImpl implements WeatherService {
  private _snapshot: WeatherSnapshot;
  private _timeCompression: number;
  private _config: InterpolationConfig;

  constructor(snapshot: WeatherSnapshot, fetchMetres: number) {
    this._snapshot = snapshot;
    this._timeCompression = DEFAULT_COMPRESSION;
    this._config = {
      waveLagSeconds: waveLagFromFetch(fetchMetres),
      timeCompression: this._timeCompression,
    };
  }

  get snapshot(): WeatherSnapshot {
    return this._snapshot;
  }

  get timeCompression(): number {
    return this._timeCompression;
  }

  set timeCompression(value: number) {
    this._timeCompression = clamp(value, MIN_COMPRESSION, MAX_COMPRESSION);
    this._config = { ...this._config, timeCompression: this._timeCompression };
  }

  /**
   * Update the active snapshot (e.g., when a stale-while-revalidate refresh completes).
   * The interpolation config is preserved — only the data changes.
   */
  updateSnapshot(snapshot: WeatherSnapshot): void {
    this._snapshot = snapshot;
  }

  /**
   * Interpolated weather at the given session time.
   * Session time is advanced by the session clock and scaled by timeCompression
   * to produce the forecast offset.
   */
  sampleAt(time: SessionTime): WeatherKeyframe {
    const timeline = this._snapshot.timeline;
    if (timeline.length === 0) {
      // No timeline — return the snapshot's current conditions as a static keyframe
      return {
        offset: 0,
        wind: this._snapshot.wind,
        sea: this._snapshot.sea,
        current: this._snapshot.current,
        sky: this._snapshot.sky,
        air: this._snapshot.air,
      };
    }

    return sampleTimeline(timeline, time, this._config);
  }
}
