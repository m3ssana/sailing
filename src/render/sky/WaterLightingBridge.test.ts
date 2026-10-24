/**
 * Tests for WaterLightingBridge (F.1) — verifies the live lighting is written
 * into the ocean water material's uniforms with the correct shapes, and that
 * a sunrise→sunset sweep makes the reflected sun progress as expected.
 */

import { describe, it, expect } from 'vitest';
import type { SkyState, WaterAppearance } from '@/types';
import { buildWaterMaterial } from '@render/ocean/WaterMaterial';
import { computeSkyStateForVenue, createSkyState } from '@environment/SkyState';
import { computeLightingState } from './LightingModel';
import { applyLightingToWater } from './WaterLightingBridge';
import { createLightingState } from '@render/lighting/LightingState';

const APPEARANCE: WaterAppearance = {
  colorShallow: { r: 0.1, g: 0.4, b: 0.5 },
  colorDeep: { r: 0.02, g: 0.08, b: 0.15 },
  turbidity: 0.2,
  extinctionDepth: 15,
};

function makeWater() {
  return buildWaterMaterial({
    appearance: APPEARANCE,
    sunDirection: { x: 0, y: 1, z: 0 },
  });
}

describe('applyLightingToWater', () => {
  it('writes sun direction, premultiplied sun colour, and sky colours', () => {
    const water = makeWater();
    const sky: SkyState = {
      ...createSkyState(),
      sunDirection: { x: 0.2, y: 0.6, z: -0.77 },
    };
    const lighting = {
      ...createLightingState(),
      sunColor: { r: 1, g: 0.8, b: 0.6 },
      sunIlluminance: 0.5,
      zenithColor: { r: 0.2, g: 0.4, b: 0.85 },
      horizonColor: { r: 0.7, g: 0.78, b: 0.9 },
    };

    applyLightingToWater(water.uniforms, sky, lighting);

    const sunDir = water.uniforms.sunDirection.value as { x: number; y: number; z: number };
    expect(sunDir.x).toBeCloseTo(0.2, 6);
    expect(sunDir.y).toBeCloseTo(0.6, 6);
    expect(sunDir.z).toBeCloseTo(-0.77, 6);

    const sunCol = water.uniforms.sunColor.value as { r: number; g: number; b: number };
    // Premultiplied by illuminance 0.5.
    expect(sunCol.r).toBeCloseTo(0.5, 6);
    expect(sunCol.g).toBeCloseTo(0.4, 6);
    expect(sunCol.b).toBeCloseTo(0.3, 6);

    const skyCol = water.uniforms.skyColor.value as { r: number; g: number; b: number };
    expect(skyCol.b).toBeCloseTo(0.85, 6);
    const hCol = water.uniforms.skyHorizonColor.value as { r: number; g: number; b: number };
    expect(hCol.r).toBeCloseTo(0.7, 6);
  });

  it('sunrise→sunset sweep makes the reflected sun brighten then dim', () => {
    const water = makeWater();
    // Newport solstice, several UTC hours spanning the day.
    const lat = 41.49;
    const lon = -71.31;
    const base = Date.UTC(2023, 5, 21, 0, 0, 0);

    const lumByHour: Array<{ elev: number; lum: number }> = [];
    for (let h = 9; h <= 24; h++) {
      const sky = computeSkyStateForVenue(lat, lon, base, h * 3600, 0, 0, 0, createSkyState());
      const lighting = computeLightingState(sky, { solarRadiation: 0, visibility: 30000 });
      applyLightingToWater(water.uniforms, sky, lighting);
      const c = water.uniforms.sunColor.value as { r: number; g: number; b: number };
      lumByHour.push({ elev: sky.sunElevation, lum: c.r + c.g + c.b });
    }

    // The sample with the highest sun elevation must have a brighter reflected
    // sun than the lowest-elevation (near-sunset / night) samples.
    const highest = lumByHour.reduce((a, b) => (b.elev > a.elev ? b : a));
    const lowest = lumByHour.reduce((a, b) => (b.elev < a.elev ? b : a));
    expect(highest.lum).toBeGreaterThan(lowest.lum);
    // Night reflection is effectively extinguished.
    expect(lowest.lum).toBeLessThan(0.05);
  });
});
