/**
 * Weather contracts — the boundary between live API data and the simulation.
 *
 * FROZEN CONTRACT — see docs/interfaces.md.
 *
 * Everything here is already normalized to SI and radians. Raw Open-Meteo JSON
 * never escapes `src/weather/normalize.ts`, so no downstream system needs to
 * know which provider supplied the data or in what units.
 */

import type { EpochMs, MetresPerSecond, Metres, Radians, SessionTime } from './units';

/**
 * Where the active conditions came from. Surfaced in the HUD so a player always
 * knows whether they are sailing real weather (requirement 2.6).
 */
export type WeatherSource = 'live' | 'cache' | 'climatology' | 'default' | 'sandbox';

/** Atmospheric wind state at the 10 m reference height. */
export interface WindConditions {
  /** Sustained wind speed at 10 m. */
  trueSpeed: MetresPerSecond;
  /** Meteorological direction — the bearing the wind blows FROM. */
  trueDirection: Radians;
  /** Upper bound for gust magnitude. The gust layer never exceeds this. */
  gustCeiling: MetresPerSecond;
  /**
   * Derived atmospheric stability, 0 (very stable) .. 1 (very unstable).
   * Drives oscillation amplitude and gust sharpness. Computed in normalize.ts
   * from the gust spread and the air/sea temperature delta — never fetched.
   */
  stability: number;
}

/** A single wave train. */
export interface WaveTrain {
  /** Significant height. */
  height: Metres;
  /** Peak period. */
  period: number;
  /** Direction the waves travel FROM. */
  direction: Radians;
}

/** Sea state. */
export interface SeaConditions {
  /** Significant height of the combined sea. */
  significantHeight: Metres;
  /** Dominant period of the combined sea. */
  dominantPeriod: number;
  /** Dominant direction the combined sea comes FROM. */
  dominantDirection: Radians;
  /** Long-period swell component. */
  swell: WaveTrain;
  /** Locally generated wind wave component. */
  windWave: WaveTrain;
  /** Sea surface temperature, °C. Feeds stability and visual water colour. */
  surfaceTemp: number;
  /** Tidal height relative to mean sea level. */
  tideHeight: Metres;
}

/** Ocean or tidal current. */
export interface CurrentConditions {
  speed: MetresPerSecond;
  /** Direction the current flows TOWARDS — opposite convention to wind. */
  direction: Radians;
}

/** Sky and visibility state. */
export interface SkyConditions {
  /** Low cloud cover fraction, 0..1. */
  cloudLow: number;
  /** Mid cloud cover fraction, 0..1. */
  cloudMid: number;
  /** High cloud cover fraction, 0..1. */
  cloudHigh: number;
  /** Horizontal visibility. Drives aerial perspective density. */
  visibility: Metres;
  /** Precipitation rate, mm/h. */
  precipitation: number;
  /** WMO weather interpretation code. */
  wmoCode: number;
  /** Shortwave solar radiation, W/m². Modulates lighting intensity. */
  solarRadiation: number;
  /** True when the sun is above the horizon at the venue. */
  isDay: boolean;
}

/** Air properties. Density is computed, not assumed (see design.md §4.2). */
export interface AirConditions {
  /** Air temperature, °C. */
  temperature: number;
  /** Mean sea level pressure, Pa. */
  pressure: number;
  /** Density derived from pressure and temperature, kg/m³. */
  density: number;
}

/** One point on the forecast timeline. */
export interface WeatherKeyframe {
  /** Offset from the snapshot's base time, in seconds. May be negative (past). */
  offset: number;
  wind: WindConditions;
  sea: SeaConditions;
  current: CurrentConditions;
  sky: SkyConditions;
  air: AirConditions;
}

/**
 * A complete, normalized weather state for one venue at one moment, plus the
 * forecast timeline used to evolve conditions during play.
 *
 * Embedded verbatim into replays (requirement 6.5b), so it must stay
 * JSON-serializable and free of functions or class instances.
 */
export interface WeatherSnapshot {
  /** When this snapshot was fetched. */
  fetchedAt: EpochMs;
  /** Which fallback tier produced it. */
  source: WeatherSource;
  venueId: string;
  /** Venue-local time at `fetchedAt`. */
  localTime: {
    iso: string;
    utcOffsetSeconds: number;
  };
  wind: WindConditions;
  sea: SeaConditions;
  current: CurrentConditions;
  sky: SkyConditions;
  air: AirConditions;
  /** Ordered by `offset`, ascending. Interpolated by WeatherService.sampleAt(). */
  timeline: WeatherKeyframe[];
  /** Attribution strings required by the data providers. */
  attribution: string[];
}

/**
 * Serves normalized weather to the rest of the engine and evolves it over the
 * session.
 */
export interface WeatherService {
  /** The snapshot currently in effect. */
  readonly snapshot: WeatherSnapshot;
  /**
   * Conditions at a given session time, interpolated from the timeline.
   * Direction uses shortest-arc interpolation; speed uses Catmull-Rom; wave
   * height lags the wind (design.md §4.3).
   */
  sampleAt(time: SessionTime): WeatherKeyframe;
  /** Multiplier applied to real time. 1 = real time, 60 = one hour per minute. */
  timeCompression: number;
}

/** Monthly climatology used as the offline fallback (requirement 2.6). */
export interface MonthlyClimate {
  /** 1 = January. */
  month: number;
  meanWindSpeed: MetresPerSecond;
  /** Prevailing direction the wind blows FROM. */
  prevailingDirection: Radians;
  gustFactor: number;
  meanWaveHeight: Metres;
  meanWavePeriod: number;
  meanAirTemp: number;
  meanSeaTemp: number;
  meanCloudCover: number;
}
