/**
 * Vector maths on plain `Vec2` / `Vec3` objects.
 *
 * Every function that returns a vector accepts an optional `out` parameter and
 * writes into it. That is not a micro-optimisation: the physics step runs at
 * 120 Hz over a dozen boats with several force generators each, so allocating
 * result vectors would produce sustained GC pressure and visible frame spikes
 * (requirement 8.8).
 *
 * These operate on plain objects rather than a class so the engine-agnostic
 * layers never need three.js — see docs/interfaces.md.
 */

import type { Vec2, Vec3 } from '@/types';

// --- construction -----------------------------------------------------------

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const vec2 = (x = 0, y = 0): Vec2 => ({ x, y });

export function set3(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function copy3(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

export function clone3(a: Vec3): Vec3 {
  return { x: a.x, y: a.y, z: a.z };
}

export function zero3(out: Vec3): Vec3 {
  out.x = 0;
  out.y = 0;
  out.z = 0;
  return out;
}

// --- arithmetic -------------------------------------------------------------

export function add3(a: Vec3, b: Vec3, out: Vec3 = vec3()): Vec3 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  out.z = a.z + b.z;
  return out;
}

export function sub3(a: Vec3, b: Vec3, out: Vec3 = vec3()): Vec3 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
  return out;
}

export function scale3(a: Vec3, s: number, out: Vec3 = vec3()): Vec3 {
  out.x = a.x * s;
  out.y = a.y * s;
  out.z = a.z * s;
  return out;
}

/** `out += a * s`. The workhorse of force accumulation. */
export function addScaled3(out: Vec3, a: Vec3, s: number): Vec3 {
  out.x += a.x * s;
  out.y += a.y * s;
  out.z += a.z * s;
  return out;
}

export function mul3(a: Vec3, b: Vec3, out: Vec3 = vec3()): Vec3 {
  out.x = a.x * b.x;
  out.y = a.y * b.y;
  out.z = a.z * b.z;
  return out;
}

export function negate3(a: Vec3, out: Vec3 = vec3()): Vec3 {
  out.x = -a.x;
  out.y = -a.y;
  out.z = -a.z;
  return out;
}

// --- products and magnitudes ------------------------------------------------

export function dot3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross3(a: Vec3, b: Vec3, out: Vec3 = vec3()): Vec3 {
  // Read components first so `out` may alias `a` or `b`.
  const ax = a.x;
  const ay = a.y;
  const az = a.z;
  const bx = b.x;
  const by = b.y;
  const bz = b.z;
  out.x = ay * bz - az * by;
  out.y = az * bx - ax * bz;
  out.z = ax * by - ay * bx;
  return out;
}

export function lengthSq3(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function length3(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

export function distance3(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Normalize. A zero-length vector yields zero rather than NaN — physics code
 * legitimately normalizes velocity vectors that may be exactly zero at rest,
 * and a NaN there would propagate through the whole integrator.
 */
export function normalize3(a: Vec3, out: Vec3 = vec3()): Vec3 {
  const len = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  if (len === 0) {
    out.x = 0;
    out.y = 0;
    out.z = 0;
    return out;
  }
  const inv = 1 / len;
  out.x = a.x * inv;
  out.y = a.y * inv;
  out.z = a.z * inv;
  return out;
}

export function lerp3(a: Vec3, b: Vec3, t: number, out: Vec3 = vec3()): Vec3 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

/** True when every component is finite. Used by physics stability assertions. */
export function isFinite3(a: Vec3): boolean {
  return Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);
}

// --- 2D ---------------------------------------------------------------------

export function set2(out: Vec2, x: number, y: number): Vec2 {
  out.x = x;
  out.y = y;
  return out;
}

export function copy2(out: Vec2, a: Vec2): Vec2 {
  out.x = a.x;
  out.y = a.y;
  return out;
}

export function add2(a: Vec2, b: Vec2, out: Vec2 = vec2()): Vec2 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  return out;
}

export function sub2(a: Vec2, b: Vec2, out: Vec2 = vec2()): Vec2 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  return out;
}

export function scale2(a: Vec2, s: number, out: Vec2 = vec2()): Vec2 {
  out.x = a.x * s;
  out.y = a.y * s;
  return out;
}

export function dot2(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/** Scalar cross product (the z component of the 3D cross). Sign gives turn direction. */
export function cross2(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

export function length2(a: Vec2): number {
  return Math.sqrt(a.x * a.x + a.y * a.y);
}

export function distance2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function normalize2(a: Vec2, out: Vec2 = vec2()): Vec2 {
  const len = Math.sqrt(a.x * a.x + a.y * a.y);
  if (len === 0) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  const inv = 1 / len;
  out.x = a.x * inv;
  out.y = a.y * inv;
  return out;
}

/** Rotate a 2D vector counter-clockwise by `angle` radians. */
export function rotate2(a: Vec2, angle: number, out: Vec2 = vec2()): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const ax = a.x;
  const ay = a.y;
  out.x = ax * c - ay * s;
  out.y = ax * s + ay * c;
  return out;
}

// --- compass bearings -------------------------------------------------------

/**
 * Convert a compass bearing to a horizontal world direction.
 *
 * World space is Y-up with +X east and +Z south, so bearing θ maps to
 * `(sin θ, 0, -cos θ)`. Getting this wrong flips north and south, which is
 * exactly the kind of error that makes a wind shift feel backwards.
 */
export function bearingToDirection(bearing: number, out: Vec3 = vec3()): Vec3 {
  out.x = Math.sin(bearing);
  out.y = 0;
  out.z = -Math.cos(bearing);
  return out;
}

/** Convert a horizontal world direction to a compass bearing in `[0, 2π)`. */
export function directionToBearing(direction: Vec3): number {
  const bearing = Math.atan2(direction.x, -direction.z);
  return bearing < 0 ? bearing + Math.PI * 2 : bearing;
}

/**
 * Convert a meteorological wind direction (the bearing wind blows FROM) into the
 * velocity vector of the moving air, which points the opposite way.
 */
export function windVector(directionFrom: number, speed: number, out: Vec3 = vec3()): Vec3 {
  // Air moves towards (direction + π).
  out.x = -Math.sin(directionFrom) * speed;
  out.y = 0;
  out.z = Math.cos(directionFrom) * speed;
  return out;
}
