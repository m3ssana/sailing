import { describe, it, expect } from 'vitest';
import {
  gustContrastScale,
  effectiveGustIntensity,
  DEEP_NIGHT_NO_MOON_FLOOR,
} from './GustVisibility';

const FULL_MOON = 0.02;

describe('gustContrastScale', () => {
  it('is exactly 1.0 by full day regardless of moon', () => {
    expect(gustContrastScale({ nightFactor: 0 }, 0)).toBeCloseTo(1, 6);
    expect(gustContrastScale({ nightFactor: 0 }, FULL_MOON)).toBeCloseTo(1, 6);
  });

  it('is <= 0.35 at deep night with no moon', () => {
    const s = gustContrastScale({ nightFactor: 1 }, 0);
    expect(s).toBeLessThanOrEqual(0.35);
    expect(s).toBeCloseTo(DEEP_NIGHT_NO_MOON_FLOOR, 6);
  });

  it('is partially restored by moonlight at deep night', () => {
    const noMoon = gustContrastScale({ nightFactor: 1 }, 0);
    const halfMoon = gustContrastScale({ nightFactor: 1 }, FULL_MOON * 0.5);
    const fullMoon = gustContrastScale({ nightFactor: 1 }, FULL_MOON);
    expect(halfMoon).toBeGreaterThan(noMoon);
    expect(fullMoon).toBeGreaterThan(halfMoon);
    // Full moon restores up to half the lost contrast → floor rises to ~0.65.
    expect(fullMoon).toBeCloseTo(0.3 + 0.5 * 0.7, 6);
  });

  it('is monotone decreasing in nightFactor (no moon)', () => {
    let prev = Infinity;
    for (let nf = 0; nf <= 1.0001; nf += 0.1) {
      const s = gustContrastScale({ nightFactor: Math.min(1, nf) }, 0);
      expect(s).toBeLessThanOrEqual(prev + 1e-9);
      prev = s;
    }
  });

  it('is monotone increasing in moonlight at fixed night', () => {
    let prev = -Infinity;
    for (let m = 0; m <= FULL_MOON * 1.0001; m += FULL_MOON / 10) {
      const s = gustContrastScale({ nightFactor: 1 }, m);
      expect(s).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = s;
    }
  });

  it('stays within (0, 1] everywhere', () => {
    for (let nf = 0; nf <= 1; nf += 0.25) {
      for (let m = 0; m <= FULL_MOON * 2; m += FULL_MOON / 4) {
        const s = gustContrastScale({ nightFactor: nf }, m);
        expect(s).toBeGreaterThan(0);
        expect(s).toBeLessThanOrEqual(1);
      }
    }
  });

  it('does not overshoot above-full moonlight', () => {
    const full = gustContrastScale({ nightFactor: 1 }, FULL_MOON);
    const superFull = gustContrastScale({ nightFactor: 1 }, FULL_MOON * 3);
    expect(superFull).toBeCloseTo(full, 6);
  });
});

describe('effectiveGustIntensity', () => {
  it('equals raw intensity by day', () => {
    expect(effectiveGustIntensity(0.8, { nightFactor: 0 }, 0)).toBeCloseTo(0.8, 6);
  });

  it('is darkened less at night (readability drops)', () => {
    const day = effectiveGustIntensity(0.8, { nightFactor: 0 }, 0);
    const night = effectiveGustIntensity(0.8, { nightFactor: 1 }, 0);
    expect(night).toBeLessThan(day);
    expect(night).toBeCloseTo(0.8 * DEEP_NIGHT_NO_MOON_FLOOR, 6);
  });

  it('clamps raw intensity into [0,1]', () => {
    expect(effectiveGustIntensity(5, { nightFactor: 0 }, 0)).toBeCloseTo(1, 6);
    expect(effectiveGustIntensity(-2, { nightFactor: 0 }, 0)).toBe(0);
  });
});

describe('GustVisibility — NaN poisoning guards (audit fix #3)', () => {
  it('gustContrastScale never returns NaN for non-finite inputs', () => {
    expect(Number.isNaN(gustContrastScale({ nightFactor: NaN }, 0))).toBe(false);
    expect(Number.isNaN(gustContrastScale({ nightFactor: 1 }, NaN))).toBe(false);
    expect(Number.isNaN(gustContrastScale({ nightFactor: NaN }, NaN))).toBe(false);
    expect(Number.isNaN(gustContrastScale({ nightFactor: Infinity }, -Infinity))).toBe(false);
    // Stays in range.
    const s = gustContrastScale({ nightFactor: NaN }, NaN);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  it('a NaN nightFactor is treated as day (0) → contrast 1', () => {
    expect(gustContrastScale({ nightFactor: NaN }, 0)).toBeCloseTo(1, 6);
  });

  it('effectiveGustIntensity never returns NaN for non-finite inputs', () => {
    expect(Number.isNaN(effectiveGustIntensity(NaN, { nightFactor: 1 }, 0))).toBe(false);
    expect(Number.isNaN(effectiveGustIntensity(0.8, { nightFactor: NaN }, 0))).toBe(false);
    expect(Number.isNaN(effectiveGustIntensity(0.8, { nightFactor: 1 }, NaN))).toBe(false);
    expect(effectiveGustIntensity(NaN, { nightFactor: 0 }, 0)).toBe(0);
  });
});
