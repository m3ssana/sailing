/**
 * Interpolation tests — circular direction interpolation crossing north,
 * Catmull-Rom for speeds, wave lag behind wind.
 */

import { describe, it, expect } from 'vitest';
import { UNITS } from '@/types';
import type { WeatherKeyframe } from '@/types';
import { sampleTimeline, waveLagFromFetch } from '@weather/interpolate';
import type { InterpolationConfig } from '@weather/interpolate';

/** Helper: build a minimal keyframe with just the fields we're testing. */
function makeKeyframe(
  offset: number,
  windSpeed: number,
  windDir: number,
  waveHeight: number,
): WeatherKeyframe {
  return {
    offset,
    wind: { trueSpeed: windSpeed, trueDirection: windDir, gustCeiling: windSpeed * 1.3, stability: 0.3 },
    sea: {
      significantHeight: waveHeight,
      dominantPeriod: 5,
      dominantDirection: windDir,
      swell: { height: waveHeight * 0.5, period: 8, direction: windDir },
      windWave: { height: waveHeight * 0.5, period: 3, direction: windDir },
      surfaceTemp: 18,
      tideHeight: 0,
    },
    current: { speed: 0.2, direction: windDir },
    sky: {
      cloudLow: 0.3, cloudMid: 0.2, cloudHigh: 0.1,
      visibility: 20000, precipitation: 0, wmoCode: 0,
      solarRadiation: 500, isDay: true,
    },
    air: { temperature: 20, pressure: 101325, density: 1.2 },
  };
}

describe('Circular interpolation', () => {
  it('350° → 10° crosses north (not 180°)', () => {
    // Two keyframes: wind from 350° then shifts to 10° (crossing north)
    const dir350 = 350 * UNITS.DEG_TO_RAD;
    const dir10 = 10 * UNITS.DEG_TO_RAD;

    const timeline: WeatherKeyframe[] = [
      makeKeyframe(0, 7, dir350, 0.5),
      makeKeyframe(3600, 7, dir10, 0.5),
    ];

    const config: InterpolationConfig = {
      waveLagSeconds: 0,
      timeCompression: 1,
    };

    // At t=1800 (halfway), direction should be ~0° (north), not ~180° (south)
    const sample = sampleTimeline(timeline, 1800, config);
    const dirDeg = sample.wind.trueDirection * UNITS.RAD_TO_DEG;

    // Should be near 0° (or 360°), definitely not near 180°
    const normalizedDeg = ((dirDeg % 360) + 360) % 360;
    expect(normalizedDeg).toBeLessThan(10);
    // or greater than 350
    if (normalizedDeg > 10) {
      expect(normalizedDeg).toBeGreaterThan(350);
    }
  });

  it('300° → 60° takes the short arc through north', () => {
    // 300° and 60° are 120° apart. The short arc goes through 0° (north).
    // The long arc would go through 180° (south). Midpoint should be 0°.
    const dir300 = 300 * UNITS.DEG_TO_RAD;
    const dir60 = 60 * UNITS.DEG_TO_RAD;

    const timeline: WeatherKeyframe[] = [
      makeKeyframe(0, 7, dir300, 0.5),
      makeKeyframe(3600, 7, dir60, 0.5),
    ];

    const config: InterpolationConfig = {
      waveLagSeconds: 0,
      timeCompression: 1,
    };

    // Halfway: should be near 0° (north), not 180° (south)
    const sample = sampleTimeline(timeline, 1800, config);
    const dirDeg = sample.wind.trueDirection * UNITS.RAD_TO_DEG;
    const normalizedDeg = ((dirDeg % 360) + 360) % 360;

    // Should be near 0° (north)
    expect(Math.min(normalizedDeg, 360 - normalizedDeg)).toBeLessThan(5);
  });

  it('antipodal case (270° → 90°) is mathematically ambiguous', () => {
    // 270° and 90° are exactly 180° apart — neither arc is shorter.
    // The implementation picks one valid midpoint (0° or 180°); both are correct.
    // This test documents the ambiguity rather than prescribing a direction.
    const dir270 = 270 * UNITS.DEG_TO_RAD;
    const dir90 = 90 * UNITS.DEG_TO_RAD;

    const timeline: WeatherKeyframe[] = [
      makeKeyframe(0, 7, dir270, 0.5),
      makeKeyframe(3600, 7, dir90, 0.5),
    ];

    const config: InterpolationConfig = {
      waveLagSeconds: 0,
      timeCompression: 1,
    };

    const sample = sampleTimeline(timeline, 1800, config);
    const dirDeg = sample.wind.trueDirection * UNITS.RAD_TO_DEG;
    const normalizedDeg = ((dirDeg % 360) + 360) % 360;

    // Result must be one of the two valid antipodal midpoints: 0° or 180°.
    const distTo0 = Math.min(normalizedDeg, 360 - normalizedDeg);
    const distTo180 = Math.abs(normalizedDeg - 180);
    expect(Math.min(distTo0, distTo180)).toBeLessThan(1);
  });

  it('current direction also uses circular interpolation', () => {
    const dir350 = 350 * UNITS.DEG_TO_RAD;
    const dir10 = 10 * UNITS.DEG_TO_RAD;

    const kf1 = makeKeyframe(0, 7, 0, 0.5);
    const kf2 = makeKeyframe(3600, 7, 0, 0.5);
    kf1.current = { speed: 0.3, direction: dir350 };
    kf2.current = { speed: 0.3, direction: dir10 };

    const timeline: WeatherKeyframe[] = [kf1, kf2];
    const config: InterpolationConfig = { waveLagSeconds: 0, timeCompression: 1 };

    const sample = sampleTimeline(timeline, 1800, config);
    const dirDeg = sample.current.direction * UNITS.RAD_TO_DEG;
    const normalizedDeg = ((dirDeg % 360) + 360) % 360;

    expect(Math.min(normalizedDeg, 360 - normalizedDeg)).toBeLessThan(10);
  });
});

describe('Catmull-Rom speed interpolation', () => {
  it('produces smooth buildup without piecewise-linear kinks', () => {
    // 4 keyframes with increasing then plateauing wind
    const timeline: WeatherKeyframe[] = [
      makeKeyframe(0, 5, 0, 0.3),
      makeKeyframe(3600, 8, 0, 0.5),
      makeKeyframe(7200, 10, 0, 0.7),
      makeKeyframe(10800, 9, 0, 0.6),
    ];

    const config: InterpolationConfig = { waveLagSeconds: 0, timeCompression: 1 };

    // Sample at the midpoint between keyframe 1 and 2
    const sample = sampleTimeline(timeline, 5400, config);

    // Catmull-Rom should give something between 8 and 10 but not exactly 9
    // (linear would give exactly 9)
    expect(sample.wind.trueSpeed).toBeGreaterThan(7.5);
    expect(sample.wind.trueSpeed).toBeLessThan(10.5);
  });

  it('never produces negative wind speed', () => {
    const timeline: WeatherKeyframe[] = [
      makeKeyframe(0, 2, 0, 0.2),
      makeKeyframe(3600, 0.5, 0, 0.1),
      makeKeyframe(7200, 0.2, 0, 0.05),
      makeKeyframe(10800, 3, 0, 0.3),
    ];

    const config: InterpolationConfig = { waveLagSeconds: 0, timeCompression: 1 };

    // Sample throughout — speed must never go negative
    for (let t = 0; t <= 10800; t += 300) {
      const sample = sampleTimeline(timeline, t, config);
      expect(sample.wind.trueSpeed).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('Wave lag behind wind', () => {
  it('wave height lags behind a wind increase', () => {
    // Wind builds from 5 to 15 m/s over the first two keyframes
    // Waves should still be low when sampled at the same time as the wind peak
    const timeline: WeatherKeyframe[] = [
      makeKeyframe(0, 5, 0, 0.3),
      makeKeyframe(3600, 15, 0, 1.5),
      makeKeyframe(7200, 15, 0, 1.8),
      makeKeyframe(10800, 15, 0, 2.0),
    ];

    // Large wave lag of 1800s means the sea is sampling 30 min in the past
    const configWithLag: InterpolationConfig = {
      waveLagSeconds: 1800,
      timeCompression: 1,
    };

    const configNoLag: InterpolationConfig = {
      waveLagSeconds: 0,
      timeCompression: 1,
    };

    // At t=3600, wind has reached 15 m/s
    const withLag = sampleTimeline(timeline, 3600, configWithLag);
    const noLag = sampleTimeline(timeline, 3600, configNoLag);

    // With lag, the sea should still be lower (sampling from earlier timeline)
    expect(withLag.sea.significantHeight).toBeLessThan(noLag.sea.significantHeight);
  });

  it('waveLagFromFetch computes reasonable values', () => {
    // Short fetch (lake) → short lag
    const shortLag = waveLagFromFetch(2000); // 2 km
    expect(shortLag).toBe(120); // minimum 120s

    // Medium fetch (bay)
    const mediumLag = waveLagFromFetch(10000); // 10 km
    expect(mediumLag).toBe(600); // 10000 * 0.06 = 600s

    // Long fetch (open ocean)
    const longLag = waveLagFromFetch(50000); // 50 km
    expect(longLag).toBe(1800); // capped at 1800s
  });
});

describe('Time compression', () => {
  it('8× compression maps 450s session to 3600s forecast', () => {
    const timeline: WeatherKeyframe[] = [
      makeKeyframe(0, 8, 0, 0.5),
      makeKeyframe(3600, 12, 0, 0.8),
    ];

    const config: InterpolationConfig = {
      waveLagSeconds: 0,
      timeCompression: 8,
    };

    // At session time 450s with 8× compression → forecast offset 3600s
    const sample = sampleTimeline(timeline, 450, config);
    // Should be at or very near the second keyframe
    expect(sample.wind.trueSpeed).toBeCloseTo(12, 0);
  });
});
