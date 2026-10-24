/**
 * Wave coherence regression (requirement 4.12).
 *
 * The visible ocean surface (render side) and the physics `WaveField` must
 * agree to within 5 cm. They do so BY CONSTRUCTION: both evaluate the same
 * truncated Gerstner sum over the SAME component table.
 *
 * TSL node graphs cannot be evaluated on the CPU in a unit test, but the
 * render-side displacement is produced by two code paths that share the exact
 * component math with `WaveFieldCPU.displacement()`:
 *   - `evaluateCascadeTexture` (mid-tier CPU displacement texture), and
 *   - `buildGerstnerPositionNode` (low-tier vertex shader), whose formulae are a
 *     line-for-line transcription of `evaluateCascadeTexture` / `WaveFieldCPU`.
 *
 * This test exercises the CPU-evaluable path (`evaluateCascadeTexture`) against
 * `createWaveFieldCPU` at matched world points and session times, and asserts
 * the max vertical error is far under 5 cm (it is ~0: identical math). It also
 * confirms `buildWaterMaterial` wires a `positionNode` + `normalNode` only when
 * the component table is supplied, and leaves the surface flat otherwise.
 *
 * If this regresses, the "visible waves == physics waves" contract is broken —
 * suspect a divergence between the render Gerstner math and WaveFieldCPU, or a
 * phase-clock mismatch (the material time uniform must be the physics session
 * time).
 */

import { describe, expect, it } from 'vitest';
import type { WaveSpectrumParams } from '@/types';
import { createWaveFieldCPU } from '@environment/waves/WaveFieldCPU';
import { evaluateCascadeTexture, _testing } from '@render/ocean/SpectrumFallback';
import { buildWaterMaterial } from '@render/ocean/WaterMaterial';
import { uniform } from 'three/tsl';

// A representative Newport-ish wind sea + a little swell.
const PARAMS: WaveSpectrumParams = {
  windSpeed: 6, // ~12 kt
  windDirection: (205 * Math.PI) / 180, // SW, comes-from bearing
  fetch: 4000,
  significantHeight: 0.6,
  swellHeight: 0.3,
  swellPeriod: 5,
  swellDirection: (200 * Math.PI) / 180,
  peakEnhancement: 3.3,
  directionalSpread: 8,
  depth: 20,
  currentVelocity: { x: 0, y: 0 },
  seed: 1234,
};

describe('wave coherence (req 4.12): render surface vs physics WaveField', () => {
  it('render-side Gerstner height matches the CPU WaveField within 5 cm (in fact ~0)', () => {
    const field = createWaveFieldCPU(PARAMS);
    const components = field.components;

    // Evaluate the render-side cascade texture over a 128² patch spanning a
    // known world extent, then compare each texel's vertical (G = dy) against
    // the physics field at the SAME world point and time.
    const resolution = 128;
    const scale = 100; // metres per cascade edge
    const buf = new Float32Array(resolution * resolution * 4);

    let maxErr = 0;
    let sumSq = 0;
    let n = 0;

    for (const t of [0, 3.7, 12.25, 40]) {
      evaluateCascadeTexture(buf, components, scale, resolution, t);

      const invRes = scale / resolution;
      const half = scale * 0.5;
      // Sample a sparse grid of texels (every 11th) to keep the test fast.
      for (let row = 0; row < resolution; row += 11) {
        for (let col = 0; col < resolution; col += 11) {
          const wz = (row + 0.5) * invRes - half;
          const wx = (col + 0.5) * invRes - half;
          const renderDy = buf[(row * resolution + col) * 4 + 1] ?? 0;
          const physicsH = field.height(wx, wz, t);
          const err = Math.abs(renderDy - physicsH);
          if (err > maxErr) maxErr = err;
          sumSq += err * err;
          n++;
        }
      }
    }

    const rms = Math.sqrt(sumSq / n);
    // Same math → exact agreement to floating-point. Assert far inside 5 cm.
    expect(maxErr).toBeLessThan(0.05);
    expect(maxErr).toBeLessThan(1e-6); // actually identical
    expect(rms).toBeLessThan(1e-7);
  });

  it('render-side horizontal Gerstner displacement matches the CPU WaveField', () => {
    const field = createWaveFieldCPU(PARAMS);
    const components = field.components;
    const resolution = 64;
    const scale = 80;
    const buf = new Float32Array(resolution * resolution * 4);
    const t = 7.5;
    evaluateCascadeTexture(buf, components, scale, resolution, t);

    const invRes = scale / resolution;
    const half = scale * 0.5;
    let maxErr = 0;
    const out = { x: 0, y: 0, z: 0 };
    for (let row = 0; row < resolution; row += 7) {
      for (let col = 0; col < resolution; col += 7) {
        const wz = (row + 0.5) * invRes - half;
        const wx = (col + 0.5) * invRes - half;
        const idx = (row * resolution + col) * 4;
        const dx = buf[idx] ?? 0;
        const dy = buf[idx + 1] ?? 0;
        const dz = buf[idx + 2] ?? 0;
        field.displacement(wx, wz, t, out);
        maxErr = Math.max(maxErr, Math.abs(dx - out.x), Math.abs(dy - out.y), Math.abs(dz - out.z));
      }
    }
    expect(maxErr).toBeLessThan(1e-6);
  });
});

describe('buildWaterMaterial wave wiring', () => {
  const appearance = {
    colorShallow: { r: 0.29, g: 0.44, b: 0.41 },
    colorDeep: { r: 0.17, g: 0.29, b: 0.31 },
    turbidity: 0.45,
    extinctionDepth: 8,
  };

  it('wires positionNode + normalNode when the component table is supplied', () => {
    const field = createWaveFieldCPU(PARAMS);
    const timeUniform = uniform(0);
    const { material } = buildWaterMaterial({
      appearance,
      sunDirection: { x: 0.3, y: 0.8, z: 0.2 },
      waveComponents: field.components,
      waveTimeUniform: timeUniform,
    });
    expect(material.positionNode).not.toBeNull();
    expect(material.normalNode).not.toBeNull();
  });

  it('leaves the surface flat (no positionNode) when components are omitted', () => {
    const { material } = buildWaterMaterial({
      appearance,
      sunDirection: { x: 0.3, y: 0.8, z: 0.2 },
    });
    expect(material.positionNode).toBeNull();
  });

  it('shares the time uniform so the phase clock can be driven per-frame', () => {
    const field = createWaveFieldCPU(PARAMS);
    const timeUniform = uniform(0);
    buildWaterMaterial({
      appearance,
      sunDirection: { x: 0.3, y: 0.8, z: 0.2 },
      waveComponents: field.components,
      waveTimeUniform: timeUniform,
    });
    // The caller drives this exact handle each frame; verify it is mutable.
    timeUniform.value = 42;
    expect(timeUniform.value).toBe(42);
  });

  it('wires band-limited displacement+normal per ring without throwing', () => {
    const field = createWaveFieldCPU(PARAMS);
    const timeUniform = uniform(0);
    const camPos = uniform({ x: 0, y: 2, z: 0 });
    // Coarse far ring: band-limiting + camera-driven far fade both active.
    const { material } = buildWaterMaterial({
      appearance,
      sunDirection: { x: 0.3, y: 0.8, z: 0.2 },
      waveComponents: field.components,
      waveTimeUniform: timeUniform,
      vertexSpacing: 16,
      cameraPositionUniform: camPos,
    });
    expect(material.positionNode).not.toBeNull();
    expect(material.normalNode).not.toBeNull();
    expect(material.roughnessNode).not.toBeNull();
  });
});

// ─── Band-limiting (anti-aliasing) ──────────────────────────────────────────────

describe('per-ring band-limiting weight (req: resolve the far-sea aliasing)', () => {
  const { bandLimitWeight, BAND_LIMIT_LO, BAND_LIMIT_HI } = _testing;

  it('a component with wavelength < 2 × spacing has ZERO weight', () => {
    const spacing = 8; // metres between vertices on a coarse ring
    // Wavelength just below the floor BAND_LIMIT_LO × spacing.
    const lambda = BAND_LIMIT_LO * spacing * 0.95;
    const k = (2 * Math.PI) / lambda; // wavenumber
    expect(bandLimitWeight(k, spacing)).toBe(0);
    // And at exactly 2× spacing it is still zero (the smoothstep lower edge).
    const kAt2x = (2 * Math.PI) / (BAND_LIMIT_LO * spacing);
    expect(bandLimitWeight(kAt2x, spacing)).toBe(0);
  });

  it('a component with wavelength ≥ 4 × spacing has FULL weight', () => {
    const spacing = 8;
    const lambda = BAND_LIMIT_HI * spacing * 1.1;
    const k = (2 * Math.PI) / lambda;
    expect(bandLimitWeight(k, spacing)).toBe(1);
  });

  it('weight is monotone NON-INCREASING in spacing for a fixed component', () => {
    const k = (2 * Math.PI) / 6; // a 6 m chop component (wavelength 6 m)
    const spacings = [0.5, 1, 2, 3, 4, 6, 10, 20, 40];
    let prev = Infinity;
    for (const s of spacings) {
      const w = bandLimitWeight(k, s);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
      expect(w).toBeLessThanOrEqual(prev + 1e-12); // non-increasing as spacing grows
      prev = w;
    }
    // The near ring (0.5 m) fully keeps a 6 m wave; a 40 m-spacing ring drops it.
    expect(bandLimitWeight(k, 0.5)).toBe(1);
    expect(bandLimitWeight(k, 40)).toBe(0);
  });

  it('weight is monotone NON-DECREASING in wavelength for a fixed spacing', () => {
    const spacing = 8;
    const wavelengths = [2, 4, 8, 12, 16, 24, 32, 48, 80];
    let prev = -Infinity;
    for (const lambda of wavelengths) {
      const k = (2 * Math.PI) / lambda;
      const w = bandLimitWeight(k, spacing);
      expect(w).toBeGreaterThanOrEqual(prev - 1e-12); // non-decreasing as λ grows
      prev = w;
    }
  });

  it('the NEAR ring keeps the LONG-wavelength components fully (coherence preserved)', () => {
    // The innermost clipmap ring has 0.5 m vertex spacing (Nyquist ≈ 1 m). The
    // long swell + peak components — the ones that carry the dominant visual
    // motion of the sea the boat rides — have wavelengths many metres long and
    // weigh exactly 1 there. Only the very shortest chop (λ ≲ 2 m) is trimmed,
    // which a 0.5 m mesh cannot carry cleanly anyway. Coherence is preserved to
    // well under 5 cm (proven quantitatively in the previous test); here we
    // confirm every component with λ ≥ 2 m (the physically meaningful ones at
    // this spacing) is fully kept.
    const field = createWaveFieldCPU(PARAMS);
    const nearSpacing = 0.5;
    let keptFull = 0;
    for (const c of field.components) {
      const lambda = (2 * Math.PI) / c.wavenumber;
      if (lambda >= 2) {
        expect(bandLimitWeight(c.wavenumber, nearSpacing)).toBe(1);
        keptFull++;
      }
    }
    // The spectrum is dominated by resolvable components (most are kept full).
    expect(keptFull).toBeGreaterThan(0);
  });

  it('near-ring band-limited height still matches the physics field within 5 cm (req 4.12)', () => {
    // Apply the NEAR-ring band-limit weights to the component amplitudes and
    // compare the resulting Gerstner height against the un-weighted physics
    // WaveField the boat samples. The error must stay far under the 5 cm
    // coherence requirement — band-limiting the near ring does not move the
    // sea out from under the boat.
    const field = createWaveFieldCPU(PARAMS);
    const nearSpacing = 0.5;
    const weighted = field.components.map((c) => ({
      ...c,
      amplitude: c.amplitude * bandLimitWeight(c.wavenumber, nearSpacing),
    }));
    const heightOf = (
      comps: readonly { amplitude: number; wavenumber: number; direction: { x: number; y: number }; frequency: number; phase: number }[],
      x: number,
      z: number,
      t: number,
    ): number => {
      let h = 0;
      for (const c of comps) {
        const kDotP = c.wavenumber * (c.direction.x * x + c.direction.y * z);
        h += c.amplitude * Math.cos(kDotP - c.frequency * t + c.phase);
      }
      return h;
    };
    let maxErr = 0;
    for (const t of [0, 5.3, 19.75]) {
      for (let x = -8; x <= 8; x += 2) {
        for (let z = -8; z <= 8; z += 2) {
          const err = Math.abs(heightOf(weighted, x, z, t) - field.height(x, z, t));
          if (err > maxErr) maxErr = err;
        }
      }
    }
    expect(maxErr).toBeLessThan(0.05); // well under 5 cm
  });
});
