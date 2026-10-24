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
 * CANONICAL HEADING QUATERNION — the single engine-wide orientation convention.
 *
 * ## The convention (see docs/interfaces.md and STATUS.md "Hard-won knowledge")
 *
 * Body axes: forward = −Z_body, starboard = +X_body, up = +Y_body. These form a
 * right-handed frame: starboard = forward × up, i.e. (0,0,−1) × (0,1,0) = (1,0,0).
 *
 * World space is Y-up right-handed, +X east, +Z south, and a compass bearing
 * increases CLOCKWISE seen from above. A boat at heading `h` (bearing) points its
 * bow along the PHYSICAL forward `(sin h, 0, −cos h)` — the SAME vector
 * `bearingToDirection(h)` returns and the same direction the force generators and
 * the boat's own velocity use.
 *
 * A rotation by +θ about +Y (right-handed, Y up) turns a horizontal vector
 * COUNTER-clockwise seen from above, but a bearing increases CLOCKWISE. Therefore
 * the heading quaternion is a rotation about +Y by **−h**, NOT +h. This is the
 * one correction that makes the quaternion frame identical to the physical frame:
 * with it, `rotateVec3(quatFromHeading(h), (0,0,−1)) === (sin h, 0, −cos h)` to
 * machine precision, so every `rotateVec3(orientation, …)` body-axis derivation
 * (Buoyancy, WaveDrag point placement, the CoM, RightingMoment/Damping body-axis
 * couples) agrees with the `(sin h, …)` force generators by construction.
 *
 * The historical bug (now fixed): `fromAxisAngle({0,1,0}, +h)` produced the
 * X-MIRROR `(−sin h, 0, −cos h)`, so the quaternion frame and the physical frame
 * were opposite-handed. That mismatch was the root cause of the heading-dependent
 * capsize/half-speed (`tests/unit/physics/rotationInvariance.test.ts`).
 */
export function quatFromHeading(h: number, out: Quat = quat()): Quat {
  // Rotation about +Y by −h.
  const half = -h * 0.5;
  out.x = 0;
  out.y = Math.sin(half);
  out.z = 0;
  out.w = Math.cos(half);
  return out;
}

/**
 * Build a rotation from intrinsic yaw-pitch-roll, applied in that order:
 * `q = qYaw · qPitch · qRoll`.
 *
 * Yaw is the compass HEADING — a rotation about +Y by **−yaw** (see
 * `quatFromHeading`; `fromYawPitchRoll(h,0,0) === quatFromHeading(h)`). Pitch is
 * about the body starboard axis +X (bow-up positive). Roll is about the body
 * forward axis −Z (starboard-down positive = heel positive to starboard), to
 * match the derived-state extractors `headingFromQuat`/`pitchFromQuat`/
 * `heelFromQuat` below, which invert this build exactly (verified round-trip to
 * machine precision across heading/pitch/heel).
 */
export function fromYawPitchRoll(
  yaw: number,
  pitch: number,
  roll: number,
  out: Quat = quat(),
): Quat {
  // Yaw about +Y by −yaw.
  const hy = -yaw * 0.5;
  const qyX = 0;
  const qyY = Math.sin(hy);
  const qyZ = 0;
  const qyW = Math.cos(hy);
  // Pitch about +X.
  const hp = pitch * 0.5;
  const qpX = Math.sin(hp);
  const qpW = Math.cos(hp);
  // Roll about −Z.
  const hr = roll * 0.5;
  const qrZ = -Math.sin(hr);
  const qrW = Math.cos(hr);

  // a = qYaw · qPitch
  const ax = qyW * qpX + qyX * qpW; // = qyW·qpX
  const ay = qyY * qpW + qyZ * qpX; // = qyY·qpW
  const az = qyZ * qpW - qyY * qpX; // = −qyY·qpX
  const aw = qyW * qpW - qyX * qpX; // = qyW·qpW

  // out = a · qRoll  (qRoll = (0,0,qrZ,qrW))
  out.x = aw * 0 + ax * qrW + ay * qrZ - az * 0;
  out.y = aw * 0 - ax * qrZ + ay * qrW + az * 0;
  out.z = aw * qrZ + ax * 0 - ay * 0 + az * qrW;
  out.w = aw * qrW - ax * 0 - ay * 0 - az * qrZ;
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

/**
 * Extract the compass heading (bearing of the bow) as a value in `[0, 2π)`.
 *
 * Uses the ACTUAL rotated forward axis so it is the exact inverse of
 * `quatFromHeading`: `f = rotateVec3(q, (0,0,−1))`, bearing = `atan2(f.x, −f.z)`.
 * (The previous formula read an internal `(sin h, +cos h)` that disagreed in
 * sign with what `rotateVec3((0,0,−1))` actually produces — the X-mirror bug.)
 */
export function headingFromQuat(q: Quat): number {
  // Forward = q · (0,0,−1).  f.x = −2(q.x·q.z + q.w·q.y),  f.z = −(1 − 2(q.x²+q.y²)).
  const fx = -2 * (q.x * q.z + q.w * q.y);
  const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
  const bearing = Math.atan2(fx, -fz);
  return bearing < 0 ? bearing + Math.PI * 2 : bearing;
}

/**
 * Extract heel (roll about the body FORWARD axis), positive to starboard
 * (starboard side DOWN).
 *
 * Geometric (frame-order-independent): with the rotated starboard axis
 * `s = q·(1,0,0)` and up axis `u = q·(0,1,0)`, `heel = atan2(−s.y, u.y)`. When
 * the boat heels to starboard the starboard gunwale dips (s.y < 0) so heel > 0.
 * Exact inverse of the roll term in `fromYawPitchRoll`.
 */
export function heelFromQuat(q: Quat): number {
  // s = q·(1,0,0):  s.y = 2(q.x·q.y + q.w·q.z).
  const sy = 2 * (q.x * q.y + q.w * q.z);
  // u = q·(0,1,0):  u.y = 1 − 2(q.x² + q.z²).
  const uy = 1 - 2 * (q.x * q.x + q.z * q.z);
  return Math.atan2(-sy, uy);
}

/**
 * Extract pitch (about the body starboard axis), positive bow-up.
 *
 * `f = q·(0,0,−1)`; the world-Y component of the forward axis is `sin(pitch)`.
 */
export function pitchFromQuat(q: Quat): number {
  // f.y = −2(q.y·q.z − q.w·q.x) = 2(q.w·q.x − q.y·q.z).
  const fy = 2 * (q.w * q.x - q.y * q.z);
  return Math.asin(Math.max(-1, Math.min(1, fy)));
}


// ─── Canonical body-axis extraction ──────────────────────────────────────────
//
// Body axes: forward = −Z_body, starboard = +X_body, up = +Y_body. These three
// helpers are the ONE sanctioned way for a force generator (or the camera) to
// derive the boat's body axes in world space from its orientation. Deriving them
// via `rotateVec3` of the body basis — rather than re-building `(sin h, …)` from
// the heading — guarantees every consumer uses the SAME frame as the quaternion
// (heel/pitch included), which is what makes the dynamics rotation-invariant.

/** Boat forward (bow) direction in world space: `q · (0,0,−1)`. */
export function forwardFromQuat(q: Quat, out: Vec3 = vec3()): Vec3 {
  return rotateVec3(q, { x: 0, y: 0, z: -1 }, out);
}

/** Boat starboard direction in world space: `q · (1,0,0)`. */
export function starboardFromQuat(q: Quat, out: Vec3 = vec3()): Vec3 {
  return rotateVec3(q, { x: 1, y: 0, z: 0 }, out);
}

/** Boat up (masthead) direction in world space: `q · (0,1,0)`. */
export function upFromQuat(q: Quat, out: Vec3 = vec3()): Vec3 {
  return rotateVec3(q, { x: 0, y: 1, z: 0 }, out);
}
