/**
 * Tests for OceanClipmap — E.1 ocean clipmap geometry.
 *
 * Validates:
 * 1. Triangle/vertex count is constant and matches the formula
 * 2. Grid snapping produces correct snapped origins
 * 3. No degenerate triangles in the geometry
 * 4. Triangle count stays IDENTICAL across different camera positions (flatness)
 */

import { describe, it, expect } from 'vitest';
import {
  createOceanClipmap,
  snapToGrid,
  _testing,
} from './OceanClipmap';

const { GRID_CELLS, GRID_VERTS, VERTS_PER_RING, TRIS_PER_RING, BASE_CELL_SIZE } = _testing;

// ─── Triangle / vertex count formula ─────────────────────────────────────────

describe('OceanClipmap — geometry counts', () => {
  it('constants are internally consistent', () => {
    expect(GRID_VERTS).toBe(GRID_CELLS + 1);
    expect(VERTS_PER_RING).toBe(GRID_VERTS * GRID_VERTS);
    expect(TRIS_PER_RING).toBe(GRID_CELLS * GRID_CELLS * 2);
  });

  it('total triangle count equals ringCount × TRIS_PER_RING', () => {
    const clipmap = createOceanClipmap(8);
    expect(clipmap.triangleCount).toBe(8 * TRIS_PER_RING);
    expect(clipmap.triangleCount).toBe(65536);
    clipmap.dispose();
  });

  it('total vertex count equals ringCount × VERTS_PER_RING', () => {
    const clipmap = createOceanClipmap(8);
    expect(clipmap.vertexCount).toBe(8 * VERTS_PER_RING);
    expect(clipmap.vertexCount).toBe(8 * 65 * 65);
    clipmap.dispose();
  });

  it('triangle count matches ~65k target', () => {
    const clipmap = createOceanClipmap(8);
    // The requirement is "flat at ~65k"
    expect(clipmap.triangleCount).toBeGreaterThanOrEqual(60000);
    expect(clipmap.triangleCount).toBeLessThanOrEqual(70000);
    clipmap.dispose();
  });

  it('ringCount is configurable via QualityKnobs.oceanGridRings', () => {
    const clipmap4 = createOceanClipmap(4);
    expect(clipmap4.triangleCount).toBe(4 * TRIS_PER_RING);
    expect(clipmap4.ringCount).toBe(4);
    clipmap4.dispose();

    const clipmap12 = createOceanClipmap(12);
    expect(clipmap12.triangleCount).toBe(12 * TRIS_PER_RING);
    expect(clipmap12.ringCount).toBe(12);
    clipmap12.dispose();
  });
});

// ─── Flatness — triangle count is IDENTICAL regardless of camera position ────

describe('OceanClipmap — flatness (triangle count independent of camera position)', () => {
  const cameraPositions: Array<[number, number, string]> = [
    [0, 0, 'origin'],
    [100, 200, 'moderate offset'],
    [-500, 300, 'negative X, positive Z'],
    [10000, -10000, 'far from origin'],
    [0.3, 0.7, 'sub-cell fractional position'],
    [1234.567, -8901.234, 'arbitrary floating point'],
  ];

  it('triangle count stays identical across all camera positions', () => {
    const clipmap = createOceanClipmap(8);
    const expectedTriangles = clipmap.triangleCount;
    const expectedVertices = clipmap.vertexCount;

    for (const [x, z, label] of cameraPositions) {
      clipmap.update(x, z);
      // The triangle count is a fixed property, not recomputed — this verifies
      // the design: geometry topology never changes, only the mesh position uniform.
      expect(clipmap.triangleCount, `triangles at ${label}`).toBe(expectedTriangles);
      expect(clipmap.vertexCount, `vertices at ${label}`).toBe(expectedVertices);
    }

    clipmap.dispose();
  });

  it('ring count stays identical across updates', () => {
    const clipmap = createOceanClipmap(8);

    for (const [x, z] of cameraPositions) {
      clipmap.update(x, z);
      expect(clipmap.ringCount).toBe(8);
    }

    clipmap.dispose();
  });
});

// ─── Grid snapping ───────────────────────────────────────────────────────────

describe('OceanClipmap — grid snapping', () => {
  it('snapToGrid snaps to floor of cell size', () => {
    // Cell size 0.5: 1.3 → 1.0 (floor(1.3/0.5)*0.5 = 2*0.5 = 1.0)
    expect(snapToGrid(1.3, 0.5)).toBeCloseTo(1.0);
    expect(snapToGrid(1.0, 0.5)).toBeCloseTo(1.0);
    expect(snapToGrid(0.9, 0.5)).toBeCloseTo(0.5);
    expect(snapToGrid(0.0, 0.5)).toBeCloseTo(0.0);
  });

  it('snapToGrid handles negative values', () => {
    // floor(-1.3/0.5)*0.5 = floor(-2.6)*0.5 = -3*0.5 = -1.5
    expect(snapToGrid(-1.3, 0.5)).toBeCloseTo(-1.5);
    expect(snapToGrid(-1.0, 0.5)).toBeCloseTo(-1.0);
    expect(snapToGrid(-0.1, 0.5)).toBeCloseTo(-0.5);
  });

  it('snapToGrid with larger cell sizes', () => {
    // Cell size 4: 5.5 → 4.0 (floor(5.5/4)*4 = 1*4 = 4)
    expect(snapToGrid(5.5, 4.0)).toBeCloseTo(4.0);
    expect(snapToGrid(8.0, 4.0)).toBeCloseTo(8.0);
    expect(snapToGrid(11.9, 4.0)).toBeCloseTo(8.0);
  });

  it('ring 0 snaps at BASE_CELL_SIZE intervals', () => {
    const clipmap = createOceanClipmap(8);
    clipmap.update(1.3, 2.7);

    const info = clipmap.getRingInfo(0);
    expect(info).toBeDefined();
    expect(info?.cellSize).toBe(BASE_CELL_SIZE);
    expect(info?.snappedX).toBeCloseTo(snapToGrid(1.3, BASE_CELL_SIZE));
    expect(info?.snappedZ).toBeCloseTo(snapToGrid(2.7, BASE_CELL_SIZE));
    clipmap.dispose();
  });

  it('ring N snaps at BASE_CELL_SIZE × 2^N intervals', () => {
    const clipmap = createOceanClipmap(8);
    clipmap.update(100, -50);

    for (let i = 0; i < 8; i++) {
      const info = clipmap.getRingInfo(i);
      expect(info).toBeDefined();
      const expectedCellSize = BASE_CELL_SIZE * Math.pow(2, i);
      expect(info?.cellSize).toBeCloseTo(expectedCellSize);
      expect(info?.snappedX).toBeCloseTo(snapToGrid(100, expectedCellSize));
      expect(info?.snappedZ).toBeCloseTo(snapToGrid(-50, expectedCellSize));
    }

    clipmap.dispose();
  });

  it('sub-cell camera movement does NOT change snapped position', () => {
    const clipmap = createOceanClipmap(8);

    // Move camera within a single cell of ring 0
    clipmap.update(0.1, 0.1);
    const offset1 = clipmap.getRingWorldOffset(0);

    clipmap.update(0.2, 0.2);
    const offset2 = clipmap.getRingWorldOffset(0);

    // Both should snap to the same grid point (floor within the same cell)
    expect(offset1[0]).toBeCloseTo(offset2[0]);
    expect(offset1[1]).toBeCloseTo(offset2[1]);

    clipmap.dispose();
  });

  it('crossing a cell boundary DOES change snapped position', () => {
    const clipmap = createOceanClipmap(8);

    // Ring 0 cell size = 0.5. Move from 0.4 to 0.6 → crosses 0.5 boundary.
    clipmap.update(0.4, 0);
    const offset1 = clipmap.getRingWorldOffset(0);

    clipmap.update(0.6, 0);
    const offset2 = clipmap.getRingWorldOffset(0);

    // 0.4 snaps to 0.0; 0.6 snaps to 0.5
    expect(offset1[0]).toBeCloseTo(0.0);
    expect(offset2[0]).toBeCloseTo(0.5);

    clipmap.dispose();
  });
});

// ─── No degenerate triangles ─────────────────────────────────────────────────

describe('OceanClipmap — no degenerate triangles', () => {
  /**
   * Check that no triangle in the given position/index buffers has zero area.
   * This is equivalent to assertNoDegenerateTriangles from geometryAssertions.ts
   * but adapted for Float32Array + Uint32Array (BufferGeometry layout) rather
   * than the GeneratedMesh type.
   */
  function assertNoDegenerateTrisInBuffers(
    positions: Float32Array,
    indices: Uint32Array,
    epsilon = 1e-10,
  ): void {
    const degenerate: number[] = [];

    for (let i = 0; i < indices.length; i += 3) {
      const i0 = indices[i];
      const i1 = indices[i + 1];
      const i2 = indices[i + 2];

      if (i0 === undefined || i1 === undefined || i2 === undefined) continue;

      const p0x = positions[i0 * 3] ?? 0;
      const p0y = positions[i0 * 3 + 1] ?? 0;
      const p0z = positions[i0 * 3 + 2] ?? 0;

      const p1x = positions[i1 * 3] ?? 0;
      const p1y = positions[i1 * 3 + 1] ?? 0;
      const p1z = positions[i1 * 3 + 2] ?? 0;

      const p2x = positions[i2 * 3] ?? 0;
      const p2y = positions[i2 * 3 + 1] ?? 0;
      const p2z = positions[i2 * 3 + 2] ?? 0;

      const e1x = p1x - p0x;
      const e1y = p1y - p0y;
      const e1z = p1z - p0z;
      const e2x = p2x - p0x;
      const e2y = p2y - p0y;
      const e2z = p2z - p0z;

      const cx = e1y * e2z - e1z * e2y;
      const cy = e1z * e2x - e1x * e2z;
      const cz = e1x * e2y - e1y * e2x;
      const areaSq = cx * cx + cy * cy + cz * cz;

      if (areaSq < epsilon * epsilon) {
        degenerate.push(i / 3);
      }
    }

    if (degenerate.length > 0) {
      const preview = degenerate.slice(0, 10).join(', ');
      throw new Error(
        `Found ${degenerate.length} degenerate triangles. Face indices: ${preview}`,
      );
    }
  }

  it('no degenerate triangles in any ring (default 8 rings)', () => {
    const clipmap = createOceanClipmap(8);

    for (let i = 0; i < 8; i++) {
      const posBuffer = clipmap.getPositionBuffer(i);
      expect(posBuffer).toBeDefined();

      // Get index buffer from mesh geometry
      const mesh = clipmap.getRingMesh(i);
      expect(mesh).toBeDefined();

      // Rebuild indices from our known topology (same indices for all rings)
      // since our type declarations don't expose getIndex.
      const indexCount = GRID_CELLS * GRID_CELLS * 6;
      const indices = new Uint32Array(indexCount);
      let idx = 0;
      for (let row = 0; row < GRID_CELLS; row++) {
        for (let col = 0; col < GRID_CELLS; col++) {
          const tl = row * GRID_VERTS + col;
          const tr = row * GRID_VERTS + col + 1;
          const bl = (row + 1) * GRID_VERTS + col;
          const br = (row + 1) * GRID_VERTS + col + 1;
          indices[idx++] = tl;
          indices[idx++] = bl;
          indices[idx++] = tr;
          indices[idx++] = tr;
          indices[idx++] = bl;
          indices[idx++] = br;
        }
      }

      assertNoDegenerateTrisInBuffers(posBuffer!, indices);
    }

    clipmap.dispose();
  });

  it('no degenerate triangles after grid snapping moves meshes', () => {
    const clipmap = createOceanClipmap(8);

    // Update to an arbitrary position
    clipmap.update(1234.5, -6789.0);

    // The geometry itself doesn't change — only mesh.position changes.
    // Verify the position buffer still has valid triangles (it should be
    // identical to construction time since we don't rebuild geometry).
    for (let i = 0; i < 8; i++) {
      const posBuffer = clipmap.getPositionBuffer(i);
      expect(posBuffer).toBeDefined();

      const indexCount = GRID_CELLS * GRID_CELLS * 6;
      const indices = new Uint32Array(indexCount);
      let idx = 0;
      for (let row = 0; row < GRID_CELLS; row++) {
        for (let col = 0; col < GRID_CELLS; col++) {
          const tl = row * GRID_VERTS + col;
          const tr = row * GRID_VERTS + col + 1;
          const bl = (row + 1) * GRID_VERTS + col;
          const br = (row + 1) * GRID_VERTS + col + 1;
          indices[idx++] = tl;
          indices[idx++] = bl;
          indices[idx++] = tr;
          indices[idx++] = tr;
          indices[idx++] = bl;
          indices[idx++] = br;
        }
      }

      assertNoDegenerateTrisInBuffers(posBuffer!, indices);
    }

    clipmap.dispose();
  });
});

// ─── Position buffer layout ──────────────────────────────────────────────────

describe('OceanClipmap — position buffer', () => {
  it('position buffers have correct length', () => {
    const clipmap = createOceanClipmap(8);

    for (let i = 0; i < 8; i++) {
      const buffer = clipmap.getPositionBuffer(i);
      expect(buffer).toBeDefined();
      expect(buffer?.length).toBe(VERTS_PER_RING * 3);
    }

    clipmap.dispose();
  });

  it('initial Y values are zero (flat, no displacement)', () => {
    const clipmap = createOceanClipmap(8);
    const buffer = clipmap.getPositionBuffer(0);
    expect(buffer).toBeDefined();

    // Check all Y components are 0
    for (let i = 0; i < VERTS_PER_RING; i++) {
      const y = buffer?.[i * 3 + 1];
      expect(y).toBe(0);
    }

    clipmap.dispose();
  });

  it('ring cell sizes double per ring', () => {
    const clipmap = createOceanClipmap(8);
    const infos = clipmap.getRingInfos();

    for (let i = 0; i < infos.length; i++) {
      const info = infos[i];
      expect(info).toBeDefined();
      expect(info?.cellSize).toBeCloseTo(BASE_CELL_SIZE * Math.pow(2, i));
    }

    clipmap.dispose();
  });

  it('invalid ring index returns undefined', () => {
    const clipmap = createOceanClipmap(8);
    expect(clipmap.getPositionBuffer(-1)).toBeUndefined();
    expect(clipmap.getPositionBuffer(8)).toBeUndefined();
    expect(clipmap.getRingInfo(99)).toBeUndefined();
    clipmap.dispose();
  });
});

// ─── Cascade fade attribute ──────────────────────────────────────────────────

describe('OceanClipmap — cascade fade', () => {
  it('fade values are in [0, 1] range', () => {
    const { fadeArray } = _testing.buildRingGeometry(0, 8);

    for (let i = 0; i < fadeArray.length; i++) {
      const val = fadeArray[i];
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(1);
    }
  });

  it('centre vertices have fade = 0', () => {
    const { fadeArray } = _testing.buildRingGeometry(0, 8);

    // Centre vertex
    const centreRow = Math.floor(GRID_VERTS / 2);
    const centreCol = Math.floor(GRID_VERTS / 2);
    const centreIdx = centreRow * GRID_VERTS + centreCol;
    const centreVal = fadeArray[centreIdx];
    expect(centreVal).toBe(0);
  });

  it('outermost ring has non-zero fade at boundary', () => {
    // Ring 7 (outermost of 8) should have fade > 0 at its edge
    const { fadeArray } = _testing.buildRingGeometry(7, 8);

    // Corner vertex (max Chebyshev distance)
    const cornerIdx = 0; // top-left corner
    const cornerVal = fadeArray[cornerIdx];
    expect(cornerVal).toBeGreaterThan(0);
  });
});

// ─── Disposal ────────────────────────────────────────────────────────────────

describe('OceanClipmap — lifecycle', () => {
  it('dispose does not throw', () => {
    const clipmap = createOceanClipmap(8);
    expect(() => clipmap.dispose()).not.toThrow();
  });

  it('group contains exactly ringCount children', () => {
    const clipmap = createOceanClipmap(8);
    expect(clipmap.group.children.length).toBe(8);
    clipmap.dispose();
  });

  it('gridCells and gridVerts are accessible', () => {
    const clipmap = createOceanClipmap(8);
    expect(clipmap.gridCells).toBe(GRID_CELLS);
    expect(clipmap.gridVerts).toBe(GRID_VERTS);
    clipmap.dispose();
  });
});
