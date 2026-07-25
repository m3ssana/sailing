/**
 * Parametric curve evaluation and resampling.
 *
 * Station curves in hull definitions are authored with hand-placed control
 * points at uneven arc-length intervals. The lofter requires all sections to
 * have the same point count with consistent spacing — `resampleByArcLength`
 * bridges that gap. Without it, lofted quads stretch unevenly and normals twist.
 *
 * Engine-agnostic — no three.js.
 */

import type { Vec2, Vec3 } from '@/types';

// ─── Catmull-Rom splines ─────────────────────────────────────────────────────

/**
 * Evaluate a Catmull-Rom segment between p1 and p2 at parameter t ∈ [0, 1].
 * Uses the centripetal parameterisation (alpha = 0.5 for standard C-R).
 */
function catmullRomSegment2D(
  p0: Vec2,
  p1: Vec2,
  p2: Vec2,
  p3: Vec2,
  t: number,
  out: Vec2,
): Vec2 {
  const t2 = t * t;
  const t3 = t2 * t;
  out.x =
    0.5 *
    (2 * p1.x +
      (-p0.x + p2.x) * t +
      (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
      (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
  out.y =
    0.5 *
    (2 * p1.y +
      (-p0.y + p2.y) * t +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
  return out;
}

function catmullRomSegment3D(
  p0: Vec3,
  p1: Vec3,
  p2: Vec3,
  p3: Vec3,
  t: number,
  out: Vec3,
): Vec3 {
  const t2 = t * t;
  const t3 = t2 * t;
  out.x =
    0.5 *
    (2 * p1.x +
      (-p0.x + p2.x) * t +
      (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
      (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
  out.y =
    0.5 *
    (2 * p1.y +
      (-p0.y + p2.y) * t +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
  out.z =
    0.5 *
    (2 * p1.z +
      (-p0.z + p2.z) * t +
      (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 +
      (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3);
  return out;
}

export interface SplineOptions {
  /** Whether the curve closes on itself. Default false. */
  closed?: boolean;
}

/**
 * Evaluate a Catmull-Rom spline through the given 2D control points, returning
 * `samples` evenly-parametrised points along it.
 *
 * For an open curve, phantom tangents at the endpoints are reflected from the
 * first/last interior segment so the curve passes through the endpoints cleanly.
 */
export function catmullRomSpline2D(
  points: readonly Vec2[],
  samples: number,
  options?: SplineOptions,
): Vec2[] {
  if (points.length < 2) return points.map((p) => ({ x: p.x, y: p.y }));

  const closed = options?.closed === true;
  const n = points.length;
  const result: Vec2[] = [];
  const tmp: Vec2 = { x: 0, y: 0 };

  // Number of segments: n-1 for open, n for closed
  const segments = closed ? n : n - 1;
  const samplesPerSegment = Math.max(1, Math.ceil(samples / segments));
  const totalSamples = samplesPerSegment * segments + (closed ? 0 : 1);

  for (let i = 0; i < totalSamples; i++) {
    const globalT = i / (totalSamples - (closed ? 0 : 1));
    const segF = globalT * segments;
    const seg = Math.min(Math.floor(segF), segments - 1);
    const localT = segF - seg;

    // Resolve the four control points for this segment, wrapping for closed curves
    const getIdx = (idx: number): number => {
      if (closed) return ((idx % n) + n) % n;
      return Math.max(0, Math.min(n - 1, idx));
    };

    const p0 = points[getIdx(seg - 1)];
    const p1 = points[getIdx(seg)];
    const p2 = points[getIdx(seg + 1)];
    const p3 = points[getIdx(seg + 2)];

    if (p0 === undefined || p1 === undefined || p2 === undefined || p3 === undefined) continue;

    catmullRomSegment2D(p0, p1, p2, p3, localT, tmp);
    result.push({ x: tmp.x, y: tmp.y });
  }

  return result;
}

/**
 * Evaluate a Catmull-Rom spline through the given 3D control points.
 */
export function catmullRomSpline3D(
  points: readonly Vec3[],
  samples: number,
  options?: SplineOptions,
): Vec3[] {
  if (points.length < 2) return points.map((p) => ({ x: p.x, y: p.y, z: p.z }));

  const closed = options?.closed === true;
  const n = points.length;
  const result: Vec3[] = [];
  const tmp: Vec3 = { x: 0, y: 0, z: 0 };

  const segments = closed ? n : n - 1;
  const samplesPerSegment = Math.max(1, Math.ceil(samples / segments));
  const totalSamples = samplesPerSegment * segments + (closed ? 0 : 1);

  for (let i = 0; i < totalSamples; i++) {
    const globalT = i / (totalSamples - (closed ? 0 : 1));
    const segF = globalT * segments;
    const seg = Math.min(Math.floor(segF), segments - 1);
    const localT = segF - seg;

    const getIdx = (idx: number): number => {
      if (closed) return ((idx % n) + n) % n;
      return Math.max(0, Math.min(n - 1, idx));
    };

    const p0 = points[getIdx(seg - 1)];
    const p1 = points[getIdx(seg)];
    const p2 = points[getIdx(seg + 1)];
    const p3 = points[getIdx(seg + 2)];

    if (p0 === undefined || p1 === undefined || p2 === undefined || p3 === undefined) continue;

    catmullRomSegment3D(p0, p1, p2, p3, localT, tmp);
    result.push({ x: tmp.x, y: tmp.y, z: tmp.z });
  }

  return result;
}

// ─── Arc-length resampling ───────────────────────────────────────────────────

function dist2D(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function dist3D(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Resample a 2D polyline to `count` points at equal arc-length spacing.
 *
 * Preserves the first and last points exactly. This is critical for lofting —
 * each station ring must start at the keel and end at the sheer, and the point
 * counts must match across all stations for quad-strip connectivity.
 */
export function resampleByArcLength2D(points: readonly Vec2[], count: number): Vec2[] {
  if (count < 2 || points.length < 2) {
    return points.map((p) => ({ x: p.x, y: p.y }));
  }

  // Compute cumulative arc lengths
  const lengths: number[] = [0];
  let totalLength = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    if (prev === undefined || curr === undefined) continue;
    totalLength += dist2D(prev, curr);
    lengths.push(totalLength);
  }

  if (totalLength < 1e-12) {
    // Degenerate curve — all points coincident. Return copies of the first point.
    const p0 = points[0];
    if (p0 === undefined) return [];
    return Array.from({ length: count }, () => ({ x: p0.x, y: p0.y }));
  }

  const result: Vec2[] = [];
  const step = totalLength / (count - 1);

  for (let i = 0; i < count; i++) {
    const targetLen = i * step;

    // Binary search for the segment containing targetLen
    let lo = 0;
    let hi = lengths.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const val = lengths[mid];
      if (val !== undefined && val <= targetLen) lo = mid;
      else hi = mid;
    }

    const segStart = lengths[lo];
    const segEnd = lengths[hi];
    if (segStart === undefined || segEnd === undefined) continue;

    const segLen = segEnd - segStart;
    const t = segLen < 1e-12 ? 0 : (targetLen - segStart) / segLen;

    const a = points[lo];
    const b = points[hi];
    if (a === undefined || b === undefined) continue;

    result.push({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
    });
  }

  return result;
}

/**
 * Resample a 3D polyline to `count` points at equal arc-length spacing.
 * Preserves the first and last points exactly.
 */
export function resampleByArcLength3D(points: readonly Vec3[], count: number): Vec3[] {
  if (count < 2 || points.length < 2) {
    return points.map((p) => ({ x: p.x, y: p.y, z: p.z }));
  }

  const lengths: number[] = [0];
  let totalLength = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    if (prev === undefined || curr === undefined) continue;
    totalLength += dist3D(prev, curr);
    lengths.push(totalLength);
  }

  if (totalLength < 1e-12) {
    const p0 = points[0];
    if (p0 === undefined) return [];
    return Array.from({ length: count }, () => ({ x: p0.x, y: p0.y, z: p0.z }));
  }

  const result: Vec3[] = [];
  const step = totalLength / (count - 1);

  for (let i = 0; i < count; i++) {
    const targetLen = i * step;

    let lo = 0;
    let hi = lengths.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const val = lengths[mid];
      if (val !== undefined && val <= targetLen) lo = mid;
      else hi = mid;
    }

    const segStart = lengths[lo];
    const segEnd = lengths[hi];
    if (segStart === undefined || segEnd === undefined) continue;

    const segLen = segEnd - segStart;
    const t = segLen < 1e-12 ? 0 : (targetLen - segStart) / segLen;

    const a = points[lo];
    const b = points[hi];
    if (a === undefined || b === undefined) continue;

    result.push({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
    });
  }

  return result;
}

// ─── Cubic Bézier ────────────────────────────────────────────────────────────

/**
 * Evaluate a cubic Bézier at parameter t.
 * B(t) = (1-t)³P0 + 3(1-t)²tP1 + 3(1-t)t²P2 + t³P3
 */
export function cubicBezier2D(
  p0: Vec2,
  p1: Vec2,
  p2: Vec2,
  p3: Vec2,
  t: number,
): Vec2 {
  const it = 1 - t;
  const it2 = it * it;
  const it3 = it2 * it;
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: it3 * p0.x + 3 * it2 * t * p1.x + 3 * it * t2 * p2.x + t3 * p3.x,
    y: it3 * p0.y + 3 * it2 * t * p1.y + 3 * it * t2 * p2.y + t3 * p3.y,
  };
}

export function cubicBezier3D(
  p0: Vec3,
  p1: Vec3,
  p2: Vec3,
  p3: Vec3,
  t: number,
): Vec3 {
  const it = 1 - t;
  const it2 = it * it;
  const it3 = it2 * it;
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x: it3 * p0.x + 3 * it2 * t * p1.x + 3 * it * t2 * p2.x + t3 * p3.x,
    y: it3 * p0.y + 3 * it2 * t * p1.y + 3 * it * t2 * p2.y + t3 * p3.y,
    z: it3 * p0.z + 3 * it2 * t * p1.z + 3 * it * t2 * p2.z + t3 * p3.z,
  };
}

/**
 * Evaluate a cubic Bézier curve at `samples` evenly-spaced parametric points.
 * The result is NOT arc-length parameterised — use `resampleByArcLength2D` on
 * the output if uniform spacing is needed.
 */
export function cubicBezierSamples2D(
  p0: Vec2,
  p1: Vec2,
  p2: Vec2,
  p3: Vec2,
  samples: number,
): Vec2[] {
  const result: Vec2[] = [];
  for (let i = 0; i <= samples; i++) {
    result.push(cubicBezier2D(p0, p1, p2, p3, i / samples));
  }
  return result;
}

export function cubicBezierSamples3D(
  p0: Vec3,
  p1: Vec3,
  p2: Vec3,
  p3: Vec3,
  samples: number,
): Vec3[] {
  const result: Vec3[] = [];
  for (let i = 0; i <= samples; i++) {
    result.push(cubicBezier3D(p0, p1, p2, p3, i / samples));
  }
  return result;
}
