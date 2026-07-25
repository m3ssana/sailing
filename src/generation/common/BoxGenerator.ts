/**
 * Trivial box generator — the reference implementation proving the generation
 * harness works end to end.
 *
 * Generates a watertight, consistently-wound box mesh with analytic volume
 * equal to width × height × depth. This is the acceptance criterion for the
 * generation harness (Phase 0.6): computeVolume(box) === w*h*d.
 *
 * Uses 8 shared vertices so the mesh is topologically watertight (every edge
 * shared by exactly 2 triangles). This is necessary for the divergence theorem
 * volume calculation to work correctly.
 *
 * Engine-agnostic — no three.js.
 */

import type { GeneratedMesh, GeneratedModel, Generator, Seed } from '@/types';
import { computeBounds, computeNormals, gatherTransferables } from './meshUtils';

export interface BoxParams {
  width: number;
  height: number;
  depth: number;
}

/**
 * Generates an axis-aligned box centred at the origin.
 *
 * 8 shared vertices, 12 triangles (2 per face), counter-clockwise winding
 * when viewed from outside. UVs are a simple mapping per vertex.
 *
 * The seed parameter is accepted for interface compliance but ignored — a box
 * is fully deterministic from its dimensions alone.
 *
 * Vertex layout (Y-up, right-handed):
 *
 *       6--------7
 *      /|       /|
 *     4--------5 |
 *     | |      | |
 *     | 2------|-3
 *     |/       |/
 *     0--------1
 *
 *  0: (-hw, -hh, +hd)   front-bottom-left
 *  1: (+hw, -hh, +hd)   front-bottom-right
 *  2: (-hw, -hh, -hd)   back-bottom-left
 *  3: (+hw, -hh, -hd)   back-bottom-right
 *  4: (-hw, +hh, +hd)   front-top-left
 *  5: (+hw, +hh, +hd)   front-top-right
 *  6: (-hw, +hh, -hd)   back-top-left
 *  7: (+hw, +hh, -hd)   back-top-right
 */
export const BoxGenerator: Generator<BoxParams, GeneratedModel> = {
  id: 'box',

  generate(params: BoxParams, _seed: Seed): GeneratedModel {
    const { width, height, depth } = params;
    const hw = width / 2;
    const hh = height / 2;
    const hd = depth / 2;

    // 8 shared vertices
    const positions = new Float32Array([
      -hw, -hh, hd, // 0: front-bottom-left
      hw, -hh, hd, // 1: front-bottom-right
      -hw, -hh, -hd, // 2: back-bottom-left
      hw, -hh, -hd, // 3: back-bottom-right
      -hw, hh, hd, // 4: front-top-left
      hw, hh, hd, // 5: front-top-right
      -hw, hh, -hd, // 6: back-top-left
      hw, hh, -hd, // 7: back-top-right
    ]);

    // 12 triangles (2 per face), counter-clockwise when viewed from outside.
    // The sign of the cross product determines the normal direction:
    // for CCW winding from outside, the normal points outward.
    const indices = new Uint32Array([
      // Front face (+Z): 0, 1, 5, 4 → CCW from outside (looking in -Z direction)
      0, 1, 5,
      0, 5, 4,
      // Back face (-Z): 3, 2, 6, 7 → CCW from outside (looking in +Z direction)
      3, 2, 6,
      3, 6, 7,
      // Top face (+Y): 4, 5, 7, 6 → CCW from outside (looking in -Y direction)
      4, 5, 7,
      4, 7, 6,
      // Bottom face (-Y): 2, 3, 1, 0 → CCW from outside (looking in +Y direction)
      2, 3, 1,
      2, 1, 0,
      // Right face (+X): 1, 3, 7, 5 → CCW from outside (looking in -X direction)
      1, 3, 7,
      1, 7, 5,
      // Left face (-X): 2, 0, 4, 6 → CCW from outside (looking in +X direction)
      2, 0, 4,
      2, 4, 6,
    ]);

    // UVs: simple per-vertex mapping (not per-face since vertices are shared)
    const uvs = new Float32Array([
      0, 0, // 0
      1, 0, // 1
      0, 0, // 2
      1, 0, // 3
      0, 1, // 4
      1, 1, // 5
      0, 1, // 6
      1, 1, // 7
    ]);

    const normals = computeNormals(positions, indices);
    const bounds = computeBounds(positions);

    const mesh: GeneratedMesh = {
      positions,
      normals,
      uvs,
      indices,
      bounds,
      meta: {
        volume: width * height * depth,
        surfaceArea: 2 * (width * height + height * depth + width * depth),
      },
    };

    const model: GeneratedModel = {
      meshes: [mesh],
      groups: [{ name: 'box', start: 0, count: indices.length, materialId: 'default' }],
      transferables: [],
    };

    model.transferables = gatherTransferables(model);
    return model;
  },
};
