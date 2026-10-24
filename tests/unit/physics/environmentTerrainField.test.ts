/**
 * Test for the additive `EnvironmentConfig.terrainField` passthrough
 * (src/environment/Environment.ts).
 *
 * The field is forwarded to `createWindField` so a venue's generated wind
 * influence field modulates the simulated wind. The change must be purely
 * additive and backward compatible: omitting `terrainField` leaves the wind
 * exactly as before (neutral identity influence).
 *
 * Lives under tests/unit/physics (owned by this stream) rather than
 * tests/unit/environment (owned by another stream) to respect ownership; it
 * imports the real `createEnvironment` and the frozen `TerrainInfluenceField`
 * contract from the wind layer.
 */

import { describe, it, expect } from 'vitest';
import type { TerrainInfluenceField } from '@environment/wind';
import { makeEnvironment, makeSnapshot, makeWeatherService, makeVenue } from '../boats/fixtures';
import { createEnvironment } from '@/environment';

const TIME = 0;

describe('EnvironmentConfig.terrainField passthrough', () => {
  it('is backward compatible: omitting it leaves the wind unchanged', () => {
    // Two environments built identically with NO terrainField must sample the
    // same wind (the neutral identity influence, as before this field existed).
    const a = makeEnvironment(12);
    const b = makeEnvironment(12);
    const wa = a.wind.sample(100, 200, 5, TIME);
    const wb = b.wind.sample(100, 200, 5, TIME);
    expect(wb.speed).toBeCloseTo(wa.speed, 10);
    expect(wb.direction).toBeCloseTo(wa.direction, 10);
  });

  it('forwards the terrain field so it modulates wind speed/direction', () => {
    // A single-pixel field with a strong speed multiplier and a direction bias.
    // (G encodes direction bias: 0.5 → 0°, 1.0 → +45°.) The wind sampled WITH the
    // field must differ from the neutral baseline in the way the field dictates.
    const boostField: TerrainInfluenceField = {
      data: new Float32Array([1.35, 1.0]), // speed ×1.35, +45° direction bias.
      originX: -1e6, originZ: -1e6, extentX: 2e6, extentZ: 2e6, resolution: 1,
    };

    const snapshot = makeSnapshot(12);
    const weatherService = makeWeatherService(snapshot);
    const venue = makeVenue();

    const neutral = createEnvironment({ weatherService, venue, seed: 1234 });
    const influenced = createEnvironment({
      weatherService, venue, seed: 1234, terrainField: boostField,
    });

    const wn = neutral.wind.sample(0, 0, 5, TIME);
    const wi = influenced.wind.sample(0, 0, 5, TIME);

    // Speed multiplied up (1.35× before the gust-ceiling clamp; strictly faster).
    expect(wi.speed).toBeGreaterThan(wn.speed);
    // Direction shifted by the +45° bias (not equal to the neutral direction).
    expect(Math.abs(wi.direction - wn.direction)).toBeGreaterThan(0.1);
  });
});
