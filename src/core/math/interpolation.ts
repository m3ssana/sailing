/**
 * Interpolation and easing.
 *
 * `circularLerp` is the important one. Wind direction is an angle, and a shift
 * from 350° to 10° must cross north — a naive lerp sweeps 340° backwards through
 * south, producing a wind that spins the wrong way through every forecast
 * transition. This is the single most common bug in weather-driven simulations,
 * so the function exists specifically to make it unrepresentable.
 */

const TAU = Math.PI * 2;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Clamp to 0..1. */
export function saturate(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Inverse lerp; returns 0 when the range is degenerate. */
export function inverseLerp(a: number, b: number, value: number): number {
  return a === b ? 0 : (value - a) / (b - a);
}

/** Remap from one range to another, unclamped. */
export function remap(value: number, inMin: number, inMax: number, outMin: number, outMax: number) {
  return outMin + (value - inMin) * ((outMax - outMin) / (inMax - inMin));
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = saturate((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = saturate((x - edge0) / (edge1 - edge0));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Wrap an angle into `[0, 2π)`. */
export function wrapAngle(angle: number): number {
  const wrapped = angle % TAU;
  return wrapped < 0 ? wrapped + TAU : wrapped;
}

/** Wrap an angle into `(-π, π]`. */
export function wrapAngleSigned(angle: number): number {
  const wrapped = wrapAngle(angle + Math.PI);
  return wrapped - Math.PI;
}

/**
 * Smallest signed difference `b - a`, in `(-π, π]`.
 *
 * Positive means b is clockwise of a. Used everywhere a heading error is needed
 * — steering to a target angle, measuring a wind shift, layline geometry.
 */
export function angleDelta(a: number, b: number): number {
  return wrapAngleSigned(b - a);
}

/**
 * Interpolate between two angles along the shorter arc.
 *
 * `circularLerp(350°, 10°, 0.5)` returns 0°, not 180°.
 */
export function circularLerp(a: number, b: number, t: number): number {
  return wrapAngle(a + angleDelta(a, b) * t);
}

/**
 * Catmull-Rom interpolation through four control points, evaluated between p1
 * and p2. Used for forecast wind speed so a building breeze reads as a smooth
 * curve instead of piecewise-linear kinks at each hourly keyframe.
 */
export function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/**
 * Catmull-Rom on angles, taking the shorter arc at every step.
 *
 * Implemented by unwrapping the control angles into a continuous sequence
 * relative to p1 before interpolating, so a spline crossing north behaves.
 */
export function catmullRomAngle(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const base = p1;
  const a0 = base + angleDelta(base, p0);
  const a2 = base + angleDelta(base, p2);
  const a3 = a2 + angleDelta(a2, p3);
  return wrapAngle(catmullRom(a0, base, a2, a3, t));
}

/**
 * Frame-rate independent exponential approach.
 *
 * `damp(current, target, lambda, dt)` moves a fraction of the way to the target
 * per unit time, independent of step size — unlike `lerp(current, target, 0.1)`
 * in an update loop, which silently changes behaviour with frame rate.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return target + (current - target) * Math.exp(-lambda * dt);
}

/** Angular form of {@link damp}, taking the shorter arc. */
export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  const delta = angleDelta(current, target);
  return wrapAngle(target - delta * Math.exp(-lambda * dt));
}

/**
 * Critically damped spring, as used for replay checkpoint correction and camera
 * follow. Returns the new value and mutates `velocity` in place.
 *
 * Critically damped means it converges as fast as possible without overshoot,
 * which is what makes a checkpoint correction imperceptible rather than a visible
 * snap or wobble (design.md §12.2).
 */
export function springDamp(
  current: number,
  target: number,
  velocity: { value: number },
  smoothTime: number,
  dt: number,
): number {
  const omega = 2 / Math.max(1e-4, smoothTime);
  const x = omega * dt;
  // Padé approximation of exp(-x); cheaper and stable for the range we use.
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (velocity.value + omega * change) * dt;
  velocity.value = (velocity.value - omega * temp) * exp;
  return target + (change + temp) * exp;
}

/** Piecewise-linear lookup on a sorted curve, with clamped ends. */
export function sampleCurve(curve: readonly { x: number; y: number }[], x: number): number {
  const n = curve.length;
  if (n === 0) return 0;
  const first = curve[0];
  const last = curve[n - 1];
  if (first === undefined || last === undefined) return 0;
  if (x <= first.x) return first.y;
  if (x >= last.x) return last.y;

  // Binary search for the bracketing segment.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const point = curve[mid];
    if (point === undefined) break;
    if (point.x <= x) lo = mid;
    else hi = mid;
  }

  const a = curve[lo];
  const b = curve[hi];
  if (a === undefined || b === undefined) return 0;
  const span = b.x - a.x;
  return span === 0 ? a.y : a.y + ((x - a.x) / span) * (b.y - a.y);
}
