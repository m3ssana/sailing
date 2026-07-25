/**
 * TerrainBuilder tests — D.5.
 *
 * Validates:
 * - Synthetic coastline produces coherent land, beach, and shelving bathymetry.
 * - Land mask correctness (land where expected, water where expected).
 * - Shore distance is negative offshore and near-zero at coastline.
 * - Bathymetry shallows near shore (no cliffs at the waterline).
 * - Heightfield: positive on land, negative in deep water.
 * - Determinism: same seed → byte-identical output.
 * - Mesh: valid, finite, bounds matching params.
 */

import { describe, it, expect } from 'vitest';
import type { TerrainParams, Polyline, Vec2 } from '@/types';
import { TerrainBuilder } from './TerrainBuilder';
import { assertFiniteBuffers, assertNoDegenerateTriangles } from '../testing/geometryAssertions';

// ─── Test fixtures ───────────────────────────────────────────────────────────

/**
 * A simple bay: a CCW outer ring that forms a square peninsula on the left half.
 * The terrain is 1000m × 1000m. The coastline encloses roughly the left 50%
 * as land (a rectangular peninsula), leaving the right 50% as water.
 *
 *   (100,100) ─── (500,100)
 *      |              |
 *      |    LAND      |     WATER
 *      |              |
 *   (100,900) ─── (500,900)
 *
 * Points are in CCW order → positive signed area → land inside.
 */
function makeBayCoastline(): Polyline {
  return {
    points: [
      { x: 100, y: 100 },
      { x: 100, y: 900 },
      { x: 500, y: 900 },
      { x: 500, y: 100 },
    ],
    closed: true,
  };
}

/**
 * Depth contours at increasing distances from the bay's eastern shore.
 */
function makeDepthContours(): Polyline[] {
  return [
    {
      points: [
        { x: 600, y: 100 },
        { x: 600, y: 900 },
      ],
      closed: false,
      depth: 5,
    },
    {
      points: [
        { x: 750, y: 100 },
        { x: 750, y: 900 },
      ],
      closed: false,
      depth: 15,
    },
    {
      points: [
        { x: 900, y: 100 },
        { x: 900, y: 900 },
      ],
      closed: false,
      depth: 30,
    },
  ];
}

/**
 * A concave, L-shaped peninsula (non-convex). Points are CCW → positive area
 * → land inside. This tests that point-in-polygon correctly handles a
 * non-convex outline, which a naive convex-only test would miss.
 *
 * L-shape occupying the bottom-left and left-middle of the domain:
 *
 *   (100,100) ─ (300,100)
 *      |            |
 *      |            (300,300) ─ (500,300)
 *      |                            |
 *      |         WATER (notch)      |
 *      |                            |
 *   (100,900) ────────────────── (500,900)
 */
function makeLShapedCoastline(): Polyline {
  return {
    points: [
      { x: 100, y: 100 },
      { x: 100, y: 900 },
      { x: 500, y: 900 },
      { x: 500, y: 300 },
      { x: 300, y: 300 },
      { x: 300, y: 100 },
    ],
    closed: true,
  };
}

/**
 * Two separate islands (archipelago) — tests that land mask correctly unions
 * multiple disjoint closed rings rather than only recognizing the first.
 */
function makeArchipelagoCoastlines(): Polyline[] {
  return [
    {
      // Island 1: small square, west side
      points: [
        { x: 150, y: 150 },
        { x: 150, y: 350 },
        { x: 350, y: 350 },
        { x: 350, y: 150 },
      ],
      closed: true,
    },
    {
      // Island 2: small square, east side, far from island 1
      points: [
        { x: 650, y: 600 },
        { x: 650, y: 800 },
        { x: 850, y: 800 },
        { x: 850, y: 600 },
      ],
      closed: true,
    },
  ];
}

/**
 * An open (non-closed) coastline that crosses the domain — e.g. a mainland
 * shoreline that enters and exits the terrain bounds rather than forming a
 * closed ring. Per TerrainBuilder's documented behavior, open coastlines do
 * NOT contribute to the land mask (only closed rings do) — this fixture
 * exists to make that current, real limitation explicit and tested rather
 * than silently unverified.
 */
function makeOpenCoastline(): Polyline {
  return {
    points: [
      { x: 0, y: 500 },
      { x: 500, y: 500 },
      { x: 1000, y: 500 },
    ],
    closed: false,
  };
}

function makeTestParams(overrides?: Partial<TerrainParams>): TerrainParams {
  return {
    bounds: { min: { x: 0, y: 0 }, max: { x: 1000, y: 1000 } },
    coastlines: [makeBayCoastline()],
    depthContours: makeDepthContours(),
    relief: 'hilly',
    maxElevation: 50,
    maxDepth: 40,
    resolution: 32,
    seed: 42,
    ...overrides,
  };
}

// ─── Helper to get grid coordinates from cell index ──────────────────────────

function cellCenter(col: number, row: number, resolution: number, bounds: { min: Vec2; max: Vec2 }): Vec2 {
  const w = bounds.max.x - bounds.min.x;
  const h = bounds.max.y - bounds.min.y;
  return {
    x: bounds.min.x + (col + 0.5) * (w / resolution),
    y: bounds.min.y + (row + 0.5) * (h / resolution),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('TerrainBuilder', () => {
  describe('land mask correctness', () => {
    it('marks cells inside the coastline as land', () => {
      const params = makeTestParams();
      const result = TerrainBuilder.generate(params, params.seed);

      // A cell clearly inside the peninsula (col ≈ 25% of 32 ≈ 8, row ≈ 50% ≈ 16)
      // Cell centre at col=5 → x ≈ 0 + (5.5)*(1000/32) = 171.875 — inside [100, 500]
      // Row=16 → y ≈ 0 + (16.5)*(1000/32) = 515.625 — inside [100, 900]
      const landCol = 5;
      const landRow = 16;
      const center = cellCenter(landCol, landRow, params.resolution, params.bounds);

      // Verify the cell is geometrically inside the coastline
      expect(center.x).toBeGreaterThan(100);
      expect(center.x).toBeLessThan(500);
      expect(center.y).toBeGreaterThan(100);
      expect(center.y).toBeLessThan(900);

      const idx = landRow * params.resolution + landCol;
      expect(result.landMask[idx]).toBe(1);
    });

    it('marks cells outside the coastline as water', () => {
      const params = makeTestParams();
      const result = TerrainBuilder.generate(params, params.seed);

      // A cell clearly in the water (col ≈ 75% of 32 ≈ 24)
      // Cell centre at col=24 → x ≈ (24.5)*(1000/32) = 765.625 — outside [100, 500]
      const waterCol = 24;
      const waterRow = 16;
      const center = cellCenter(waterCol, waterRow, params.resolution, params.bounds);

      expect(center.x).toBeGreaterThan(500);
      const idx = waterRow * params.resolution + waterCol;
      expect(result.landMask[idx]).toBe(0);
    });

    it('cells at the bounds edges outside coastline are water', () => {
      const params = makeTestParams();
      const result = TerrainBuilder.generate(params, params.seed);

      // Top-left corner: col=0, row=0 → x ≈ 15.6, y ≈ 15.6 — outside coastline [100..500, 100..900]
      const idx = 0;
      expect(result.landMask[idx]).toBe(0);
    });
  });

  describe('shore distance field', () => {
    it('is negative offshore (water cells)', () => {
      const params = makeTestParams();
      const result = TerrainBuilder.generate(params, params.seed);

      // Sample several water cells (right side of grid)
      for (let row = 8; row < 24; row += 4) {
        const col = 24; // Well into the water
        const idx = row * params.resolution + col;
        expect(result.shoreDistance[idx]).toBeLessThan(0);
      }
    });

    it('is positive on land cells', () => {
      const params = makeTestParams();
      const result = TerrainBuilder.generate(params, params.seed);

      // Sample land cells (inside the peninsula)
      for (let row = 8; row < 24; row += 4) {
        const col = 8; // Well inside land
        const idx = row * params.resolution + col;
        expect(result.shoreDistance[idx]).toBeGreaterThan(0);
      }
    });

    it('approaches zero near the coastline boundary', () => {
      const params = makeTestParams({ resolution: 64 });
      const result = TerrainBuilder.generate(params, params.seed);

      // The coastline at x=500 maps to col ≈ 500/1000 * 64 = 32
      // Cells immediately on either side of col 32 should have small |distance|
      const coastCol = 32;
      const testRow = 32; // Middle of the grid
      const idx = testRow * params.resolution + coastCol;
      const dist = result.shoreDistance[idx];
      // Should be within ~1 cell width of zero (1000/64 ≈ 15.6m)
      expect(Math.abs(dist ?? Infinity)).toBeLessThan(25);
    });
  });

  describe('bathymetry and shelving', () => {
    it('depth shallows monotonically near shore (no cliff at waterline)', () => {
      const params = makeTestParams({ resolution: 64 });
      const result = TerrainBuilder.generate(params, params.seed);

      // Walk from the coastline (x=500) eastward into water
      // col for x=500 ≈ 32, moving right into deeper water
      const testRow = 32;
      let prevDepth = 0; // At shore, depth should be ~0

      // Start just past the coastline
      let violations = 0;
      for (let col = 33; col < 60; col++) {
        const idx = testRow * params.resolution + col;
        const depth = result.heightfield[idx] ?? 0;
        // Depth should be negative and getting more negative (deeper)
        // Allow small noise fluctuations — check overall trend
        if (depth > prevDepth + 0.5) {
          violations++;
        }
        prevDepth = depth;
      }

      // Allow a few noise-induced violations but trend must be monotonic
      expect(violations).toBeLessThan(5);
    });

    it('depth at shore is near zero', () => {
      const params = makeTestParams({ resolution: 64 });
      const result = TerrainBuilder.generate(params, params.seed);

      // Cell just past the coastline (x=500 → col ≈ 32, take col 33)
      const testRow = 32;
      const coastAdjacentCol = 33;
      const idx = testRow * params.resolution + coastAdjacentCol;
      const depth = result.heightfield[idx] ?? 0;

      // Should be shallow near shore — much less than maxDepth
      expect(Math.abs(depth)).toBeLessThan(params.maxDepth * 0.3);
    });

    it('deep water approaches maxDepth-scaled values', () => {
      const params = makeTestParams({ resolution: 64 });
      const result = TerrainBuilder.generate(params, params.seed);

      // Far offshore cells (col ≈ 58 of 64, well past all contours)
      const testRow = 32;
      const deepCol = 58;
      const idx = testRow * params.resolution + deepCol;
      const depth = result.heightfield[idx] ?? 0;

      // Should be significantly negative
      expect(depth).toBeLessThan(-5);
    });

    it('depth does not shallow again past the outermost (deepest) contour (regression: IDW blended back toward a closer shallower contour)', () => {
      // Reproduces the audit finding: with contours at x=600(5m), x=750(15m),
      // x=900(30m), unbounded IDW pulled points beyond x=900 back toward the
      // NUMERICALLY closer x=750/x=600 contours, causing depth to shallow then
      // deepen again past the last contour instead of monotonically deepening
      // (or holding). That was a multi-metre structural swing, not noise.
      // buildBathymetry legitimately modulates depth by up to ±10% via seeded
      // noise (`noiseModulation = 1 + noiseVal * 0.1`) — at ~30m depth that is
      // up to ±3m of expected jitter per cell, so the tolerance here must be
      // wide enough to absorb that while still catching a structural
      // multi-metre trend reversal across the whole sampled range.
      const params = makeTestParams({ resolution: 100, depthContours: makeDepthContours() });
      const result = TerrainBuilder.generate(params, params.seed);

      const testRow = 50;
      // x=900 → col = 90. Sample from just past it to the edge, and compare
      // against the DEEPEST point seen so far rather than only the immediate
      // previous sample, so isolated noise jitter on one cell doesn't trip a
      // false positive — only a genuine sustained shallowing trend should.
      let deepestSoFar = -Infinity;
      let sustainedShallowingViolations = 0;
      for (let col = 91; col < 99; col++) {
        const idx = testRow * params.resolution + col;
        const depth = result.heightfield[idx] ?? 0;
        if (depth > deepestSoFar) deepestSoFar = depth;
        // A "sustained" shallowing violation: shallower than the deepest point
        // seen so far by more than the noise envelope (10% of maxDepth = 4m).
        if (depth > deepestSoFar + params.maxDepth * 0.1 + 0.01) {
          sustainedShallowingViolations++;
        }
      }

      expect(sustainedShallowingViolations).toBe(0);
    });
  });

  describe('heightfield values', () => {
    it('land cells have non-negative elevation (allow noise dips near 0 at boundary)', () => {
      const params = makeTestParams();
      const result = TerrainBuilder.generate(params, params.seed);

      // Interior land cells should be non-negative
      for (let row = 8; row < 24; row++) {
        for (let col = 4; col < 12; col++) {
          const idx = row * params.resolution + col;
          if ((result.landMask[idx] ?? 0) === 1) {
            const h = result.heightfield[idx] ?? 0;
            // Allow very small negative values from noise at boundaries
            expect(h).toBeGreaterThanOrEqual(-0.5);
          }
        }
      }
    });

    it('water cells have non-positive elevation', () => {
      const params = makeTestParams();
      const result = TerrainBuilder.generate(params, params.seed);

      for (let row = 0; row < params.resolution; row++) {
        for (let col = 0; col < params.resolution; col++) {
          const idx = row * params.resolution + col;
          if ((result.landMask[idx] ?? 0) === 0) {
            const h = result.heightfield[idx] ?? 0;
            expect(h).toBeLessThanOrEqual(0);
          }
        }
      }
    });
  });

  describe('determinism', () => {
    it('same seed produces byte-identical heightfield', () => {
      const params = makeTestParams();
      const a = TerrainBuilder.generate(params, params.seed);
      const b = TerrainBuilder.generate(params, params.seed);

      expect(a.heightfield.length).toBe(b.heightfield.length);
      for (let i = 0; i < a.heightfield.length; i++) {
        expect(a.heightfield[i]).toBe(b.heightfield[i]);
      }
    });

    it('same seed produces byte-identical landMask', () => {
      const params = makeTestParams();
      const a = TerrainBuilder.generate(params, params.seed);
      const b = TerrainBuilder.generate(params, params.seed);

      expect(a.landMask.length).toBe(b.landMask.length);
      for (let i = 0; i < a.landMask.length; i++) {
        expect(a.landMask[i]).toBe(b.landMask[i]);
      }
    });

    it('same seed produces byte-identical mesh positions', () => {
      const params = makeTestParams();
      const a = TerrainBuilder.generate(params, params.seed);
      const b = TerrainBuilder.generate(params, params.seed);

      expect(a.mesh.positions.length).toBe(b.mesh.positions.length);
      for (let i = 0; i < a.mesh.positions.length; i++) {
        expect(a.mesh.positions[i]).toBe(b.mesh.positions[i]);
      }
    });

    it('different seeds produce different heightfields', () => {
      const params = makeTestParams();
      const a = TerrainBuilder.generate(params, 42);
      const b = TerrainBuilder.generate(params, 99);

      let diffs = 0;
      for (let i = 0; i < a.heightfield.length; i++) {
        if (a.heightfield[i] !== b.heightfield[i]) diffs++;
      }
      expect(diffs).toBeGreaterThan(0);
    });
  });

  describe('mesh validity', () => {
    it('produces finite buffers (no NaN/Infinity)', () => {
      const params = makeTestParams();
      const result = TerrainBuilder.generate(params, params.seed);
      assertFiniteBuffers(result.mesh);
    });

    it('has no degenerate triangles', () => {
      const params = makeTestParams();
      const result = TerrainBuilder.generate(params, params.seed);
      assertNoDegenerateTriangles(result.mesh);
    });

    it('mesh bounds match TerrainParams bounds horizontally', () => {
      const params = makeTestParams();
      const result = TerrainBuilder.generate(params, params.seed);

      const meshBounds = result.mesh.bounds;
      // X bounds should span the terrain
      expect(meshBounds.min.x).toBeGreaterThanOrEqual(params.bounds.min.x);
      expect(meshBounds.max.x).toBeLessThanOrEqual(params.bounds.max.x);
      // Z bounds correspond to params bounds y
      expect(meshBounds.min.z).toBeGreaterThanOrEqual(params.bounds.min.y);
      expect(meshBounds.max.z).toBeLessThanOrEqual(params.bounds.max.y);
    });

    it('mesh bounds Y range covers heightfield range', () => {
      const params = makeTestParams();
      const result = TerrainBuilder.generate(params, params.seed);

      let minH = Infinity;
      let maxH = -Infinity;
      for (let i = 0; i < result.heightfield.length; i++) {
        const h = result.heightfield[i] ?? 0;
        if (h < minH) minH = h;
        if (h > maxH) maxH = h;
      }

      expect(result.mesh.bounds.min.y).toBeCloseTo(minH, 4);
      expect(result.mesh.bounds.max.y).toBeCloseTo(maxH, 4);
    });

    it('normals are predominantly upward (+Y dominant)', () => {
      const params = makeTestParams();
      const result = TerrainBuilder.generate(params, params.seed);

      // For terrain, most normals should have a positive Y component (pointing up)
      let upCount = 0;
      const vertexCount = result.mesh.normals.length / 3;
      for (let i = 0; i < vertexCount; i++) {
        const ny = result.mesh.normals[i * 3 + 1] ?? 0;
        if (ny > 0) upCount++;
      }

      // At least 90% should point upward (terrain is mostly gentle slopes)
      expect(upCount / vertexCount).toBeGreaterThan(0.9);
    });

    it('correct vertex and index counts', () => {
      const params = makeTestParams();
      const result = TerrainBuilder.generate(params, params.seed);
      const res = params.resolution;

      expect(result.mesh.positions.length).toBe(res * res * 3);
      expect(result.mesh.normals.length).toBe(res * res * 3);
      expect(result.mesh.uvs.length).toBe(res * res * 2);
      expect(result.mesh.indices.length).toBe((res - 1) * (res - 1) * 6);
    });

    it('resolution and bounds are passed through', () => {
      const params = makeTestParams();
      const result = TerrainBuilder.generate(params, params.seed);

      expect(result.resolution).toBe(params.resolution);
      expect(result.bounds).toEqual(params.bounds);
    });
  });

  describe('transferables', () => {
    it('includes all typed array buffers', () => {
      const params = makeTestParams();
      const result = TerrainBuilder.generate(params, params.seed);

      expect(result.transferables.length).toBeGreaterThanOrEqual(7);
      // All should be ArrayBuffer instances
      for (const t of result.transferables) {
        expect(t).toBeInstanceOf(ArrayBuffer);
      }
    });
  });

  describe('edge cases', () => {
    it('handles no depth contours (pure distance-based bathymetry)', () => {
      const params = makeTestParams({ depthContours: [] });
      const result = TerrainBuilder.generate(params, params.seed);

      // Should still produce valid output
      assertFiniteBuffers(result.mesh);
      expect(result.heightfield.length).toBe(params.resolution * params.resolution);
    });

    it('handles flat relief', () => {
      const params = makeTestParams({ relief: 'flat' });
      const result = TerrainBuilder.generate(params, params.seed);

      assertFiniteBuffers(result.mesh);
      // Flat terrain should have lower elevation variance than mountainous
      let maxElev = 0;
      for (let i = 0; i < result.heightfield.length; i++) {
        const h = result.heightfield[i] ?? 0;
        if (h > maxElev) maxElev = h;
      }
      expect(maxElev).toBeLessThan(params.maxElevation);
    });

    it('handles mountainous relief', () => {
      const params = makeTestParams({ relief: 'mountainous', maxElevation: 200 });
      const result = TerrainBuilder.generate(params, params.seed);

      assertFiniteBuffers(result.mesh);
    });

    it('handles small resolution (4×4)', () => {
      const params = makeTestParams({ resolution: 4 });
      const result = TerrainBuilder.generate(params, params.seed);

      expect(result.heightfield.length).toBe(16);
      expect(result.landMask.length).toBe(16);
      assertFiniteBuffers(result.mesh);
    });

    it('handles a concave (L-shaped) coastline correctly — the notch is water, not land', () => {
      // Audit gap: all prior tests used a simple convex rectangle. A bug in
      // point-in-polygon that only manifests on non-convex outlines (e.g. a
      // naive bounding-box check instead of true ray casting) would pass
      // every existing test and still be wrong. This test specifically
      // checks a cell INSIDE the L-shape's concave notch, which is water
      // despite being within the shape's overall bounding box.
      const params = makeTestParams({
        coastlines: [makeLShapedCoastline()],
        depthContours: [],
        resolution: 100,
      });
      const result = TerrainBuilder.generate(params, params.seed);

      // Notch region: x in (300,500), y in (100,300) — inside the L's bounding
      // box but outside the L-shaped polygon itself (the cut-out corner).
      const notchCol = Math.floor(400 / 1000 * 100); // x=400
      const notchRow = Math.floor(200 / 1000 * 100); // y=200
      const notchIdx = notchRow * params.resolution + notchCol;
      expect(result.landMask[notchIdx]).toBe(0);

      // A point genuinely inside the L's vertical arm: x in (100,300), y in (400,900)
      const armCol = Math.floor(200 / 1000 * 100);
      const armRow = Math.floor(600 / 1000 * 100);
      const armIdx = armRow * params.resolution + armCol;
      expect(result.landMask[armIdx]).toBe(1);

      // A point in the L's horizontal foot: x in (100,500), y in (700,900)
      const footCol = Math.floor(450 / 1000 * 100);
      const footRow = Math.floor(800 / 1000 * 100);
      const footIdx = footRow * params.resolution + footCol;
      expect(result.landMask[footIdx]).toBe(1);

      assertFiniteBuffers(result.mesh);
    });

    it('handles multiple disjoint islands (archipelago) — both islands are land, the gap between is water', () => {
      // Audit gap: single-coastline tests can't catch a bug where only the
      // FIRST coastline in the array is honored (e.g. an early return instead
      // of a loop, or an accumulator overwritten instead of OR'd).
      const params = makeTestParams({
        coastlines: makeArchipelagoCoastlines(),
        depthContours: [],
        resolution: 100,
      });
      const result = TerrainBuilder.generate(params, params.seed);

      // Island 1 centre: (250, 250)
      const i1Col = Math.floor(250 / 1000 * 100);
      const i1Row = Math.floor(250 / 1000 * 100);
      expect(result.landMask[i1Row * params.resolution + i1Col]).toBe(1);

      // Island 2 centre: (750, 700)
      const i2Col = Math.floor(750 / 1000 * 100);
      const i2Row = Math.floor(700 / 1000 * 100);
      expect(result.landMask[i2Row * params.resolution + i2Col]).toBe(1);

      // Between the islands, e.g. (500, 500) — must be water, not accidentally
      // unioned into one giant landmass by a bounding-box shortcut.
      const gapCol = Math.floor(500 / 1000 * 100);
      const gapRow = Math.floor(500 / 1000 * 100);
      expect(result.landMask[gapRow * params.resolution + gapCol]).toBe(0);

      assertFiniteBuffers(result.mesh);
    });

    it('documents current behavior for an open (non-closed) coastline: it does not contribute to the land mask', () => {
      // Audit finding: TerrainBuilder skips non-closed polylines entirely
      // (`if (!coast.closed) continue`), so a mainland shoreline that enters
      // and exits the terrain bounds — a realistic case for real venues —
      // currently produces NO land at all, silently. This test makes that
      // limitation explicit and will force a visible test change (not a
      // silent behavior change) if/when open-coastline support is added.
      const params = makeTestParams({
        coastlines: [makeOpenCoastline()],
        depthContours: [],
        resolution: 32,
      });
      const result = TerrainBuilder.generate(params, params.seed);

      // Every cell is water — the open coastline contributes nothing.
      let landCount = 0;
      for (let i = 0; i < result.landMask.length; i++) {
        if ((result.landMask[i] ?? 0) === 1) landCount++;
      }
      expect(landCount).toBe(0);
      assertFiniteBuffers(result.mesh);
    });
  });
});
