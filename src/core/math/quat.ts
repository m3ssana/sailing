/**
 * Quaternion maths for rigid-body orientation.
 *
 * Same allocation-free convention as `vec.ts`. Quaternions are used rather than
 * Euler angles because the boat pitches, rolls and yaws simultaneously in waves,
 * and Euler integration of large combined rotations gimbal-locks near vertical —
 * which is precisely the capsize case that has to stay stable.
 */

import type { Quat, Vec3 } from '@/types';
import { vec3 } from './vec';

export const quat = (x = 0, y = 0, z = 0, w = 1): Quat => ({ x, y, z, w });

export function setQ(out: Quat, x: number, y: number, z: number, w: number): Quat {
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}

export function copyQ(out: Quat, a: Quat): Quat {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  out.w = a.w;
  return out;
}

export function identityQ(out: Quat): Quat {
  out.x = 0;
  out.y = 0;
  out.z = 0;
  out.w = 1;
  return out;
}

/** Hamilton product `a * b`: apply b, then a. */
export function multiplyQ(a: Quat, b: Quat, out: Quat = quat()): Quat {
  const ax = a.x;
  const ay = a.y;
  const az = a.z;
  const aw = a.w;
  const bx = b.x;
  const by = b.y;
  const bz = b.z;
  const bw = b.w;
  out.x = aw * bx + ax * bw + ay * bz - az * by;
  out.y = aw * by - ax * bz + ay * bw + az * bx;
  out.z = aw * bz + ax * by - ay * bx + az * bw;
  out.w = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

export function normalizeQ(a: Quat, out: Quat = quat()): Quat {
  const len = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z + a.w * a.w);
  if (len === 0) return identityQ(out);
  const inv = 1 / len;
  out.x = a.x * inv;
  out.y = a.y * inv;
  out.z = a.z * inv;
  out.w = a.w * inv;
  return out;
}

export function conjugateQ(a: Quat, out: Quat = quat()): Quat {
  out.x = -a.x;
  out.y = -a.y;
  out.z = -a.z;
  out.w = a.w;
  return out;
}

/** Build a rotation of `angle` radians about a unit `axis`. */
export function fromAxisAngle(axis: Vec3, angle: number, out: Quat = quat()): Quat {
  const half = angle * 0.5;
  const s = Math.sin(half);
  out.x = axis.x * s;
  out.y = axis.y * s;
  out.z = axis.z * s;
  out.w = Math.cos(half);
  return out;
}

/**
 * Build a rotation from intrinsic yaw-pitch-roll, applied in that order.
 *
 * Yaw is about +Y (heading), pitch about +X (bow up positive), roll about -Z
 * (starboard down positive) to match the boat conventions in `BoatState`.
 */
export function fromYawPitchRoll(
  yaw: number,
  pitch: number,
  roll: number,
  out: Quat = quat(),
): Quat {
  const cy = Math.cos(yaw * 0.5);
  const sy = Math.sin(yaw * 0.5);
  const cp = Math.cos(pitch * 0.5);
  const sp = Math.sin(pitch * 0.5);
  const cr = Math.cos(roll * 0.5);
  const sr = Math.sin(roll * 0.5);

  out.x = sp * cy * cr + cp * sy * sr;
  out.y = cp * sy * cr - sp * cy * sr;
  out.z = cp * cy * sr - sp * sy * cr;
  out.w = cp * cy * cr + sp * sy * sr;
  return normalizeQ(out, out);
}

/** Rotate a vector by a quaternion. */
export function rotateVec3(q: Quat, v: Vec3, out: Vec3 = vec3()): Vec3 {
  // t = 2 * (q_vec × v); result = v + q_w * t + q_vec × t
  const qx = q.x;
  const qy = q.y;
  const qz = q.z;
  const qw = q.w;
  const vx = v.x;
  const vy = v.y;
  const vz = v.z;

  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);

  out.x = vx + qw * tx + (qy * tz - qz * ty);
  out.y = vy + qw * ty + (qz * tx - qx * tz);
  out.z = vz + qw * tz + (qx * ty - qy * tx);
  return out;
}

/** Rotate a vector by the inverse of a quaternion (world → local). */
export function rotateVec3Inverse(q: Quat, v: Vec3, out: Vec3 = vec3()): Vec3 {
  const qx = -q.x;
  const qy = -q.y;
  const qz = -q.z;
  const qw = q.w;
  const vx = v.x;
  const vy = v.y;
  const vz = v.z;

  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);

  out.x = vx + qw * tx + (qy * tz - qz * ty);
  out.y = vy + qw * ty + (qz * tx - qx * tz);
  out.z = vz + qw * tz + (qx * ty - qy * tx);
  return out;
}

/**
 * Integrate orientation by an angular velocity over `dt`.
 *
 * Uses the exact exponential map rather than the common first-order
 * `q += 0.5 * ω * q * dt` approximation. The approximation drifts and requires
 * renormalization every step; at 120 Hz over a 30-minute session that drift is
 * measurable, and it degrades exactly when angular rates are highest — a boat
 * being thrown around in a steep sea.
 */
export function integrateOrientation(
  q: Quat,
  angularVelocity: Vec3,
  dt: number,
  out: Quat = quat(),
): Quat {
  const wx = angularVelocity.x;
  const wy = angularVelocity.y;
  const wz = angularVelocity.z;
  const omega = Math.sqrt(wx * wx + wy * wy + wz * wz);

  if (omega < 1e-9) {
    return copyQ(out, q);
  }

  const half = omega * dt * 0.5;
  const s = Math.sin(half) / omega;
  const dqx = wx * s;
  const dqy = wy * s;
  const dqz = wz * s;
  const dqw = Math.cos(half);

  // out = dq * q
  const qx = q.x;
  const qy = q.y;
  const qz = q.z;
  const qw = q.w;
  out.x = dqw * qx + dqx * qw + dqy * qz - dqz * qy;
  out.y = dqw * qy - dqx * qz + dqy * qw + dqz * qx;
  out.z = dqw * qz + dqx * qy - dqy * qx + dqz * qw;
  out.w = dqw * qw - dqx * qx - dqy * qy - dqz * qz;
  return normalizeQ(out, out);
}

/** Spherical linear interpolation, taking the shorter arc. */
export function slerpQ(a: Quat, b: Quat, t: number, out: Quat = quat()): Quat {
  let cosHalf = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;

  // Negate one end if needed so we interpolate the short way round.
  if (cosHalf < 0) {
    cosHalf = -cosHalf;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }

  // Nearly parallel: fall back to linear interpolation to avoid dividing by ~0.
  if (cosHalf > 0.9995) {
    out.x = a.x + (bx - a.x) * t;
    out.y = a.y + (by - a.y) * t;
    out.z = a.z + (bz - a.z) * t;
    out.w = a.w + (bw - a.w) * t;
    return normalizeQ(out, out);
  }

  const halfAngle = Math.acos(cosHalf);
  const sinHalf = Math.sin(halfAngle);
  const ratioA = Math.sin((1 - t) * halfAngle) / sinHalf;
  const ratioB = Math.sin(t * halfAngle) / sinHalf;

  out.x = a.x * ratioA + bx * ratioB;
  out.y = a.y * ratioA + by * ratioB;
  out.z = a.z * ratioA + bz * ratioB;
  out.w = a.w * ratioA + bw * ratioB;
  return out;
}

/** Extract the heading (rotation about +Y) as a bearing in `[0, 2π)`. */
export function headingFromQuat(q: Quat): number {
  // Rotate the local forward axis (0,0,-1) and read its bearing.
  const fx = 2 * (q.x * q.z + q.w * q.y);
  const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
  const bearing = Math.atan2(fx, fz);
  return bearing < 0 ? bearing + Math.PI * 2 : bearing;
}

/** Extract heel (roll) in radians, positive to starboard. */
export function heelFromQuat(q: Quat): number {
  // Local up axis (0,1,0) rotated into world space.
  const ux = 2 * (q.x * q.y - q.w * q.z);
  const uy = 1 - 2 * (q.x * q.x + q.z * q.z);
  return Math.atan2(ux, uy);
}

/** Extract pitch in radians, positive bow-up. */
export function pitchFromQuat(q: Quat): number {
  // Local forward axis (0,0,-1); its world Y component gives pitch.
  const fy = -2 * (q.y * q.z - q.w * q.x);
  return Math.asin(Math.max(-1, Math.min(1, fy)));
}
