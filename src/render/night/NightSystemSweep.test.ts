/**
 * NightSystem — real-venue integration sweep (Stream F.4 audit fix #4).
 *
 * The prior facade test only checked that outputs were "defined / in range" for
 * one hand-rolled sky. This ties the facade's moonlight / star-visibility / gust
 * outputs to a REAL sky computed by `computeSkyStateForVenue` over a day/night
 * sweep at Newport, so a regression in any one feeding model (sun elevation →
 * nightFactor → star visibility / gust contrast) is caught end-to-end.
 *
 * Lighting is built the way a caller without F.1's `computeLightingState` would:
 * `createLightingState()` with `nightFactor` driven by
 * `nightFactorFromSunElevation(sunElevation)` — the documented night blend.
 */

import { describe, it, expect } from 'vitest';
import type { SkyState } from '@/types';
import { computeSkyStateForVenue, createSkyState } from '@environment/SkyState';
import {
  createLightingState,
  nightFactorFromSunElevation,
  type LightingState,
} from '../lighting/LightingState';
import { createNightSystem } from './NightSystem';

// Newport, RI. Longitude east-positive (its actual geographic longitude).
const NEWPORT_LAT = 41.49;
const NEWPORT_LON = -71.31;
const DEG = Math.PI / 180;

// 2023-11-14, mid-November. Newport is UTC-5 (EST) → local = UTC - 5h.
const BASE_UTC = Date.UTC(2023, 10, 14, 0, 0, 0);

/** Build the real sky for Newport at a given UTC hour on 2023-11-14. */
function newportSky(utcHour: number): SkyState {
  const out = createSkyState();
  return computeSkyStateForVenue(
    NEWPORT_LAT,
    NEWPORT_LON,
    BASE_UTC,
    utcHour * 3600,
    0, // clouds: clear so night features are unobstructed
    0,
    0,
    out,
  );
}

/** Lighting from the real sun elevation via the documented night blend. */
function lightingFor(sky: SkyState): LightingState {
  const l = createLightingState();
  l.overcast = 0;
  l.nightFactor = nightFactorFromSunElevation(sky.sunElevation);
  return l;
}

function runNight(utcHour: number): {
  sky: SkyState;
  lighting: LightingState;
  starVisibility: number;
  effectiveGustIntensity: number | undefined;
  moonIlluminance: number;
} {
  const sky = newportSky(utcHour);
  const lighting = lightingFor(sky);
  const sys = createNightSystem({
    seed: 2023,
    starCount: 400,
    latitude: NEWPORT_LAT * DEG,
  });
  sys.update(sky, lighting, { rawGustIntensity: 1 });
  const out = {
    sky,
    lighting,
    starVisibility: sys.starVisibility,
    effectiveGustIntensity: sys.effectiveGustIntensity,
    moonIlluminance: sys.moonlight.moonIlluminance,
  };
  sys.dispose();
  return out;
}

describe('NightSystem — Newport 2023-11-14 day/night sweep', () => {
  // Newport is UTC-5: local midnight ≈ 05:00 UTC, local noon ≈ 17:00 UTC.
  const LOCAL_MIDNIGHT_UTC = 5;
  const LOCAL_NOON_UTC = 17;

  it('sun is below the horizon at local midnight and well above at local noon', () => {
    const midnight = newportSky(LOCAL_MIDNIGHT_UTC);
    const noon = newportSky(LOCAL_NOON_UTC);
    expect(midnight.sunElevation).toBeLessThan(0);
    expect(noon.sunElevation).toBeGreaterThan(10 * DEG);
  });

  it('stars are visible at local midnight (nightFactor → 1, visibility > 0)', () => {
    const r = runNight(LOCAL_MIDNIGHT_UTC);
    expect(r.lighting.nightFactor).toBeGreaterThan(0.9);
    expect(r.starVisibility).toBeGreaterThan(0);
  });

  it('gust contrast is strongly suppressed (< 0.5) at local midnight', () => {
    const r = runNight(LOCAL_MIDNIGHT_UTC);
    // rawGustIntensity 1 → effective is exactly the contrast scale.
    expect(r.effectiveGustIntensity).toBeDefined();
    expect(r.effectiveGustIntensity).toBeLessThan(0.5);
  });

  it('gust contrast is full (≈ 1) at local noon and stars are not visible', () => {
    const r = runNight(LOCAL_NOON_UTC);
    expect(r.lighting.nightFactor).toBeCloseTo(0, 6);
    expect(r.effectiveGustIntensity).toBeCloseTo(1, 6);
    expect(r.starVisibility).toBe(0);
  });

  it('the given UTC sweep (21:00, 00:00, 03:00) is self-consistent across the three models', () => {
    for (const hour of [21, 24, 27]) {
      // 24 → next-day 00:00 UTC, 27 → 03:00 UTC (session time is additive).
      const r = runNight(hour);
      // All outputs finite and in range (no NaN poisoning end-to-end).
      expect(Number.isFinite(r.starVisibility)).toBe(true);
      expect(r.starVisibility).toBeGreaterThanOrEqual(0);
      expect(r.starVisibility).toBeLessThanOrEqual(1);
      expect(Number.isFinite(r.effectiveGustIntensity ?? NaN)).toBe(true);
      expect(r.effectiveGustIntensity).toBeGreaterThan(0);
      expect(r.effectiveGustIntensity).toBeLessThanOrEqual(1);
      // Monotone physical tie: more night ⇒ stronger star visibility ceiling and
      // weaker gust contrast. When fully night, gust contrast must be < day.
      if (r.lighting.nightFactor > 0.9) {
        expect(r.effectiveGustIntensity).toBeLessThan(0.5);
      }
    }
  });
});
