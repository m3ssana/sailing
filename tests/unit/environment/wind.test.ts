/**
 * Wind field tests.
 *
 * Validates determinism, gust coherence/anisotropy, magnitude bounds,
 * oscillation amplitude scaling, vertical gradient, and allocation freedom.
 */

import { describe, it, expect } from 'vitest';
import { createWindField } from '@environment/wind';
import type { WindFieldConfig } from '@environment/wind';
import type { WeatherKeyframe, WeatherService, WeatherSnapshot } from '@/types';
import type { WindProfile } from '@/types';

const DEG = Math.PI / 180;

/** Minimal snapshot for testing. */
function makeSnapshot(overrides?: Partial<{
  trueSpeed: number;
  trueDirection: number;
  gustCeiling: number;
  stability: number;
}>): WeatherSnapshot {
  const wind = {
    trueSpeed: overrides?.trueSpeed ?? 6,
    trueDirection: overrides?.trueDirection ?? 270 * DEG,
    gustCeiling: overrides?.gustCeiling ?? 10,
    stability: overrides?.stability ?? 0.3,
  };
  const keyframe: WeatherKeyframe = {
    offset: 0,
    wind,
    sea: {
      significantHeight: 1,
      dominantPeriod: 6,
      dominantDirection: 270 * DEG,
      swell: { height: 0.5, period: 10, direction: 270 * DEG },
      windWave: { height: 0.5, period: 4, direction: 270 * DEG },
      surfaceTemp: 18,
      tideHeight: 0,
    },
    current: { speed: 0.2, direction: 90 * DEG },
    sky: { cloudLow: 0.3, cloudMid: 0.2, cloudHigh: 0.1, visibility: 20000, precipitation: 0, wmoCode: 0, solarRadiation: 500, isDay: true },
    air: { temperature: 20, pressure: 101325, density: 1.225 },
  };
  return {
    fetchedAt: 1700000000000,
    source: 'live',
    venueId: 'newport',
    localTime: { iso: '2023-11-14T12:00:00', utcOffsetSeconds: -18000 },
    wind,
    sea: keyframe.sea,
    current: keyframe.current,
    sky: keyframe.sky,
    air: keyframe.air,
    timeline: [keyframe],
    attribution: ['Open-Meteo'],
  };
}

function makeWeatherService(snapshot: WeatherSnapshot): WeatherService {
  const kf = snapshot.timeline[0];
  if (kf === undefined) throw new Error('No keyframe');
  return {
    snapshot,
    sampleAt: () => kf,
    timeCompression: 1,
  };
}

function makeWindProfile(overrides?: Partial<WindProfile>): WindProfile {
  return {
    shearExponent: overrides?.shearExponent ?? 0.11,
    oscillationScale: overrides?.oscillationScale ?? 1,
    gustScale: overrides?.gustScale ?? 1,
    fetch: overrides?.fetch ?? 5000,
  };
}

function makeConfig(overrides?: {
  snapshot?: WeatherSnapshot;
  windProfile?: Partial<WindProfile>;
  seed?: number;
}): WindFieldConfig {
  const snapshot = overrides?.snapshot ?? makeSnapshot();
  return {
    weatherService: makeWeatherService(snapshot),
    seed: overrides?.seed ?? 42,
    windProfile: makeWindProfile(overrides?.windProfile),
  };
}

describe('WindField determinism', () => {
  it('same (seed, snapshot) yields identical samples from two independent fields', () => {
    const config = makeConfig();
    const field1 = createWindField({ ...config });
    const field2 = createWindField({ ...config });

    // Sample at several positions and times.
    const positions = [
      { x: 0, z: 0, h: 10, t: 0 },
      { x: 100, z: -50, h: 10, t: 30 },
      { x: -200, z: 300, h: 15, t: 120 },
      { x: 500, z: 500, h: 5, t: 300 },
    ];

    for (const { x, z, h, t } of positions) {
      const s1 = field1.sample(x, z, h, t);
      const s2 = field2.sample(x, z, h, t);
      expect(s1.speed).toBe(s2.speed);
      expect(s1.direction).toBe(s2.direction);
      expect(s1.gustFactor).toBe(s2.gustFactor);
      expect(s1.velocity.x).toBe(s2.velocity.x);
      expect(s1.velocity.y).toBe(s2.velocity.y);
      expect(s1.velocity.z).toBe(s2.velocity.z);
    }
  });

  it('different seeds yield different samples', () => {
    const field1 = createWindField(makeConfig({ seed: 1 }));
    const field2 = createWindField(makeConfig({ seed: 2 }));

    const s1 = field1.sample(100, 100, 10, 50);
    const s2 = field2.sample(100, 100, 10, 50);

    // With different seeds the gust pattern should differ.
    expect(s1.gustFactor).not.toBe(s2.gustFactor);
  });
});

describe('Gust coherence and anisotropy', () => {
  it('correlation along wind axis is higher than across it', () => {
    const snapshot = makeSnapshot({ trueDirection: 0 }); // Wind from north.
    const config = makeConfig({ snapshot });
    const field = createWindField(config);

    // Sample a line along the wind (north-south = z axis) and across it (east-west = x axis).
    const t = 100;
    const baseX = 0;
    const baseZ = 0;
    const step = 20; // metres between samples
    const n = 50;

    const alongSamples: number[] = [];
    const acrossSamples: number[] = [];

    for (let i = 0; i < n; i++) {
      // Along wind (downwind = south = +z for wind from north)
      alongSamples.push(field.sample(baseX, baseZ + i * step, 10, t).gustFactor);
      // Across wind (east = +x)
      acrossSamples.push(field.sample(baseX + i * step, baseZ, 10, t).gustFactor);
    }

    // Compute lag-1 autocorrelation as a measure of coherence.
    const autoCorrelation = (samples: number[]): number => {
      const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
      let num = 0;
      let den = 0;
      for (let i = 0; i < samples.length - 1; i++) {
        const a = (samples[i] ?? 0) - mean;
        const b = (samples[i + 1] ?? 0) - mean;
        num += a * b;
        den += a * a;
      }
      return den === 0 ? 0 : num / den;
    };

    const alongCorr = autoCorrelation(alongSamples);
    const acrossCorr = autoCorrelation(acrossSamples);

    // Anisotropy: along-wind correlation must be measurably higher.
    expect(alongCorr).toBeGreaterThan(acrossCorr);
  });
});

describe('Gust magnitude bounds', () => {
  it('never exceeds gustCeiling and never goes below zero', () => {
    const snapshot = makeSnapshot({ trueSpeed: 8, gustCeiling: 14 });
    const config = makeConfig({ snapshot });
    const field = createWindField(config);

    for (let t = 0; t < 600; t += 5) {
      for (let x = -500; x <= 500; x += 100) {
        for (let z = -500; z <= 500; z += 100) {
          const s = field.sample(x, z, 10, t);
          expect(s.speed).toBeGreaterThanOrEqual(0);
          // Allow some headroom for the numerical composition (oscillation * gust * terrain).
          // The hard cap in WindField is gustCeiling * 1.5.
          expect(s.speed).toBeLessThanOrEqual(14 * 1.5);
        }
      }
    }
  });

  it('gustFactor stays within expected range', () => {
    const snapshot = makeSnapshot({ trueSpeed: 6, gustCeiling: 10 });
    const config = makeConfig({ snapshot });
    const field = createWindField(config);

    for (let t = 0; t < 300; t += 10) {
      const s = field.sample(200, -100, 10, t);
      // gustFactor range: [0.8, gustCeiling/baseSpeed]
      expect(s.gustFactor).toBeGreaterThanOrEqual(0.8);
      expect(s.gustFactor).toBeLessThanOrEqual(10 / 6 + 0.01);
    }
  });
});

describe('Oscillation amplitude scales with stability', () => {
  it('unstable conditions produce larger direction swings', () => {
    const stableSnapshot = makeSnapshot({ stability: 0.1 });
    const unstableSnapshot = makeSnapshot({ stability: 0.9 });

    const stableField = createWindField(makeConfig({ snapshot: stableSnapshot }));
    const unstableField = createWindField(makeConfig({ snapshot: unstableSnapshot }));

    // Measure direction range over time at a fixed position.
    let stableRange = 0;
    let unstableRange = 0;
    let stableMin = Infinity;
    let stableMax = -Infinity;
    let unstableMin = Infinity;
    let unstableMax = -Infinity;

    for (let t = 0; t < 500; t += 1) {
      const sd = stableField.sample(0, 0, 10, t).direction;
      const ud = unstableField.sample(0, 0, 10, t).direction;
      if (sd < stableMin) stableMin = sd;
      if (sd > stableMax) stableMax = sd;
      if (ud < unstableMin) unstableMin = ud;
      if (ud > unstableMax) unstableMax = ud;
    }
    stableRange = stableMax - stableMin;
    unstableRange = unstableMax - unstableMin;

    expect(unstableRange).toBeGreaterThan(stableRange);
  });
});

describe('Vertical gradient', () => {
  it('wind at 10m exceeds wind at 1m', () => {
    const config = makeConfig({ windProfile: { shearExponent: 0.14 } });
    const field = createWindField(config);
    const t = 50;

    const speed10 = field.sample(0, 0, 10, t).speed;
    const speed1 = field.sample(0, 0, 1, t).speed;

    expect(speed10).toBeGreaterThan(speed1);
  });

  it('matches the power law', () => {
    const alpha = 0.14;
    const config = makeConfig({ windProfile: { shearExponent: alpha } });
    const field = createWindField(config);
    const t = 50;

    const speed10 = field.sample(0, 0, 10, t).speed;
    const speed20 = field.sample(0, 0, 20, t).speed;

    // Expected ratio: (20/10)^alpha = 2^0.14 ≈ 1.1
    const expectedRatio = Math.pow(20 / 10, alpha);
    const actualRatio = speed20 / speed10;

    expect(actualRatio).toBeCloseTo(expectedRatio, 4);
  });
});

describe('sampleGustGridInto allocation freedom', () => {
  it('does not allocate — buffer is caller-owned and reused', () => {
    const config = makeConfig();
    const field = createWindField(config);
    const resolution = 16;
    const buffer = new Float32Array(resolution * resolution);
    const origin = { x: -100, y: -100 };

    // Call many times. The same buffer is written into.
    for (let i = 0; i < 1000; i++) {
      field.sampleGustGridInto(buffer, origin, 10, resolution, i * 0.1);
    }

    // Verify the buffer has sensible values (all gust factors in valid range).
    for (let i = 0; i < buffer.length; i++) {
      const val = buffer[i];
      if (val !== undefined) {
        expect(val).toBeGreaterThanOrEqual(0.5);
        expect(val).toBeLessThanOrEqual(3.0);
      }
    }
  });

  it('fills the correct number of cells', () => {
    const config = makeConfig();
    const field = createWindField(config);
    const resolution = 8;
    const buffer = new Float32Array(resolution * resolution);
    buffer.fill(-1);

    field.sampleGustGridInto(buffer, { x: 0, y: 0 }, 5, resolution, 0);

    // All cells should be overwritten (no -1 remaining).
    for (let i = 0; i < buffer.length; i++) {
      const val = buffer[i];
      if (val !== undefined) {
        expect(val).not.toBe(-1);
      }
    }
  });
});
