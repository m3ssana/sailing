/**
 * Tests for CloudModel.ts (F.2) — layer policy, noise, coverage, temporal helpers.
 */

import { describe, expect, it } from 'vitest';
import type { SkyState } from '@/types';
import { createLightingState } from '@render/lighting/LightingState';
import {
  hash3,
  valueNoise3,
  fbm,
  coverageThreshold,
  cloudDensity,
  measureCoverageFraction,
  cloudLayersFromSky,
  haltonJitter,
  reprojectionBlend,
  quarterResSize,
} from '@render/weather/CloudModel';

function makeSky(partial: Partial<SkyState>): SkyState {
  return {
    sunDirection: { x: 0.3, y: 0.8, z: -0.5 },
    sunElevation: 0.9,
    sunAzimuth: 2,
    moonDirection: { x: 0, y: -1, z: 0 },
    moonElevation: -0.5,
    moonPhase: 0.5,
    siderealTime: 1,
    cloudLow: 0,
    cloudMid: 0,
    cloudHigh: 0,
    isNight: false,
    ...partial,
  };
}

describe('deterministic noise', () => {
  it('hash3 is in [0,1) and deterministic', () => {
    for (let i = 0; i < 20; i++) {
      const v = hash3(i, i * 2, i * 3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(hash3(i, i * 2, i * 3)).toBe(v);
    }
  });

  it('valueNoise3 and fbm are in [0,1] and deterministic', () => {
    for (let i = 0; i < 20; i++) {
      const x = i * 1.7;
      const vn = valueNoise3(x, 0.5, x * 0.3);
      const f = fbm(x, 0.5, x * 0.3);
      expect(vn).toBeGreaterThanOrEqual(0);
      expect(vn).toBeLessThanOrEqual(1);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
      expect(fbm(x, 0.5, x * 0.3)).toBe(f);
    }
  });
});

describe('coverageThreshold', () => {
  it('monotone decreasing in coverage (more cover ⇒ lower threshold)', () => {
    let prev = Infinity;
    for (let c = 0; c <= 1.0001; c += 0.1) {
      const t = coverageThreshold(c);
      expect(t).toBeLessThanOrEqual(prev + 1e-9);
      prev = t;
    }
  });

  it('endpoints pass nothing at coverage 0 and everything at coverage 1', () => {
    // coverageThreshold is the fBm field's inverse-CDF, so the endpoints are
    // thresholds just outside the field's observed range (~[0.10, 0.82]), not
    // literal 1 and 0. The meaningful property is the resulting coverage: a
    // dense grid has ~0 cloud at coverage 0 and ~full cloud at coverage 1.
    expect(measureCoverageFraction(0)).toBeCloseTo(0, 6);
    expect(measureCoverageFraction(1)).toBeCloseTo(1, 6);
    expect(coverageThreshold(0)).toBeGreaterThan(0.82);
    expect(coverageThreshold(1)).toBeLessThan(0.1);
  });
});

describe('coverage-fraction property test', () => {
  it('measured sky fraction matches requested coverage within ±0.08', () => {
    for (let c = 0.1; c <= 0.9 + 1e-9; c += 0.1) {
      const measured = measureCoverageFraction(c);
      expect(Math.abs(measured - c)).toBeLessThanOrEqual(0.08);
    }
  });
});

describe('cloudDensity', () => {
  it('returns 0 in gaps (below threshold) and positive in clouds', () => {
    const layer = {
      frequency: 1 / 2500,
      threshold: coverageThreshold(0.5),
      density: 1,
      detailAmplitude: 0.5,
      drift: { x: 0, y: 0 },
    };
    let sawZero = false;
    let sawPositive = false;
    for (let i = 0; i < 100; i++) {
      const d = cloudDensity(i * 500, i * 377, layer, 0);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
      if (d === 0) sawZero = true;
      if (d > 0) sawPositive = true;
    }
    expect(sawZero).toBe(true);
    expect(sawPositive).toBe(true);
  });

  it('drift advects the field deterministically', () => {
    const layer = {
      frequency: 1 / 2500,
      threshold: coverageThreshold(0.5),
      density: 1,
      detailAmplitude: 0.5,
      drift: { x: 10, y: 0 },
    };
    // Sampling a moving point by the same drift offset reproduces t=0 value.
    const at0 = cloudDensity(1000, 0, layer, 0);
    const atT = cloudDensity(1000 + 10 * 5, 0, layer, 5);
    expect(atT).toBeCloseTo(at0, 10);
  });
});

describe('cloudLayersFromSky — stratus vs cumulus', () => {
  const lighting = createLightingState();
  const overcast = cloudLayersFromSky(
    makeSky({ cloudLow: 1, cloudMid: 1, cloudHigh: 1 }),
    lighting,
  );
  const clear = cloudLayersFromSky(
    makeSky({ cloudLow: 0.2, cloudMid: 0, cloudHigh: 0.1 }),
    lighting,
  );

  const overcastLow = overcast[0];
  const clearLow = clear[0];

  it('returns two layers (low + high)', () => {
    expect(overcast).toHaveLength(2);
    expect(overcast[0]?.kind).toBe('low');
    expect(overcast[1]?.kind).toBe('high');
  });

  it('overcast has higher coverage than clear', () => {
    expect(overcastLow?.coverage).toBeGreaterThan(clearLow?.coverage ?? 1);
    expect(overcastLow?.coverage).toBeCloseTo(1, 6);
    expect(clearLow?.coverage).toBeCloseTo(0.2, 6);
  });

  it('overcast reads flat: lower contrast and lower detail amplitude than clear cumulus', () => {
    expect(overcastLow?.contrast).toBeLessThan(clearLow?.contrast ?? 1);
    expect(overcastLow?.detailAmplitude).toBeLessThan(clearLow?.detailAmplitude ?? 1);
  });

  it('overcast is denser than scattered cumulus', () => {
    expect(overcastLow?.density).toBeGreaterThan(clearLow?.density ?? 1);
  });

  it('overcast deck sits lower and thicker than scattered', () => {
    expect(overcastLow?.baseAltitude).toBeLessThan(clearLow?.baseAltitude ?? 0);
    expect(overcastLow?.thickness).toBeGreaterThan(clearLow?.thickness ?? 0);
  });

  it('wind velocity sets the drift (air-velocity direction)', () => {
    const windy = cloudLayersFromSky(
      makeSky({ cloudLow: 0.5 }),
      lighting,
      { x: 5, y: 0, z: -3 },
    );
    expect(windy[0]?.drift).toEqual({ x: 5, y: -3 });
    // High clouds drift faster.
    expect(Math.abs(windy[1]?.drift.x ?? 0)).toBeGreaterThan(Math.abs(windy[0]?.drift.x ?? 0));
  });

  it('layers carry a silver-lining colour distinct from the shadow colour', () => {
    const s = clearLow;
    expect(s).toBeDefined();
    if (!s) return;
    const silverLum = s.silverLining.r + s.silverLining.g + s.silverLining.b;
    const shadowLum = s.shadowColor.r + s.shadowColor.g + s.shadowColor.b;
    expect(silverLum).toBeGreaterThan(shadowLum);
  });
});

describe('temporal reprojection helpers', () => {
  it('Halton (2,3) known values', () => {
    expect(haltonJitter(1).x).toBeCloseTo(0.5, 10);
    expect(haltonJitter(2).x).toBeCloseTo(0.25, 10);
    expect(haltonJitter(3).x).toBeCloseTo(0.75, 10);
    expect(haltonJitter(1).y).toBeCloseTo(1 / 3, 10);
    expect(haltonJitter(2).y).toBeCloseTo(2 / 3, 10);
    expect(haltonJitter(3).y).toBeCloseTo(1 / 9, 10);
  });

  it('reprojectionBlend drops to 0 on disocclusion', () => {
    expect(reprojectionBlend(0, 1)).toBe(0);
    expect(reprojectionBlend(5, 1)).toBe(0);
  });

  it('reprojectionBlend is high when static and valid, lower with velocity', () => {
    const still = reprojectionBlend(0, 0);
    const fast = reprojectionBlend(50, 0);
    expect(still).toBeGreaterThan(0.5);
    expect(fast).toBeLessThan(still);
    expect(still).toBeGreaterThanOrEqual(fast);
  });

  it('quarterResSize halves and floors (min 1)', () => {
    expect(quarterResSize(1920, 1080)).toEqual({ width: 960, height: 540 });
    expect(quarterResSize(1, 1)).toEqual({ width: 1, height: 1 });
  });
});
