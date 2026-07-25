/**
 * Shared scalar and vector types, plus the unit conventions every layer obeys.
 *
 * FROZEN CONTRACT — see docs/interfaces.md. Do not change without coordinating
 * across workstreams.
 *
 * ## Unit conventions (non-negotiable)
 *
 * All *internal* values are SI. Conversion to display units (knots, nautical
 * miles) happens only in the UI layer. This prevents the classic simulator bug
 * where a unit conversion leaks into a force calculation.
 *
 * - distance: metres
 * - speed: metres per second
 * - angle: **radians** internally; degrees only at API and UI boundaries
 * - mass: kilograms
 * - force: newtons
 * - moment: newton-metres
 * - time: seconds
 * - density: kg/m³
 * - pressure: pascals
 *
 * ## Direction conventions (a frequent source of sign errors)
 *
 * - `windDirection` is **meteorological**: the compass bearing the wind blows
 *   *from*. 270° is a westerly.
 * - `waveDirection` follows the same "from" convention (matching the marine API).
 * - `currentDirection` is the direction the current flows **towards** (also
 *   matching the marine API). The asymmetry is inherited from the data source,
 *   so it is named explicitly everywhere rather than assumed.
 * - `heading` is the boat's bow bearing, clockwise from true north.
 *
 * ## World space
 *
 * Right-handed, Y-up, metres. +X is east, +Z is **south**, so that a compass
 * bearing θ maps to the horizontal direction `(sin θ, 0, -cos θ)`.
 */

/** A 2D vector in world space (x = east, y = south when used as a ground plane). */
export interface Vec2 {
  x: number;
  y: number;
}

/** A 3D vector in world space. Y is up. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** A unit quaternion. */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Linear RGB in the 0..1 range. Never sRGB — the render layer handles encoding. */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

/** A point on a monotonic lookup curve, used for coefficient and response tables. */
export interface CurvePoint {
  /** Independent variable (angle in radians, Froude number, speed, …). */
  x: number;
  /** Dependent value. */
  y: number;
}

/** Seconds since the session began, advanced by the session clock. */
export type SessionTime = number;

/** Milliseconds since the Unix epoch. */
export type EpochMs = number;

/** A branded 32-bit seed. Any system consuming it must be deterministic in it. */
export type Seed = number;

/** Angle in radians. */
export type Radians = number;

/** Angle in degrees. Only appears at API and UI boundaries. */
export type Degrees = number;

/** Metres. */
export type Metres = number;

/** Metres per second. */
export type MetresPerSecond = number;

/** Metres in a nautical mile — the international definition, exact. */
const METRES_PER_NAUTICAL_MILE = 1852;
/** Seconds in an hour. */
const SECONDS_PER_HOUR = 3600;

/**
 * Unit conversion constants. Display-layer use only.
 *
 * Derived from the definition of the nautical mile rather than written as
 * truncated decimals, so each pair is an exact reciprocal. Hand-written decimals
 * here caused a round-trip error of 4e-6 — small, but it would accumulate in any
 * display that converts repeatedly.
 */
export const UNITS = {
  /** metres per second → knots */
  MS_TO_KNOTS: SECONDS_PER_HOUR / METRES_PER_NAUTICAL_MILE,
  /** knots → metres per second */
  KNOTS_TO_MS: METRES_PER_NAUTICAL_MILE / SECONDS_PER_HOUR,
  /** metres → nautical miles */
  M_TO_NM: 1 / METRES_PER_NAUTICAL_MILE,
  /** nautical miles → metres */
  NM_TO_M: METRES_PER_NAUTICAL_MILE,
  DEG_TO_RAD: Math.PI / 180,
  RAD_TO_DEG: 180 / Math.PI,
} as const;

/** Physical constants used across physics and environment. */
export const PHYSICS_CONSTANTS = {
  /** Gravitational acceleration, m/s². */
  GRAVITY: 9.80665,
  /** Density of seawater at 15 °C, kg/m³. */
  WATER_DENSITY: 1025,
  /** Density of fresh water at 15 °C, kg/m³ — used for lake venues. */
  FRESHWATER_DENSITY: 999,
  /** Reference air density at 15 °C and 1013.25 hPa, kg/m³. Actual value is
   *  computed per session from live pressure and temperature. */
  AIR_DENSITY_REFERENCE: 1.225,
  /** Kinematic viscosity of seawater at 15 °C, m²/s. Used by the ITTC friction line. */
  WATER_KINEMATIC_VISCOSITY: 1.1892e-6,
  /** Specific gas constant for dry air, J/(kg·K). */
  DRY_AIR_GAS_CONSTANT: 287.058,
} as const;
