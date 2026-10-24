/**
 * TAA — PURE temporal-anti-aliasing model (Stream F.3).
 *
 * NO three.js. These are the three decisions a TAA resolve makes, factored out
 * so they can be unit-tested headlessly: where to jitter the projection, how to
 * clamp reprojected history to the local neighbourhood (to reject ghosting), and
 * how to blend current and history.
 *
 * `haltonJitter` already exists in src/render/weather/CloudModel.ts; per the
 * import-boundary/module-group rule we do NOT import it across module groups and
 * define our own `taaJitter` here.
 *
 * Conventions: NDC sub-pixel offsets are in the range (−1, +1) normalised device
 * coordinates; a one-pixel offset equals `2/width` in NDC x and `2/height` in y.
 */

// ─── Halton low-discrepancy sequence ───────────────────────────────────────────

/** `index`-th value of the radical-inverse Halton sequence in the given base.
 *  `index` is 1-based by convention (index 0 yields 0). */
export function halton(index: number, base: number): number {
  let result = 0;
  let f = 1 / base;
  let i = index;
  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }
  return result;
}

/** A sub-pixel jitter offset in NDC. */
export interface Jitter {
  /** NDC x offset, (−1, 1). */
  x: number;
  /** NDC y offset, (−1, 1). */
  y: number;
}

/**
 * TAA sub-pixel jitter for a given frame, using the Halton(2,3) sequence
 * (the standard TAA choice). The raw Halton pair in [0,1) is recentred to
 * [−0.5, 0.5) pixels, then converted to NDC via the viewport size.
 *
 * Period of the sequence is 16 frames (a common TAA cadence); the frame index
 * is taken modulo 16 so the pattern repeats and history converges.
 *
 * @param frameIndex Frame counter (any non-negative integer).
 * @param width      Viewport width in pixels (> 0).
 * @param height     Viewport height in pixels (> 0).
 */
export function taaJitter(frameIndex: number, width: number, height: number): Jitter {
  const n = (Math.abs(Math.floor(frameIndex)) % 16) + 1; // 1-based, period 16
  const hx = halton(n, 2) - 0.5; // [−0.5, 0.5) pixels
  const hy = halton(n, 3) - 0.5;
  // One pixel == 2/size in NDC.
  return {
    x: (hx * 2) / Math.max(1, width),
    y: (hy * 2) / Math.max(1, height),
  };
}

// ─── Neighbourhood clamp ───────────────────────────────────────────────────────

/** A per-channel RGB sample. */
export interface Sample3 {
  r: number;
  g: number;
  b: number;
}

/**
 * Clamp a history sample component-wise into the AABB `[min, max]` formed by the
 * current pixel's spatial neighbourhood (the classic variance/min-max clamp that
 * rejects ghosting). Returns a new sample.
 */
export function neighbourhoodClamp(history: Sample3, min: Sample3, max: Sample3): Sample3 {
  const c = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  return {
    r: c(history.r, min.r, max.r),
    g: c(history.g, min.g, max.g),
    b: c(history.b, min.b, max.b),
  };
}

/** Compute the component-wise min/max of a set of neighbourhood samples. */
export function neighbourhoodBounds(samples: readonly Sample3[]): { min: Sample3; max: Sample3 } {
  const min: Sample3 = { r: Infinity, g: Infinity, b: Infinity };
  const max: Sample3 = { r: -Infinity, g: -Infinity, b: -Infinity };
  for (const s of samples) {
    min.r = Math.min(min.r, s.r);
    min.g = Math.min(min.g, s.g);
    min.b = Math.min(min.b, s.b);
    max.r = Math.max(max.r, s.r);
    max.g = Math.max(max.g, s.g);
    max.b = Math.max(max.b, s.b);
  }
  return { min, max };
}

// ─── Blend ─────────────────────────────────────────────────────────────────────

/**
 * Blend the current sample with the (already clamped) history sample.
 *
 * The history weight starts from `baseHistoryWeight` (e.g. 0.9 → the resolve is
 * 90% history, 10% current, giving ~10-frame convergence) and is REDUCED by the
 * reprojection velocity: fast-moving pixels trust history less, because
 * reprojection error grows with motion. The velocity rejection uses
 * `w = baseHistoryWeight · exp(−velocity · velocitySensitivity)`.
 *
 * For a static scene (velocity 0) repeatedly blending a constant current value
 * converges the output to that value (the mean), which the tests assert.
 *
 * @param current           This frame's resolved colour.
 * @param historyClamped    Neighbourhood-clamped reprojected history.
 * @param velocity          Reprojection speed in pixels (≥ 0).
 * @param baseHistoryWeight History weight at zero velocity, 0..1 (default 0.9).
 * @param velocitySensitivity Exponential rejection rate (default 1.0, per pixel).
 */
export function taaBlend(
  current: Sample3,
  historyClamped: Sample3,
  velocity: number,
  baseHistoryWeight = 0.9,
  velocitySensitivity = 1.0,
): Sample3 {
  const base = Math.min(1, Math.max(0, baseHistoryWeight));
  const v = Math.max(0, velocity);
  const w = base * Math.exp(-v * Math.max(0, velocitySensitivity));
  const cw = 1 - w;
  return {
    r: current.r * cw + historyClamped.r * w,
    g: current.g * cw + historyClamped.g * w,
    b: current.b * cw + historyClamped.b * w,
  };
}
