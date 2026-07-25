/**
 * Ridge/plateau background landmark generator — D.6.
 *
 * Produces a background hill/mountain ridge silhouette. Uses seeded noise to
 * perturb a ridge profile, then builds a strip mesh (heightfield-like) for the
 * ridge face visible from water. This is purely background scenery — a visual
 * silhouette at 2+ km, not a walkable terrain (that's D.5's TerrainBuilder).
 *
 * Geometry: origin-centred. Ridge extends along X axis, height along Y, depth
 * along Z. The mesh is a one-sided strip (front face toward +Z) — an open
 * surface by design, since only the silhouette profile matters.
 *
 * Closed-solid: NO — this is an open surface (visible from one side only, like
 * a billboard with depth). Watertightness assertions should NOT be applied.
 *
 * Engine-agnostic — no three.js.
 */

import type { GeneratedMesh, GeneratedModel, Generator, Seed } from '@/types';
import { createNoiseSource2D } from '../common/noise';
import { computeBounds, computeNormals, gatherTransferables } from '../common/meshUtils';

// ─── Params ──────────────────────────────────────────────────────────────────

/**
 * Parameters for the ridge/plateau generator.
 *
 * | Param | Default | Description |
 * |---|---|---|
 * | width | 2000 | Horizontal extent of the ridge (metres) |
 * | maxHeight | 300 | Maximum peak height |
 * | minHeight | 50 | Base height of the ridge |
 * | depth | 100 | Depth (Z thickness) of the ridge mesh |
 * | segments | 64 | Number of horizontal segments |
 * | depthSegments | 4 | Number of depth (Z) segments |
 * | noiseScale | 0.003 | Noise frequency (lower = broader features) |
 * | octaves | 4 | Noise octaves for ridge profile |
 * | ridged | true | Use ridged noise (sharper peaks) vs smooth fbm |
 */
export interface RidgePlateauParams {
  width: number;
  maxHeight: number;
  minHeight: number;
  depth: number;
  segments: number;
  depthSegments: number;
  noiseScale: number;
  octaves: number;
  ridged: boolean;
}

const DEFAULTS: RidgePlateauParams = {
  width: 2000,
  maxHeight: 300,
  minHeight: 50,
  depth: 100,
  segments: 64,
  depthSegments: 4,
  noiseScale: 0.003,
  octaves: 4,
  ridged: true,
};

function resolveParams(raw: Record<string, unknown>): RidgePlateauParams {
  return {
    width: typeof raw['width'] === 'number' ? raw['width'] : DEFAULTS.width,
    maxHeight: typeof raw['maxHeight'] === 'number' ? raw['maxHeight'] : DEFAULTS.maxHeight,
    minHeight: typeof raw['minHeight'] === 'number' ? raw['minHeight'] : DEFAULTS.minHeight,
    depth: typeof raw['depth'] === 'number' ? raw['depth'] : DEFAULTS.depth,
    segments: typeof raw['segments'] === 'number' ? raw['segments'] : DEFAULTS.segments,
    depthSegments: typeof raw['depthSegments'] === 'number' ? raw['depthSegments'] : DEFAULTS.depthSegments,
    noiseScale: typeof raw['noiseScale'] === 'number' ? raw['noiseScale'] : DEFAULTS.noiseScale,
    octaves: typeof raw['octaves'] === 'number' ? raw['octaves'] : DEFAULTS.octaves,
    ridged: typeof raw['ridged'] === 'boolean' ? raw['ridged'] : DEFAULTS.ridged,
  };
}

// ─── Generator ───────────────────────────────────────────────────────────────

export const RidgePlateauGenerator: Generator<
  Record<string, unknown>,
  GeneratedModel
> = {
  id: 'ridgePlateau',

  generate(raw: Record<string, unknown>, seed: Seed): GeneratedModel {
    const params = resolveParams(raw);
    const {
      width,
      maxHeight,
      minHeight,
      depth,
      segments,
      depthSegments,
      noiseScale,
      octaves,
      ridged,
    } = params;

    const noise = createNoiseSource2D(seed);
    const heightRange = maxHeight - minHeight;

    // Generate height profile along X using seeded noise
    const heights: number[] = [];
    for (let i = 0; i <= segments; i++) {
      const x = (i / segments - 0.5) * width;
      const noiseVal = ridged
        ? noise.ridged(x * noiseScale, seed * 0.01, octaves)
        : noise.fbm(x * noiseScale, seed * 0.01, octaves);
      // Map noise [0,1] range to [minHeight, maxHeight]
      const h = minHeight + noiseVal * heightRange;
      heights.push(h);
    }

    // Build a strip mesh: (segments+1) columns × (depthSegments+1) rows
    const cols = segments + 1;
    const rows = depthSegments + 1;
    const totalVerts = cols * rows;
    const totalTris = segments * depthSegments * 2;

    const positions = new Float32Array(totalVerts * 3);
    const uvs = new Float32Array(totalVerts * 2);
    const indices = new Uint32Array(totalTris * 3);

    // ── Vertices: front face slopes from full height at top to 0 at bottom
    let vIdx = 0;
    let uvIdx = 0;
    for (let row = 0; row < rows; row++) {
      const rowT = row / depthSegments; // 0 = front (bottom), 1 = back (top ridge)
      const z = -depth * 0.5 + depth * rowT;

      for (let col = 0; col < cols; col++) {
        const colT = col / segments;
        const x = (colT - 0.5) * width;
        const colHeight = heights[col] ?? minHeight;

        // Height increases from 0 at front-bottom to full at back-top
        const y = colHeight * rowT;

        positions[vIdx] = x;
        positions[vIdx + 1] = y;
        positions[vIdx + 2] = z;
        vIdx += 3;

        uvs[uvIdx] = colT;
        uvs[uvIdx + 1] = rowT;
        uvIdx += 2;
      }
    }

    // ── Indices: quads as two triangles, CCW from front (+Z facing direction)
    let iIdx = 0;
    for (let row = 0; row < depthSegments; row++) {
      for (let col = 0; col < segments; col++) {
        const a = row * cols + col;
        const b = row * cols + col + 1;
        const c = (row + 1) * cols + col;
        const d = (row + 1) * cols + col + 1;

        // CCW winding viewed from +Z (front face)
        indices[iIdx] = a;
        indices[iIdx + 1] = c;
        indices[iIdx + 2] = d;
        indices[iIdx + 3] = a;
        indices[iIdx + 4] = d;
        indices[iIdx + 5] = b;
        iIdx += 6;
      }
    }

    const normals = computeNormals(positions, indices);
    const bounds = computeBounds(positions);

    const mesh: GeneratedMesh = {
      positions,
      normals,
      uvs,
      indices,
      bounds,
      meta: {
        width,
        maxHeight,
        triangleCount: totalTris,
      },
    };

    const model: GeneratedModel = {
      meshes: [mesh],
      groups: [
        { name: 'ridge', start: 0, count: indices.length, materialId: 'terrain' },
      ],
      transferables: [],
    };
    model.transferables = gatherTransferables(model);
    return model;
  },
};
