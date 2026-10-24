/**
 * Camera math — pure helpers used by the camera models (H.4).
 *
 * No three.js, no DOM. These build on `@core/math` but add the few things the
 * camera needs that the shared math layer does not expose: a look-rotation
 * (forward+up → quaternion) in the three.js **-Z forward** convention, a roll
 * about the view axis, and frame-rate-independent exponential smoothing of
 * vectors.
 *
 * ## The -Z forward convention, made explicit
 *
 * A three.js camera looks down its local **-Z**. So a quaternion `q` "looks at"
 * a target when `rotateVec3(q, (0,0,-1))` equals `normalize(target - position)`.
 * `lookRotationZNeg` builds exactly that quaternion from a forward direction and
 * a world-up hint, with local +X = right, local +Y = up. This is tested against
 * the concrete case in the task: a camera at the stern looking forward along the
 * boat heading must have the bow ahead in view (i.e. the forward axis points at
 * the bow), see `cameraMath.test.ts`.
 */

import type { Quat, Vec3 } from '@/types';
import {
  cross3,
  dot3,
  length3,
  normalize3,
  set3,
  vec3,
} from '@core/math/vec';
import { setQ } from '@core/math/quat';

/** World up. */
const WORLD_UP: Vec3 = { x: 0, y: 1, z: 0 };
/** Fallback up when forward is nearly parallel to world up. */
const FALLBACK_UP: Vec3 = { x: 0, y: 0, z: 1 };

/**
 * Build a camera quaternion that looks along `forward` (local -Z) with the
 * camera's up kept as close as possible to `up` (default world +Y).
 *
 * The result is orthonormal and right-handed: local +X = right, +Y = up,
 * -Z = forward. Degenerate inputs (zero forward, forward ∥ up) fall back
 * gracefully rather than producing NaN.
 *
 * Allocation note: uses three caller-provided-or-fresh scratch vectors. Callers
 * on the hot path pass their own `scratch` to stay allocation-free.
 */
export function lookRotationZNeg(
  forward: Vec3,
  up: Vec3 = WORLD_UP,
  out: Quat = setQ({ x: 0, y: 0, z: 0, w: 1 }, 0, 0, 0, 1),
  scratch: LookScratch = createLookScratch(),
): Quat {
  // f = normalized forward (the direction the camera looks).
  const f = normalize3(forward, scratch.f);
  if (length3(f) === 0) {
    return setQ(out, 0, 0, 0, 1);
  }

  // Choose an up hint not parallel to f.
  let upHint = up;
  if (Math.abs(dot3(f, up)) > 0.9999) {
    upHint = FALLBACK_UP;
  }

  // right = normalize(f × up)  — three uses -Z forward, so with f = -Z,
  // r = f × up gives +X to the right for up = +Y (f=(0,0,-1) → r=(1,0,0)).
  const r = normalize3(cross3(f, upHint, scratch.r), scratch.r);
  if (length3(r) === 0) {
    return setQ(out, 0, 0, 0, 1);
  }
  // trueUp = r × f  (local +Y)
  const u = cross3(r, f, scratch.u);

  // Rotation matrix columns are the camera's local axes in world space:
  //   col0 = right (+X), col1 = up (+Y), col2 = back (+Z) = -forward.
  const m00 = r.x;
  const m10 = r.y;
  const m20 = r.z;
  const m01 = u.x;
  const m11 = u.y;
  const m21 = u.z;
  const m02 = -f.x;
  const m12 = -f.y;
  const m22 = -f.z;

  // Matrix → quaternion (Shepperd's method).
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return setQ(
      out,
      (m21 - m12) / s,
      (m02 - m20) / s,
      (m10 - m01) / s,
      0.25 * s,
    );
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return setQ(
      out,
      0.25 * s,
      (m01 + m10) / s,
      (m02 + m20) / s,
      (m21 - m12) / s,
    );
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return setQ(
      out,
      (m01 + m10) / s,
      0.25 * s,
      (m12 + m21) / s,
      (m02 - m20) / s,
    );
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return setQ(
    out,
    (m02 + m20) / s,
    (m12 + m21) / s,
    0.25 * s,
    (m10 - m01) / s,
  );
}

/** Scratch vectors for {@link lookRotationZNeg}. One per camera instance. */
export interface LookScratch {
  f: Vec3;
  r: Vec3;
  u: Vec3;
}

export function createLookScratch(): LookScratch {
  return { f: vec3(), r: vec3(), u: vec3() };
}

/**
 * Post-multiply a look quaternion by a roll about the camera's local view axis
 * (-Z), so the horizon tilts by `roll` radians. Positive roll rolls the camera
 * to starboard (the view tilts so the right side drops), matching the sign of
 * `heelFromQuat`.
 *
 * q' = q * rollQuat, where rollQuat rotates about local -Z by `roll`.
 * A rotation about -Z by θ has axis (0,0,-1): quat = (0,0,-sin(θ/2),cos(θ/2)).
 */
export function applyViewRoll(q: Quat, roll: number, out: Quat = { x: 0, y: 0, z: 0, w: 1 }): Quat {
  const half = roll * 0.5;
  const rz = -Math.sin(half);
  const rw = Math.cos(half);
  // out = q * (0, 0, rz, rw)
  const { x, y, z, w } = q;
  out.x = w * 0 + x * rw + y * rz - z * 0;
  out.y = w * 0 - x * rz + y * rw + z * 0;
  out.z = w * rz + x * 0 - y * 0 + z * rw;
  out.w = w * rw - x * 0 - y * 0 - z * rz;
  return out;
}

/**
 * Frame-rate-independent exponential smoothing of a vector toward a target.
 *
 * `out = target + (current - target) * exp(-lambda * dt)`, applied per
 * component. Larger `lambda` converges faster. Independent of `dt` by
 * construction (two half-steps equal one full step to within float error),
 * which the spring tests exploit to assert 30 Hz and 120 Hz agree.
 *
 * Writes into `out` (may alias `current`). Allocation-free.
 */
export function dampVec3(
  current: Vec3,
  target: Vec3,
  lambda: number,
  dt: number,
  out: Vec3 = vec3(),
): Vec3 {
  const k = Math.exp(-lambda * dt);
  return set3(
    out,
    target.x + (current.x - target.x) * k,
    target.y + (current.y - target.y) * k,
    target.z + (current.z - target.z) * k,
  );
}
