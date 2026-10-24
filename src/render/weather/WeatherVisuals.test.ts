/**
 * Tests for CloudRenderer.ts and WeatherVisuals.ts (F.2).
 *
 * Headless: build the three/TSL objects in node, drive update(), confirm the
 * fallback path is selected when cloudMarchSteps == 0, and dispose cleanly.
 */

import { describe, expect, it } from 'vitest';
import type { QualityKnobs, SkyConditions, SkyState, Vec3 } from '@/types';
import { createLightingState } from '@render/lighting/LightingState';
import { createCloudRenderer } from '@render/weather/CloudRenderer';
import { createWeatherVisuals } from '@render/weather/WeatherVisuals';

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

function makeConditions(partial: Partial<SkyConditions> = {}): SkyConditions {
  return {
    cloudLow: 0.6,
    cloudMid: 0.2,
    cloudHigh: 0.1,
    visibility: 10_000,
    precipitation: 0,
    wmoCode: 2,
    solarRadiation: 500,
    isDay: true,
    ...partial,
  };
}

const CAMERA: Vec3 = { x: 100, y: 3, z: -50 };
const WIND: Vec3 = { x: 5, y: 0, z: -2 };

function knobs(cloudMarchSteps: number): Pick<QualityKnobs, 'cloudMarchSteps'> {
  return { cloudMarchSteps };
}

describe('createCloudRenderer', () => {
  it('builds and exposes an object', () => {
    const r = createCloudRenderer();
    expect(r.object).toBeDefined();
    r.dispose();
  });

  it('selects the raymarch path when cloudMarchSteps > 0', () => {
    const r = createCloudRenderer();
    r.update(makeSky(), createLightingState(), 0, CAMERA, knobs(16), WIND);
    expect(r.isFallback).toBe(false);
    r.dispose();
  });

  it('selects the FALLBACK path when cloudMarchSteps == 0', () => {
    const r = createCloudRenderer();
    r.update(makeSky(), createLightingState(), 0, CAMERA, knobs(0), WIND);
    expect(r.isFallback).toBe(true);
    r.dispose();
  });

  it('dome follows the camera (x,z)', () => {
    const r = createCloudRenderer();
    r.update(makeSky(), createLightingState(), 1, CAMERA, knobs(8), WIND);
    expect(r.object.position.x).toBe(CAMERA.x);
    expect(r.object.position.z).toBe(CAMERA.z);
    r.dispose();
  });

  it('updates repeatedly without throwing (temporal bookkeeping advances)', () => {
    const r = createCloudRenderer();
    expect(() => {
      for (let f = 0; f < 10; f++) {
        r.update(makeSky(), createLightingState(), f * 0.016, CAMERA, knobs(12), WIND);
      }
    }).not.toThrow();
    r.dispose();
  });
});

describe('createWeatherVisuals facade', () => {
  it('bundles clouds + rain + visibility and updates in one call', () => {
    const wv = createWeatherVisuals({ rainBudget: 100 });
    expect(wv.object).toBeDefined();
    expect(wv.clouds).toBeDefined();
    expect(wv.rain).toBeDefined();
    expect(wv.visibility).toBeDefined();

    expect(() =>
      wv.update(
        makeSky(),
        makeConditions({ precipitation: 8, visibility: 3000 }),
        createLightingState(),
        WIND,
        0.016,
        CAMERA,
        knobs(16),
      ),
    ).not.toThrow();

    // Rain active under precipitation.
    expect(wv.rain.object.visible).toBe(true);
    wv.dispose();
  });

  it('rain hides when precipitation is 0', () => {
    const wv = createWeatherVisuals({ rainBudget: 100 });
    wv.update(makeSky(), makeConditions({ precipitation: 0 }), createLightingState(), WIND, 0.016, CAMERA, knobs(16));
    expect(wv.rain.object.visible).toBe(false);
    wv.dispose();
  });

  it('respects cloudMarchSteps == 0 fallback through the facade', () => {
    const wv = createWeatherVisuals();
    wv.update(makeSky(), makeConditions(), createLightingState(), WIND, 0.016, CAMERA, knobs(0));
    expect(wv.clouds.isFallback).toBe(true);
    wv.dispose();
  });
});
