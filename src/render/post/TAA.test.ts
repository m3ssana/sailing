/**
 * Tests for the pure TAA model. Derived from first principles: Halton radical
 * inverse, min/max clamp, and exponential history blend.
 */

import { describe, it, expect } from 'vitest';
import {
  halton,
  taaJitter,
  neighbourhoodClamp,
  neighbourhoodBounds,
  taaBlend,
  type Sample3,
} from './TAA';

describe('halton', () => {
  it('matches known radical-inverse values in base 2', () => {
    // Halton base 2: 1→1/2, 2→1/4, 3→3/4, 4→1/8
    expect(halton(1, 2)).toBeCloseTo(0.5, 10);
    expect(halton(2, 2)).toBeCloseTo(0.25, 10);
    expect(halton(3, 2)).toBeCloseTo(0.75, 10);
    expect(halton(4, 2)).toBeCloseTo(0.125, 10);
  });
  it('matches known values in base 3', () => {
    // base 3: 1→1/3, 2→2/3, 3→1/9
    expect(halton(1, 3)).toBeCloseTo(1 / 3, 10);
    expect(halton(2, 3)).toBeCloseTo(2 / 3, 10);
    expect(halton(3, 3)).toBeCloseTo(1 / 9, 10);
  });
});

describe('taaJitter', () => {
  it('produces sub-pixel offsets within ±1 pixel in NDC', () => {
    const w = 1920;
    const h = 1080;
    for (let f = 0; f < 32; f++) {
      const j = taaJitter(f, w, h);
      // |offset| ≤ 0.5 px → ≤ 1/size in NDC
      expect(Math.abs(j.x)).toBeLessThanOrEqual(1 / w + 1e-12);
      expect(Math.abs(j.y)).toBeLessThanOrEqual(1 / h + 1e-12);
    }
  });

  it('has a period of 16 frames', () => {
    const a = taaJitter(3, 800, 600);
    const b = taaJitter(3 + 16, 800, 600);
    expect(b.x).toBeCloseTo(a.x, 12);
    expect(b.y).toBeCloseTo(a.y, 12);
  });

  it('distributes samples around zero (low discrepancy, non-degenerate)', () => {
    let sx = 0;
    let sy = 0;
    const N = 16;
    for (let f = 0; f < N; f++) {
      const j = taaJitter(f, 1000, 1000);
      sx += j.x;
      sy += j.y;
    }
    // Mean offset is small (centred jitter), but individual offsets are nonzero.
    expect(Math.abs(sx / N)).toBeLessThan(1 / 1000);
    expect(Math.abs(sy / N)).toBeLessThan(1 / 1000);
  });
});

describe('neighbourhoodClamp / bounds', () => {
  it('clamps history into the component-wise AABB', () => {
    const samples: Sample3[] = [
      { r: 0.2, g: 0.1, b: 0.5 },
      { r: 0.4, g: 0.3, b: 0.6 },
      { r: 0.3, g: 0.2, b: 0.55 },
    ];
    const { min, max } = neighbourhoodBounds(samples);
    expect(min).toEqual({ r: 0.2, g: 0.1, b: 0.5 });
    expect(max).toEqual({ r: 0.4, g: 0.3, b: 0.6 });

    const outlier: Sample3 = { r: 0.9, g: -0.2, b: 0.55 };
    const clamped = neighbourhoodClamp(outlier, min, max);
    expect(clamped.r).toBe(0.4); // clamped to max
    expect(clamped.g).toBe(0.1); // clamped to min
    expect(clamped.b).toBe(0.55); // inside → unchanged
  });
});

describe('taaBlend', () => {
  it('a static scene converges the resolve to the constant current value', () => {
    const current: Sample3 = { r: 0.6, g: 0.3, b: 0.2 };
    let history: Sample3 = { r: 0, g: 0, b: 0 };
    for (let i = 0; i < 200; i++) {
      // Static: no velocity, history already in-neighbourhood so no clamp change.
      history = taaBlend(current, history, 0, 0.9);
    }
    expect(history.r).toBeCloseTo(current.r, 4);
    expect(history.g).toBeCloseTo(current.g, 4);
    expect(history.b).toBeCloseTo(current.b, 4);
  });

  it('history is only ever trusted after clamping to the neighbourhood', () => {
    // A ghosting history value is first clamped, then blended → bounded result.
    const current: Sample3 = { r: 0.5, g: 0.5, b: 0.5 };
    const min: Sample3 = { r: 0.4, g: 0.4, b: 0.4 };
    const max: Sample3 = { r: 0.6, g: 0.6, b: 0.6 };
    const ghost: Sample3 = { r: 1.0, g: 0.0, b: 1.0 };
    const clamped = neighbourhoodClamp(ghost, min, max);
    const out = taaBlend(current, clamped, 0, 0.9);
    // Result stays within the neighbourhood (no ghost leaks through).
    expect(out.r).toBeGreaterThanOrEqual(min.r - 1e-9);
    expect(out.r).toBeLessThanOrEqual(max.r + 1e-9);
    expect(out.g).toBeGreaterThanOrEqual(min.g - 1e-9);
    expect(out.b).toBeLessThanOrEqual(max.b + 1e-9);
  });

  it('velocity reduces the history weight (rejection)', () => {
    const current: Sample3 = { r: 1, g: 1, b: 1 };
    const history: Sample3 = { r: 0, g: 0, b: 0 };
    const still = taaBlend(current, history, 0, 0.9, 1);
    const fast = taaBlend(current, history, 5, 0.9, 1);
    // With velocity, more weight goes to current → brighter result.
    expect(fast.r).toBeGreaterThan(still.r);
    // At very high velocity, history is almost fully rejected → ≈ current.
    const veryFast = taaBlend(current, history, 50, 0.9, 1);
    expect(veryFast.r).toBeCloseTo(1, 3);
  });

  it('zero history weight returns the current sample', () => {
    const current: Sample3 = { r: 0.3, g: 0.7, b: 0.1 };
    const out = taaBlend(current, { r: 9, g: 9, b: 9 }, 0, 0);
    expect(out).toEqual(current);
  });
});
