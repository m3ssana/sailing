/**
 * Tests for the common geometry toolkit (D.1).
 *
 * Uses the existing geometry assertion helpers to validate watertightness,
 * winding consistency, finite buffers, and geometric correctness.
 */

import { describe, expect, it } from 'vitest';
import type { Vec2, Vec3 } from '@/types';
import {
  assertConsistentWinding,
  assertFiniteBuffers,
  assertNoDegenerateTriangles,
  assertWatertight,
  computeVolume,
} from '@generation/testing/geometryAssertions';
import {
  catmullRomSpline2D,
  catmullRomSpline3D,
  cubicBezier2D,
  resampleByArcLength2D,
  resampleByArcLength3D,
} from '@generation/common/curves';
import { loftSurface } from '@generation/common/lofting';
import { computeParallelTransportFrames, ribbon, sweepTube } from '@generation/common/sweep';
import { extrudePolygon, revolve } from '@generation/common/extrude';
import { triangulate } from '@generation/common/triangulate';
import { bevelProfile, bevelledRect, chamferSize } from '@generation/common/chamfer';
import { createNoiseSource2D, createNoiseSource3D } from '@generation/common/noise';

// ─── curves.ts ───────────────────────────────────────────────────────────────

describe('curves', () => {
  describe('resampleByArcLength2D', () => {
    it('preserves first and last endpoints', () => {
      const points: Vec2[] = [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 3, y: 0 },
        { x: 6, y: 0 },
      ];
      const resampled = resampleByArcLength2D(points, 7);
      expect(resampled).toHaveLength(7);

      const first = resampled[0];
      const last = resampled[6];
      expect(first).toBeDefined();
      expect(last).toBeDefined();
      if (first !== undefined && last !== undefined) {
        expect(first.x).toBeCloseTo(0, 10);
        expect(first.y).toBeCloseTo(0, 10);
        expect(last.x).toBeCloseTo(6, 10);
        expect(last.y).toBeCloseTo(0, 10);
      }
    });

    it('produces evenly-spaced points', () => {
      // Non-uniform input: points at 0, 1, 5, 10
      const points: Vec2[] = [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 5, y: 0 },
        { x: 10, y: 0 },
      ];
      const resampled = resampleByArcLength2D(points, 11);
      expect(resampled).toHaveLength(11);

      // Expected spacing: 10 / (11-1) = 1.0 between each point
      for (let i = 1; i < resampled.length; i++) {
        const prev = resampled[i - 1];
        const curr = resampled[i];
        if (prev === undefined || curr === undefined) continue;
        const dist = Math.sqrt((curr.x - prev.x) ** 2 + (curr.y - prev.y) ** 2);
        expect(dist).toBeCloseTo(1.0, 5);
      }
    });

    it('handles a curve with varying directions', () => {
      const points: Vec2[] = [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 2, y: 0 },
        { x: 3, y: 1 },
      ];
      const resampled = resampleByArcLength2D(points, 10);
      expect(resampled).toHaveLength(10);

      // Spacing should be uniform
      const distances: number[] = [];
      for (let i = 1; i < resampled.length; i++) {
        const prev = resampled[i - 1];
        const curr = resampled[i];
        if (prev === undefined || curr === undefined) continue;
        distances.push(Math.sqrt((curr.x - prev.x) ** 2 + (curr.y - prev.y) ** 2));
      }
      const avgDist = distances.reduce((a, b) => a + b, 0) / distances.length;
      for (const d of distances) {
        expect(d).toBeCloseTo(avgDist, 4);
      }
    });
  });

  describe('resampleByArcLength3D', () => {
    it('preserves endpoints in 3D', () => {
      const points: Vec3[] = [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 1, z: 0 },
        { x: 2, y: 0, z: 1 },
      ];
      const resampled = resampleByArcLength3D(points, 5);
      expect(resampled).toHaveLength(5);

      const first = resampled[0];
      const last = resampled[4];
      expect(first).toBeDefined();
      expect(last).toBeDefined();
      if (first !== undefined && last !== undefined) {
        expect(first.x).toBeCloseTo(0);
        expect(first.y).toBeCloseTo(0);
        expect(first.z).toBeCloseTo(0);
        expect(last.x).toBeCloseTo(2);
        expect(last.y).toBeCloseTo(0);
        expect(last.z).toBeCloseTo(1);
      }
    });
  });

  describe('catmullRomSpline2D', () => {
    it('produces smooth interpolation through control points', () => {
      const points: Vec2[] = [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 2, y: 0 },
        { x: 3, y: 1 },
      ];
      const result = catmullRomSpline2D(points, 20);
      expect(result.length).toBeGreaterThanOrEqual(20);
      // Should pass through (or very close to) control points
      const first = result[0];
      expect(first).toBeDefined();
      if (first !== undefined) {
        expect(first.x).toBeCloseTo(0, 1);
        expect(first.y).toBeCloseTo(0, 1);
      }
    });

    it('handles closed curves', () => {
      const points: Vec2[] = [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ];
      const result = catmullRomSpline2D(points, 20, { closed: true });
      expect(result.length).toBeGreaterThanOrEqual(20);
    });
  });

  describe('catmullRomSpline3D', () => {
    it('produces interpolation in 3D', () => {
      const points: Vec3[] = [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 1, z: 0 },
        { x: 2, y: 0, z: 1 },
        { x: 3, y: 1, z: 1 },
      ];
      const result = catmullRomSpline3D(points, 20);
      expect(result.length).toBeGreaterThanOrEqual(20);
    });
  });

  describe('cubicBezier2D', () => {
    it('evaluates endpoints correctly', () => {
      const p0: Vec2 = { x: 0, y: 0 };
      const p1: Vec2 = { x: 1, y: 2 };
      const p2: Vec2 = { x: 3, y: 2 };
      const p3: Vec2 = { x: 4, y: 0 };

      const start = cubicBezier2D(p0, p1, p2, p3, 0);
      const end = cubicBezier2D(p0, p1, p2, p3, 1);

      expect(start.x).toBeCloseTo(0);
      expect(start.y).toBeCloseTo(0);
      expect(end.x).toBeCloseTo(4);
      expect(end.y).toBeCloseTo(0);
    });
  });
});

// ─── lofting.ts ──────────────────────────────────────────────────────────────

describe('lofting', () => {
  /** Create a circular ring of points at the given position along Z. */
  function makeCircleRing(z: number, radius: number, count: number): Vec3[] {
    const ring: Vec3[] = [];
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      ring.push({
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        z,
      });
    }
    return ring;
  }

  it('produces a watertight lofted tube when capped with closed rings', () => {
    const sections = [
      makeCircleRing(0, 1, 16),
      makeCircleRing(1, 1, 16),
      makeCircleRing(2, 1, 16),
      makeCircleRing(3, 1, 16),
    ];
    const mesh = loftSurface(sections, { closedRings: true, capStart: true, capEnd: true });

    assertFiniteBuffers(mesh);
    assertNoDegenerateTriangles(mesh);
    assertWatertight(mesh);
    assertConsistentWinding(mesh);

    // Volume should approximate π*r²*h = π*1*3 ≈ 9.42
    const volume = computeVolume(mesh);
    expect(volume).toBeCloseTo(Math.PI * 1 * 1 * 3, 0);
  });

  it('lofts a tapered tube correctly', () => {
    const sections = [
      makeCircleRing(0, 2, 16),
      makeCircleRing(2, 1, 16),
      makeCircleRing(4, 0.5, 16),
    ];
    const mesh = loftSurface(sections, { closedRings: true, capStart: true, capEnd: true });

    assertFiniteBuffers(mesh);
    assertWatertight(mesh);
    assertConsistentWinding(mesh);
  });

  it('rejects sections with different point counts', () => {
    const sections = [
      makeCircleRing(0, 1, 8),
      makeCircleRing(1, 1, 10), // different count
    ];
    expect(() => loftSurface(sections)).toThrow('equal point counts');
  });

  it('rejects fewer than 2 sections', () => {
    expect(() => loftSurface([makeCircleRing(0, 1, 8)])).toThrow('at least 2 sections');
  });
});

// ─── sweep.ts ────────────────────────────────────────────────────────────────

describe('sweep', () => {
  describe('sweepTube', () => {
    it('produces a watertight tube along a straight path', () => {
      const path: Vec3[] = [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 },
        { x: 0, y: 2, z: 0 },
        { x: 0, y: 3, z: 0 },
      ];
      const mesh = sweepTube(path, () => 0.5, 12);

      assertFiniteBuffers(mesh);
      assertNoDegenerateTriangles(mesh);
      assertWatertight(mesh);
      assertConsistentWinding(mesh);

      // Volume ≈ π*r²*h = π*0.25*3 ≈ 2.36
      const volume = computeVolume(mesh);
      expect(volume).toBeCloseTo(Math.PI * 0.25 * 3, 0);
    });

    it('produces a tapered tube (mast shape)', () => {
      const path: Vec3[] = [];
      for (let i = 0; i <= 10; i++) {
        path.push({ x: 0, y: i, z: 0 });
      }
      // Taper from 0.1 at base to 0.05 at tip
      const mesh = sweepTube(path, (t) => 0.1 * (1 - t * 0.5), 8);

      assertFiniteBuffers(mesh);
      assertWatertight(mesh);
      assertConsistentWinding(mesh);
    });

    it('does not twist along an S-curve path', () => {
      // S-curve with an inflection point — this is exactly where Frenet frames fail
      const path: Vec3[] = [];
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        path.push({
          x: Math.sin(t * Math.PI * 2) * 2,
          y: t * 10,
          z: Math.cos(t * Math.PI) * 0.5,
        });
      }

      const frames = computeParallelTransportFrames(path);

      // Check frame continuity: dot product of consecutive normals should be
      // close to 1 (no sudden flips). A Frenet frame flip would give dot ≈ -1.
      for (let i = 1; i < frames.length; i++) {
        const prev = frames[i - 1];
        const curr = frames[i];
        if (prev === undefined || curr === undefined) continue;

        const dot =
          prev.normal.x * curr.normal.x +
          prev.normal.y * curr.normal.y +
          prev.normal.z * curr.normal.z;

        // Allow gradual rotation but not sudden flips
        expect(dot).toBeGreaterThan(0.8);
      }

      // Also verify the mesh is valid
      const mesh = sweepTube(path, () => 0.3, 8);
      assertFiniteBuffers(mesh);
      assertWatertight(mesh);
      assertConsistentWinding(mesh);
    });
  });

  describe('ribbon', () => {
    it('produces a valid ribbon mesh', () => {
      const path: Vec3[] = [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 },
        { x: 0, y: 2, z: 0 },
      ];
      const mesh = ribbon(path, () => 0.1);

      assertFiniteBuffers(mesh);
      assertNoDegenerateTriangles(mesh);
      expect(mesh.indices.length).toBe(12); // 2 quads × 2 tris × 3 indices
    });
  });
});

// ─── extrude.ts ──────────────────────────────────────────────────────────────

describe('extrude', () => {
  describe('extrudePolygon', () => {
    it('produces correct volume for a square extrusion', () => {
      // Square: 2×2 = area 4, height 3, volume = 12
      const square: Vec2[] = [
        { x: -1, y: -1 },
        { x: 1, y: -1 },
        { x: 1, y: 1 },
        { x: -1, y: 1 },
      ];
      const mesh = extrudePolygon(square, 3);

      assertFiniteBuffers(mesh);
      assertNoDegenerateTriangles(mesh);
      assertConsistentWinding(mesh);
      assertWatertight(mesh);

      const volume = computeVolume(mesh);
      // Area = 4, height = 3, expected volume = 12
      expect(volume).toBeCloseTo(12, 1);
    });

    it('produces correct volume for a triangle extrusion', () => {
      // Right triangle: base 2, height 2, area = 2, extrude height 5, volume = 10
      const triangle: Vec2[] = [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 0, y: 2 },
      ];
      const mesh = extrudePolygon(triangle, 5);

      assertFiniteBuffers(mesh);
      assertWatertight(mesh);
      assertConsistentWinding(mesh);

      const volume = computeVolume(mesh);
      expect(volume).toBeCloseTo(10, 1);
    });

    it('handles bevel option without breaking geometry', () => {
      const square: Vec2[] = [
        { x: -1, y: -1 },
        { x: 1, y: -1 },
        { x: 1, y: 1 },
        { x: -1, y: 1 },
      ];
      const mesh = extrudePolygon(square, 5, { bevel: 0.2, bevelSegments: 2 });

      assertFiniteBuffers(mesh);
      assertNoDegenerateTriangles(mesh);
    });
  });

  describe('revolve', () => {
    it('produces a valid revolved shape', () => {
      // Simple profile for a cylinder: constant radius
      const profile: Vec2[] = [
        { x: 1, y: 0 },
        { x: 1, y: 2 },
      ];
      const mesh = revolve(profile, 16);

      assertFiniteBuffers(mesh);
      assertNoDegenerateTriangles(mesh);
    });

    it('handles partial arc', () => {
      const profile: Vec2[] = [
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 1, y: 2 },
      ];
      const mesh = revolve(profile, 8, Math.PI); // half circle
      assertFiniteBuffers(mesh);
    });
  });
});

// ─── triangulate.ts ──────────────────────────────────────────────────────────

describe('triangulate', () => {
  it('triangulates a convex polygon (square)', () => {
    const square: Vec2[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const indices = triangulate(square);
    // A square needs 2 triangles = 6 indices
    expect(indices).toHaveLength(6);

    // All indices should be valid vertex indices
    for (const idx of indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(4);
    }
  });

  it('triangulates a concave polygon (L-shape)', () => {
    // L-shaped polygon (concave)
    const lShape: Vec2[] = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 0, y: 2 },
    ];
    const indices = triangulate(lShape);
    // 6 vertices → 4 triangles = 12 indices
    expect(indices).toHaveLength(12);

    for (const idx of indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(6);
    }
  });

  it('triangulates a polygon with a hole', () => {
    // Outer square
    const outer: Vec2[] = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ];
    // Inner hole (clockwise)
    const hole: Vec2[] = [
      { x: 1, y: 1 },
      { x: 1, y: 3 },
      { x: 3, y: 3 },
      { x: 3, y: 1 },
    ];
    const indices = triangulate(outer, [hole]);

    // Should produce valid triangulation
    expect(indices.length).toBeGreaterThan(0);
    expect(indices.length % 3).toBe(0);

    // All indices should be valid (outer has 4 vertices, hole has 4, total 8)
    for (const idx of indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(8);
    }

    // Should have enough triangles to cover the area minus the hole
    // A square with a square hole: 8 vertices → at least 8 triangles typically
    expect(indices.length / 3).toBeGreaterThanOrEqual(6);
  });

  it('handles a pentagon (odd vertex count, concave-safe)', () => {
    const pentagon: Vec2[] = [];
    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2;
      pentagon.push({ x: Math.cos(angle), y: Math.sin(angle) });
    }
    const indices = triangulate(pentagon);
    // 5 vertices → 3 triangles = 9 indices
    expect(indices).toHaveLength(9);
  });
});

// ─── chamfer.ts ──────────────────────────────────────────────────────────────

describe('chamfer', () => {
  it('chamferSize returns 1.5% of major dimension by default', () => {
    expect(chamferSize(12)).toBeCloseTo(0.18); // 12m hull → 18cm chamfer
    expect(chamferSize(1.5)).toBeCloseTo(0.0225); // 1.5m drum → 2.25cm
  });

  it('chamferSize respects custom fraction', () => {
    expect(chamferSize(10, 0.02)).toBeCloseTo(0.2); // 2% of 10m
    expect(chamferSize(10, 0.01)).toBeCloseTo(0.1); // 1% of 10m
  });

  it('bevelProfile produces a quarter-circle arc', () => {
    const profile = bevelProfile(1.0, 8);
    expect(profile).toHaveLength(9); // 8 segments + 1

    // First point should be at (1, 0)
    const first = profile[0];
    expect(first).toBeDefined();
    if (first !== undefined) {
      expect(first.x).toBeCloseTo(1.0);
      expect(first.y).toBeCloseTo(0);
    }

    // Last point should be at (0, 1)
    const last = profile[8];
    expect(last).toBeDefined();
    if (last !== undefined) {
      expect(last.x).toBeCloseTo(0);
      expect(last.y).toBeCloseTo(1.0);
    }

    // All points should be on the unit circle
    for (const p of profile) {
      const dist = Math.sqrt(p.x * p.x + p.y * p.y);
      expect(dist).toBeCloseTo(1.0, 5);
    }
  });

  it('bevelledRect produces a closed profile with rounded corners', () => {
    const rect = bevelledRect(2, 1, 0.2, 4);
    // 4 corners × (4+1) points = 20 points
    expect(rect).toHaveLength(20);

    // All points should be within the outer bounds
    for (const p of rect) {
      expect(p.x).toBeGreaterThanOrEqual(-2.01);
      expect(p.x).toBeLessThanOrEqual(2.01);
      expect(p.y).toBeGreaterThanOrEqual(-1.01);
      expect(p.y).toBeLessThanOrEqual(1.01);
    }
  });
});

// ─── noise.ts ────────────────────────────────────────────────────────────────

describe('noise', () => {
  it('creates deterministic 2D noise from seed', () => {
    const noise1 = createNoiseSource2D(42);
    const noise2 = createNoiseSource2D(42);

    // Same seed should produce same values
    expect(noise1.sample(1.5, 2.3)).toBe(noise2.sample(1.5, 2.3));
    expect(noise1.fbm(0.5, 0.7)).toBe(noise2.fbm(0.5, 0.7));
  });

  it('different seeds produce different noise', () => {
    const noise1 = createNoiseSource2D(42);
    const noise2 = createNoiseSource2D(99);

    expect(noise1.sample(1.0, 1.0)).not.toBe(noise2.sample(1.0, 1.0));
  });

  it('noise values are in expected range [-1, 1]', () => {
    const noise = createNoiseSource2D(123);
    for (let i = 0; i < 100; i++) {
      const val = noise.sample(i * 0.37, i * 0.53);
      expect(val).toBeGreaterThanOrEqual(-1);
      expect(val).toBeLessThanOrEqual(1);
    }
  });

  it('ridged noise produces values in [0, 1]', () => {
    const noise = createNoiseSource2D(456);
    for (let i = 0; i < 50; i++) {
      const val = noise.ridged(i * 0.5, i * 0.3);
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(1);
    }
  });

  it('billow noise produces values in [0, 1]', () => {
    const noise = createNoiseSource2D(789);
    for (let i = 0; i < 50; i++) {
      const val = noise.billow(i * 0.5, i * 0.3);
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(1);
    }
  });

  it('domainWarp produces finite values', () => {
    const noise = createNoiseSource2D(321);
    for (let i = 0; i < 20; i++) {
      const val = noise.domainWarp(i * 0.4, i * 0.6, 0.5);
      expect(Number.isFinite(val)).toBe(true);
    }
  });

  it('creates deterministic 3D noise', () => {
    const noise1 = createNoiseSource3D(42);
    const noise2 = createNoiseSource3D(42);
    expect(noise1.sample(1, 2, 3)).toBe(noise2.sample(1, 2, 3));
  });
});
