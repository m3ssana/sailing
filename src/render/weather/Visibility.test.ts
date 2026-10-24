/**
 * Tests for Visibility.ts (F.2) — Koschmieder aerial perspective.
 *
 * Headless: pure-model assertions plus TSL node builds in node without throwing.
 */

import { describe, expect, it } from 'vitest';
import type { RGB } from '@/types';
import { createLightingState } from '@render/lighting/LightingState';
import {
  CONTRAST_THRESHOLD,
  MIN_VISIBILITY,
  MAX_VISIBILITY,
  clampVisibility,
  extinction,
  transmittance,
  apparentContrast,
  fogFarDistance,
  aerialPerspective,
  createVisibilityUniforms,
  applyAerialPerspectiveNode,
} from '@render/weather/Visibility';
import { float } from 'three/tsl';

describe('Koschmieder relation', () => {
  it('extinction beta = 3.912 / V', () => {
    const V = 10_000;
    expect(extinction(V)).toBeCloseTo(3.912023 / V, 9);
  });

  it('apparent contrast is exactly the threshold 0.02 at distance == visibility', () => {
    for (const V of [100, 1_000, 10_000, 50_000]) {
      expect(apparentContrast(V, V)).toBeCloseTo(CONTRAST_THRESHOLD, 9);
    }
  });

  it('apparent contrast at 0.1·V is > 0.67', () => {
    for (const V of [500, 5_000, 40_000]) {
      expect(apparentContrast(0.1 * V, V)).toBeGreaterThan(0.67);
    }
  });

  it('contrast at 0.1·V equals 0.02^0.1 ≈ 0.6762', () => {
    const V = 10_000;
    expect(apparentContrast(0.1 * V, V)).toBeCloseTo(Math.pow(0.02, 0.1), 6);
  });
});

describe('transmittance', () => {
  it('is 1 at distance 0', () => {
    expect(transmittance(0, 5_000)).toBeCloseTo(1, 12);
  });

  it('is monotone decreasing in distance', () => {
    let prev = Infinity;
    for (let d = 0; d <= 20_000; d += 500) {
      const t = transmittance(d, 5_000);
      expect(t).toBeLessThanOrEqual(prev + 1e-12);
      prev = t;
    }
  });
});

describe('visibility clamp', () => {
  it('clamps to [50 m, 80 km]', () => {
    expect(clampVisibility(10)).toBe(MIN_VISIBILITY);
    expect(clampVisibility(1_000_000)).toBe(MAX_VISIBILITY);
    expect(clampVisibility(5_000)).toBe(5_000);
  });

  it('non-finite visibility falls back to max', () => {
    expect(clampVisibility(NaN)).toBe(MAX_VISIBILITY);
    expect(clampVisibility(Infinity)).toBe(MAX_VISIBILITY);
  });

  it('fogFarDistance returns the clamped visibility', () => {
    expect(fogFarDistance(1)).toBe(MIN_VISIBILITY);
    expect(fogFarDistance(12_345)).toBe(12_345);
  });
});

describe('aerialPerspective', () => {
  const color: RGB = { r: 0.1, g: 0.6, b: 0.3 };
  const fog: RGB = { r: 0.7, g: 0.75, b: 0.8 };

  it('returns the input colour at distance 0', () => {
    const out: RGB = { r: 0, g: 0, b: 0 };
    aerialPerspective(color, fog, 0, 5_000, out);
    expect(out.r).toBeCloseTo(color.r, 10);
    expect(out.g).toBeCloseTo(color.g, 10);
    expect(out.b).toBeCloseTo(color.b, 10);
  });

  it('converges to the fog colour at large distance', () => {
    const out: RGB = { r: 0, g: 0, b: 0 };
    aerialPerspective(color, fog, 1_000_000, 1_000, out);
    expect(out.r).toBeCloseTo(fog.r, 4);
    expect(out.g).toBeCloseTo(fog.g, 4);
    expect(out.b).toBeCloseTo(fog.b, 4);
  });

  it('height falloff reduces the fade at altitude', () => {
    const low: RGB = { r: 0, g: 0, b: 0 };
    const high: RGB = { r: 0, g: 0, b: 0 };
    aerialPerspective(color, fog, 8_000, 5_000, low, 0);
    aerialPerspective(color, fog, 8_000, 5_000, high, 5_000);
    // Higher sample retains more of its own colour (less fog mix).
    const lowMix = Math.abs(low.r - color.r);
    const highMix = Math.abs(high.r - color.r);
    expect(highMix).toBeLessThan(lowMix);
  });

  it('writes into and returns the out object', () => {
    const out: RGB = { r: 0, g: 0, b: 0 };
    const ret = aerialPerspective(color, fog, 100, 5_000, out);
    expect(ret).toBe(out);
  });
});

describe('TSL layer builds in node', () => {
  it('creates uniforms and updates without throwing', () => {
    const u = createVisibilityUniforms();
    expect(u.beta).toBeDefined();
    expect(() => u.update(5_000, createLightingState())).not.toThrow();
  });

  it('builds the aerial-perspective node without throwing', () => {
    const u = createVisibilityUniforms();
    const node = applyAerialPerspectiveNode(float(0.5), float(1000), u);
    expect(node).toBeDefined();
  });
});
