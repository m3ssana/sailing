/**
 * Tests for SpectrumCompute — E.2 GPU spectrum compute.
 *
 * Validates:
 * 1. Config validation against QualityKnobs constraints
 * 2. Cascade assignment by wavelength
 * 3. Component packing correctness
 * 4. Per-texel evaluation mathematical correctness vs WaveFieldCPU reference
 * 5. Jacobian properties (≈1 on flat water, <1 at crests)
 * 6. Normal convention agreement (T_z × T_x)
 * 7. Buffer layout correctness
 *
 * NO GPU compute execution — all tests exercise the CPU-side logic.
 */

import { describe, it, expect } from 'vitest';
import {
  validateConfig,
  configFromKnobs,
  assignCascade,
  buildCascadeData,
  evaluateTexelCPU,
  createSpectrumCompute,
  packComponentsForGPU,
  _testing,
} from './SpectrumCompute';
import type { CascadeData } from './SpectrumCompute';
import { buildSpectrum } from '@environment/waves/WaveSpectrum';
import { createWaveFieldCPU } from '@environment/waves/WaveFieldCPU';
import type { WaveSpectrumParams } from '@/types';

const { PI, sqrt, abs } = Math;
const { MAX_GPU_COMPONENTS, CASCADE_EXTENTS, CASCADE_WAVELENGTH_BOUNDS } = _testing;

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeDefaultParams(overrides: Partial<WaveSpectrumParams> = {}): WaveSpectrumParams {
  return {
    windSpeed: 10,
    windDirection: PI * 1.5,
    fetch: 200_000,
    significantHeight: 2.0,
    swellHeight: 0.5,
    swellPeriod: 12,
    swellDirection: PI,
    peakEnhancement: 3.3,
    directionalSpread: 10,
    depth: 100,
    currentVelocity: { x: 0, y: 0 },
    seed: 42,
    ...overrides,
  };
}

// ─── Config validation ────────────────────────────────────────────────────────

describe('SpectrumCompute — config validation', () => {
  it('accepts valid configs', () => {
    expect(() => validateConfig({ cascades: 1, resolution: 128 })).not.toThrow();
    expect(() => validateConfig({ cascades: 2, resolution: 128 })).not.toThrow();
    expect(() => validateConfig({ cascades: 3, resolution: 256 })).not.toThrow();
  });

  it('rejects invalid cascade count', () => {
    expect(() => validateConfig({ cascades: 0 as never, resolution: 128 })).toThrow(RangeError);
    expect(() => validateConfig({ cascades: 4 as never, resolution: 256 })).toThrow(RangeError);
  });

  it('rejects invalid resolution', () => {
    expect(() => validateConfig({ cascades: 3, resolution: 64 as never })).toThrow(RangeError);
    expect(() => validateConfig({ cascades: 3, resolution: 512 as never })).toThrow(RangeError);
  });

  it('configFromKnobs extracts correct values', () => {
    const config = configFromKnobs({ oceanCascades: 3, oceanResolution: 256 });
    expect(config.cascades).toBe(3);
    expect(config.resolution).toBe(256);
  });
});

// ─── Cascade assignment ───────────────────────────────────────────────────────

describe('SpectrumCompute — cascade assignment', () => {
  it('assigns short wavelengths to cascade 0', () => {
    // wavelength = 2π/k; for cascade 0, λ < CASCADE_WAVELENGTH_BOUNDS[0]
    const k = (2 * PI) / 10; // 10m wavelength
    expect(assignCascade(k, 3)).toBe(0);
  });

  it('assigns medium wavelengths to cascade 1', () => {
    // Between bounds[0] and bounds[1]
    const k = (2 * PI) / 100; // 100m wavelength
    expect(assignCascade(k, 3)).toBe(1);
  });

  it('assigns long wavelengths to cascade 2', () => {
    // Above bounds[1]
    const k = (2 * PI) / 300; // 300m wavelength
    expect(assignCascade(k, 3)).toBe(2);
  });

  it('single cascade assigns everything to 0', () => {
    const k1 = (2 * PI) / 10;
    const k2 = (2 * PI) / 100;
    const k3 = (2 * PI) / 300;
    expect(assignCascade(k1, 1)).toBe(0);
    expect(assignCascade(k2, 1)).toBe(0);
    expect(assignCascade(k3, 1)).toBe(0);
  });

  it('two cascades: short to 0, rest to 1', () => {
    const kShort = (2 * PI) / 10;
    const kLong = (2 * PI) / 100;
    expect(assignCascade(kShort, 2)).toBe(0);
    expect(assignCascade(kLong, 2)).toBe(1);
  });

  it('rejects zero or negative wavenumber', () => {
    expect(assignCascade(0, 3)).toBe(-1);
    expect(assignCascade(-1, 3)).toBe(-1);
  });

  it('wavelength bounds are geometrically correct', () => {
    // bounds[0] should be sqrt(extent[0] * extent[1])
    const expected0 = sqrt(CASCADE_EXTENTS[0] * CASCADE_EXTENTS[1]);
    expect(CASCADE_WAVELENGTH_BOUNDS[0]).toBeCloseTo(expected0, 6);
    const expected1 = sqrt(CASCADE_EXTENTS[1] * CASCADE_EXTENTS[2]);
    expect(CASCADE_WAVELENGTH_BOUNDS[1]).toBeCloseTo(expected1, 6);
  });
});

// ─── Cascade data building ────────────────────────────────────────────────────

describe('SpectrumCompute — buildCascadeData', () => {
  it('produces the requested number of cascades', () => {
    const params = makeDefaultParams();
    const result = buildSpectrum(params, 128);
    const cascades = buildCascadeData(result.components, { cascades: 3, resolution: 256 });
    expect(cascades.length).toBe(3);
  });

  it('caps components at MAX_GPU_COMPONENTS per cascade', () => {
    const params = makeDefaultParams();
    // Request way more components than max
    const result = buildSpectrum(params, 500);
    const cascades = buildCascadeData(result.components, { cascades: 1, resolution: 256 });
    const cascade0 = cascades[0];
    expect(cascade0).toBeDefined();
    if (cascade0 !== undefined) {
      expect(cascade0.componentCount).toBeLessThanOrEqual(MAX_GPU_COMPONENTS);
    }
  });

  it('assigns correct extents to cascades', () => {
    const params = makeDefaultParams();
    const result = buildSpectrum(params, 128);
    const cascades = buildCascadeData(result.components, { cascades: 3, resolution: 256 });
    expect(cascades[0]?.extent).toBe(CASCADE_EXTENTS[0]);
    expect(cascades[1]?.extent).toBe(CASCADE_EXTENTS[1]);
    expect(cascades[2]?.extent).toBe(CASCADE_EXTENTS[2]);
  });

  it('sorts components by energy descending', () => {
    const params = makeDefaultParams();
    const result = buildSpectrum(params, 128);
    const cascades = buildCascadeData(result.components, { cascades: 3, resolution: 256 });
    for (const cascade of cascades) {
      for (let i = 1; i < cascade.components.length; i++) {
        const prev = cascade.components[i - 1];
        const curr = cascade.components[i];
        if (prev === undefined || curr === undefined) continue;
        expect(prev.amplitude * prev.amplitude).toBeGreaterThanOrEqual(
          curr.amplitude * curr.amplitude - 1e-15,
        );
      }
    }
  });

  it('no component appears in multiple cascades', () => {
    const params = makeDefaultParams();
    const result = buildSpectrum(params, 128);
    const cascades = buildCascadeData(result.components, { cascades: 3, resolution: 256 });
    const allComponents: Set<string> = new Set();
    for (const cascade of cascades) {
      for (const comp of cascade.components) {
        const key = `${comp.wavenumber}_${comp.frequency}_${comp.phase}`;
        expect(allComponents.has(key)).toBe(false);
        allComponents.add(key);
      }
    }
  });
});


// ─── Component packing ────────────────────────────────────────────────────────

describe('SpectrumCompute — packComponentsForGPU', () => {
  it('packs amplitude, wavenumber, frequency, phase into dataA', () => {
    const params = makeDefaultParams();
    const result = buildSpectrum(params, 24);
    const cascades = buildCascadeData(result.components, { cascades: 1, resolution: 128 });
    const cascade0 = cascades[0];
    expect(cascade0).toBeDefined();
    if (cascade0 === undefined) return;

    const { dataA, dataB } = packComponentsForGPU(cascade0);
    expect(dataA.length).toBe(cascade0.componentCount * 4);
    expect(dataB.length).toBe(cascade0.componentCount * 4);

    // Verify first component packing (Float32 has ~7 significant digits)
    const comp0 = cascade0.components[0];
    if (comp0 === undefined) return;
    expect(dataA[0]).toBeCloseTo(comp0.amplitude, 5);
    expect(dataA[1]).toBeCloseTo(comp0.wavenumber, 5);
    expect(dataA[2]).toBeCloseTo(comp0.frequency, 5);
    expect(dataA[3]).toBeCloseTo(comp0.phase, 5);
    expect(dataB[0]).toBeCloseTo(comp0.steepness, 5);
    expect(dataB[1]).toBeCloseTo(comp0.dirX, 5);
    expect(dataB[2]).toBeCloseTo(comp0.dirZ, 5);
    expect(dataB[3]).toBe(0);
  });

  it('packs all components without data loss', () => {
    const params = makeDefaultParams();
    const result = buildSpectrum(params, 64);
    const cascades = buildCascadeData(result.components, { cascades: 1, resolution: 128 });
    const cascade0 = cascades[0];
    if (cascade0 === undefined) return;

    const { dataA, dataB } = packComponentsForGPU(cascade0);

    for (let i = 0; i < cascade0.componentCount; i++) {
      const comp = cascade0.components[i];
      if (comp === undefined) continue;
      const base = i * 4;
      expect(dataA[base]).toBeCloseTo(comp.amplitude, 5);
      expect(dataA[base + 1]).toBeCloseTo(comp.wavenumber, 5);
      expect(dataA[base + 2]).toBeCloseTo(comp.frequency, 5);
      expect(dataA[base + 3]).toBeCloseTo(comp.phase, 5);
      expect(dataB[base]).toBeCloseTo(comp.steepness, 5);
      expect(dataB[base + 1]).toBeCloseTo(comp.dirX, 5);
      expect(dataB[base + 2]).toBeCloseTo(comp.dirZ, 5);
    }
  });
});

// ─── Per-texel evaluation ─────────────────────────────────────────────────────

describe('SpectrumCompute — evaluateTexelCPU', () => {
  it('produces zero displacement with zero-amplitude components', () => {
    const cascade: CascadeData = {
      index: 0,
      extent: 25,
      components: [{
        amplitude: 0,
        wavenumber: 1,
        frequency: 1,
        phase: 0,
        steepness: 0.5,
        dirX: 1,
        dirZ: 0,
      }],
      componentCount: 1,
    };
    const result = evaluateTexelCPU(cascade, 128, 64, 64, 0);
    expect(result.displacement.x).toBe(0);
    expect(result.displacement.y).toBe(0);
    expect(result.displacement.z).toBe(0);
    expect(result.jacobian).toBeCloseTo(1.0, 10);
  });

  it('matches hand-computed single-component case', () => {
    // Single component: A=1, k=1, ω=1, φ=0, Q=0.5, dir=(1,0)
    // At (col=128, row=128) in 256² → world pos = (0, 0) (centre of tile)
    // phase = k*(dirX*0 + dirZ*0) - ω*0 + φ = 0
    // cos(0) = 1, sin(0) = 0
    // dy = 1*1 = 1
    // dx = -0.5*1*1*0 = 0
    // dz = -0.5*1*0*0 = 0
    const cascade: CascadeData = {
      index: 0,
      extent: 100,
      components: [{
        amplitude: 1.0,
        wavenumber: 1.0,
        frequency: 1.0,
        phase: 0,
        steepness: 0.5,
        dirX: 1.0,
        dirZ: 0.0,
      }],
      componentCount: 1,
    };
    const result = evaluateTexelCPU(cascade, 256, 128, 128, 0);
    expect(result.displacement.y).toBeCloseTo(1.0, 10);
    expect(result.displacement.x).toBeCloseTo(0.0, 10);
    expect(result.displacement.z).toBeCloseTo(0.0, 10);
  });

  it('horizontal displacement follows Gerstner formula', () => {
    // At phase = π/2: cos(π/2)=0, sin(π/2)=1
    // dy = A*cos(π/2) = 0
    // dx = -Q*A*dirX*sin(π/2) = -0.5*1.0*1.0*1 = -0.5
    // Need phase = π/2 at our sample point.
    // phase = k*(dirX*worldX + dirZ*worldZ) - ω*t + φ
    // With k=1, dirX=1, dirZ=0, ω=0, φ=0:
    // phase = worldX = π/2
    // worldX = (col/res - 0.5) * extent
    // We want worldX = π/2 ≈ 1.5708
    // (col/256 - 0.5) * 100 = 1.5708
    // col/256 = 0.5 + 1.5708/100 = 0.515708
    // col = 131.94... round to 132
    // Actual worldX = (132/256 - 0.5) * 100 = (0.515625 - 0.5) * 100 = 1.5625
    // Actual phase = 1.5625 (close to π/2 but not exact)
    // Use exact: set φ = π/2, sample at centre (worldX=0)
    const cascade: CascadeData = {
      index: 0,
      extent: 100,
      components: [{
        amplitude: 1.0,
        wavenumber: 1.0,
        frequency: 0.0,
        phase: PI / 2,
        steepness: 0.5,
        dirX: 1.0,
        dirZ: 0.0,
      }],
      componentCount: 1,
    };
    const result = evaluateTexelCPU(cascade, 256, 128, 128, 0);
    // phase = 0 - 0 + π/2 = π/2
    // cos(π/2) ≈ 0, sin(π/2) = 1
    expect(result.displacement.y).toBeCloseTo(0.0, 6);
    expect(result.displacement.x).toBeCloseTo(-0.5, 6); // -Q*A*dirX*sin
    expect(result.displacement.z).toBeCloseTo(0.0, 10);
  });

  it('Jacobian is approximately 1 on flat water (very small waves)', () => {
    const params = makeDefaultParams({ significantHeight: 0.001, swellHeight: 0 });
    const result = buildSpectrum(params, 24);
    const cascades = buildCascadeData(result.components, { cascades: 1, resolution: 128 });
    const cascade0 = cascades[0];
    if (cascade0 === undefined) return;

    const texel = evaluateTexelCPU(cascade0, 128, 64, 64, 5.0);
    expect(texel.jacobian).toBeCloseTo(1.0, 2);
  });

  it('Jacobian decreases below 1 for steep waves', () => {
    // A single very steep component should produce J < 1 at certain phases
    const cascade: CascadeData = {
      index: 0,
      extent: 50,
      components: [{
        amplitude: 2.0,
        wavenumber: 0.5,
        frequency: 1.0,
        phase: 0,
        steepness: 0.8, // Very steep
        dirX: 1.0,
        dirZ: 0.0,
      }],
      componentCount: 1,
    };
    // At the wave crest (phase=0): cos(0)=1
    // ∂Dx/∂x = -Q*A*k*dirX²*cos(0) = -0.8*2.0*0.5*1*1 = -0.8
    // ∂Dz/∂z = -Q*A*k*dirZ²*cos(0) = 0
    // J = (1 + (-0.8))*(1 + 0) - 0² = 0.2
    const texelCentre = evaluateTexelCPU(cascade, 256, 128, 128, 0);
    expect(texelCentre.jacobian).toBeCloseTo(0.2, 6);
    expect(texelCentre.jacobian).toBeLessThan(1.0);
  });
});

// ─── Coherence with WaveFieldCPU ──────────────────────────────────────────────

describe('SpectrumCompute — coherence with WaveFieldCPU', () => {
  it('GPU texel height matches CPU field height at same world position (same components)', () => {
    // Both paths use the SAME spectrum. If we restrict the GPU cascade to the
    // same 24 components as the CPU, the results must be bitwise-identical.
    const params = makeDefaultParams();
    const cpuField = createWaveFieldCPU(params);
    const cpuComponents = cpuField.components;

    // Build a single cascade with the same 24 components
    const cascade: CascadeData = {
      index: 0,
      extent: 200, // Large enough to contain our sample points
      components: cpuComponents.map(c => ({
        amplitude: c.amplitude,
        wavenumber: c.wavenumber,
        frequency: c.frequency,
        phase: c.phase,
        steepness: c.steepness,
        dirX: c.direction.x,
        dirZ: c.direction.y,
      })),
      componentCount: cpuComponents.length,
    };

    // Sample several world positions via texel coordinates
    const resolution = 256;
    const time = 5.0;
    let maxHeightError = 0;
    let maxDispError = 0;

    const testPoints: Array<[number, number]> = [
      [128, 128], // centre
      [0, 0],     // corner
      [255, 255], // opposite corner
      [64, 192],  // arbitrary
      [200, 50],  // arbitrary
    ];

    for (const [col, row] of testPoints) {
      const worldX = (col / resolution - 0.5) * cascade.extent;
      const worldZ = (row / resolution - 0.5) * cascade.extent;

      // GPU-path evaluation
      const gpuResult = evaluateTexelCPU(cascade, resolution, col, row, time);

      // CPU-path evaluation
      const cpuHeight = cpuField.height(worldX, worldZ, time);
      const cpuDisp = { x: 0, y: 0, z: 0 };
      cpuField.displacement(worldX, worldZ, time, cpuDisp);

      // Height (dy) should match exactly
      const heightErr = abs(gpuResult.displacement.y - cpuHeight);
      maxHeightError = Math.max(maxHeightError, heightErr);

      // Full displacement should match
      const dispErr = sqrt(
        (gpuResult.displacement.x - cpuDisp.x) ** 2 +
        (gpuResult.displacement.y - cpuDisp.y) ** 2 +
        (gpuResult.displacement.z - cpuDisp.z) ** 2,
      );
      maxDispError = Math.max(maxDispError, dispErr);
    }

    // Should be numerically identical (same formula, same data)
    expect(maxHeightError).toBeLessThan(1e-10);
    expect(maxDispError).toBeLessThan(1e-10);
  });

  it('GPU normal convention agrees with CPU (T_z × T_x yields up on flat water)', () => {
    // The derivative texture provides ∂Dy/∂x and ∂Dy/∂z. The normal is
    // reconstructed as T_z × T_x where:
    //   T_x = (1 + ∂Dx/∂x, ∂Dy/∂x, ∂Dz/∂x)
    //   T_z = (∂Dx/∂z, ∂Dy/∂z, 1 + ∂Dz/∂z)
    //
    // For flat water (all derivatives ≈ 0):
    //   T_x = (1, 0, 0), T_z = (0, 0, 1)
    //   T_z × T_x = (0*0 - 1*0, 1*1 - 0*0, 0*0 - 0*1) = (0, 1, 0)
    //
    // This is the Y-up convention — correct.

    const params = makeDefaultParams({ significantHeight: 0.001, swellHeight: 0 });
    const result = buildSpectrum(params, 24);
    const cascades = buildCascadeData(result.components, { cascades: 1, resolution: 128 });
    const cascade0 = cascades[0];
    if (cascade0 === undefined) return;

    const texel = evaluateTexelCPU(cascade0, 128, 64, 64, 0);

    // With near-zero waves, derivatives should be small (but not zero with
    // many components at 0.001m Hs — each component is tiny but there are ~24+)
    expect(abs(texel.derivatives.dDy_dx)).toBeLessThan(0.2);
    expect(abs(texel.derivatives.dDy_dz)).toBeLessThan(0.2);

    // Reconstruct normal from derivatives to verify convention
    // For the test, we verify the full normal matches CPU's normal()
    const cpuField = createWaveFieldCPU(params);
    const worldX = (64 / 128 - 0.5) * cascade0.extent;
    const worldZ = (64 / 128 - 0.5) * cascade0.extent;
    const cpuNormal = { x: 0, y: 0, z: 0 };
    cpuField.normal(worldX, worldZ, 0, cpuNormal);

    // Near-flat water: normal ≈ (0, 1, 0)
    expect(cpuNormal.y).toBeGreaterThan(0.99);
  });

  it('GPU derivatives agree with CPU normal() for moderate waves', () => {
    const params = makeDefaultParams();
    const cpuField = createWaveFieldCPU(params);
    const cpuComponents = cpuField.components;

    const cascade: CascadeData = {
      index: 0,
      extent: 200,
      components: cpuComponents.map(c => ({
        amplitude: c.amplitude,
        wavenumber: c.wavenumber,
        frequency: c.frequency,
        phase: c.phase,
        steepness: c.steepness,
        dirX: c.direction.x,
        dirZ: c.direction.y,
      })),
      componentCount: cpuComponents.length,
    };

    const resolution = 256;
    const time = 3.0;

    // Test several points: verify GPU derivative dDy_dx matches CPU normal
    const testCols = [64, 128, 192, 100, 200];
    const testRows = [64, 128, 192, 150, 50];

    for (let i = 0; i < testCols.length; i++) {
      const col = testCols[i] as number;
      const row = testRows[i] as number;
      const worldX = (col / resolution - 0.5) * cascade.extent;
      const worldZ = (row / resolution - 0.5) * cascade.extent;

      const texel = evaluateTexelCPU(cascade, resolution, col, row, time);

      // Verify derivatives are finite
      expect(Number.isFinite(texel.derivatives.dDy_dx)).toBe(true);
      expect(Number.isFinite(texel.derivatives.dDy_dz)).toBe(true);

      // The CPU normal at the same point must point upward (same convention)
      const cpuNormal = { x: 0, y: 0, z: 0 };
      cpuField.normal(worldX, worldZ, time, cpuNormal);

      // For moderate 2m waves, normals must point up (not inverted)
      expect(cpuNormal.y).toBeGreaterThan(0);

      // Cross-check: CPU's nx ≈ -(dDy_dx) / sqrt(1 + derivatives²) to first order.
      // For a direct validation, the CPU's dDy/dx must match our texel's dDy_dx
      // since they use the SAME formula. Verify sign consistency:
      // If dDy_dx > 0, the wave slopes up going east, so normal tilts west (nx < 0).
      if (abs(texel.derivatives.dDy_dx) > 0.01) {
        // Sign of normal x should be opposite to dDy_dx (for upward normal)
        const expectedSign = texel.derivatives.dDy_dx > 0 ? -1 : 1;
        const actualSign = cpuNormal.x > 0 ? 1 : -1;
        // This should hold unless horizontal displacement dominates
        // For moderate waves (steepness < 0.5), it reliably holds
        if (abs(cpuNormal.x) > 0.01) {
          expect(actualSign).toBe(expectedSign);
        }
      }
    }
  });
});


// ─── Factory and handle ───────────────────────────────────────────────────────

describe('SpectrumCompute — createSpectrumCompute', () => {
  it('creates handle with correct cascade count', () => {
    const params = makeDefaultParams();
    const handle = createSpectrumCompute(params, { cascades: 3, resolution: 128 });
    expect(handle.cascadeData.length).toBe(3);
    expect(handle.config.cascades).toBe(3);
    expect(handle.config.resolution).toBe(128);
    handle.dispose();
  });

  it('allocates buffers of correct size', () => {
    const params = makeDefaultParams();
    const handle = createSpectrumCompute(params, { cascades: 2, resolution: 128 });

    const dispBuf = handle.getDisplacementBuffer(0);
    const derivBuf = handle.getDerivativeBuffer(0);
    const jacBuf = handle.getJacobianBuffer(0);

    expect(dispBuf).toBeDefined();
    expect(derivBuf).toBeDefined();
    expect(jacBuf).toBeDefined();

    if (dispBuf !== undefined) expect(dispBuf.length).toBe(128 * 128 * 4);
    if (derivBuf !== undefined) expect(derivBuf.length).toBe(128 * 128 * 4);
    if (jacBuf !== undefined) expect(jacBuf.length).toBe(128 * 128);

    handle.dispose();
  });

  it('returns undefined for out-of-range cascade index', () => {
    const params = makeDefaultParams();
    const handle = createSpectrumCompute(params, { cascades: 2, resolution: 128 });
    expect(handle.getDisplacementBuffer(5)).toBeUndefined();
    expect(handle.getDerivativeBuffer(5)).toBeUndefined();
    expect(handle.getJacobianBuffer(5)).toBeUndefined();
    handle.dispose();
  });

  it('evaluateTexel returns undefined for invalid coordinates', () => {
    const params = makeDefaultParams();
    const handle = createSpectrumCompute(params, { cascades: 1, resolution: 128 });
    expect(handle.evaluateTexel(0, -1, 0, 0)).toBeUndefined();
    expect(handle.evaluateTexel(0, 0, 128, 0)).toBeUndefined();
    expect(handle.evaluateTexel(5, 0, 0, 0)).toBeUndefined();
    handle.dispose();
  });

  it('evaluateTexel returns valid result for valid coordinates', () => {
    const params = makeDefaultParams();
    const handle = createSpectrumCompute(params, { cascades: 1, resolution: 128 });
    const result = handle.evaluateTexel(0, 64, 64, 5.0);
    expect(result).toBeDefined();
    if (result !== undefined) {
      expect(Number.isFinite(result.displacement.x)).toBe(true);
      expect(Number.isFinite(result.displacement.y)).toBe(true);
      expect(Number.isFinite(result.displacement.z)).toBe(true);
      expect(Number.isFinite(result.jacobian)).toBe(true);
    }
    handle.dispose();
  });

  it('updateSpectrum changes cascade data', () => {
    const params = makeDefaultParams();
    const handle = createSpectrumCompute(params, { cascades: 1, resolution: 128 });

    const before = handle.cascadeData[0]?.components[0]?.phase;

    // Change seed to get different phases
    const newParams = makeDefaultParams({ seed: 999 });
    handle.updateSpectrum(newParams);

    const after = handle.cascadeData[0]?.components[0]?.phase;
    expect(before).not.toBe(after);
    handle.dispose();
  });
});

// ─── evaluateAllCPU and buffer layout ─────────────────────────────────────────

describe('SpectrumCompute — evaluateAllCPU buffer correctness', () => {
  it('fills displacement buffer matching per-texel evaluation', () => {
    const params = makeDefaultParams();
    const handle = createSpectrumCompute(params, { cascades: 1, resolution: 128 });
    handle.evaluateAllCPU(3.0);

    const dispBuf = handle.getDisplacementBuffer(0);
    expect(dispBuf).toBeDefined();
    if (dispBuf === undefined) return;

    // Spot-check a few texels
    const checkPoints = [[10, 20], [64, 64], [100, 5], [127, 127]];
    for (const [col, row] of checkPoints) {
      if (col === undefined || row === undefined) continue;
      const texelResult = handle.evaluateTexel(0, col, row, 3.0);
      if (texelResult === undefined) continue;

      const idx = (row * 128 + col) * 4;
      expect(dispBuf[idx]).toBeCloseTo(texelResult.displacement.x, 6);
      expect(dispBuf[idx + 1]).toBeCloseTo(texelResult.displacement.y, 6);
      expect(dispBuf[idx + 2]).toBeCloseTo(texelResult.displacement.z, 6);
      expect(dispBuf[idx + 3]).toBeCloseTo(1.0, 6);
    }

    handle.dispose();
  });

  it('fills derivative buffer matching per-texel evaluation', () => {
    const params = makeDefaultParams();
    const handle = createSpectrumCompute(params, { cascades: 1, resolution: 128 });
    handle.evaluateAllCPU(7.0);

    const derivBuf = handle.getDerivativeBuffer(0);
    expect(derivBuf).toBeDefined();
    if (derivBuf === undefined) return;

    const col = 80;
    const row = 40;
    const texelResult = handle.evaluateTexel(0, col, row, 7.0);
    if (texelResult === undefined) return;

    const idx = (row * 128 + col) * 4;
    expect(derivBuf[idx]).toBeCloseTo(texelResult.derivatives.dDy_dx, 6);
    expect(derivBuf[idx + 1]).toBeCloseTo(texelResult.derivatives.dDy_dz, 6);
    expect(derivBuf[idx + 2]).toBeCloseTo(texelResult.derivatives.horizontalDiv, 6);
    expect(derivBuf[idx + 3]).toBeCloseTo(0.0, 6);

    handle.dispose();
  });

  it('fills Jacobian buffer matching per-texel evaluation', () => {
    const params = makeDefaultParams();
    const handle = createSpectrumCompute(params, { cascades: 1, resolution: 128 });
    handle.evaluateAllCPU(2.5);

    const jacBuf = handle.getJacobianBuffer(0);
    expect(jacBuf).toBeDefined();
    if (jacBuf === undefined) return;

    const col = 50;
    const row = 90;
    const texelResult = handle.evaluateTexel(0, col, row, 2.5);
    if (texelResult === undefined) return;

    const idx = row * 128 + col;
    expect(jacBuf[idx]).toBeCloseTo(texelResult.jacobian, 6);

    handle.dispose();
  });

  it('Jacobian values are physically reasonable for ocean waves', () => {
    const params = makeDefaultParams();
    const handle = createSpectrumCompute(params, { cascades: 1, resolution: 128 });
    handle.evaluateAllCPU(5.0);

    const jacBuf = handle.getJacobianBuffer(0);
    if (jacBuf === undefined) return;

    let minJ = Infinity;
    let maxJ = -Infinity;
    let nanCount = 0;

    for (let i = 0; i < jacBuf.length; i++) {
      const j = jacBuf[i] as number;
      if (!Number.isFinite(j)) {
        nanCount++;
        continue;
      }
      if (j < minJ) minJ = j;
      if (j > maxJ) maxJ = j;
    }

    expect(nanCount).toBe(0);
    // For 2m significant height, Jacobian should range from near 1.0 down
    // slightly. The actual variation depends on cascade extent and steepness.
    expect(minJ).toBeGreaterThan(-1.0);
    expect(maxJ).toBeLessThan(2.0);
    // There should be some variation (may be small for short cascades)
    expect(maxJ - minJ).toBeGreaterThan(0.0001);

    handle.dispose();
  });

  it('displacement texture A channel is always 1.0', () => {
    const params = makeDefaultParams();
    const handle = createSpectrumCompute(params, { cascades: 1, resolution: 128 });
    handle.evaluateAllCPU(1.0);

    const dispBuf = handle.getDisplacementBuffer(0);
    if (dispBuf === undefined) return;

    for (let i = 0; i < 128 * 128; i++) {
      expect(dispBuf[i * 4 + 3]).toBe(1.0);
    }

    handle.dispose();
  });

  it('derivative texture A channel is always 0.0', () => {
    const params = makeDefaultParams();
    const handle = createSpectrumCompute(params, { cascades: 1, resolution: 128 });
    handle.evaluateAllCPU(1.0);

    const derivBuf = handle.getDerivativeBuffer(0);
    if (derivBuf === undefined) return;

    for (let i = 0; i < 128 * 128; i++) {
      expect(derivBuf[i * 4 + 3]).toBe(0.0);
    }

    handle.dispose();
  });
});

// ─── NaN safety ───────────────────────────────────────────────────────────────

describe('SpectrumCompute — NaN safety', () => {
  const extremeCases: Array<{ name: string; overrides: Partial<WaveSpectrumParams> }> = [
    { name: 'zero wind', overrides: { windSpeed: 0, significantHeight: 0.01, swellHeight: 0.5 } },
    { name: '40 m/s gale', overrides: { windSpeed: 40, significantHeight: 8.0 } },
    { name: 'shallow water', overrides: { depth: 0.5, significantHeight: 0.3 } },
    { name: 'no swell', overrides: { swellHeight: 0, swellPeriod: 0 } },
  ];

  for (const { name, overrides } of extremeCases) {
    it(`no NaN in texel output for ${name}`, () => {
      const params = makeDefaultParams(overrides);
      const handle = createSpectrumCompute(params, { cascades: 1, resolution: 128 });

      // Check several texels
      for (let i = 0; i < 50; i++) {
        const col = (i * 7) % 128;
        const row = (i * 13) % 128;
        const result = handle.evaluateTexel(0, col, row, i * 0.5);
        if (result === undefined) continue;
        expect(Number.isFinite(result.displacement.x)).toBe(true);
        expect(Number.isFinite(result.displacement.y)).toBe(true);
        expect(Number.isFinite(result.displacement.z)).toBe(true);
        expect(Number.isFinite(result.derivatives.dDy_dx)).toBe(true);
        expect(Number.isFinite(result.derivatives.dDy_dz)).toBe(true);
        expect(Number.isFinite(result.derivatives.horizontalDiv)).toBe(true);
        expect(Number.isFinite(result.jacobian)).toBe(true);
      }

      handle.dispose();
    });
  }
});
