/**
 * Tests for the wind influence field generator (D.7).
 *
 * Uses small resolution (32×32) for speed while verifying the generator
 * accepts resolution as a parameter and produces correct qualitative effects.
 *
 * Conventions: wind bearing is direction wind comes FROM. Bearing 0 = from north.
 * Grid: row = south (+Z), col = east (+X). Bounds min = NW corner, max = SE corner.
 */

import { describe, expect, it } from 'vitest';
import { generateWindInfluenceField } from './WindInfluenceField';
import type { WindInfluenceFieldParams } from './WindInfluenceField';
import type { Polyline, Vec2 } from '@/types';

const RESOLUTION = 32;
const BOUNDS = { min: { x: 0, y: 0 }, max: { x: 1000, y: 1000 } };
const SEED = 42;

/** Helper: decode speed multiplier at grid position (row, col). */
function getSpeed(data: Float32Array, resolution: number, row: number, col: number): number {
  const idx = (row * resolution + col) * 2;
  return data[idx] ?? 1;
}

/** Helper: decode direction deflection at grid position (row, col) in radians. */
function getDeflection(data: Float32Array, resolution: number, row: number, col: number): number {
  const idx = (row * resolution + col) * 2 + 1;
  const encoded = data[idx] ?? 0.5;
  return (encoded - 0.5) * 2 * (Math.PI / 4);
}

/**
 * Create a closed rectangular polygon with negative signed area in Y-south space,
 * which the builder classifies as outer ring → land inside.
 *
 * Winding: (x1,y1)→(x1,y2)→(x2,y2)→(x2,y1) produces negative signed area
 * when x2 > x1 and y2 > y1.
 */
function makeRect(x1: number, y1: number, x2: number, y2: number): Polyline {
  const points: Vec2[] = [
    { x: x1, y: y1 },
    { x: x1, y: y2 },
    { x: x2, y: y2 },
    { x: x2, y: y1 },
  ];
  return { points, closed: true };
}



describe('WindInfluenceField', () => {
  describe('all-water venue (no coastline)', () => {
    it('produces speed ≈ 1 and deflection ≈ 0 everywhere', () => {
      const params: WindInfluenceFieldParams = {
        bounds: BOUNDS,
        coastlines: [],
        relief: 'flat',
        maxElevation: 0,
        resolution: RESOLUTION,
        referenceWindDirection: 0, // from north
        seed: SEED,
      };

      const result = generateWindInfluenceField(params);

      expect(result.resolution).toBe(RESOLUTION);
      expect(result.data.length).toBe(RESOLUTION * RESOLUTION * 2);

      for (let row = 0; row < RESOLUTION; row++) {
        for (let col = 0; col < RESOLUTION; col++) {
          const speed = getSpeed(result.data, RESOLUTION, row, col);
          const defl = getDeflection(result.data, RESOLUTION, row, col);
          expect(speed).toBeCloseTo(1.0, 1);
          expect(Math.abs(defl)).toBeLessThan(0.01);
        }
      }
    });
  });

  describe('determinism', () => {
    it('produces identical output for same inputs', () => {
      const params: WindInfluenceFieldParams = {
        bounds: BOUNDS,
        coastlines: [makeRect(200, 200, 400, 600)],
        relief: 'hilly',
        maxElevation: 100,
        resolution: RESOLUTION,
        referenceWindDirection: Math.PI / 4, // from NE
        seed: SEED,
      };

      const result1 = generateWindInfluenceField(params);
      const result2 = generateWindInfluenceField(params);

      expect(result1.data.length).toBe(result2.data.length);
      for (let i = 0; i < result1.data.length; i++) {
        expect(result1.data[i]).toBe(result2.data[i]);
      }
    });
  });

  describe('lee shadow', () => {
    it('reduces speed downwind of a headland compared to open water', () => {
      // Wind from north (bearing 0). Land in northern part of the grid.
      // Downwind = south of the land. We compare a point directly south of land
      // to a point at the same latitude but far from land (open water).

      // Headland: a peninsula sticking south from the north edge
      // Winding: (x1,y1)→(x1,y2)→(x2,y2)→(x2,y1) → negative signed area → land
      const headland: Polyline = {
        points: [
          { x: 400, y: 0 },
          { x: 400, y: 500 },
          { x: 600, y: 500 },
          { x: 600, y: 0 },
        ],
        closed: true,
      };

      const params: WindInfluenceFieldParams = {
        bounds: BOUNDS,
        coastlines: [headland],
        relief: 'hilly',
        maxElevation: 200,
        resolution: RESOLUTION,
        referenceWindDirection: 0, // from north
        seed: SEED,
      };

      const result = generateWindInfluenceField(params);

      // Point directly downwind of headland tip: row ~18 (south of row 16 = 500m),
      // col ~16 (middle of headland at 500m)
      // Grid: col 16 = 500m, row 18 = 562m (just south of the headland tip at 500m)
      const leeRow = 18;
      const leeCol = 16;
      const leeShadowSpeed = getSpeed(result.data, RESOLUTION, leeRow, leeCol);

      // Open water point: same row but far from land (col 2 = ~62m, west side open)
      const openRow = 18;
      const openCol = 2;
      const openSpeed = getSpeed(result.data, RESOLUTION, openRow, openCol);

      // Lee shadow should reduce speed compared to open water
      expect(leeShadowSpeed).toBeLessThan(openSpeed);
    });
  });

  describe('gap acceleration', () => {
    it('boosts speed in a narrow channel between two land masses', () => {
      // Two land masses with a narrow gap between them.
      // Wind from the north (bearing 0).
      // The gap is perpendicular to the wind — two blocks of land on east and west
      // with a narrow channel in the middle.
      const leftLand = makeRect(0, 200, 400, 800);    // left block
      const rightLand = makeRect(600, 200, 1000, 800); // right block
      // Gap is 400–600 in X (200m wide), 200–800 in Y

      const params: WindInfluenceFieldParams = {
        bounds: BOUNDS,
        coastlines: [leftLand, rightLand],
        relief: 'hilly',
        maxElevation: 150,
        resolution: RESOLUTION,
        referenceWindDirection: 0, // from north
        seed: SEED,
      };

      const result = generateWindInfluenceField(params);

      // Point in the gap: col ~16 (500m, centre), row ~16 (500m, middle of channel)
      const gapRow = 16;
      const gapCol = 16;
      const gapSpeed = getSpeed(result.data, RESOLUTION, gapRow, gapCol);

      // Reference: open water far from any influence (this scenario has land on
      // both sides, so we use a point at the very south edge which is outside the gap)
      // Actually, for a fair comparison, let's check the gap speed exceeds 1.0
      // since both the lee shadow and gap boost operate on this region, and the
      // gap boost should dominate in the channel centre.
      // Also compare against a point at same distance from shore but NOT in a gap.
      // Point at row 2, col 16 (north of the land blocks — open water)
      const refRow = 2;
      const refCol = 16;
      const refSpeed = getSpeed(result.data, RESOLUTION, refRow, refCol);

      // Gap should have higher speed than equivalent non-gap position
      expect(gapSpeed).toBeGreaterThan(refSpeed);
    });
  });

  describe('shoreline bend', () => {
    it('deflects wind direction near a straight N-S coastline', () => {
      // Straight N-S coastline on the west side. Wind from the north.
      // Near the coast, wind should bend toward shore-parallel (i.e., toward N-S).
      // Since wind is already from the north (shore-parallel for a N-S coast),
      // use wind from the east instead so there's a clear bend signal.
      const westCoast: Polyline = {
        points: [
          { x: 0, y: 0 },
          { x: 0, y: 1000 },
          { x: 200, y: 1000 },
          { x: 200, y: 0 },
        ],
        closed: true,
      };

      const params: WindInfluenceFieldParams = {
        bounds: BOUNDS,
        coastlines: [westCoast],
        relief: 'flat',
        maxElevation: 50,
        resolution: RESOLUTION,
        referenceWindDirection: Math.PI / 2, // from east (bearing 90°)
        seed: SEED,
      };

      const result = generateWindInfluenceField(params);

      // Point near the coast: col ~8 (250m, just offshore), row ~16 (middle)
      const nearRow = 16;
      const nearCol = 8;
      const nearDeflection = getDeflection(result.data, RESOLUTION, nearRow, nearCol);

      // Point far from coast: col ~28 (875m), row ~16
      const farRow = 16;
      const farCol = 28;
      const farDeflection = getDeflection(result.data, RESOLUTION, farRow, farCol);

      // Near coast should have larger absolute deflection than far from coast
      expect(Math.abs(nearDeflection)).toBeGreaterThan(Math.abs(farDeflection));
      // And should be non-trivially non-zero
      expect(Math.abs(nearDeflection)).toBeGreaterThan(0.01); // > ~0.5°

      // Check direction consistency: for a N-S coast with wind from east,
      // the wind should bend toward north or south (shore-parallel).
      // Shore tangent for a N-S wall runs at bearing 0° or 180°.
      // Wind from east = bearing 90°. Deflection should bend TOWARD 0° or 180°,
      // meaning the deflection should be negative (turning clockwise from east toward south)
      // or toward north (counterclockwise). The sign depends on which tangent direction
      // is closer. From 90° (east), 0° (north) is -90° away, 180° (south) is +90° away.
      // The algorithm picks the closer one: both are equidistant at 90°, but after the
      // π/2 check it should resolve. The important thing is it's non-zero and consistent.
      // Just verify it's meaningfully non-zero — we already checked magnitude above.
    });
  });

  describe('output format', () => {
    it('matches TerrainInfluenceField contract shape', () => {
      const params: WindInfluenceFieldParams = {
        bounds: BOUNDS,
        coastlines: [makeRect(100, 100, 300, 300)],
        relief: 'flat',
        maxElevation: 50,
        resolution: RESOLUTION,
        referenceWindDirection: 0,
        seed: SEED,
      };

      const result = generateWindInfluenceField(params);

      // Shape checks
      expect(result.resolution).toBe(RESOLUTION);
      expect(result.originX).toBe(BOUNDS.min.x);
      expect(result.originZ).toBe(BOUNDS.min.y);
      expect(result.extentX).toBe(BOUNDS.max.x - BOUNDS.min.x);
      expect(result.extentZ).toBe(BOUNDS.max.y - BOUNDS.min.y);
      expect(result.data).toBeInstanceOf(Float32Array);
      expect(result.data.length).toBe(RESOLUTION * RESOLUTION * 2);

      // All speed values within consumer's valid range [0.15, 1.35]
      // All direction bias values within [0, 1]
      for (let i = 0; i < RESOLUTION * RESOLUTION; i++) {
        const speed = result.data[i * 2] ?? 0;
        const bias = result.data[i * 2 + 1] ?? 0;
        expect(speed).toBeGreaterThanOrEqual(0.15);
        expect(speed).toBeLessThanOrEqual(1.35);
        expect(bias).toBeGreaterThanOrEqual(0);
        expect(bias).toBeLessThanOrEqual(1);
      }
    });

    it('defaults to 512 resolution when not specified', () => {
      const params: WindInfluenceFieldParams = {
        bounds: BOUNDS,
        coastlines: [],
        relief: 'flat',
        maxElevation: 0,
        referenceWindDirection: 0,
        seed: SEED,
      };

      const result = generateWindInfluenceField(params);
      expect(result.resolution).toBe(512);
      expect(result.data.length).toBe(512 * 512 * 2);
    });
  });
});
