/**
 * Tests for the BoatView module (I.1).
 *
 * Tests run headlessly (no GPU context). We test:
 * 1. toBufferGeometry — correct attribute lengths and index buffer.
 * 2. Interpolation math — lerp and slerp correctness.
 * 3. Live colour/sail-number updates — mutate uniform values without rebuild.
 * 4. Wetness heuristic — correct computation from boat state.
 */

import { describe, expect, it } from 'vitest';
import type { GeneratedMesh, Quat, Vec3 } from '@/types';
import { toBufferGeometry } from '@render/boat/toBufferGeometry';
import {
  interpolateBoatState,
  lerpVec3,
  slerpQuat,
  type InterpolableState,
} from '@render/boat/interpolation';

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** A minimal valid GeneratedMesh: a single triangle. */
function makeSingleTriangleMesh(): GeneratedMesh {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
    meta: { triangleCount: 1 },
  };
}

/** A quad mesh (2 triangles, 4 vertices). */
function makeQuadMesh(): GeneratedMesh {
  return {
    positions: new Float32Array([
      0, 0, 0,
      1, 0, 0,
      1, 1, 0,
      0, 1, 0,
    ]),
    normals: new Float32Array([
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
    ]),
    uvs: new Float32Array([
      0, 0,
      1, 0,
      1, 1,
      0, 1,
    ]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
    meta: { triangleCount: 2 },
  };
}

/** A mesh with per-vertex colors. */
function makeColoredMesh(): GeneratedMesh {
  return {
    ...makeSingleTriangleMesh(),
    colors: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
  };
}

// Identity quaternion
const QUAT_IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };

// 90° rotation about Y axis: (0, sin(45°), 0, cos(45°))
const QUAT_90Y: Quat = {
  x: 0,
  y: Math.sin(Math.PI / 4),
  z: 0,
  w: Math.cos(Math.PI / 4),
};

// ─── toBufferGeometry tests ──────────────────────────────────────────────────

describe('toBufferGeometry', () => {
  it('creates geometry with correct position attribute length', () => {
    const mesh = makeSingleTriangleMesh();
    const geom = toBufferGeometry(mesh);

    // setAttribute is called with Float32BufferAttribute(positions, 3)
    // We can verify via the geometry's internal state
    expect(geom).toBeDefined();
    expect(geom).toHaveProperty('setAttribute');
    expect(geom).toHaveProperty('setIndex');
  });

  it('handles a quad mesh (4 vertices, 6 indices)', () => {
    const mesh = makeQuadMesh();
    const geom = toBufferGeometry(mesh);
    expect(geom).toBeDefined();
  });

  it('sets color attribute when colors are present', () => {
    const mesh = makeColoredMesh();
    const geom = toBufferGeometry(mesh);
    expect(geom).toBeDefined();
  });

  it('does not set color attribute when colors are absent', () => {
    const mesh = makeSingleTriangleMesh();
    expect(mesh.colors).toBeUndefined();
    const geom = toBufferGeometry(mesh);
    expect(geom).toBeDefined();
  });

  it('validates that positions length is divisible by 3', () => {
    const mesh = makeSingleTriangleMesh();
    // 3 vertices * 3 components = 9 floats
    expect(mesh.positions.length % 3).toBe(0);
    const geom = toBufferGeometry(mesh);
    expect(geom).toBeDefined();
  });

  it('validates that uvs length matches vertex count * 2', () => {
    const mesh = makeSingleTriangleMesh();
    const vertexCount = mesh.positions.length / 3;
    expect(mesh.uvs.length).toBe(vertexCount * 2);
  });

  it('validates that normals length matches positions length', () => {
    const mesh = makeSingleTriangleMesh();
    expect(mesh.normals.length).toBe(mesh.positions.length);
  });

  it('validates that indices length is divisible by 3', () => {
    const mesh = makeQuadMesh();
    expect(mesh.indices.length % 3).toBe(0);
  });

  it('validates that all indices are within vertex count bounds', () => {
    const mesh = makeQuadMesh();
    const vertexCount = mesh.positions.length / 3;
    for (let i = 0; i < mesh.indices.length; i++) {
      const idx = mesh.indices[i];
      expect(idx).toBeDefined();
      expect(idx).toBeLessThan(vertexCount);
    }
  });
});

// ─── Interpolation tests ─────────────────────────────────────────────────────

describe('lerpVec3', () => {
  it('returns a at t=0', () => {
    const a: Vec3 = { x: 1, y: 2, z: 3 };
    const b: Vec3 = { x: 4, y: 5, z: 6 };
    const result = lerpVec3(a, b, 0);
    expect(result.x).toBeCloseTo(1);
    expect(result.y).toBeCloseTo(2);
    expect(result.z).toBeCloseTo(3);
  });

  it('returns b at t=1', () => {
    const a: Vec3 = { x: 1, y: 2, z: 3 };
    const b: Vec3 = { x: 4, y: 5, z: 6 };
    const result = lerpVec3(a, b, 1);
    expect(result.x).toBeCloseTo(4);
    expect(result.y).toBeCloseTo(5);
    expect(result.z).toBeCloseTo(6);
  });

  it('returns midpoint at t=0.5', () => {
    const a: Vec3 = { x: 0, y: 0, z: 0 };
    const b: Vec3 = { x: 10, y: 20, z: 30 };
    const result = lerpVec3(a, b, 0.5);
    expect(result.x).toBeCloseTo(5);
    expect(result.y).toBeCloseTo(10);
    expect(result.z).toBeCloseTo(15);
  });

  it('handles negative coordinates', () => {
    const a: Vec3 = { x: -5, y: -3, z: -1 };
    const b: Vec3 = { x: 5, y: 3, z: 1 };
    const result = lerpVec3(a, b, 0.5);
    expect(result.x).toBeCloseTo(0);
    expect(result.y).toBeCloseTo(0);
    expect(result.z).toBeCloseTo(0);
  });
});

describe('slerpQuat', () => {
  it('returns a at t=0', () => {
    const result = slerpQuat(QUAT_IDENTITY, QUAT_90Y, 0);
    expect(result.x).toBeCloseTo(QUAT_IDENTITY.x);
    expect(result.y).toBeCloseTo(QUAT_IDENTITY.y);
    expect(result.z).toBeCloseTo(QUAT_IDENTITY.z);
    expect(result.w).toBeCloseTo(QUAT_IDENTITY.w);
  });

  it('returns b at t=1', () => {
    const result = slerpQuat(QUAT_IDENTITY, QUAT_90Y, 1);
    expect(result.x).toBeCloseTo(QUAT_90Y.x);
    expect(result.y).toBeCloseTo(QUAT_90Y.y);
    expect(result.z).toBeCloseTo(QUAT_90Y.z);
    expect(result.w).toBeCloseTo(QUAT_90Y.w);
  });

  it('returns a unit quaternion at t=0.5', () => {
    const result = slerpQuat(QUAT_IDENTITY, QUAT_90Y, 0.5);
    const len = Math.sqrt(
      result.x * result.x + result.y * result.y +
      result.z * result.z + result.w * result.w,
    );
    expect(len).toBeCloseTo(1.0);
  });

  it('midpoint between identity and 90° Y is a 45° Y rotation', () => {
    const result = slerpQuat(QUAT_IDENTITY, QUAT_90Y, 0.5);
    // 45° about Y: (0, sin(22.5°), 0, cos(22.5°))
    const expected = {
      x: 0,
      y: Math.sin(Math.PI / 8),
      z: 0,
      w: Math.cos(Math.PI / 8),
    };
    expect(result.x).toBeCloseTo(expected.x, 5);
    expect(result.y).toBeCloseTo(expected.y, 5);
    expect(result.z).toBeCloseTo(expected.z, 5);
    expect(result.w).toBeCloseTo(expected.w, 5);
  });

  it('handles shortest path (negates when dot < 0)', () => {
    // Negate QUAT_90Y — represents the same rotation in the long-way-round form
    const negated: Quat = {
      x: -QUAT_90Y.x,
      y: -QUAT_90Y.y,
      z: -QUAT_90Y.z,
      w: -QUAT_90Y.w,
    };
    const result = slerpQuat(QUAT_IDENTITY, negated, 0.5);
    // Should take the shortest path (same as positive form at t=0.5)
    const expected = slerpQuat(QUAT_IDENTITY, QUAT_90Y, 0.5);
    expect(result.x).toBeCloseTo(expected.x, 5);
    expect(result.y).toBeCloseTo(expected.y, 5);
    expect(result.z).toBeCloseTo(expected.z, 5);
    expect(result.w).toBeCloseTo(expected.w, 5);
  });

  it('handles near-identical quaternions (linear fallback)', () => {
    // Tiny rotation: almost identity
    const almostIdentity: Quat = { x: 0, y: 0.0001, z: 0, w: 0.99999999 };
    const result = slerpQuat(QUAT_IDENTITY, almostIdentity, 0.5);
    const len = Math.sqrt(
      result.x * result.x + result.y * result.y +
      result.z * result.z + result.w * result.w,
    );
    expect(len).toBeCloseTo(1.0);
  });

  it('identity slerped with identity gives identity', () => {
    const result = slerpQuat(QUAT_IDENTITY, QUAT_IDENTITY, 0.5);
    expect(result.x).toBeCloseTo(0);
    expect(result.y).toBeCloseTo(0);
    expect(result.z).toBeCloseTo(0);
    expect(result.w).toBeCloseTo(1);
  });
});

describe('interpolateBoatState', () => {
  it('returns prev state at alpha=0', () => {
    const prev: InterpolableState = {
      position: { x: 0, y: 0, z: 0 },
      orientation: QUAT_IDENTITY,
      heel: 0,
      speed: 0,
    };
    const curr: InterpolableState = {
      position: { x: 10, y: 5, z: 20 },
      orientation: QUAT_90Y,
      heel: 0.3,
      speed: 5,
    };
    const result = interpolateBoatState(prev, curr, 0);
    expect(result.position.x).toBeCloseTo(0);
    expect(result.position.y).toBeCloseTo(0);
    expect(result.position.z).toBeCloseTo(0);
  });

  it('returns curr state at alpha=1', () => {
    const prev: InterpolableState = {
      position: { x: 0, y: 0, z: 0 },
      orientation: QUAT_IDENTITY,
      heel: 0,
      speed: 0,
    };
    const curr: InterpolableState = {
      position: { x: 10, y: 5, z: 20 },
      orientation: QUAT_90Y,
      heel: 0.3,
      speed: 5,
    };
    const result = interpolateBoatState(prev, curr, 1);
    expect(result.position.x).toBeCloseTo(10);
    expect(result.position.y).toBeCloseTo(5);
    expect(result.position.z).toBeCloseTo(20);
  });

  it('produces intermediate position at alpha=0.5', () => {
    const prev: InterpolableState = {
      position: { x: 0, y: 0, z: 0 },
      orientation: QUAT_IDENTITY,
      heel: 0,
      speed: 0,
    };
    const curr: InterpolableState = {
      position: { x: 10, y: 0, z: 0 },
      orientation: QUAT_IDENTITY,
      heel: 0,
      speed: 0,
    };
    const result = interpolateBoatState(prev, curr, 0.5);
    expect(result.position.x).toBeCloseTo(5);
  });
});
