/**
 * Tide and current field tests.
 *
 * Validates that tidal current reverses across high water, height oscillates
 * with proper period, and the current field composes base + tidal components.
 */

import { describe, it, expect } from 'vitest';
import { createTideModel } from '@environment/TideModel';
import { createCurrentField } from '@environment/CurrentField';
import type { TideProfile, WeatherKeyframe, WeatherService, WeatherSnapshot } from '@/types';

const DEG = Math.PI / 180;

function makeTideProfile(overrides?: Partial<TideProfile>): TideProfile {
  return {
    amplitude: overrides?.amplitude ?? 1.5,
    phaseOffsetHours: overrides?.phaseOffsetHours ?? 0,
    currentStrength: overrides?.currentStrength ?? 1.0,
    currentAxis: overrides?.currentAxis ?? { x: 1, y: 0 }, // East-west axis.
  };
}

function makeSnapshot(): WeatherSnapshot {
  const keyframe: WeatherKeyframe = {
    offset: 0,
    wind: { trueSpeed: 6, trueDirection: 270 * DEG, gustCeiling: 10, stability: 0.3 },
    sea: {
      significantHeight: 1, dominantPeriod: 6, dominantDirection: 270 * DEG,
      swell: { height: 0.5, period: 10, direction: 270 * DEG },
      windWave: { height: 0.5, period: 4, direction: 270 * DEG },
      surfaceTemp: 18, tideHeight: 0.5,
    },
    current: { speed: 0.3, direction: 90 * DEG }, // Current flowing east (towards 90°)
    sky: { cloudLow: 0.3, cloudMid: 0.2, cloudHigh: 0.1, visibility: 20000, precipitation: 0, wmoCode: 0, solarRadiation: 500, isDay: true },
    air: { temperature: 20, pressure: 101325, density: 1.225 },
  };
  return {
    fetchedAt: 1700000000000,
    source: 'live',
    venueId: 'newport',
    localTime: { iso: '2023-11-14T12:00:00', utcOffsetSeconds: -18000 },
    wind: keyframe.wind,
    sea: keyframe.sea,
    current: keyframe.current,
    sky: keyframe.sky,
    air: keyframe.air,
    timeline: [keyframe],
    attribution: ['Open-Meteo'],
  };
}

function makeWeatherService(snapshot?: WeatherSnapshot): WeatherService {
  const s = snapshot ?? makeSnapshot();
  const kf = s.timeline[0];
  if (kf === undefined) throw new Error('No keyframe');
  return { snapshot: s, sampleAt: () => kf, timeCompression: 1 };
}

describe('TideModel', () => {
  it('height oscillates with semidiurnal period', () => {
    const profile = makeTideProfile();
    const model = createTideModel({
      profile,
      baseTideHeight: 0,
      utcOffsetSeconds: 0,
      sessionStartEpochMs: 1700000000000,
    });

    // Sample over 13 hours — should see roughly one full M2 cycle.
    const heights: number[] = [];
    for (let t = 0; t < 13 * 3600; t += 600) {
      heights.push(model.height(t));
    }

    // Find peaks (high waters).
    let peaks = 0;
    for (let i = 1; i < heights.length - 1; i++) {
      const prev = heights[i - 1];
      const curr = heights[i];
      const next = heights[i + 1];
      if (prev !== undefined && curr !== undefined && next !== undefined) {
        if (curr > prev && curr > next) peaks++;
      }
    }

    // Should have approximately 2 high waters in 13 hours (M2 period ~12.42h).
    expect(peaks).toBeGreaterThanOrEqual(1);
    expect(peaks).toBeLessThanOrEqual(3);
  });

  it('amplitude matches profile', () => {
    const profile = makeTideProfile({ amplitude: 2.0, phaseOffsetHours: 0 });
    const model = createTideModel({
      profile,
      baseTideHeight: 0,
      utcOffsetSeconds: 0,
      sessionStartEpochMs: 0, // Simplifies phase.
    });

    // Find max and min height over a full period.
    let maxH = -Infinity;
    let minH = Infinity;
    for (let t = 0; t < 50000; t += 60) {
      const h = model.height(t);
      if (h > maxH) maxH = h;
      if (h < minH) minH = h;
    }

    // Range should be roughly 2 * amplitude * (1 + S2_ratio) = 2 * 2 * 1.46 = 5.84
    // But M2 and S2 can constructively interfere: max is amplitude * (1 + 0.46) = 2.92
    const maxExpected = 2.0 * (1 + 0.46);
    expect(maxH).toBeCloseTo(maxExpected, 0);
  });

  it('current reverses across high water', () => {
    const profile = makeTideProfile({ currentStrength: 1.5 });
    const model = createTideModel({
      profile,
      baseTideHeight: 0,
      utcOffsetSeconds: 0,
      sessionStartEpochMs: 1700000000000,
    });

    // Find the next high water from t=0.
    const hw = model.nextHighWater(0);

    // Sample current before and after high water.
    const before = model.currentVelocity(hw - 1800); // 30 min before.
    const after = model.currentVelocity(hw + 1800); // 30 min after.

    // Current should reverse (sign change on the principal axis).
    // The current is on the x-axis per our profile.
    expect(before.x * after.x).toBeLessThan(0);
  });

  it('nextReversal returns a time after t', () => {
    const profile = makeTideProfile();
    const model = createTideModel({
      profile,
      baseTideHeight: 0,
      utcOffsetSeconds: 0,
      sessionStartEpochMs: 1700000000000,
    });

    const reversal = model.nextReversal(0);
    expect(reversal).toBeGreaterThan(60); // At least 1 minute in the future.
    expect(reversal).toBeLessThan(7 * 3600); // Less than 7 hours (half M2 period).
  });
});

describe('CurrentField', () => {
  it('combines base current and tidal current', () => {
    const snapshot = makeSnapshot();
    const service = makeWeatherService(snapshot);
    const field = createCurrentField({
      weatherService: service,
      tideProfile: makeTideProfile({ currentStrength: 0.5 }),
      sessionStartEpochMs: snapshot.fetchedAt,
    });

    // At t=0 there's both a base current (0.3 m/s towards 90°) and tidal.
    const sample = field.sample(0, 0, 0);
    // Should have non-zero current.
    const speed = Math.sqrt(sample.x * sample.x + sample.y * sample.y);
    expect(speed).toBeGreaterThan(0);
  });

  it('tideHeight varies over time', () => {
    const snapshot = makeSnapshot();
    const service = makeWeatherService(snapshot);
    const field = createCurrentField({
      weatherService: service,
      tideProfile: makeTideProfile({ amplitude: 2.0 }),
      sessionStartEpochMs: snapshot.fetchedAt,
    });

    const h1 = field.tideHeight(0);
    const h2 = field.tideHeight(6 * 3600); // 6 hours later.
    expect(h1).not.toBeCloseTo(h2, 1);
  });

  it('venturi effect increases current in shallower water', () => {
    const snapshot = makeSnapshot();
    const service = makeWeatherService(snapshot);
    const deepField = createCurrentField({
      weatherService: service,
      tideProfile: makeTideProfile({ currentStrength: 1.0 }),
      depthAt: () => 20,
      referenceDepth: 20,
      sessionStartEpochMs: snapshot.fetchedAt,
    });
    const shallowField = createCurrentField({
      weatherService: service,
      tideProfile: makeTideProfile({ currentStrength: 1.0 }),
      depthAt: () => 5,
      referenceDepth: 20,
      sessionStartEpochMs: snapshot.fetchedAt,
    });

    const t = 3 * 3600; // Some time with active current.
    const deepSample = deepField.sample(0, 0, t);
    const shallowSample = shallowField.sample(0, 0, t);

    const deepSpeed = Math.sqrt(deepSample.x ** 2 + deepSample.y ** 2);
    const shallowSpeed = Math.sqrt(shallowSample.x ** 2 + shallowSample.y ** 2);

    // Shallow water should have stronger current due to venturi.
    expect(shallowSpeed).toBeGreaterThan(deepSpeed);
  });
});
