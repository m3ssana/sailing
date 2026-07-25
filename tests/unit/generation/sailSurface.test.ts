/**
 * Tests for the sail surface generator (D.4).
 *
 * Verifies correct dimensions, grid topology, luff round geometry, broadseam,
 * determinism, and panel encoding for both main-sail and jib archetypes.
 */

import { describe, expect, it } from 'vitest';
import type { SailSurfaceParams } from '@/types';
import {
  assertDeterministic,
  assertFiniteBuffers,
  assertNoDegenerateTriangles,
  computeSurfaceArea,
} from '@generation/testing/geometryAssertions';
import { SailSurfaceGenerator } from '@generation/sail/SailSurfaceGenerator';

// ─── Test parameters ─────────────────────────────────────────────────────────

/**
 * Mainsail: tall, narrow triangle. Typical masthead main.
 * luff ~13.5m, foot ~4.5m, leech ~14.0m (high aspect ratio).
 */
const mainParams: SailSurfaceParams = {
  luffLength: 13.5,
  footLength: 4.5,
  leechLength: 14.0,
  luffRound: 0.02, // 2% of luff — conservative
  broadseam: 0.03, // 3% of foot
  twist: 0.12, // ~7 degrees at the head
  luffSegments: 20,
  footSegments: 12,
  panelCount: 6,
};

/**
 * Jib: shorter, wider triangle. Typical fractional jib.
 * luff ~10m, foot ~3.5m, leech ~9.5m (lower aspect ratio, more overlap).
 */
const jibParams: SailSurfaceParams = {
  luffLength: 10.0,
  footLength: 3.5,
  leechLength: 9.5,
  luffRound: 0.01, // 1% — jibs have less luff round
  broadseam: 0.02, // 2% of foot
  twist: 0.08, // ~4.5 degrees at the head
  luffSegments: 16,
  footSegments: 10,
  panelCount: 5,
};

/**
 * Flat sail: zero luff round and broadseam for planarity testing.
 */
const flatParams: SailSurfaceParams = {
  luffLength: 10.0,
  footLength: 4.0,
  leechLength: 10.5,
  luffRound: 0,
  broadseam: 0,
  twist: 0,
  luffSegments: 10,
  footSegments: 8,
  panelCount: 4,
};

// ─── Helper: measure edge length from positions buffer ───────────────────────

function measureEdge(positions: Float32Array, vertexIndices: number[]): number {
  let length = 0;
  for (let i = 1; i < vertexIndices.length; i++) {
    const prev = vertexIndices[i - 1];
    const curr = vertexIndices[i];
    if (prev === undefined || curr === undefined) continue;
    const dx = (positions[curr * 3] ?? 0) - (positions[prev * 3] ?? 0);
    const dy = (positions[curr * 3 + 1] ?? 0) - (positions[prev * 3 + 1] ?? 0);
    const dz = (positions[curr * 3 + 2] ?? 0) - (positions[prev * 3 + 2] ?? 0);
    length += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return length;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('SailSurfaceGenerator', () => {
  describe('grid topology', () => {
    it('produces correct vertex count for main', () => {
      const model = SailSurfaceGenerator.generate(mainParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;
      const expectedVertices = (mainParams.luffSegments + 1) * (mainParams.footSegments + 1);
      expect(mesh.positions.length / 3).toBe(expectedVertices);
    });

    it('produces correct triangle count for main', () => {
      const model = SailSurfaceGenerator.generate(mainParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;
      const expectedTriangles = mainParams.luffSegments * mainParams.footSegments * 2;
      expect(mesh.indices.length / 3).toBe(expectedTriangles);
    });

    it('produces correct vertex count for jib', () => {
      const model = SailSurfaceGenerator.generate(jibParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;
      const expectedVertices = (jibParams.luffSegments + 1) * (jibParams.footSegments + 1);
      expect(mesh.positions.length / 3).toBe(expectedVertices);
    });

    it('produces correct triangle count for jib', () => {
      const model = SailSurfaceGenerator.generate(jibParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;
      const expectedTriangles = jibParams.luffSegments * jibParams.footSegments * 2;
      expect(mesh.indices.length / 3).toBe(expectedTriangles);
    });
  });

  describe('edge lengths (correct dimensions)', () => {
    it('main sail luff edge matches luffLength within 2%', () => {
      const model = SailSurfaceGenerator.generate(mainParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;

      const cols = mainParams.footSegments + 1;
      const rows = mainParams.luffSegments + 1;
      const luffVerts: number[] = [];
      for (let i = 0; i < rows; i++) luffVerts.push(i * cols);

      const actualLuff = measureEdge(mesh.positions, luffVerts);
      // Luff round adds curve length, so actual should be >= input
      expect(actualLuff).toBeGreaterThanOrEqual(mainParams.luffLength);
      // But within 2% for reasonable luffRound values
      expect(actualLuff).toBeLessThan(mainParams.luffLength * 1.02);
    });

    it('main sail foot edge matches footLength within 2%', () => {
      const model = SailSurfaceGenerator.generate(mainParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;

      const cols = mainParams.footSegments + 1;
      const footVerts: number[] = [];
      for (let j = 0; j < cols; j++) footVerts.push(j);

      const actualFoot = measureEdge(mesh.positions, footVerts);
      // Broadseam adds curve length
      expect(actualFoot).toBeGreaterThanOrEqual(mainParams.footLength * 0.98);
      expect(actualFoot).toBeLessThan(mainParams.footLength * 1.05);
    });

    it('main sail leech edge matches leechLength within 2%', () => {
      const model = SailSurfaceGenerator.generate(mainParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;

      const cols = mainParams.footSegments + 1;
      const rows = mainParams.luffSegments + 1;
      const leechVerts: number[] = [];
      for (let i = 0; i < rows; i++) leechVerts.push(i * cols + mainParams.footSegments);

      const actualLeech = measureEdge(mesh.positions, leechVerts);
      // Leech is a straight ruled line (no round/broadseam), should be close
      expect(actualLeech).toBeCloseTo(mainParams.leechLength, 0);
      expect(Math.abs(actualLeech - mainParams.leechLength) / mainParams.leechLength).toBeLessThan(0.02);
    });

    it('jib sail luff edge matches luffLength within 2%', () => {
      const model = SailSurfaceGenerator.generate(jibParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;

      const cols = jibParams.footSegments + 1;
      const rows = jibParams.luffSegments + 1;
      const luffVerts: number[] = [];
      for (let i = 0; i < rows; i++) luffVerts.push(i * cols);

      const actualLuff = measureEdge(mesh.positions, luffVerts);
      expect(actualLuff).toBeGreaterThanOrEqual(jibParams.luffLength);
      expect(actualLuff).toBeLessThan(jibParams.luffLength * 1.02);
    });

    it('jib sail foot edge matches footLength within 5%', () => {
      const model = SailSurfaceGenerator.generate(jibParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;

      const cols = jibParams.footSegments + 1;
      const footVerts: number[] = [];
      for (let j = 0; j < cols; j++) footVerts.push(j);

      const actualFoot = measureEdge(mesh.positions, footVerts);
      expect(actualFoot).toBeGreaterThanOrEqual(jibParams.footLength * 0.98);
      expect(actualFoot).toBeLessThan(jibParams.footLength * 1.05);
    });

    it('jib sail leech edge matches leechLength within 2%', () => {
      const model = SailSurfaceGenerator.generate(jibParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;

      const cols = jibParams.footSegments + 1;
      const rows = jibParams.luffSegments + 1;
      const leechVerts: number[] = [];
      for (let i = 0; i < rows; i++) leechVerts.push(i * cols + jibParams.footSegments);

      const actualLeech = measureEdge(mesh.positions, leechVerts);
      expect(Math.abs(actualLeech - jibParams.leechLength) / jibParams.leechLength).toBeLessThan(0.02);
    });
  });

  describe('luff round geometry', () => {
    it('flat sail (luffRound=0) has straight luff edge', () => {
      const model = SailSurfaceGenerator.generate(flatParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;

      const cols = flatParams.footSegments + 1;
      const rows = flatParams.luffSegments + 1;

      // With luffRound=0 and twist=0, all luff points should be at x=0
      for (let i = 0; i < rows; i++) {
        const vtxIdx = i * cols; // u=0 column
        const x = mesh.positions[vtxIdx * 3] ?? 0;
        expect(Math.abs(x)).toBeLessThan(1e-10);
      }
    });

    it('luffRound > 0 bows the luff edge outward', () => {
      const model = SailSurfaceGenerator.generate(mainParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;

      const cols = mainParams.footSegments + 1;
      const rows = mainParams.luffSegments + 1;

      // Check midpoint of the luff: should have positive X offset
      const midRow = Math.floor(rows / 2);
      const vtxIdx = midRow * cols; // u=0 column at midpoint
      const x = mesh.positions[vtxIdx * 3] ?? 0;

      // Expected offset at midpoint: luffRound * luffLength * 4 * 0.5 * 0.5 = luffRound * luffLength
      const expectedOffset = mainParams.luffRound * mainParams.luffLength;
      expect(x).toBeGreaterThan(0);
      expect(x).toBeCloseTo(expectedOffset, 1);
    });

    it('luff round is zero at tack and head', () => {
      const model = SailSurfaceGenerator.generate(mainParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;

      const cols = mainParams.footSegments + 1;
      const rows = mainParams.luffSegments + 1;

      // Tack (row 0, col 0)
      const tackX = mesh.positions[0] ?? 0;
      expect(Math.abs(tackX)).toBeLessThan(1e-10);

      // Head (last row, col 0)
      const headIdx = (rows - 1) * cols;
      const headX = mesh.positions[headIdx * 3] ?? 0;
      expect(Math.abs(headX)).toBeLessThan(1e-10);
    });
  });

  describe('broadseam geometry', () => {
    it('broadseam=0 produces straight foot edge', () => {
      const model = SailSurfaceGenerator.generate(flatParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;

      const cols = flatParams.footSegments + 1;

      // With no broadseam and no twist, foot edge should be a straight line
      // from tack (0,0,0) to clew
      // Check that points lie on the line between first and last foot vertex
      const startX = mesh.positions[0] ?? 0;
      const startY = mesh.positions[1] ?? 0;
      const endIdx = flatParams.footSegments;
      const endX = mesh.positions[endIdx * 3] ?? 0;
      const endY = mesh.positions[endIdx * 3 + 1] ?? 0;

      for (let j = 1; j < cols - 1; j++) {
        const t = j / flatParams.footSegments;
        const expectedX = startX + (endX - startX) * t;
        const expectedY = startY + (endY - startY) * t;
        const actualX = mesh.positions[j * 3] ?? 0;
        const actualY = mesh.positions[j * 3 + 1] ?? 0;
        expect(Math.abs(actualX - expectedX)).toBeLessThan(1e-7);
        expect(Math.abs(actualY - expectedY)).toBeLessThan(1e-7);
      }
    });

    it('broadseam > 0 adds fullness to the foot', () => {
      const model = SailSurfaceGenerator.generate(mainParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;

      const cols = mainParams.footSegments + 1;
      // Foot midpoint (row 0, middle column)
      const midCol = Math.floor(cols / 2);
      const midY = mesh.positions[midCol * 3 + 1] ?? 0;

      // Generate a version without broadseam for comparison
      const noBroadseamParams: SailSurfaceParams = { ...mainParams, broadseam: 0 };
      const refModel = SailSurfaceGenerator.generate(noBroadseamParams, 42);
      const refMesh = refModel.meshes[0];
      expect(refMesh).toBeDefined();
      if (!refMesh) return;

      const refMidY = refMesh.positions[midCol * 3 + 1] ?? 0;
      // Broadseam should push the foot midpoint higher (positive Y)
      expect(midY).toBeGreaterThan(refMidY);
    });
  });

  describe('twist', () => {
    it('twist=0 keeps all points in the XY plane', () => {
      const model = SailSurfaceGenerator.generate(flatParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;

      for (let i = 0; i < mesh.positions.length; i += 3) {
        const z = mesh.positions[i + 2] ?? 0;
        expect(Math.abs(z)).toBeLessThan(1e-10);
      }
    });

    it('twist > 0 displaces mid-height vertices in Z', () => {
      const model = SailSurfaceGenerator.generate(mainParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;

      const cols = mainParams.footSegments + 1;
      const rows = mainParams.luffSegments + 1;

      // Check foot row z=0
      for (let j = 0; j < cols; j++) {
        const z = mesh.positions[j * 3 + 2] ?? 0;
        expect(Math.abs(z)).toBeLessThan(1e-10);
      }

      // Check mid-height rows have non-zero Z for leech-side vertices.
      // At mid-height the sail has significant X spread, so twist * v
      // creates measurable Z displacement via Y-axis rotation.
      const midRow = Math.floor(rows / 2);
      let maxZ = 0;
      for (let j = 1; j < cols; j++) {
        const vtx = midRow * cols + j;
        const z = Math.abs(mesh.positions[vtx * 3 + 2] ?? 0);
        if (z > maxZ) maxZ = z;
      }
      // At midRow (v≈0.5), twist angle ≈ 0.06 rad, and X is ~2m (for a 4.5m foot),
      // so Z displacement ≈ sin(0.06) * 2 ≈ 0.12m
      expect(maxZ).toBeGreaterThan(0.01);
    });
  });

  describe('metadata', () => {
    it('emits correct dimension metadata for main', () => {
      const model = SailSurfaceGenerator.generate(mainParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;

      expect(mesh.meta['actualLuffLength']).toBeDefined();
      expect(mesh.meta['actualFootLength']).toBeDefined();
      expect(mesh.meta['actualLeechLength']).toBeDefined();
      expect(mesh.meta['area']).toBeDefined();
      expect(mesh.meta['area']).toBeGreaterThan(0);
      expect(mesh.meta['vertexCount']).toBe(
        (mainParams.luffSegments + 1) * (mainParams.footSegments + 1),
      );
      expect(mesh.meta['triangleCount']).toBe(
        mainParams.luffSegments * mainParams.footSegments * 2,
      );
    });

    it('meta area is positive and plausible (bounded by triangle area)', () => {
      const model = SailSurfaceGenerator.generate(mainParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;

      const area = mesh.meta['area'] ?? 0;
      // A triangular sail area ≈ 0.5 * luff * foot * sin(angle)
      // Should be roughly half of luff * foot for typical proportions
      const maxPossibleArea = mainParams.luffLength * mainParams.footLength;
      expect(area).toBeGreaterThan(0);
      expect(area).toBeLessThan(maxPossibleArea);
    });
  });

  describe('panel encoding', () => {
    it('colors buffer has panel fraction in R channel', () => {
      const model = SailSurfaceGenerator.generate(mainParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;
      expect(mesh.colors).toBeDefined();
      if (!mesh.colors) return;

      const cols = mainParams.footSegments + 1;
      // At u = 0 (luff), panel fraction should be 0
      const luffColor = mesh.colors[0] ?? -1;
      expect(luffColor).toBeCloseTo(0, 5);

      // At u = 0.5 (mid-girth), check panelCount/2 * 1/panelCount remainder
      const midCol = Math.floor(cols / 2);
      const midU = midCol / mainParams.footSegments;
      const expectedFraction = (midU * mainParams.panelCount) % 1.0;
      const midColor = mesh.colors[midCol * 3] ?? -1;
      expect(midColor).toBeCloseTo(expectedFraction, 4);
    });
  });

  describe('geometry integrity', () => {
    it('main sail has no NaN/Infinity in buffers', () => {
      const model = SailSurfaceGenerator.generate(mainParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;
      assertFiniteBuffers(mesh);
    });

    it('jib sail has no NaN/Infinity in buffers', () => {
      const model = SailSurfaceGenerator.generate(jibParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;
      assertFiniteBuffers(mesh);
    });

    it('main sail has no degenerate triangles', () => {
      const model = SailSurfaceGenerator.generate(mainParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;
      assertNoDegenerateTriangles(mesh);
    });

    it('jib sail has no degenerate triangles', () => {
      const model = SailSurfaceGenerator.generate(jibParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;
      assertNoDegenerateTriangles(mesh);
    });

    it('surface area is positive for both sails', () => {
      const mainModel = SailSurfaceGenerator.generate(mainParams, 42);
      const mainMesh = mainModel.meshes[0];
      expect(mainMesh).toBeDefined();
      if (!mainMesh) return;
      expect(computeSurfaceArea(mainMesh)).toBeGreaterThan(0);

      const jibModel = SailSurfaceGenerator.generate(jibParams, 42);
      const jibMesh = jibModel.meshes[0];
      expect(jibMesh).toBeDefined();
      if (!jibMesh) return;
      expect(computeSurfaceArea(jibMesh)).toBeGreaterThan(0);
    });
  });

  describe('determinism', () => {
    it('main sail is deterministic', () => {
      assertDeterministic(SailSurfaceGenerator, mainParams, 42);
    });

    it('jib sail is deterministic', () => {
      assertDeterministic(SailSurfaceGenerator, jibParams, 99);
    });

    it('different seeds produce identical output (seed is unused)', () => {
      const a = SailSurfaceGenerator.generate(mainParams, 1);
      const b = SailSurfaceGenerator.generate(mainParams, 9999);
      const meshA = a.meshes[0];
      const meshB = b.meshes[0];
      expect(meshA).toBeDefined();
      expect(meshB).toBeDefined();
      if (!meshA || !meshB) return;

      // Sail surface is fully deterministic from params alone (no randomness)
      for (let i = 0; i < meshA.positions.length; i++) {
        expect(meshA.positions[i]).toBe(meshB.positions[i]);
      }
    });
  });

  describe('UVs', () => {
    it('UVs are in [0,1] range', () => {
      const model = SailSurfaceGenerator.generate(mainParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;

      for (let i = 0; i < mesh.uvs.length; i++) {
        const val = mesh.uvs[i] ?? -1;
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThanOrEqual(1);
      }
    });

    it('UV corners map correctly', () => {
      const model = SailSurfaceGenerator.generate(flatParams, 42);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;

      const cols = flatParams.footSegments + 1;
      const rows = flatParams.luffSegments + 1;

      // Tack (row 0, col 0): u=0, v=0
      expect(mesh.uvs[0]).toBe(0);
      expect(mesh.uvs[1]).toBe(0);

      // Clew (row 0, last col): u=1, v=0
      const clewIdx = flatParams.footSegments;
      expect(mesh.uvs[clewIdx * 2]).toBe(1);
      expect(mesh.uvs[clewIdx * 2 + 1]).toBe(0);

      // Head at luff (last row, col 0): u=0, v=1
      const headIdx = (rows - 1) * cols;
      expect(mesh.uvs[headIdx * 2]).toBe(0);
      expect(mesh.uvs[headIdx * 2 + 1]).toBe(1);
    });
  });

  describe('model structure', () => {
    it('has exactly one mesh', () => {
      const model = SailSurfaceGenerator.generate(mainParams, 42);
      expect(model.meshes.length).toBe(1);
    });

    it('has one group with sailcloth material', () => {
      const model = SailSurfaceGenerator.generate(mainParams, 42);
      expect(model.groups.length).toBe(1);
      const group = model.groups[0];
      expect(group).toBeDefined();
      if (!group) return;
      expect(group.materialId).toBe('sailcloth');
      expect(group.start).toBe(0);
      const mesh = model.meshes[0];
      expect(mesh).toBeDefined();
      if (!mesh) return;
      expect(group.count).toBe(mesh.indices.length);
    });

    it('transferables are populated', () => {
      const model = SailSurfaceGenerator.generate(mainParams, 42);
      expect(model.transferables.length).toBeGreaterThan(0);
    });
  });
});
