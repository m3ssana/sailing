/**
 * Skyline landmark generator — D.6.
 *
 * Produces a cluster of building-like extruded prisms at varying heights,
 * creating a recognizable city skyline silhouette. Uses seeded noise for
 * height/footprint variation so the same seed always produces the same skyline.
 *
 * Geometry: origin-centred in local space. Buildings rise along +Y from Y=0.
 * The cluster extends along X and Z.
 *
 * Closed-solid: YES — each building is a closed extruded polygon with caps.
 * The merged mesh is technically a collection of closed solids, but
 * assertWatertight will fail on the merge (shared no edges between buildings).
 * Individual buildings ARE watertight.
 *
 * Engine-agnostic — no three.js.
 */

import type { GeneratedMesh, GeneratedModel, Generator, Seed, Vec2 } from '@/types';
import { extrudePolygon } from '../common/extrude';
import { chamferSize } from '../common/chamfer';
import { createNoiseSource2D } from '../common/noise';
import { computeBounds, gatherTransferables, mergeMeshes } from '../common/meshUtils';
import { createRandom } from '@core/math';

// ─── Params ──────────────────────────────────────────────────────────────────

/**
 * Parameters for the skyline generator.
 *
 * | Param | Default | Description |
 * |---|---|---|
 * | width | 400 | Total cluster width along X (metres) |
 * | depth | 100 | Total cluster depth along Z (metres) |
 * | numBuildings | 20 | Number of buildings in the cluster |
 * | minHeight | 20 | Minimum building height |
 * | maxHeight | 150 | Maximum building height |
 * | minFootprint | 15 | Minimum building footprint size |
 * | maxFootprint | 40 | Maximum building footprint size |
 * | heightBias | 0.6 | Bias toward taller buildings in the centre (0-1) |
 */
export interface SkylineParams {
  width: number;
  depth: number;
  numBuildings: number;
  minHeight: number;
  maxHeight: number;
  minFootprint: number;
  maxFootprint: number;
  heightBias: number;
}

const DEFAULTS: SkylineParams = {
  width: 400,
  depth: 100,
  numBuildings: 20,
  minHeight: 20,
  maxHeight: 150,
  minFootprint: 15,
  maxFootprint: 40,
  heightBias: 0.6,
};

function resolveParams(raw: Record<string, unknown>): SkylineParams {
  return {
    width: typeof raw['width'] === 'number' ? raw['width'] : DEFAULTS.width,
    depth: typeof raw['depth'] === 'number' ? raw['depth'] : DEFAULTS.depth,
    numBuildings: typeof raw['numBuildings'] === 'number' ? raw['numBuildings'] : DEFAULTS.numBuildings,
    minHeight: typeof raw['minHeight'] === 'number' ? raw['minHeight'] : DEFAULTS.minHeight,
    maxHeight: typeof raw['maxHeight'] === 'number' ? raw['maxHeight'] : DEFAULTS.maxHeight,
    minFootprint: typeof raw['minFootprint'] === 'number' ? raw['minFootprint'] : DEFAULTS.minFootprint,
    maxFootprint: typeof raw['maxFootprint'] === 'number' ? raw['maxFootprint'] : DEFAULTS.maxFootprint,
    heightBias: typeof raw['heightBias'] === 'number' ? raw['heightBias'] : DEFAULTS.heightBias,
  };
}

// ─── Geometry helpers ────────────────────────────────────────────────────────

/** Generate a rectangular footprint with optional chamfered corners. */
function rectangleFootprint(halfW: number, halfD: number): Vec2[] {
  return [
    { x: -halfW, y: -halfD },
    { x: halfW, y: -halfD },
    { x: halfW, y: halfD },
    { x: -halfW, y: halfD },
  ];
}

/** Translate a mesh in-place. */
function translateMesh(mesh: GeneratedMesh, dx: number, _dy: number, dz: number): void {
  for (let i = 0; i < mesh.positions.length; i += 3) {
    mesh.positions[i] = (mesh.positions[i] ?? 0) + dx;
    mesh.positions[i + 1] = (mesh.positions[i + 1] ?? 0) + _dy;
    mesh.positions[i + 2] = (mesh.positions[i + 2] ?? 0) + dz;
  }
}

// ─── Generator ───────────────────────────────────────────────────────────────

export const SkylineGenerator: Generator<
  Record<string, unknown>,
  GeneratedModel
> = {
  id: 'skyline',

  generate(raw: Record<string, unknown>, seed: Seed): GeneratedModel {
    const params = resolveParams(raw);
    const {
      width,
      depth,
      numBuildings,
      minHeight,
      maxHeight,
      minFootprint,
      maxFootprint,
      heightBias,
    } = params;

    const allMeshes: GeneratedMesh[] = [];
    const rng = createRandom(seed);
    const noise = createNoiseSource2D(seed);
    const heightRange = maxHeight - minHeight;
    const footprintRange = maxFootprint - minFootprint;

    for (let i = 0; i < numBuildings; i++) {
      // Position within cluster, seeded
      const px = (rng.next() - 0.5) * width;
      const pz = (rng.next() - 0.5) * depth;

      // Height uses noise for spatial coherence (taller in centre)
      const distFromCentre = Math.sqrt(
        (px / (width * 0.5)) ** 2 + (pz / (depth * 0.5)) ** 2,
      );
      const centreBias = Math.max(0, 1 - distFromCentre) * heightBias;
      const noiseHeight = noise.fbm(px * 0.01, pz * 0.01, 3);
      const heightT = Math.max(0, Math.min(1, (noiseHeight + 1) * 0.5 + centreBias * 0.5));
      const buildingHeight = minHeight + heightT * heightRange;

      // Footprint size
      const footprintSize = minFootprint + rng.next() * footprintRange;
      const footprintAspect = 0.6 + rng.next() * 0.8; // 0.6 to 1.4 aspect ratio
      const halfW = (footprintSize * footprintAspect) / 2;
      const halfD = footprintSize / (2 * footprintAspect);

      const outline = rectangleFootprint(halfW, halfD);
      const bevel = chamferSize(buildingHeight);
      const building = extrudePolygon(outline, buildingHeight, { bevel, bevelSegments: 1 });

      translateMesh(building, px, 0, pz);
      allMeshes.push(building);
    }

    // ── Merge
    const merged = mergeMeshes(allMeshes);
    const bounds = computeBounds(merged.positions);
    const finalMesh: GeneratedMesh = {
      ...merged,
      bounds,
      meta: {
        numBuildings,
        maxHeight,
        triangleCount: merged.indices.length / 3,
      },
    };

    const model: GeneratedModel = {
      meshes: [finalMesh],
      groups: [
        { name: 'skyline', start: 0, count: merged.indices.length, materialId: 'concrete' },
      ],
      transferables: [],
    };
    model.transferables = gatherTransferables(model);
    return model;
  },
};
