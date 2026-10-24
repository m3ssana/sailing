/**
 * Regression tests locking two lighting invariants that the FixLighting GPU
 * smoke pass verified, so they can't silently regress:
 *
 *  1. COLOUR-SPACE: colours written into three `Color` uniforms are treated as
 *     LINEAR RGB (the project convention), not sRGB. In three r0.180
 *     `new THREE.Color(r,g,b)` / `Color.setRGB(r,g,b)` default to the WORKING
 *     colour space (LinearSRGBColorSpace with ColorManagement enabled), so a
 *     linear 0.5 must read back as 0.5 — NO sRGB→linear conversion. This test
 *     fails loudly if a future three version (or a code change) reintroduces an
 *     implicit sRGB interpretation on the uniform path.
 *
 *  2. NIGHT ATTENUATION: at local midnight the sky-dome and fog colours must be
 *     < 5% of their local-noon luminance, so night reads as night. This guards
 *     the midnight-too-bright class of defect at the MODEL level (independent of
 *     the post chain).
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import { computeSkyStateForVenue, createSkyState } from '@environment/SkyState';
import { computeLightingState } from './LightingModel';
import { createLightingState } from '@render/lighting/LightingState';

const DEG = Math.PI / 180;
const LUMA = (c: { r: number; g: number; b: number }): number =>
  0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

describe('colour-space: linear intent through three.Color uniforms', () => {
  it('new THREE.Color(r,g,b) stores the given LINEAR values verbatim (no sRGB decode)', () => {
    // ColorManagement is enabled by default in r0.180; the working space is
    // linear-sRGB, so the numeric constructor must NOT apply an sRGB→linear
    // curve. A linear 0.5 reads back as 0.5 (an sRGB decode would give ~0.214).
    const c = new THREE.Color(0.5, 0.25, 0.75);
    expect(c.r).toBeCloseTo(0.5, 6);
    expect(c.g).toBeCloseTo(0.25, 6);
    expect(c.b).toBeCloseTo(0.75, 6);
  });

  it('direct .r/.g/.b assignment (the bridge update path) keeps linear values', () => {
    // WaterLightingBridge / SkyDome update colours by mutating .r/.g/.b directly.
    // That path must not round-trip through any colour space either.
    const c = new THREE.Color(0, 0, 0);
    c.r = 0.5;
    c.g = 0.123;
    c.b = 0.9;
    expect(c.r).toBeCloseTo(0.5, 6);
    expect(c.g).toBeCloseTo(0.123, 6);
    expect(c.b).toBeCloseTo(0.9, 6);
  });

  it('ColorManagement working space is linear (the assumption the render layer relies on)', () => {
    const cm = (THREE as unknown as { ColorManagement?: { enabled: boolean; workingColorSpace: string } }).ColorManagement;
    // ColorManagement is not in the project's minimal three-env typings; read it
    // structurally. In r0.180 it is enabled with a linear-sRGB working space.
    expect(cm).toBeDefined();
    expect(cm?.enabled).toBe(true);
    expect(cm?.workingColorSpace).toBe('srgb-linear');
  });
});

describe('night attenuation: midnight sky/fog << noon', () => {
  const LAT = 41.49;
  const LON = -71.31;

  function lightingAt(epoch: number, cloud = 0.0): ReturnType<typeof createLightingState> {
    const sky = createSkyState();
    computeSkyStateForVenue(LAT, LON, epoch, 0, cloud, cloud, cloud, sky);
    return computeLightingState(sky, { solarRadiation: cloud > 0 ? 150 : 600, visibility: 30000 }, createLightingState());
  }

  // 15 Jul 2024; search a clear-sky noon and a clear-sky midnight by elevation.
  function epochForElevation(targetDeg: number, deepestNight = false): number {
    const base = Date.UTC(2024, 6, 15, 0, 0, 0);
    let best = base;
    let bestScore = Infinity;
    for (let t = 0; t < 24 * 3600 * 1000; t += 2 * 60 * 1000) {
      const e = base + t;
      const sky = createSkyState();
      computeSkyStateForVenue(LAT, LON, e, 0, 0, 0, 0, sky);
      const score = deepestNight ? sky.sunElevation : Math.abs(sky.sunElevation - targetDeg * DEG);
      if (deepestNight ? score < bestScore : score < bestScore) {
        bestScore = deepestNight ? sky.sunElevation : score;
        best = e;
      }
    }
    return best;
  }

  it('midnight zenith+horizon+fog luminance are each < 5% of noon', () => {
    const noon = lightingAt(epochForElevation(65));
    const midnight = lightingAt(epochForElevation(0, true));

    expect(midnight.nightFactor).toBeGreaterThan(0.99);
    expect(noon.nightFactor).toBeLessThan(0.01);

    const noonZ = LUMA(noon.zenithColor);
    const noonH = LUMA(noon.horizonColor);
    const noonF = LUMA(noon.fogColor);

    expect(LUMA(midnight.zenithColor)).toBeLessThan(0.05 * noonZ);
    expect(LUMA(midnight.horizonColor)).toBeLessThan(0.05 * noonH);
    expect(LUMA(midnight.fogColor)).toBeLessThan(0.05 * noonF);
    // Sun illuminance fully off at night.
    expect(midnight.sunIlluminance).toBe(0);
  });
});
