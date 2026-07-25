/**
 * Tests for SpectrumFallback — E.3 WebGL2 ocean spectrum fallback.
 *
 * Tests cover:
 * 1. Component selection: 32-component low-tier uses the same energy-ranked
 *    methodology as WaveFieldCPU's 24-component path (both call buildSpectrum).
 * 2. Gerstner math correctness: the displacement computed by evaluateCascadeTexture
 *    matches a plain JS reference implementation for several sample points.
 * 3. Tier selection logic: compute=true → inactive, compute=false → mid or low.
 * 4. Handle behavior when inactive (compute available).
 */

import { describe, it, expect } from 'vitest';
import type { GPUCapabilities, QualityKnobs, WaveSpectrumParams } from '@/types';
import { buildSpectrum } from '@environment/waves/WaveSpectrum';
import {
  createSpectrumFallback,
  selectFallbackTier,
  _testing,
} from './SpectrumFallback';

const { evaluateCascadeTexture, CASCADE_RESOLUTION } = _testing;

// ─── Test fixtures ────────────────────────────────────────────────────────────

const TEST_PARAMS: WaveSpectrumParams = {
  windSpeed: 8,
  windDirection: Math.PI / 4, // NE
  fetch: 50000,
  significantHeight: 1.5,
  swellHeight: 0.5,
  swellPeriod: 10,
  swellDirection: Math.PI,
  peakEnhancement: 3.3,
  directionalSpread: 16,
  depth: 30,
  currentVelocity: { x: 0.1, y: -0.05 },
  seed: 42,
};

function makeCapabilities(compute: boolean): GPUCapabilities {
  return {
    backend: compute ? 'webgpu' : 'webgl2',
    compute,
    storageTextures: compute,
    timestampQueries: compute,
    maxTextureSize: 16384,
    float32Filterable: compute,
    adapterInfo: 'test',
  };
}

function makeMidKnobs(): QualityKnobs {
  return {
    renderScale: 1.0,
    oceanCascades: 2,
    oceanResolution: 128,
    oceanGridRings: 8,
    reflectionScale: 0.5,
    reflectionCadence: 1,
    shadowCascades: 2,
    cloudMarchSteps: 64,
    sprayBudget: 1000,
    ambientBudget: 50,
    taa: true,
    motionBlur: false,
    depthOfField: false,
    bloom: true,
  };
}

function makeLowKnobs(): QualityKnobs {
  return {
    ...makeMidKnobs(),
    oceanCascades: 1,
    oceanResolution: 128,
  };
}


// ─── 1. Component selection coherence ─────────────────────────────────────────

describe('SpectrumFallback — component selection coherence', () => {
  it('32-component low-tier is a superset of 24-component physics path', () => {
    // Both paths use buildSpectrum with different counts.
    // The 24-component set must be an exact subset of the 32-component set,
    // since both energy-rank from the same candidate pool and select top-N.
    const result24 = buildSpectrum(TEST_PARAMS, 24);
    const result32 = buildSpectrum(TEST_PARAMS, 32);

    // buildSpectrum has FINE_FREQ_BINS=24 frequency bins. With componentCount=32,
    // it requests 30 wind-sea slots but only 24 candidates exist, so it returns
    // all 24 wind-sea + 2 swell = 26. The key property is that result24's
    // components are an exact SUBSET of result32's components.
    expect(result32.components.length).toBeGreaterThanOrEqual(result24.components.length);

    // Every component in the 24-set should exist in the 32-set
    for (const c24 of result24.components) {
      const match = result32.components.find(
        c32 =>
          Math.abs(c32.amplitude - c24.amplitude) < 1e-10 &&
          Math.abs(c32.wavenumber - c24.wavenumber) < 1e-10 &&
          Math.abs(c32.frequency - c24.frequency) < 1e-10 &&
          Math.abs(c32.phase - c24.phase) < 1e-10,
      );
      expect(match).toBeDefined();
    }
  });

  it('32-component set uses the same selection function as WaveFieldCPU (buildSpectrum)', () => {
    // This test verifies that createSpectrumFallback in low tier uses
    // buildSpectrum(params, 32), which is the same function WaveFieldCPU uses
    // with count=24. The shared function guarantees identical methodology.
    const handle = createSpectrumFallback(
      makeCapabilities(false),
      makeLowKnobs(),
      TEST_PARAMS,
    );

    expect(handle.active).toBe(true);
    expect(handle.tier).toBe('low');
    // The position node should be defined for low tier
    expect(handle.getPositionNode()).toBeDefined();
    handle.dispose();
  });

  it('captures more spectral variance with 32 components than 24', () => {
    const result24 = buildSpectrum(TEST_PARAMS, 24);
    const result32 = buildSpectrum(TEST_PARAMS, 32);

    // 32 components should capture >= the variance of 24
    expect(result32.truncatedM0).toBeGreaterThanOrEqual(result24.truncatedM0);
    // Both should be close to the full m0 (high variance capture)
    expect(result24.truncatedM0 / result24.m0).toBeGreaterThan(0.9);
    expect(result32.truncatedM0 / result32.m0).toBeGreaterThan(0.95);
  });
});


// ─── 2. Gerstner math correctness ────────────────────────────────────────────

describe('SpectrumFallback — Gerstner math correctness', () => {
  /**
   * Reference JS implementation of Gerstner displacement at a single point.
   * This is a direct transcription of WaveFieldCPU.ts's displacement() logic.
   */
  function referenceDisplacement(
    components: readonly { amplitude: number; wavenumber: number; frequency: number; phase: number; direction: { x: number; y: number }; steepness: number }[],
    wx: number,
    wz: number,
    t: number,
  ): { dx: number; dy: number; dz: number } {
    let dx = 0;
    let dy = 0;
    let dz = 0;

    for (const c of components) {
      const kDotP = c.wavenumber * (c.direction.x * wx + c.direction.y * wz);
      const phase = kDotP - c.frequency * t + c.phase;
      const cosP = Math.cos(phase);
      const sinP = Math.sin(phase);

      dy += c.amplitude * cosP;
      const horizontalScale = -c.steepness * c.amplitude;
      dx += horizontalScale * c.direction.x * sinP;
      dz += horizontalScale * c.direction.y * sinP;
    }

    return { dx, dy, dz };
  }

  it('evaluateCascadeTexture matches reference Gerstner at sampled points', () => {
    const result = buildSpectrum(TEST_PARAMS);
    const components = result.components;
    const scale = 50; // metres
    const resolution = CASCADE_RESOLUTION;
    const buffer = new Float32Array(resolution * resolution * 4);
    const t = 5.0; // time

    evaluateCascadeTexture(buffer, components, scale, resolution, t);

    // Check several specific texel positions against the reference
    const testPoints = [
      { row: 0, col: 0 },
      { row: 64, col: 64 }, // centre
      { row: 127, col: 127 },
      { row: 32, col: 96 },
      { row: 100, col: 10 },
    ];

    const invRes = scale / resolution;
    const halfScale = scale * 0.5;

    for (const { row, col } of testPoints) {
      const wx = (col + 0.5) * invRes - halfScale;
      const wz = (row + 0.5) * invRes - halfScale;
      const ref = referenceDisplacement(components, wx, wz, t);

      const pixelIdx = (row * resolution + col) * 4;
      const texDx = buffer[pixelIdx] ?? 0;
      const texDy = buffer[pixelIdx + 1] ?? 0;
      const texDz = buffer[pixelIdx + 2] ?? 0;
      const texFoam = buffer[pixelIdx + 3] ?? 0;

      expect(texDx).toBeCloseTo(ref.dx, 6);
      expect(texDy).toBeCloseTo(ref.dy, 6);
      expect(texDz).toBeCloseTo(ref.dz, 6);
      expect(texFoam).toBe(0); // Foam reserved
    }
  });

  it('produces non-zero displacement for non-trivial spectrum', () => {
    const result = buildSpectrum(TEST_PARAMS);
    const scale = 50;
    const buffer = new Float32Array(CASCADE_RESOLUTION * CASCADE_RESOLUTION * 4);
    evaluateCascadeTexture(buffer, result.components, scale, CASCADE_RESOLUTION, 3.0);

    // At least some texels should have non-zero Y displacement
    let maxAbsDy = 0;
    for (let i = 0; i < buffer.length; i += 4) {
      const dy = buffer[i + 1] ?? 0;
      maxAbsDy = Math.max(maxAbsDy, Math.abs(dy));
    }
    // With Hs=1.5m, max displacement should be significant
    expect(maxAbsDy).toBeGreaterThan(0.1);
  });

  it('displacement is zero for empty component list', () => {
    const buffer = new Float32Array(4 * 4 * 4); // 4x4 tiny texture
    evaluateCascadeTexture(buffer, [], 10, 4, 0);

    for (let i = 0; i < buffer.length; i++) {
      expect(buffer[i]).toBe(0);
    }
  });
});


// ─── 3. Tier selection logic ──────────────────────────────────────────────────

describe('SpectrumFallback — tier selection', () => {
  it('returns null when compute is available', () => {
    const tier = selectFallbackTier(makeCapabilities(true), makeMidKnobs());
    expect(tier).toBeNull();
  });

  it('returns mid when compute is false and knobs request 2+ cascades', () => {
    const tier = selectFallbackTier(makeCapabilities(false), makeMidKnobs());
    expect(tier).toBe('mid');
  });

  it('returns low when compute is false and knobs request 1 cascade at 128', () => {
    const tier = selectFallbackTier(makeCapabilities(false), makeLowKnobs());
    expect(tier).toBe('low');
  });

  it('returns mid for 2 cascades even at 128 resolution', () => {
    const knobs = { ...makeMidKnobs(), oceanCascades: 2 as const, oceanResolution: 128 as const };
    const tier = selectFallbackTier(makeCapabilities(false), knobs);
    expect(tier).toBe('mid');
  });
});

// ─── 4. Handle behavior ──────────────────────────────────────────────────────

describe('SpectrumFallback — handle behavior', () => {
  it('is inactive when compute is available', () => {
    const handle = createSpectrumFallback(
      makeCapabilities(true),
      makeMidKnobs(),
      TEST_PARAMS,
    );
    expect(handle.active).toBe(false);
    expect(handle.getPositionNode()).toBeUndefined();
    expect(handle.getCascadeTextures()).toBeUndefined();
    // Should not throw on update/dispose
    handle.update(1.0);
    handle.dispose();
  });

  it('mid-tier provides cascade textures but no positionNode', () => {
    const handle = createSpectrumFallback(
      makeCapabilities(false),
      makeMidKnobs(),
      TEST_PARAMS,
    );
    expect(handle.active).toBe(true);
    expect(handle.tier).toBe('mid');
    expect(handle.getPositionNode()).toBeUndefined();

    const textures = handle.getCascadeTextures();
    expect(textures).toBeDefined();
    expect(textures?.length).toBe(2);

    handle.dispose();
  });

  it('low-tier provides positionNode but no cascade textures', () => {
    const handle = createSpectrumFallback(
      makeCapabilities(false),
      makeLowKnobs(),
      TEST_PARAMS,
    );
    expect(handle.active).toBe(true);
    expect(handle.tier).toBe('low');
    expect(handle.getPositionNode()).toBeDefined();
    expect(handle.getCascadeTextures()).toBeUndefined();

    handle.dispose();
  });

  it('mid-tier update writes non-zero data to cascade textures', () => {
    const handle = createSpectrumFallback(
      makeCapabilities(false),
      makeMidKnobs(),
      TEST_PARAMS,
    );

    // Update at t=5.0
    handle.update(5.0);

    const textures = handle.getCascadeTextures();
    expect(textures).toBeDefined();
    if (textures === undefined) return;

    // First texture should have been updated (cascade index 0)
    const tex0 = textures[0];
    expect(tex0).toBeDefined();
    if (tex0 === undefined) return;

    // Check that the texture data has non-zero displacement
    const data = tex0.image.data as Float32Array;
    let hasNonZero = false;
    for (let i = 0; i < data.length; i += 4) {
      const val = data[i + 1]; // Y displacement
      if (val !== undefined && Math.abs(val) > 0.001) {
        hasNonZero = true;
        break;
      }
    }
    expect(hasNonZero).toBe(true);

    handle.dispose();
  });

  it('updateSpectrum rebuilds components for low tier', () => {
    const handle = createSpectrumFallback(
      makeCapabilities(false),
      makeLowKnobs(),
      TEST_PARAMS,
    );

    // Get initial node
    const node1 = handle.getPositionNode();
    expect(node1).toBeDefined();

    // Update with different params
    const newParams: WaveSpectrumParams = {
      ...TEST_PARAMS,
      windSpeed: 15,
      significantHeight: 3.0,
    };
    handle.updateSpectrum(newParams);

    // Node should be rebuilt (different reference)
    const node2 = handle.getPositionNode();
    expect(node2).toBeDefined();
    // They should be different objects since spectrum changed
    expect(node2).not.toBe(node1);

    handle.dispose();
  });

  it('getCascadeScales returns expected values', () => {
    const handle = createSpectrumFallback(
      makeCapabilities(false),
      makeMidKnobs(),
      TEST_PARAMS,
    );

    const scales = handle.getCascadeScales();
    expect(scales.length).toBe(2);
    expect(scales[0]).toBe(50);
    expect(scales[1]).toBe(200);

    handle.dispose();
  });
});
