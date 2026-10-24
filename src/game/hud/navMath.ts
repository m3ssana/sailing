/**
 * Pure navigation / performance maths for the HUD view model.
 *
 * All SI and radians. Direction conventions follow the project rule: a wind
 * bearing is the compass bearing the wind blows FROM; `+X` east, `+Z` south, so a
 * compass bearing θ maps to the ground vector `(sinθ, -cosθ)` in (x, y=south).
 *
 * These functions are first-principles and independently testable. The VMG and
 * layline formulas are the classic sailing definitions (see design.md §7.5 and
 * PolarSolver.ts, which computes the polar VMG as `V·cos(TWA)` upwind and
 * `V·cos(π−TWA)` downwind).
 */

import type { Radians } from '@/types/units';
import { wrapAngle, wrapAngleSigned } from '@core/math';
import type { PointOfSail } from './types';

/**
 * Signed true/apparent wind angle off the bow, in `(-π, π]`.
 *
 * Positive = wind coming over the STARBOARD bow, negative = over the PORT bow.
 * Derived as the signed difference between the heading and the bearing the wind
 * comes FROM. When the wind is from dead ahead (fromBearing == heading) the angle
 * is 0; when from dead astern it is ±π.
 *
 * @param heading     boat bow bearing, compass radians
 * @param windFrom    bearing the wind comes FROM, compass radians
 */
export function windAngleOffBow(heading: Radians, windFrom: Radians): Radians {
  return wrapAngleSigned(windFrom - heading);
}

/**
 * Apparent wind angle and speed from true wind and boat motion, via the velocity
 * triangle — the independent check for the physics-supplied apparent wind.
 *
 * Works in the boat frame: the true wind blows TOWARDS the boat along
 * `twa + π` (since `twa` is measured to where it comes FROM). The boat's own
 * motion adds a headwind of magnitude `boatSpeed` from dead ahead.
 *
 * @param trueSpeed  true wind speed, m/s (>= 0)
 * @param twa        true wind angle off the bow, signed radians (+stbd, −port)
 * @param boatSpeed  boat speed over ground along the bow, m/s
 * @returns apparent wind { speed (m/s), angle (signed radians off the bow) }
 */
export function apparentWindAngle(
  trueSpeed: number,
  twa: Radians,
  boatSpeed: number,
): { speed: number; angle: Radians } {
  // Boat-frame axes: +y forward (bow), +x to starboard.
  // The true-wind VELOCITY vector (where the air is going) points from the
  // "comes-from" bearing towards the boat. In boat frame, a wind coming FROM
  // angle `twa` off the bow has a velocity pointing towards `twa + π`:
  //   from-direction unit = (sin twa, cos twa)   [x=stbd, y=fwd]
  //   velocity = −from-direction = (−sin twa, −cos twa)
  const windVx = -trueSpeed * Math.sin(twa);
  const windVy = -trueSpeed * Math.cos(twa);
  // The boat moving forward at `boatSpeed` sees an extra headwind −boatSpeed·ŷ.
  const appVx = windVx;
  const appVy = windVy - boatSpeed;
  const speed = Math.hypot(appVx, appVy);
  // Apparent wind comes FROM the opposite of its velocity:
  //   from-vector = −(appVx, appVy); angle off bow = atan2(fromX, fromY)
  const angle = Math.atan2(-appVx, -appVy);
  return { speed, angle: wrapAngleSigned(angle) };
}

/**
 * Velocity made good toward (upwind) or away from (downwind) the wind.
 *
 * VMG is the component of the boat's velocity along the wind axis. By the
 * project convention `windFrom` is where the wind comes FROM, so "upwind" points
 * towards `windFrom`. The signed upwind VMG is:
 *
 *   VMG_upwind = SOG · cos(angle between COG and windFrom)
 *
 * which is positive when sailing towards the wind (making ground upwind) and
 * negative when sailing away (that same number IS the downwind VMG with sign
 * flipped). This matches PolarSolver's `V·cos(TWA)` upwind / `V·cos(π−TWA)`
 * downwind exactly: with COG along the bow, the angle-between equals TWA.
 *
 * @returns `{ upwind, downwind }` in m/s. `downwind = −upwind`.
 */
export function computeVmg(
  sogMps: number,
  courseOverGround: Radians,
  windFromBearing: Radians,
): { upwind: number; downwind: number } {
  const angleToWind = wrapAngleSigned(windFromBearing - courseOverGround);
  const upwind = sogMps * Math.cos(angleToWind);
  return { upwind, downwind: -upwind };
}

/**
 * Fraction of the polar target speed the boat is achieving, `SOG / target`.
 *
 * Returns 0 when the target is non-positive (e.g. head-to-wind, where the model
 * target is ~0 and the ratio is undefined). Not clamped above 1 — surfing a wave
 * can momentarily exceed target, and hiding that is misleading.
 *
 * @param sogMps       speed over ground, m/s
 * @param twsMps       true wind speed, m/s
 * @param twaRad       true wind angle off the bow, radians (sign ignored; polar
 *                     is symmetric and `targetSpeed` takes |angle|)
 * @param targetSpeed  the polar lookup (`PolarDiagram.targetSpeed`)
 */
export function targetSpeedFraction(
  sogMps: number,
  twsMps: number,
  twaRad: Radians,
  targetSpeed: (tws: number, twa: number) => number,
): number {
  const target = targetSpeed(twsMps, Math.abs(twaRad));
  if (!(target > 0)) return 0;
  return sogMps / target;
}

/**
 * The two close-hauled compass headings that lay a windward mark for a given
 * optimal tacking angle, i.e. `windFrom ± tackAngle`.
 *
 * `port` is the heading on port tack (wind over the port bow → bow to the LEFT of
 * the wind, i.e. `windFrom − tackAngle`); `starboard` is `windFrom + tackAngle`.
 * Symmetric about the wind by construction.
 *
 * @param windFromBearing  bearing the wind comes FROM, compass radians
 * @param tackAngle        optimal upwind angle off the true wind, radians
 */
export function laylineBearings(
  windFromBearing: Radians,
  tackAngle: Radians,
): { port: Radians; starboard: Radians } {
  return {
    port: wrapAngle(windFromBearing - tackAngle),
    starboard: wrapAngle(windFromBearing + tackAngle),
  };
}

/**
 * Find the optimal upwind tacking angle (TWA) from a polar lookup by maximising
 * upwind VMG over close-hauled angles. Returns radians off the true wind.
 *
 * Searches 25°..60° in 1° steps — the plausible close-hauled band for any boat
 * the game ships. Falls back to 42° if the polar returns no positive speed.
 */
export function optimalUpwindTwa(
  twsMps: number,
  targetSpeed: (tws: number, twa: number) => number,
): Radians {
  let bestVmg = -Infinity;
  let bestTwa = (42 * Math.PI) / 180;
  for (let deg = 25; deg <= 60; deg += 1) {
    const twa = (deg * Math.PI) / 180;
    const v = targetSpeed(twsMps, twa);
    const vmg = v * Math.cos(twa);
    if (vmg > bestVmg) {
      bestVmg = vmg;
      bestTwa = twa;
    }
  }
  return bestTwa;
}

/** Classify the point of sail from the magnitude of the true wind angle. */
export function pointOfSail(twa: Radians): PointOfSail {
  const a = Math.abs(wrapAngleSigned(twa));
  const d = (a * 180) / Math.PI;
  if (d < 10) return 'head-to-wind';
  if (d < 55) return 'close-hauled';
  if (d < 80) return 'close-reach';
  if (d < 100) return 'beam-reach';
  if (d < 160) return 'broad-reach';
  return 'running';
}

/**
 * Compass bearing from one venue-local point to another.
 *
 * Venue-local is (x east, y south). A bearing θ maps to `(sinθ, -cosθ)`, so the
 * inverse is `θ = atan2(Δx, -Δy)`.
 */
export function bearingTo(from: { x: number; y: number }, to: { x: number; y: number }): Radians {
  return wrapAngle(Math.atan2(to.x - from.x, -(to.y - from.y)));
}

/** Planar distance between two venue-local points, metres. */
export function distanceTo(from: { x: number; y: number }, to: { x: number; y: number }): number {
  return Math.hypot(to.x - from.x, to.y - from.y);
}
