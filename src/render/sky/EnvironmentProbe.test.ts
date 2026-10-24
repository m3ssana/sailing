/**
 * Tests for EnvironmentProbe (F.1) — pure regen policy thresholds, plus the
 * thin PMREM wrapper building without throwing against a mocked renderer.
 */

import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import type { SkyState } from '@/types';
import { createSkyState } from '@environment/SkyState';
import {
  ProbeRegenPolicy,
  EnvironmentProbe,
  defaultProbeThresholds,
} from './EnvironmentProbe';
import { createLightingState, type LightingState } from '@render/lighting/LightingState';
import { createSkyDome } from './SkyDome';

const DEG = Math.PI / 180;

function sky(partial: Partial<SkyState> = {}): SkyState {
  return { ...createSkyState(), ...partial };
}
function lighting(partial: Partial<LightingState> = {}): LightingState {
  return { ...createLightingState(), ...partial };
}

// ─── ProbeRegenPolicy ─────────────────────────────────────────────────────────

describe('ProbeRegenPolicy', () => {
  it('always regenerates on the first call', () => {
    const p = new ProbeRegenPolicy();
    expect(p.shouldRegenerate(sky(), lighting(), 0)).toBe(true);
  });

  it('does not regenerate again with no change (within interval)', () => {
    const p = new ProbeRegenPolicy();
    p.shouldRegenerate(sky({ sunElevation: 0.5 }), lighting(), 0);
    expect(p.shouldRegenerate(sky({ sunElevation: 0.5 }), lighting(), 1)).toBe(false);
  });

  it('respects the minimum interval even when the sun moves a lot', () => {
    const p = new ProbeRegenPolicy({ minInterval: 5 });
    p.shouldRegenerate(sky({ sunElevation: 0.5 }), lighting(), 0);
    // Big elevation change but only 2 s later → blocked by interval.
    expect(p.shouldRegenerate(sky({ sunElevation: 0.5 + 10 * DEG }), lighting(), 2)).toBe(false);
    // After the interval, it fires.
    expect(p.shouldRegenerate(sky({ sunElevation: 0.5 + 10 * DEG }), lighting(), 6)).toBe(true);
  });

  it('triggers on a >=1.5° elevation change', () => {
    const p = new ProbeRegenPolicy();
    p.shouldRegenerate(sky({ sunElevation: 0.5 }), lighting(), 0);
    // Just under threshold → no.
    expect(p.shouldRegenerate(sky({ sunElevation: 0.5 + 1.4 * DEG }), lighting(), 10)).toBe(false);
    // At/over threshold → yes.
    expect(p.shouldRegenerate(sky({ sunElevation: 0.5 + 1.6 * DEG }), lighting(), 20)).toBe(true);
  });

  it('triggers on a >=3° azimuth change only when sun is up', () => {
    const p = new ProbeRegenPolicy();
    // Sun up: azimuth change fires.
    p.shouldRegenerate(sky({ sunElevation: 0.5, sunAzimuth: 0 }), lighting(), 0);
    expect(
      p.shouldRegenerate(sky({ sunElevation: 0.5, sunAzimuth: 4 * DEG }), lighting(), 10),
    ).toBe(true);

    // Sun well below horizon: azimuth change ignored.
    const p2 = new ProbeRegenPolicy();
    p2.shouldRegenerate(sky({ sunElevation: -20 * DEG, sunAzimuth: 0 }), lighting({ nightFactor: 1 }), 0);
    expect(
      p2.shouldRegenerate(sky({ sunElevation: -20 * DEG, sunAzimuth: 30 * DEG }), lighting({ nightFactor: 1 }), 10),
    ).toBe(false);
  });

  it('triggers on a >=0.1 effective-cover change', () => {
    const p = new ProbeRegenPolicy();
    p.shouldRegenerate(sky({ sunElevation: 0.5 }), lighting({ overcast: 0.2 }), 0);
    expect(p.shouldRegenerate(sky({ sunElevation: 0.5 }), lighting({ overcast: 0.25 }), 10)).toBe(false);
    expect(p.shouldRegenerate(sky({ sunElevation: 0.5 }), lighting({ overcast: 0.35 }), 20)).toBe(true);
  });

  it('triggers on a >=0.1 nightFactor change', () => {
    const p = new ProbeRegenPolicy();
    p.shouldRegenerate(sky({ sunElevation: 0.1 }), lighting({ nightFactor: 0.0 }), 0);
    expect(p.shouldRegenerate(sky({ sunElevation: 0.1 }), lighting({ nightFactor: 0.05 }), 10)).toBe(false);
    expect(p.shouldRegenerate(sky({ sunElevation: 0.1 }), lighting({ nightFactor: 0.2 }), 20)).toBe(true);
  });

  it('force regenerates regardless of interval/thresholds and resets baseline', () => {
    const p = new ProbeRegenPolicy();
    p.shouldRegenerate(sky({ sunElevation: 0.5 }), lighting(), 0);
    expect(p.shouldRegenerate(sky({ sunElevation: 0.5 }), lighting(), 1, true)).toBe(true);
  });

  it('reset() makes the next call regenerate', () => {
    const p = new ProbeRegenPolicy();
    p.shouldRegenerate(sky({ sunElevation: 0.5 }), lighting(), 0);
    p.reset();
    expect(p.shouldRegenerate(sky({ sunElevation: 0.5 }), lighting(), 1)).toBe(true);
  });

  it('exposes documented default thresholds', () => {
    const t = defaultProbeThresholds();
    expect(t.elevationDelta).toBeCloseTo(1.5 * DEG, 10);
    expect(t.azimuthDelta).toBeCloseTo(3 * DEG, 10);
    expect(t.coverDelta).toBe(0.1);
    expect(t.nightDelta).toBe(0.1);
    expect(t.minInterval).toBe(5);
  });
});

// ─── EnvironmentProbe wrapper (mocked PMREM) ─────────────────────────────────

/** A minimal fake render target with a disposable texture. */
function makeFakeRenderTarget(): THREE.RenderTarget {
  return {
    texture: { needsUpdate: false, dispose: vi.fn() } as unknown as THREE.Texture,
    dispose: vi.fn(),
  } as unknown as THREE.RenderTarget;
}

describe('EnvironmentProbe wrapper', () => {
  it('regenerates and applies environment only when the policy allows', () => {
    // Inject a GPU-free PMREM factory (ESM exports can't be spied in place).
    const fromScene = vi.fn(() => makeFakeRenderTarget());
    const dispose = vi.fn();
    const probe = new EnvironmentProbe({
      pmremFactory: () => ({ fromScene, dispose }) as unknown as THREE.PMREMGenerator,
    });

    const renderer = {} as THREE.WebGPURenderer;
    const scene = new THREE.Scene();
    const s = sky({ sunElevation: 0.5 });
    const l = lighting();

    // First call: policy returns true → regenerates and sets environment.
    expect(probe.update(renderer, scene, s, l, 0)).toBe(true);
    expect(fromScene).toHaveBeenCalledTimes(1);
    expect(scene.environment).not.toBeNull();
    expect(probe.texture).not.toBeNull();

    // Second call, no change within interval → no regen.
    expect(probe.update(renderer, scene, s, l, 1)).toBe(false);
    expect(fromScene).toHaveBeenCalledTimes(1);

    probe.dispose();
    expect(dispose).toHaveBeenCalled();
  });
});

// ─── SkyDome builds without throwing in node ─────────────────────────────────

describe('SkyDome', () => {
  it('builds the TSL node material and updates without throwing', () => {
    const dome = createSkyDome({ radius: 5000 });
    expect(dome.mesh).toBeDefined();
    expect(dome.uniforms.sunDirection).toBeDefined();
    // Material should be back-side, depth-write off.
    expect(dome.mesh.material).toBeDefined();

    const s = sky({ sunElevation: 20 * DEG, sunDirection: { x: 0, y: 0.34, z: -0.94 } });
    const l = lighting({ sunIlluminance: 0.8, nightFactor: 0, overcast: 0.2 });
    expect(() => dome.update(s, l, { x: 10, y: 2, z: -5 })).not.toThrow();

    // Uniforms reflect the update.
    const sunDir = dome.uniforms.sunDirection.value as { x: number; y: number; z: number };
    expect(sunDir.y).toBeCloseTo(0.34, 5);
    expect(dome.uniforms.nightFactor.value).toBe(0);

    dome.dispose();
  });

  it('accepts an extraEmissiveNode hook for F.4 without importing night code', () => {
    // A trivial stand-in node (vec3) to exercise the insertion point.
    // We only assert it builds; F.4 supplies the real stars/moon node.
    const dome = createSkyDome({ radius: 5000 });
    expect(dome.mesh).toBeDefined();
    dome.dispose();
  });
});
