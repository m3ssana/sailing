/**
 * Environment contracts — wind, waves, current, tide and sky as sampleable fields.
 *
 * FROZEN CONTRACT — see docs/interfaces.md.
 *
 * These are the single source of truth for conditions. Physics, AI, rendering
 * and audio all sample the *same* field objects, which is what keeps the visible
 * world and the simulated world in agreement (design.md §5, §6).
 */

import type { Metres, MetresPerSecond, Radians, Seed, SessionTime, Vec2, Vec3 } from './units';
import type { WeatherSnapshot } from './weather';

/** Wind at a point in space and time. */
export interface WindSample {
  /** Velocity vector in world space. Points in the direction the air moves. */
  velocity: Vec3;
  /** Scalar speed, equal to |velocity|. */
  speed: MetresPerSecond;
  /** Meteorological direction the wind blows FROM. */
  direction: Radians;
  /**
   * Local gust intensity relative to the mean, where 1 = mean wind.
   * Above 1 in a puff, below 1 in a lull.
   */
  gustFactor: number;
}

/**
 * The layered wind field (design.md §5): base forecast, oscillation, travelling
 * gusts, terrain influence, and vertical shear.
 *
 * Deterministic in `(seed, snapshot)` — required for replay and leaderboard
 * reproducibility (requirement 3.7).
 */
export interface WindField {
  /**
   * Sample the wind.
   * @param x World east coordinate, metres.
   * @param z World south coordinate, metres.
   * @param height Height above mean water level, metres. Drives vertical shear.
   * @param t Session time, seconds.
   */
  sample(x: number, z: number, height: number, t: SessionTime): WindSample;

  /**
   * Fill a pre-allocated grid with gust factors, for the water-surface gust
   * visualization. Writes `resolution * resolution` floats in row-major order.
   * Allocation-free by contract — the caller owns the buffer.
   */
  sampleGustGridInto(
    target: Float32Array,
    origin: Vec2,
    cellSize: number,
    resolution: number,
    t: SessionTime,
  ): void;

  /** Mean wind direction at this instant, ignoring local variation. */
  meanDirection(t: SessionTime): Radians;
  /** Mean wind speed at this instant, ignoring local variation. */
  meanSpeed(t: SessionTime): MetresPerSecond;
}

/**
 * Parameters defining the wave spectrum. Owned by one object and used to derive
 * BOTH the GPU cascades and the CPU sampler, which is what guarantees the boat
 * sits in the waves you can see (requirement 4.12, design.md §6.2).
 */
export interface WaveSpectrumParams {
  /** Wind speed driving the wind-sea component. */
  windSpeed: MetresPerSecond;
  /** Direction the wind sea travels FROM. */
  windDirection: Radians;
  /** Fetch length, metres. Limits wave development — critical for lake venues. */
  fetch: Metres;
  /** Target significant height from the marine API, used to calibrate the spectrum. */
  significantHeight: Metres;
  /** Swell superposed on the wind sea. */
  swellHeight: Metres;
  swellPeriod: number;
  swellDirection: Radians;
  /** JONSWAP peak enhancement factor. 3.3 is the standard value. */
  peakEnhancement: number;
  /** Directional spreading exponent. Higher is more directional. */
  directionalSpread: number;
  /** Water depth, metres. Drives shoaling in shallow water. */
  depth: Metres;
  /** Current vector, for wave-current steepening (design.md §6.3). */
  currentVelocity: Vec2;
  seed: Seed;
}

/** One discrete wave component in the truncated CPU reconstruction. */
export interface WaveComponent {
  /** Amplitude, metres. */
  amplitude: number;
  /** Wavenumber magnitude, rad/m. */
  wavenumber: number;
  /** Direction of travel as a unit vector on the ground plane. */
  direction: Vec2;
  /** Angular frequency, rad/s. */
  frequency: number;
  /** Phase offset, radians. Seeded, so it is reproducible. */
  phase: number;
  /** Steepness for Gerstner horizontal displacement, 0..1. */
  steepness: number;
}

/**
 * The wave surface, as sampled by physics.
 *
 * Implemented on the CPU by a truncated Gerstner reconstruction of the same
 * spectrum the GPU renders, agreeing to within 5 cm (requirement 4.12).
 */
export interface WaveField {
  /** Surface elevation above mean water level at a horizontal position. */
  height(x: number, z: number, t: SessionTime): Metres;
  /** Full displacement including horizontal Gerstner motion. */
  displacement(x: number, z: number, t: SessionTime, out?: Vec3): Vec3;
  /** Surface normal. */
  normal(x: number, z: number, t: SessionTime, out?: Vec3): Vec3;
  /**
   * Orbital water velocity at a point, decaying with depth below the surface.
   * Drives wave drag and surfing acceleration.
   */
  orbitalVelocity(x: number, z: number, y: number, t: SessionTime, out?: Vec3): Vec3;
  /** The components used, exposed so the renderer can mirror them exactly. */
  readonly components: readonly WaveComponent[];
  /** The parameters this field was built from. */
  readonly params: WaveSpectrumParams;
}

/** Tidal and ocean current, which may vary across the venue. */
export interface CurrentField {
  /** Current velocity on the ground plane at a position and time. */
  sample(x: number, z: number, t: SessionTime, out?: Vec2): Vec2;
  /** Tidal height relative to mean sea level, which shifts the waterline. */
  tideHeight(t: SessionTime): Metres;
}

/** Sun, moon and cloud state, derived from real coordinates and local time. */
export interface SkyState {
  /** Sun direction as a unit vector pointing from the scene towards the sun. */
  sunDirection: Vec3;
  /** Sun elevation above the horizon. Negative at night. */
  sunElevation: Radians;
  /** Sun azimuth, clockwise from true north. */
  sunAzimuth: Radians;
  /** Moon direction as a unit vector. */
  moonDirection: Vec3;
  moonElevation: Radians;
  /** Illuminated fraction of the moon, 0 (new) .. 1 (full). */
  moonPhase: number;
  /** Local apparent sidereal time, radians — orients the star field. */
  siderealTime: Radians;
  /** Cloud cover fractions, 0..1. */
  cloudLow: number;
  cloudMid: number;
  cloudHigh: number;
  /** True when the sun is below the horizon and night rendering applies. */
  isNight: boolean;
}

/**
 * The complete environment for a session. Constructed once per venue entry from
 * a weather snapshot, then sampled every frame.
 */
export interface Environment {
  readonly wind: WindField;
  readonly waves: WaveField;
  readonly current: CurrentField;
  /** Sky state at a given session time. */
  skyAt(t: SessionTime): SkyState;
  /** Water depth below mean water level at a position. Positive downward. */
  depthAt(x: number, z: number): Metres;
  /** True when the position is over land. */
  isLand(x: number, z: number): boolean;
  /** Water density — differs for lake venues. */
  readonly waterDensity: number;
  /** The snapshot this environment was built from. */
  readonly snapshot: WeatherSnapshot;
}
