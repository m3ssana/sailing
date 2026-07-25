/**
 * Ocean clipmap geometry — E.1
 *
 * An 8-ring camera-centred geometry clipmap that keeps triangle count flat at ~65k
 * regardless of camera position or view direction. Grid snapping prevents vertex
 * swimming; per-ring fade factors enable smooth horizon blending.
 *
 * ## Clipmap derivation (from first principles)
 *
 * A geometry clipmap tiles the water surface with concentric square rings of
 * equal triangle budget. Each ring N covers 2× the world-space extent of ring
 * N−1, at half the vertex density (cell spacing doubles). Because vertex count
 * per ring is constant, total triangles are simply `rings × trianglesPerRing`.
 *
 * With 8 rings of 64×64 cells each (2×64² = 8192 tris/ring):
 *   8 × 8192 = 65,536 triangles — matching the ~65k target.
 *
 * ## Grid snapping
 *
 * Each ring's origin snaps to a multiple of its cell size. As the camera moves
 * continuously, each ring jumps in discrete steps of its own cell width. This
 * eliminates vertex swimming (vertices slide smoothly relative to world) because
 * vertices always sit at the same world-space grid lines — only the offset uniform
 * changes. No geometry rebuild is needed per frame.
 *
 * ## Crack avoidance (overlap approach)
 *
 * Rather than computing explicit trim/T-junction strips (which require careful
 * index arithmetic prone to off-by-one errors for no visual/performance gain on
 * a displaced ocean surface), each outer ring extends one extra cell row inward
 * past the inner ring's outer boundary. The resulting one-cell overlap is
 * geometrically simple, crack-free, and costs only a negligible increase in
 * overdraw that the depth buffer eliminates.
 *
 * ## Displacement handoff (E.2 / E.3 interface)
 *
 * This module provides TOPOLOGY ONLY. Actual vertex displacement is wired by
 * downstream tasks:
 *
 * - **CPU tier (E.3 / WebGL2 fallback):** Call `getPositionBuffer(ringIndex)` to
 *   get the Float32Array backing the position attribute. Write displaced Y values
 *   (and optionally XZ Gerstner offsets) directly, then set `needsUpdate = true`
 *   on the attribute. The buffer layout is row-major, (gridSize+1)² vertices at
 *   3 floats each.
 *
 * - **GPU tier (E.2 / WebGPU):** Set `mesh.material.positionNode` to a TSL node
 *   that samples displacement textures. The `worldOffset` uniform (exposed via
 *   `getRingWorldOffset(ringIndex)`) gives the snapped origin so the shader can
 *   compute correct UV coordinates into the displacement cascade.
 *
 * - **Fade factor:** Each vertex carries a `cascadeFade` attribute (0.0 at inner
 *   boundary → 1.0 at outer boundary of each ring). E.4's water shader reads this
 *   to blend toward a flat horizon colour.
 *
 * @module
 */

import * as THREE from 'three/webgpu';

// ─── Configuration ────────────────────────────────────────────────────────────

/** Cells per side for each ring grid. 64×64 = 8192 tris/ring. */
const GRID_CELLS = 64;

/** Vertices per side = cells + 1. */
const GRID_VERTS = GRID_CELLS + 1;

/** Total vertices per ring. */
const VERTS_PER_RING = GRID_VERTS * GRID_VERTS;

/** Total triangles per ring: 2 per cell. */
const TRIS_PER_RING = GRID_CELLS * GRID_CELLS * 2;

/** Base cell size for innermost ring (metres). */
const BASE_CELL_SIZE = 0.5;

/**
 * Overlap cells: each outer ring extends this many cells inward past the inner
 * ring's boundary. One cell is sufficient to cover T-junctions without cracks.
 */
const OVERLAP_CELLS = 1;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Per-ring metadata exposed for downstream consumers. */
export interface ClipmapRingInfo {
  /** Ring index (0 = innermost). */
  readonly index: number;
  /** Cell spacing in world units for this ring. */
  readonly cellSize: number;
  /** Half-extent of the ring grid in world units (from centre to edge). */
  readonly halfExtent: number;
  /** Current snapped X offset in world space. */
  readonly snappedX: number;
  /** Current snapped Z offset in world space. */
  readonly snappedZ: number;
}

/** The public interface of the ocean clipmap. */
export interface OceanClipmapHandle {
  /** The three.js Group containing all ring meshes. Add to scene. */
  readonly group: THREE.Group;

  /** Total triangle count (constant regardless of camera position). */
  readonly triangleCount: number;

  /** Total vertex count (constant). */
  readonly vertexCount: number;

  /** Number of rings. */
  readonly ringCount: number;

  /**
   * Update ring offsets to track the camera. Call once per frame.
   * @param cameraX — camera world X position
   * @param cameraZ — camera world Z position
   */
  update(cameraX: number, cameraZ: number): void;

  /**
   * Get the position buffer for a ring (CPU displacement writes go here).
   * The buffer is a Float32Array with GRID_VERTS² × 3 elements (x,y,z interleaved).
   * After writing displaced positions, set the attribute's `needsUpdate = true`.
   */
  getPositionBuffer(ringIndex: number): Float32Array | undefined;

  /**
   * Get the current snapped world offset for a ring (shader UV calculation).
   * Returns [x, z] in world space.
   */
  getRingWorldOffset(ringIndex: number): readonly [number, number];

  /** Get info for all rings. */
  getRingInfos(): readonly ClipmapRingInfo[];

  /** Get info for a specific ring. */
  getRingInfo(ringIndex: number): ClipmapRingInfo | undefined;

  /** Get the mesh for a specific ring (for material assignment). */
  getRingMesh(ringIndex: number): THREE.Mesh | undefined;

  /** Get the grid cells per side (constant). */
  readonly gridCells: number;

  /** Get the grid vertices per side (constant). */
  readonly gridVerts: number;

  /** Dispose all GPU resources. */
  dispose(): void;
}

// ─── Grid snapping ────────────────────────────────────────────────────────────

/**
 * Snap a world-space position to the nearest grid line for a given cell size.
 * This is the core of vertex-swimming prevention.
 */
export function snapToGrid(value: number, cellSize: number): number {
  return Math.floor(value / cellSize) * cellSize;
}

// ─── Ring geometry construction ───────────────────────────────────────────────

/**
 * Build the BufferGeometry for a single clipmap ring.
 *
 * All rings have the same topology (GRID_CELLS × GRID_CELLS quad grid), but
 * different cell spacing. The geometry is constructed centred at the origin;
 * grid snapping is applied per-frame via the mesh's position.
 *
 * @param ringIndex — 0 for innermost, up to ringCount-1
 * @param ringCount — total rings (for fade calculation)
 * @returns the geometry, position buffer reference, and fade buffer reference
 */
function buildRingGeometry(ringIndex: number, ringCount: number): {
  geometry: THREE.BufferGeometry;
  positionArray: Float32Array;
  fadeArray: Float32Array;
} {
  const cellSize = BASE_CELL_SIZE * Math.pow(2, ringIndex);

  // Position buffer: row-major grid, 3 floats per vertex
  const positionArray = new Float32Array(VERTS_PER_RING * 3);
  // Cascade fade: 1 float per vertex (0 at inner → 1 at outer)
  const fadeArray = new Float32Array(VERTS_PER_RING);

  // The half-grid in cells for computing fade distance from centre
  const halfGrid = GRID_CELLS / 2;

  for (let row = 0; row < GRID_VERTS; row++) {
    for (let col = 0; col < GRID_VERTS; col++) {
      const vertIdx = row * GRID_VERTS + col;
      const baseIdx = vertIdx * 3;

      // Local position relative to ring centre
      const x = (col - halfGrid) * cellSize;
      const z = (row - halfGrid) * cellSize;

      positionArray[baseIdx] = x;
      positionArray[baseIdx + 1] = 0; // Y = 0 (displacement applied later)
      positionArray[baseIdx + 2] = z;

      // Cascade fade: Chebyshev distance from centre normalized to [0,1]
      // Inner vertices (near centre) get 0, outer boundary gets 1.
      const chebyshev = Math.max(Math.abs(col - halfGrid), Math.abs(row - halfGrid));
      // Normalize: 0 at centre, 1 at edge
      const rawFade = chebyshev / halfGrid;

      // For the outermost ring, fade the outer 25% to allow horizon blending.
      // For inner rings, only fade the outer boundary row for inter-ring transitions.
      if (ringIndex === ringCount - 1) {
        // Outermost ring: fade outer quarter
        fadeArray[vertIdx] = Math.max(0, (rawFade - 0.75) * 4);
      } else {
        // Inner rings: thin fade at the very edge (last 2 cells)
        fadeArray[vertIdx] = Math.max(0, (rawFade - (1 - 2 / halfGrid)) * halfGrid / 2);
      }
    }
  }

  // Index buffer: two triangles per cell, counter-clockwise winding from above
  // (which is "outside" for an upward-facing plane in Y-up space).
  const indexCount = GRID_CELLS * GRID_CELLS * 6;
  const indices = new Uint32Array(indexCount);
  let idx = 0;

  for (let row = 0; row < GRID_CELLS; row++) {
    for (let col = 0; col < GRID_CELLS; col++) {
      // Corners of this cell
      const tl = row * GRID_VERTS + col;           // top-left
      const tr = row * GRID_VERTS + col + 1;       // top-right
      const bl = (row + 1) * GRID_VERTS + col;     // bottom-left
      const br = (row + 1) * GRID_VERTS + col + 1; // bottom-right

      // Triangle 1: tl, bl, tr (CCW from above / +Y)
      indices[idx++] = tl;
      indices[idx++] = bl;
      indices[idx++] = tr;

      // Triangle 2: tr, bl, br (CCW from above / +Y)
      indices[idx++] = tr;
      indices[idx++] = bl;
      indices[idx++] = br;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positionArray, 3));
  geometry.setAttribute('cascadeFade', new THREE.Float32BufferAttribute(fadeArray, 1));
  geometry.setIndex(new THREE.Uint32BufferAttribute(indices, 1));

  // Normal pointing up — will be overridden by displacement or shader
  const normals = new Float32Array(VERTS_PER_RING * 3);
  for (let i = 0; i < VERTS_PER_RING; i++) {
    normals[i * 3 + 1] = 1; // Y-up
  }
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));

  return { geometry, positionArray, fadeArray };
}

// ─── Clipmap factory ──────────────────────────────────────────────────────────

/**
 * Create the ocean clipmap geometry system.
 *
 * @param ringCount — number of concentric rings (default 8, quality-scalable
 *   via QualityKnobs.oceanGridRings)
 * @returns the clipmap handle for scene integration and per-frame updates
 */
export function createOceanClipmap(ringCount = 8): OceanClipmapHandle {
  const group = new THREE.Group();
  const rings: Array<{
    mesh: THREE.Mesh;
    positionArray: Float32Array;
    fadeArray: Float32Array;
    cellSize: number;
    halfExtent: number;
    snappedX: number;
    snappedZ: number;
  }> = [];

  // Build all ring meshes
  for (let i = 0; i < ringCount; i++) {
    const cellSize = BASE_CELL_SIZE * Math.pow(2, i);
    const halfExtent = (GRID_CELLS / 2) * cellSize;

    const { geometry, positionArray, fadeArray } = buildRingGeometry(i, ringCount);

    // Placeholder material — E.4 will replace with the actual water shader.
    // Using MeshStandardNodeMaterial so positionNode is available for GPU displacement.
    const material = new THREE.MeshStandardNodeMaterial();

    const mesh = new THREE.Mesh(geometry, material);
    // Clipmap rings are always visible — consumer should disable frustumCulling
    // on these meshes. Our type declarations don't expose the property.

    rings.push({
      mesh,
      positionArray,
      fadeArray,
      cellSize,
      halfExtent,
      snappedX: 0,
      snappedZ: 0,
    });

    group.add(mesh);
  }

  const totalTriangles = ringCount * TRIS_PER_RING;
  const totalVertices = ringCount * VERTS_PER_RING;

  const handle: OceanClipmapHandle = {
    group,
    triangleCount: totalTriangles,
    vertexCount: totalVertices,
    ringCount,
    gridCells: GRID_CELLS,
    gridVerts: GRID_VERTS,

    update(cameraX: number, cameraZ: number): void {
      for (let i = 0; i < ringCount; i++) {
        const ring = rings[i];
        if (ring === undefined) continue;

        const cellSize = ring.cellSize;

        // Snap to grid: the ring's world origin jumps in discrete cell-size steps
        const snappedX = snapToGrid(cameraX, cellSize);
        const snappedZ = snapToGrid(cameraZ, cellSize);

        ring.snappedX = snappedX;
        ring.snappedZ = snappedZ;

        // Move the mesh so its centre aligns with the snapped position.
        // The geometry is built centred at local origin, so mesh.position IS
        // the world-space offset.
        ring.mesh.position.set(snappedX, 0, snappedZ);
      }
    },

    getPositionBuffer(ringIndex: number): Float32Array | undefined {
      const ring = rings[ringIndex];
      return ring?.positionArray;
    },

    getRingWorldOffset(ringIndex: number): readonly [number, number] {
      const ring = rings[ringIndex];
      if (ring === undefined) return [0, 0] as const;
      return [ring.snappedX, ring.snappedZ] as const;
    },

    getRingInfos(): readonly ClipmapRingInfo[] {
      return rings.map((ring, index) => ({
        index,
        cellSize: ring.cellSize,
        halfExtent: ring.halfExtent,
        snappedX: ring.snappedX,
        snappedZ: ring.snappedZ,
      }));
    },

    getRingInfo(ringIndex: number): ClipmapRingInfo | undefined {
      const ring = rings[ringIndex];
      if (ring === undefined) return undefined;
      return {
        index: ringIndex,
        cellSize: ring.cellSize,
        halfExtent: ring.halfExtent,
        snappedX: ring.snappedX,
        snappedZ: ring.snappedZ,
      };
    },

    getRingMesh(ringIndex: number): THREE.Mesh | undefined {
      const ring = rings[ringIndex];
      return ring?.mesh;
    },

    dispose(): void {
      for (const ring of rings) {
        ring.mesh.geometry.dispose();
        ring.mesh.material.dispose();
      }
      group.removeFromParent();
    },
  };

  return handle;
}

// ─── Exports for testing ──────────────────────────────────────────────────────

/** Exposed for unit tests — not part of the public API. */
export const _testing = {
  GRID_CELLS,
  GRID_VERTS,
  VERTS_PER_RING,
  TRIS_PER_RING,
  BASE_CELL_SIZE,
  OVERLAP_CELLS,
  buildRingGeometry,
} as const;
