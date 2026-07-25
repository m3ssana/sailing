/**
 * Base wind layer: forecast speed and direction from the weather service,
 * uniform in space. This is the "DC component" that all other layers modulate.
 */

import type { MetresPerSecond, Radians, SessionTime } from '@/types';
import type { WeatherKeyframe, WeatherService } from '@/types';

export interface BaseWindSample {
  speed: MetresPerSecond;
  direction: Radians;
  gustCeiling: MetresPerSecond;
  stability: number;
  airDensity: number;
}

/**
 * Samples the forecast at a given session time. The result is spatially uniform;
 * spatial variation comes from the gust and terrain layers above.
 */
export function sampleBaseWind(
  weatherService: WeatherService,
  t: SessionTime,
  out: BaseWindSample,
): BaseWindSample {
  const kf: WeatherKeyframe = weatherService.sampleAt(t);
  out.speed = kf.wind.trueSpeed;
  out.direction = kf.wind.trueDirection;
  out.gustCeiling = kf.wind.gustCeiling;
  out.stability = kf.wind.stability;
  out.airDensity = kf.air.density;
  return out;
}

export function createBaseWindSample(): BaseWindSample {
  return { speed: 0, direction: 0, gustCeiling: 0, stability: 0, airDensity: 1.225 };
}
