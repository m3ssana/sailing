/**
 * Render-side interpolation between two BoatState snapshots.
 *
 * The physics loop runs at 120 Hz (fixed step), while rendering runs at variable
 * frame rate. To avoid visual stutter, the renderer interpolates between the last
 * two physics states using the `alpha` factor produced by the game loop's
 * accumulator (GameLoop.ts: `stepAccumulator → result.alpha`).
 *
 * Position is linearly interpolated; orientation uses quaternion slerp.
 */

import type { Vec3, Quat } from '@/types';

/** Minimal subset of BoatState needed for render interpolation. */
export interface InterpolableState {
  position: Vec3;
  orientation: Quat;
  heel: number;
  speed: number;
}

/** Interpolated result suitable for applying to a three.js Object3D. */
export interface InterpolatedTransform {
  position: Vec3;
  orientation: Quat;
}

/**
 * Linearly interpolate two Vec3 values.
 */
export function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

/**
 * Spherical linear interpolation between two unit quaternions.
 *
 * Uses the standard slerp formula with shortest-path correction (dot < 0 → negate).
 * Falls back to linear interpolation + normalize for near-parallel quaternions
 * to avoid division by near-zero sin.
 */
export function slerpQuat(a: Quat, b: Quat, t: number): Quat {
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;

  // Compute the cosine of the angle between the two quaternions
  let cosHalfTheta = a.x * bx + a.y * by + a.z * bz + a.w * bw;

  // If negative dot, negate one quaternion to take shortest path
  if (cosHalfTheta < 0) {
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
    cosHalfTheta = -cosHalfTheta;
  }

  // If quaternions are very close, use linear interpolation
  if (cosHalfTheta >= 0.9995) {
    const rx = a.x + (bx - a.x) * t;
    const ry = a.y + (by - a.y) * t;
    const rz = a.z + (bz - a.z) * t;
    const rw = a.w + (bw - a.w) * t;
    const invLen = 1.0 / Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw);
    return { x: rx * invLen, y: ry * invLen, z: rz * invLen, w: rw * invLen };
  }

  const halfTheta = Math.acos(cosHalfTheta);
  const sinHalfTheta = Math.sqrt(1.0 - cosHalfTheta * cosHalfTheta);

  const ratioA = Math.sin((1 - t) * halfTheta) / sinHalfTheta;
  const ratioB = Math.sin(t * halfTheta) / sinHalfTheta;

  return {
    x: a.x * ratioA + bx * ratioB,
    y: a.y * ratioA + by * ratioB,
    z: a.z * ratioA + bz * ratioB,
    w: a.w * ratioA + bw * ratioB,
  };
}

/**
 * Interpolate between two physics states for smooth rendering.
 *
 * @param prev - The previous physics state snapshot.
 * @param curr - The current (most recent) physics state snapshot.
 * @param alpha - Interpolation factor from the game loop accumulator, in [0, 1).
 *   0 means render at `prev`, 1 means render at `curr`.
 */
export function interpolateBoatState(
  prev: InterpolableState,
  curr: InterpolableState,
  alpha: number,
): InterpolatedTransform {
  return {
    position: lerpVec3(prev.position, curr.position, alpha),
    orientation: slerpQuat(prev.orientation, curr.orientation, alpha),
  };
}
