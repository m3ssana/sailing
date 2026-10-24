/**
 * Regression tests for the CloudRenderer TSL raymarch layer (F.2 GAP fix).
 *
 * These assert:
 *   1. the material has a colorNode AND an opacityNode, both constructible and
 *      traversable in node (a missing TSL export only fails at runtime, so we
 *      build the graph and walk it here);
 *   2. the TSL noise port consumes the SAME shared `NOISE_CONSTANTS` as the CPU
 *      `cloudDensity` reference (the GPU and CPU cannot silently drift apart);
 *   3. the density model the GPU mirrors actually produces SCATTERED gaps for
 *      low cover and a NEAR-UNIFORM grey slab for overcast (the F.2 demo).
 */

import { describe, expect, it } from 'vitest';
import type { QualityKnobs, SkyState, Vec3 } from '@/types';
import type * as THREE from 'three/webgpu';
import { createLightingState } from '@render/lighting/LightingState';
import { createCloudRenderer, _tslTesting } from '@render/weather/CloudRenderer';
import {
  NOISE_CONSTANTS,
  cloudDensity,
  coverageThreshold,
} from '@render/weather/CloudModel';
import { float } from 'three/tsl';

function makeSky(partial: Partial<SkyState> = {}): SkyState {
  return {
    sunDirection: { x: 0.3, y: 0.8, z: -0.5 },
    sunElevation: 0.9,
    sunAzimuth: 2,
    moonDirection: { x: 0, y: -1, z: 0 },
    moonElevation: -0.5,
    moonPhase: 0.5,
    siderealTime: 1,
    cloudLow: 0.6,
    cloudMid: 0.2,
    cloudHigh: 0.1,
    isNight: false,
    ...partial,
  };
}

const CAMERA: Vec3 = { x: 100, y: 3, z: -50 };
const WIND: Vec3 = { x: 5, y: 0, z: -2 };
function knobs(cloudMarchSteps: number): Pick<QualityKnobs, 'cloudMarchSteps'> {
  return { cloudMarchSteps };
}

// ─── Material node graph ──────────────────────────────────────────────────────

describe('CloudRenderer material node graph', () => {
  it('has a colorNode and opacityNode that construct and are traversable', () => {
    const r = createCloudRenderer();
    const mesh = r.object as THREE.Mesh;
    const material = mesh.material as THREE.MeshBasicNodeMaterial;
    expect(material.colorNode).toBeDefined();
    expect(material.opacityNode).toBeDefined();
    expect(material.transparent).toBe(true);
    // Drive one update so the uniforms the nodes read are populated. The full
    // node graph only expands during a builder/.build() pass (unavailable in
    // node without a renderer), so here we assert the nodes are real TSL nodes
    // and that traversing them runs without throwing — a missing/undefined TSL
    // ref would surface as a non-node or a throw while walking.
    r.update(makeSky(), createLightingState(), 0, CAMERA, knobs(8), WIND);
    const asNode = (n: unknown): { isNode?: boolean; traverse?: (cb: (x: unknown) => void) => void } =>
      n as { isNode?: boolean; traverse?: (cb: (x: unknown) => void) => void };
    const colorNode = asNode(material.colorNode);
    const opacityNode = asNode(material.opacityNode);
    expect(colorNode.isNode).toBe(true);
    expect(opacityNode.isNode).toBe(true);
    let colorVisited = 0;
    let opacityVisited = 0;
    expect(() => colorNode.traverse?.(() => { colorVisited++; })).not.toThrow();
    expect(() => opacityNode.traverse?.(() => { opacityVisited++; })).not.toThrow();
    expect(colorVisited).toBeGreaterThan(0);
    expect(opacityVisited).toBeGreaterThan(0);
    r.dispose();
  });

  it('builder noise-port nodes construct for concrete inputs', () => {
    expect(_tslTesting.hash3Node(float(1), float(2), float(3))).toBeDefined();
    expect(_tslTesting.valueNoise3Node(float(0.5), float(0.1), float(0.9))).toBeDefined();
    expect(_tslTesting.fbmNode(float(0.5), float(0.1), float(0.9))).toBeDefined();
    expect(
      _tslTesting.cloudDensityNode(float(0.5), float(0.3), float(0.5), float(0.5), float(1)),
    ).toBeDefined();
  });
});

// ─── TSL port consumes the shared constants ───────────────────────────────────

describe('TSL noise port is wired to the shared NOISE_CONSTANTS', () => {
  const c = _tslTesting.consumedConstants;

  it('consumes the exact hash multipliers and scale', () => {
    expect(c.hashDot[0]).toBe(NOISE_CONSTANTS.hashDot[0]);
    expect(c.hashDot[1]).toBe(NOISE_CONSTANTS.hashDot[1]);
    expect(c.hashDot[2]).toBe(NOISE_CONSTANTS.hashDot[2]);
    expect(c.hashScale).toBe(NOISE_CONSTANTS.hashScale);
  });

  it('uses the same octave count and amp/freq schedule as the CPU fbm', () => {
    expect(c.octaves).toBe(NOISE_CONSTANTS.octaves);
    expect(c.ampSchedule).toHaveLength(NOISE_CONSTANTS.octaves);
    // Rebuild the CPU schedule independently and compare.
    const amp: number[] = [];
    const freq: number[] = [];
    let a = NOISE_CONSTANTS.ampStart;
    let f = NOISE_CONSTANTS.freqStart;
    for (let o = 0; o < NOISE_CONSTANTS.octaves; o++) {
      amp.push(a);
      freq.push(f);
      a *= NOISE_CONSTANTS.ampDecay;
      f *= NOISE_CONSTANTS.freqGain;
    }
    expect(c.ampSchedule).toEqual(amp);
    expect(c.freqSchedule).toEqual(freq);
  });

  it('consumes the same base-Y slice and detail offsets as cloudDensity', () => {
    expect(c.baseY).toBe(NOISE_CONSTANTS.baseY);
    expect(c.detailScale).toBe(NOISE_CONSTANTS.detailScale);
    expect(c.detailOffsetX).toBe(NOISE_CONSTANTS.detailOffsetX);
    expect(c.detailOffsetY).toBe(NOISE_CONSTANTS.detailOffsetY);
    expect(c.detailOffsetZ).toBe(NOISE_CONSTANTS.detailOffsetZ);
  });
});

// ─── The density model the GPU mirrors: scattered vs overcast ──────────────────

describe('density model: scattered shows gaps, overcast is near-uniform', () => {
  function sampleLayer(coverage: number): number[] {
    const layer = {
      frequency: 1 / 2500,
      threshold: coverageThreshold(coverage),
      density: 1,
      detailAmplitude: coverage > 0.9 ? 0.2 : 0.85,
      drift: { x: 0, y: 0 },
    };
    const out: number[] = [];
    for (let i = 0; i < 400; i++) {
      out.push(cloudDensity((i % 20) * 900, Math.floor(i / 20) * 900, layer, 0));
    }
    return out;
  }

  it('scattered cumulus (cover 0.3) leaves clear gaps', () => {
    const d = sampleLayer(0.3);
    const gaps = d.filter((v) => v === 0).length / d.length;
    expect(gaps).toBeGreaterThan(0.4); // substantial sky showing through
    expect(d.some((v) => v > 0.2)).toBe(true); // and real cloud too
  });

  it('overcast (cover 1.0) is near-uniform grey with almost no gaps', () => {
    const d = sampleLayer(1.0);
    const gaps = d.filter((v) => v === 0).length / d.length;
    expect(gaps).toBeLessThan(0.02); // sky almost fully covered
  });
});

// ─── Fallback path still selected at cloudMarchSteps == 0 ──────────────────────

describe('cheap fallback at cloudMarchSteps == 0', () => {
  it('reports isFallback and still builds/updates/disposes', () => {
    const r = createCloudRenderer();
    r.update(makeSky(), createLightingState(), 0, CAMERA, knobs(0), WIND);
    expect(r.isFallback).toBe(true);
    r.update(makeSky(), createLightingState(), 0.1, CAMERA, knobs(12), WIND);
    expect(r.isFallback).toBe(false);
    expect(() => r.dispose()).not.toThrow();
  });

  it('dome follows the camera on all three axes (aligned with SkyDome)', () => {
    const r = createCloudRenderer();
    r.update(makeSky(), createLightingState(), 1, CAMERA, knobs(8), WIND);
    expect(r.object.position.x).toBe(CAMERA.x);
    expect(r.object.position.y).toBe(CAMERA.y);
    expect(r.object.position.z).toBe(CAMERA.z);
    r.dispose();
  });
});
