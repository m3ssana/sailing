/**
 * Breakwater landmark generator — D.6.
 *
 * Produces a long, low linear harbour-protection structure with a trapezoidal
 * cross-section swept along a (possibly curved) path. Breakwaters are the
 * defining silhouette of harbour approaches — recognizable at 2+ km as a
 * low dark line across the water.
 *
 * Geometry: origin-centred in local space. The breakwater extends along X,
 * height along Y, width along Z.
 *
 * The cross-section is trapezoidal: wider at the base, narrower at the top,
 * modelling a concrete or rock-armoured breakwater slope.
 *
 * Closed-solid: YES — the swept trapezoidal tube is closed at both ends,
 * producing a watertight solid with positive volume.
 *
 * Engine-agnostic — no three.js.
 */

import type { GeneratedMesh, GeneratedModel, Generator, Seed, Vec3 } from '@/types';
import { computeBounds, computeNormals, gatherTransferables } from '../common/meshUtils';
import { createNoiseSource2D } from '../common/noise';

// ─── Params ──────────────────────────────────────────────────────────────────

/**
 * Parameters for the breakwater generator.
 *
 * | Param | Default | Description |
 * |---|---|---|
 * | length | 200 | Total length of the breakwater (metres) |
 * | height | 4 | Height above water (metres) |
 * | baseWidth | 12 | Width at the base |
 * | topWidth | 5 | Width at the top (crest) |
 * | curvature | 0 | Gentle curvature of the path (radians total bend) |
 * | segments | 32 | Longitudinal segments |
 * | roughness | 0.3 | Surface roughness perturbation (noise amplitude in metres) |
 */
export interface BreakwaterParams {
  length: number;
  height: number;
  baseWidth: number;
  topWidth: number;
  curvature: number;
  segments: number;
  roughness: number;
}

const DEFAULTS: BreakwaterParams = {
  length: 200,
  height: 4,
  baseWidth: 12,
  topWidth: 5,
  curvature: 0,
  segments: 32,
  roughness: 0.3,
};

function resolveParams(raw: Record<string, unknown>): BreakwaterParams {
  return {
    length: typeof raw['length'] === 'number' ? raw['length'] : DEFAULTS.length,
    height: typeof raw['height'] === 'number' ? raw['height'] : DEFAULTS.height,
    baseWidth: typeof raw['baseWidth'] === 'number' ? raw['baseWidth'] : DEFAULTS.baseWidth,
    topWidth: typeof raw['topWidth'] === 'number' ? raw['topWidth'] : DEFAULTS.topWidth,
    curvature: typeof raw['curvature'] === 'number' ? raw['curvature'] : DEFAULTS.curvature,
    segments: typeof raw['segments'] === 'number' ? raw['segments'] : DEFAULTS.segments,
    roughness: typeof raw['roughness'] === 'number' ? raw['roughness'] : DEFAULTS.roughness,
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Cross-section vertices for the trapezoidal profile.
 * Defined as offsets from the path centre: (lateral offset, vertical offset).
 * CCW when viewed from the +X direction (front of sweep).
 *
 * Profile shape (trapezoid):
 *       topWidth
 *      ┌────────┐   ← height
 *     /          \
 *    /            \
 *   └──────────────┘  ← Y=0
 *      baseWidth
 */

// ─── Generator ───────────────────────────────────────────────────────────────

export const BreakwaterGenerator: Generator<
  Record<string, unknown>,
  GeneratedModel
> = {
  id: 'breakwater',

  generate(raw: Record<string, unknown>, seed: Seed): GeneratedModel {
    const params = resolveParams(raw);
    const {
      length,
      height,
      baseWidth,
      topWidth,
      curvature,
      segments,
      roughness,
    } = params;

    const noise = createNoiseSource2D(seed);

    // ── Build the sweep path (possibly curved)
    const path: Vec3[] = [];
    const halfLength = length / 2;

    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const x = -halfLength + length * t;

      // Apply gentle curvature: path bends in XZ plane
      let z = 0;
      if (Math.abs(curvature) > 1e-6) {
        // Arc: z = R - R*cos(θ), where θ varies from -curvature/2 to +curvature/2
        const angle = (t - 0.5) * curvature;
        const radius = length / curvature;
        z = radius * (1 - Math.cos(angle));
      }

      path.push({ x, y: 0, z });
    }

    // ── Cross-section profile (trapezoidal)
    const halfBase = baseWidth / 2;
    const halfTop = topWidth / 2;

    // Profile points for one ring (CCW viewed from +X)
    // Bottom: flat, Top: narrower
    const profilePoints: Array<{ dz: number; dy: number }> = [
      { dz: -halfBase, dy: 0 },         // bottom-left
      { dz: halfBase, dy: 0 },          // bottom-right
      { dz: halfTop, dy: height },      // top-right
      { dz: -halfTop, dy: height },     // top-left
    ];

    const numProfile = profilePoints.length;
    const numStations = segments + 1;
    const bodyVerts = numStations * numProfile;
    const totalVerts = bodyVerts + 2; // +2 cap centres
    const bodyTris = segments * numProfile * 2;
    const capTris = numProfile * 2; // both caps as triangle fans
    const totalTris = bodyTris + capTris;

    const positions = new Float32Array(totalVerts * 3);
    const uvs = new Float32Array(totalVerts * 2);
    const indices = new Uint32Array(totalTris * 3);

    // ── Body vertices
    let vIdx = 0;
    let uvIdx = 0;

    for (let s = 0; s < numStations; s++) {
      const pt = path[s];
      if (pt === undefined) continue;
      const t = s / segments;

      for (let p = 0; p < numProfile; p++) {
        const pp = profilePoints[p];
        if (pp === undefined) continue;

        // Add noise perturbation for rocky appearance
        const noiseVal = noise.fbm(t * 10, p * 3.7 + seed * 0.001, 2) * roughness;

        positions[vIdx] = pt.x;
        positions[vIdx + 1] = pt.y + pp.dy + (pp.dy > 0 ? noiseVal : 0);
        positions[vIdx + 2] = pt.z + pp.dz + noiseVal * 0.5;
        vIdx += 3;

        uvs[uvIdx] = t;
        uvs[uvIdx + 1] = p / numProfile;
        uvIdx += 2;
      }
    }

    // ── Cap centre vertices
    const startCapIdx = bodyVerts;
    const endCapIdx = bodyVerts + 1;
    const p0 = path[0];
    const pEnd = path[segments];

    if (p0 !== undefined) {
      positions[startCapIdx * 3] = p0.x;
      positions[startCapIdx * 3 + 1] = p0.y + height * 0.5;
      positions[startCapIdx * 3 + 2] = p0.z;
      uvs[startCapIdx * 2] = 0;
      uvs[startCapIdx * 2 + 1] = 0.5;
    }
    if (pEnd !== undefined) {
      positions[endCapIdx * 3] = pEnd.x;
      positions[endCapIdx * 3 + 1] = pEnd.y + height * 0.5;
      positions[endCapIdx * 3 + 2] = pEnd.z;
      uvs[endCapIdx * 2] = 1;
      uvs[endCapIdx * 2 + 1] = 0.5;
    }

    // ── Body indices (quads between adjacent stations)
    let iIdx = 0;
    for (let s = 0; s < segments; s++) {
      for (let p = 0; p < numProfile; p++) {
        const nextP = (p + 1) % numProfile;
        const a = s * numProfile + p;
        const b = s * numProfile + nextP;
        const c = (s + 1) * numProfile + p;
        const d = (s + 1) * numProfile + nextP;

        // CCW winding viewed from outside
        indices[iIdx] = a;
        indices[iIdx + 1] = c;
        indices[iIdx + 2] = d;
        indices[iIdx + 3] = a;
        indices[iIdx + 4] = d;
        indices[iIdx + 5] = b;
        iIdx += 6;
      }
    }

    // ── Start cap (faces -X direction)
    // Body at station 0 exposes boundary half-edges in p→nextP direction
    // (from the (a,d,b) triangle with s=0: indices a→b = p→nextP).
    // Cap must provide nextP→p to close manifold.
    for (let p = 0; p < numProfile; p++) {
      const nextP = (p + 1) % numProfile;
      indices[iIdx] = startCapIdx;
      indices[iIdx + 1] = p;
      indices[iIdx + 2] = nextP;
      iIdx += 3;
    }

    // ── End cap (faces +X direction)
    // Body at last station exposes boundary half-edges in nextP→p direction
    // (from the (a,c,d) triangle with s=segments-1: the last ring edge is c→d = p→nextP,
    // but as viewed from the last ring, the exposed boundary goes nextP→p).
    // Cap must provide p→nextP to close manifold.
    const lastRingStart = segments * numProfile;
    for (let p = 0; p < numProfile; p++) {
      const nextP = (p + 1) % numProfile;
      indices[iIdx] = endCapIdx;
      indices[iIdx + 1] = lastRingStart + nextP;
      indices[iIdx + 2] = lastRingStart + p;
      iIdx += 3;
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
        length,
        height,
        triangleCount: totalTris,
      },
    };

    const model: GeneratedModel = {
      meshes: [mesh],
      groups: [
        { name: 'breakwater', start: 0, count: indices.length, materialId: 'concrete' },
      ],
      transferables: [],
    };
    model.transferables = gatherTransferables(model);
    return model;
  },
};
