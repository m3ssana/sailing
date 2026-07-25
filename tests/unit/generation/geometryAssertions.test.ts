/**
 * Tests for geometry assertion helpers.
 *
 * Validates that the assertion functions correctly detect valid and invalid
 * geometry. The box generator serves as the known-good reference, and we
 * construct deliberately broken meshes to verify that assertions fail
 * appropriately.
 */

import { describe, expect, it } from 'vitest';
import { BoxGenerator } from '@generation/common/BoxGenerator';
import {
  assertConsistentWinding,
  assertDeterministic,
  assertFiniteBuffers,
  assertNoDegenerateTriangles,
  assertWatertight,
  computeSurfaceArea,
  computeVolume,
} from '@generation/testing/geometryAssertions';
import type { GeneratedMesh } from '@/types';

// ─── Helper: create a valid box mesh for testing ─────────────────────────────

function makeBox(w: number, h: number, d: number): GeneratedMesh {
  const model = BoxGenerator.generate({ width: w, height: h, depth: d }, 42);
  const mesh = model.meshes[0];
  if (!mesh) throw new Error('BoxGenerator produced no meshes');
  return mesh;
}

/**
 * Create a minimal watertight tetrahedron (4 triangles, 4 vertices).
 * Counter-clockwise from outside, producing positive signed volume.
 */
function makeTetrahedron(): GeneratedMesh {
  // Regular tetrahedron vertices
  const positions = new Float32Array([
    1, 1, 1, // v0
    1, -1, -1, // v1
    -1, 1, -1, // v2
    -1, -1, 1, // v3
  ]);

  // 4 faces, CCW from outside.
  // For the divergence theorem to yield positive volume, the normals must
  // point outward. We verify by checking that swapping two vertices in a
  // face flips the sign.
  const indices = new Uint32Array([
    0, 1, 2, // face 0
    0, 3, 1, // face 1
    0, 2, 3, // face 2
    1, 3, 2, // face 3
  ]);

  const normals = new Float32Array(12);
  const uvs = new Float32Array(8);

  return {
    positions,
    normals,
    uvs,
    indices,
    bounds: { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } },
    meta: {},
  };
}

// ─── computeVolume ───────────────────────────────────────────────────────────

describe('computeVolume', () => {
  it('computes volume of a 1×1×1 box as 1.0', () => {
    const mesh = makeBox(1, 1, 1);
    const volume = computeVolume(mesh);
    expect(volume).toBeCloseTo(1.0, 10);
  });

  it('computes volume of a 2×3×4 box as 24.0', () => {
    const mesh = makeBox(2, 3, 4);
    const volume = computeVolume(mesh);
    expect(volume).toBeCloseTo(24.0, 10);
  });

  it('volume equals width × height × depth analytically', () => {
    // This is THE demo criterion for Phase 0.6
    const params = [
      { w: 1, h: 1, d: 1 },
      { w: 2, h: 3, d: 5 },
      { w: 0.5, h: 0.25, d: 10 },
      { w: 7.3, h: 2.1, d: 4.8 },
    ];

    for (const { w, h, d } of params) {
      const mesh = makeBox(w, h, d);
      const volume = computeVolume(mesh);
      const expected = w * h * d;
      expect(volume).toBeCloseTo(expected, 5);
    }
  });

  it('computes positive volume for a tetrahedron', () => {
    const mesh = makeTetrahedron();
    const volume = computeVolume(mesh);
    // Volume of a regular tetrahedron with edge length 2√2 is 8/3
    expect(volume).toBeCloseTo(8 / 3, 6);
  });
});

// ─── computeSurfaceArea ──────────────────────────────────────────────────────

describe('computeSurfaceArea', () => {
  it('computes surface area of a 1×1×1 box as 6.0', () => {
    const mesh = makeBox(1, 1, 1);
    const area = computeSurfaceArea(mesh);
    expect(area).toBeCloseTo(6.0, 10);
  });

  it('computes surface area of a 2×3×4 box as 52.0', () => {
    const mesh = makeBox(2, 3, 4);
    const area = computeSurfaceArea(mesh);
    // 2*(2*3 + 3*4 + 2*4) = 2*(6+12+8) = 52
    expect(area).toBeCloseTo(52.0, 10);
  });
});

// ─── assertWatertight ────────────────────────────────────────────────────────

describe('assertWatertight', () => {
  it('passes for a valid box', () => {
    const mesh = makeBox(1, 1, 1);
    expect(() => assertWatertight(mesh)).not.toThrow();
  });

  it('passes for a tetrahedron', () => {
    const mesh = makeTetrahedron();
    expect(() => assertWatertight(mesh)).not.toThrow();
  });

  it('fails for a mesh with a hole (missing face)', () => {
    const mesh = makeBox(1, 1, 1);
    // Remove the last two triangles (one face) by truncating indices
    const holed: GeneratedMesh = {
      ...mesh,
      indices: mesh.indices.slice(0, mesh.indices.length - 6),
    };
    expect(() => assertWatertight(holed)).toThrow(/not watertight/);
  });

  it('fails for a single triangle (all boundary edges)', () => {
    const mesh: GeneratedMesh = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array(9),
      uvs: new Float32Array(6),
      indices: new Uint32Array([0, 1, 2]),
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
      meta: {},
    };
    expect(() => assertWatertight(mesh)).toThrow(/not watertight/);
  });
});

// ─── assertConsistentWinding ─────────────────────────────────────────────────

describe('assertConsistentWinding', () => {
  it('passes for a valid box', () => {
    const mesh = makeBox(1, 1, 1);
    expect(() => assertConsistentWinding(mesh)).not.toThrow();
  });

  it('passes for a tetrahedron', () => {
    const mesh = makeTetrahedron();
    expect(() => assertConsistentWinding(mesh)).not.toThrow();
  });

  it('fails for an inverted box (negative volume)', () => {
    const mesh = makeBox(1, 1, 1);
    // Swap two vertices in every triangle to invert winding
    const flipped = new Uint32Array(mesh.indices.length);
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const a = mesh.indices[i] ?? 0;
      const b = mesh.indices[i + 1] ?? 0;
      const c = mesh.indices[i + 2] ?? 0;
      flipped[i] = a;
      flipped[i + 1] = c; // swap b and c
      flipped[i + 2] = b;
    }
    const inverted: GeneratedMesh = { ...mesh, indices: flipped };
    expect(() => assertConsistentWinding(inverted)).toThrow(/inverted winding/);
  });
});

// ─── assertNoDegenerateTriangles ─────────────────────────────────────────────

describe('assertNoDegenerateTriangles', () => {
  it('passes for a valid box', () => {
    const mesh = makeBox(1, 1, 1);
    expect(() => assertNoDegenerateTriangles(mesh)).not.toThrow();
  });

  it('fails for a triangle with zero area (collinear vertices)', () => {
    const mesh: GeneratedMesh = {
      positions: new Float32Array([
        0, 0, 0, // v0
        1, 0, 0, // v1
        2, 0, 0, // v2 — collinear with v0-v1
      ]),
      normals: new Float32Array(9),
      uvs: new Float32Array(6),
      indices: new Uint32Array([0, 1, 2]),
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 0, z: 0 } },
      meta: {},
    };
    expect(() => assertNoDegenerateTriangles(mesh)).toThrow(/degenerate/);
  });

  it('fails for a triangle with coincident vertices', () => {
    const mesh: GeneratedMesh = {
      positions: new Float32Array([
        1, 1, 1,
        1, 1, 1, // same as v0
        0, 0, 0,
      ]),
      normals: new Float32Array(9),
      uvs: new Float32Array(6),
      indices: new Uint32Array([0, 1, 2]),
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      meta: {},
    };
    expect(() => assertNoDegenerateTriangles(mesh)).toThrow(/degenerate/);
  });
});

// ─── assertFiniteBuffers ─────────────────────────────────────────────────────

describe('assertFiniteBuffers', () => {
  it('passes for a valid box', () => {
    const mesh = makeBox(1, 1, 1);
    expect(() => assertFiniteBuffers(mesh)).not.toThrow();
  });

  it('fails when positions contain NaN', () => {
    const mesh = makeBox(1, 1, 1);
    const corrupted = new Float32Array(mesh.positions);
    corrupted[5] = NaN;
    const bad: GeneratedMesh = { ...mesh, positions: corrupted };
    expect(() => assertFiniteBuffers(bad)).toThrow(/non-finite/);
  });

  it('fails when normals contain Infinity', () => {
    const mesh = makeBox(1, 1, 1);
    const corrupted = new Float32Array(mesh.normals);
    corrupted[2] = Infinity;
    const bad: GeneratedMesh = { ...mesh, normals: corrupted };
    expect(() => assertFiniteBuffers(bad)).toThrow(/non-finite/);
  });
});

// ─── assertDeterministic ─────────────────────────────────────────────────────

describe('assertDeterministic', () => {
  it('passes for BoxGenerator', () => {
    expect(() =>
      assertDeterministic(BoxGenerator, { width: 2, height: 3, depth: 4 }, 99),
    ).not.toThrow();
  });

  it('passes for BoxGenerator with different seeds', () => {
    // Box doesn't use the seed, but the contract still holds
    expect(() =>
      assertDeterministic(BoxGenerator, { width: 1, height: 1, depth: 1 }, 0),
    ).not.toThrow();
    expect(() =>
      assertDeterministic(BoxGenerator, { width: 1, height: 1, depth: 1 }, 12345),
    ).not.toThrow();
  });
});
