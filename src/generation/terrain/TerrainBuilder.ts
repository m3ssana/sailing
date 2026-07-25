/**
 * Terrain builder — D.5 generator.
 *
 * Coastline polyline rasterization, signed-distance field, relief from noise,
 * bathymetry from depth contours; emits render mesh, collision heightfield, and
 * depth field.
 *
 * Convention: coastline polylines use signed-area orientation derived
 * defensively from each closed ring, never assuming caller intent.
 * In the Vec2 coordinate system (x = east, y = south/+Z), the shoelace
 * formula yields:
 * - Negative signed area → outer ring → land inside (vertices traverse
 *   the boundary with the enclosed area on the left, visually CCW on screen).
 * - Positive signed area → hole ring → water inside (e.g. lagoon).
 *
 * World space: Y-up, +X east, +Z south. TerrainParams.bounds are in the
 * horizontal XZ plane (Vec2 x/y maps to world X/Z). Heightfield values become
 * the Y coordinate of the mesh.
 *
 * Complexity notes:
 * - Land mask: O(N × P) where N = grid cells, P = total coastline vertices
 *   (ray-cast point-in-polygon for each cell, summed over all closed rings).
 * - Shore distance: O(N × S) where S = total coastline segments (brute-force
 *   nearest-segment search). Acceptable for typical resolutions ≤ 512.
 *
 * Engine-agnostic — no three.js.
 */

import type {
  GeneratedMesh,
  GeneratedTerrain,
  Generator,
  Polyline,
  Seed,
  TerrainParams,
  Vec2,
} from '@/types';
import { computeBounds, computeNormals } from '../common/meshUtils';
import { createNoiseSource2D } from '../common/noise';
import { hashCombine } from '@core/math';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute signed area of a 2D polygon ring using the shoelace formula.
 *
 * In standard math convention (Y-up), positive = CCW, negative = CW.
 * However, our Vec2 maps x → world X (east), y → world Z (south), which is
 * a Y-down visual convention. In this system:
 * - Negative signed area = vertices wind CCW visually (outer ring, land inside)
 * - Positive signed area = vertices wind CW visually (hole ring, water inside)
 *
 * The builder uses the sign directly: negative → outer, positive → hole.
 */
function signedArea2D(points: readonly Vec2[]): number {
  let sum = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const curr = points[i];
    const next = points[(i + 1) % n];
    if (curr === undefined || next === undefined) continue;
    sum += (curr.x * next.y - next.x * curr.y);
  }
  return sum * 0.5;
}

/**
 * Point-in-polygon test using ray casting (even-odd rule).
 * Casts a ray in the +X direction from the test point.
 */
function pointInPolygon(px: number, py: number, ring: readonly Vec2[]): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const vi = ring[i];
    const vj = ring[j];
    if (vi === undefined || vj === undefined) continue;
    if (
      (vi.y > py) !== (vj.y > py) &&
      px < ((vj.x - vi.x) * (py - vi.y)) / (vj.y - vi.y) + vi.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Minimum distance from point (px, py) to a line segment (ax, ay)-(bx, by).
 */
function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    // Degenerate segment (point)
    const ex = px - ax;
    const ey = py - ay;
    return Math.sqrt(ex * ex + ey * ey);
  }
  // Project onto segment, clamped to [0, 1]
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const closestX = ax + t * dx;
  const closestY = ay + t * dy;
  const ex = px - closestX;
  const ey = py - closestY;
  return Math.sqrt(ex * ex + ey * ey);
}

/**
 * Compute minimum distance from a point to all segments of a polyline.
 */
function distanceToPolyline(px: number, py: number, polyline: Polyline): number {
  const pts = polyline.points;
  let minDist = Infinity;
  const segCount = polyline.closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (a === undefined || b === undefined) continue;
    const d = distanceToSegment(px, py, a.x, a.y, b.x, b.y);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

// ─── Core builder ────────────────────────────────────────────────────────────

/**
 * Build the land mask from closed coastline polylines.
 * Uses signed area to determine orientation:
 * - CCW (positive area) → outer ring → land inside, so points inside toggle ON.
 * - CW (negative area) → hole ring → water inside, so points inside toggle OFF.
 *
 * Multiple outer rings are supported (archipelago), and holes subtract land.
 */
function buildLandMask(
  resolution: number,
  bounds: { min: Vec2; max: Vec2 },
  coastlines: readonly Polyline[],
): Uint8Array {
  const mask = new Uint8Array(resolution * resolution);
  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;

  // Separate coastlines into outer rings (land) and holes (water)
  // In Y-south coordinate space: negative signed area = outer ring (land inside),
  // positive signed area = hole ring (water inside, e.g. lagoon).
  const outerRings: Vec2[][] = [];
  const holeRings: Vec2[][] = [];

  for (const coast of coastlines) {
    if (!coast.closed) continue; // Open coastlines don't define enclosed regions
    const area = signedArea2D(coast.points);
    if (area < 0) {
      outerRings.push(coast.points);
    } else if (area > 0) {
      holeRings.push(coast.points);
    }
    // area === 0 → degenerate, skip
  }

  for (let row = 0; row < resolution; row++) {
    for (let col = 0; col < resolution; col++) {
      // Map grid cell to world coordinates (cell centres)
      const px = bounds.min.x + (col + 0.5) * (width / resolution);
      const py = bounds.min.y + (row + 0.5) * (height / resolution);

      // Check if inside any outer ring
      let isLand = false;
      for (const ring of outerRings) {
        if (pointInPolygon(px, py, ring)) {
          isLand = true;
          break;
        }
      }

      // Subtract holes
      if (isLand) {
        for (const hole of holeRings) {
          if (pointInPolygon(px, py, hole)) {
            isLand = false;
            break;
          }
        }
      }

      mask[row * resolution + col] = isLand ? 1 : 0;
    }
  }

  return mask;
}

/**
 * Build the signed shore distance field.
 * Positive = on land (distance from shore inland).
 * Negative = offshore (distance from shore seaward).
 *
 * Uses brute-force nearest-segment distance to all coastline polylines.
 * Complexity: O(resolution² × totalSegments). Acceptable for typical resolutions.
 */
function buildShoreDistance(
  resolution: number,
  bounds: { min: Vec2; max: Vec2 },
  coastlines: readonly Polyline[],
  landMask: Uint8Array,
): Float32Array {
  const field = new Float32Array(resolution * resolution);
  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;

  for (let row = 0; row < resolution; row++) {
    for (let col = 0; col < resolution; col++) {
      const px = bounds.min.x + (col + 0.5) * (width / resolution);
      const py = bounds.min.y + (row + 0.5) * (height / resolution);

      let minDist = Infinity;
      for (const coast of coastlines) {
        if (coast.points.length < 2) continue;
        const d = distanceToPolyline(px, py, coast);
        if (d < minDist) minDist = d;
      }

      const idx = row * resolution + col;
      const isLand = (landMask[idx] ?? 0) === 1;
      // Positive inland, negative offshore (per interface: "Negative offshore")
      field[idx] = isLand ? minDist : -minDist;
    }
  }

  return field;
}

/**
 * Generate relief (land elevation) using seeded noise.
 * - 'flat': low amplitude, few octaves
 * - 'hilly': moderate amplitude, domain warp for rolling hills
 * - 'mountainous': high amplitude, ridged noise for peaks
 *
 * Elevation is scaled by maxElevation and modulated by distance from shore
 * (elevation rises inland, beach at the shore).
 */
function buildRelief(
  resolution: number,
  bounds: { min: Vec2; max: Vec2 },
  landMask: Uint8Array,
  shoreDistance: Float32Array,
  relief: 'flat' | 'hilly' | 'mountainous',
  maxElevation: number,
  seed: number,
): Float32Array {
  const elevations = new Float32Array(resolution * resolution);
  const noise = createNoiseSource2D(seed);
  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;

  // Scale factor for noise sampling (maps world coords to ~0..1 range for noise)
  const noiseScale = 1 / Math.max(width, height);

  // Relief profile parameters
  let octaves: number;
  let amplitude: number;
  let useRidged = false;

  switch (relief) {
    case 'flat':
      octaves = 3;
      amplitude = 0.3;
      break;
    case 'hilly':
      octaves = 5;
      amplitude = 0.7;
      break;
    case 'mountainous':
      octaves = 6;
      amplitude = 1.0;
      useRidged = true;
      break;
  }

  // Compute a reasonable beach transition distance based on terrain extent
  const beachWidth = Math.max(width, height) * 0.05; // 5% of terrain extent

  for (let row = 0; row < resolution; row++) {
    for (let col = 0; col < resolution; col++) {
      const idx = row * resolution + col;
      if ((landMask[idx] ?? 0) === 0) continue; // Skip water cells

      const px = bounds.min.x + (col + 0.5) * (width / resolution);
      const py = bounds.min.y + (row + 0.5) * (height / resolution);

      const nx = px * noiseScale;
      const ny = py * noiseScale;

      // Sample noise for elevation
      let noiseValue: number;
      if (useRidged) {
        noiseValue = noise.ridged(nx * 3, ny * 3, octaves, 2.1, 0.5);
      } else {
        noiseValue = noise.fbm(nx * 4, ny * 4, octaves, 2.0, 0.5);
        // fbm returns roughly [-1, 1], remap to [0, 1]
        noiseValue = (noiseValue + 1) * 0.5;
      }

      // Shore distance falloff: elevation rises from 0 at shore, approaching
      // full height further inland. Uses a smooth hermite ramp.
      const dist = shoreDistance[idx] ?? 0;
      const shoreRamp = Math.min(1, Math.max(0, dist / beachWidth));
      // Smoothstep for gradual beach transition
      const smoothRamp = shoreRamp * shoreRamp * (3 - 2 * shoreRamp);

      elevations[idx] = noiseValue * amplitude * maxElevation * smoothRamp;
    }
  }

  return elevations;
}

/**
 * Build bathymetry from depth contours.
 *
 * For each water cell, compute a weighted blend of depth contour values using
 * inverse-distance weighting from the nearest point on each contour polyline.
 * This is blended with a shelving falloff near the shore so depth transitions
 * smoothly from 0 at the coastline to the interpolated depth offshore.
 *
 * If no depth contours are provided, uses a simple distance-based falloff to
 * maxDepth.
 */
function buildBathymetry(
  resolution: number,
  bounds: { min: Vec2; max: Vec2 },
  landMask: Uint8Array,
  shoreDistance: Float32Array,
  depthContours: readonly Polyline[],
  maxDepth: number,
  seed: number,
): Float32Array {
  const depths = new Float32Array(resolution * resolution);
  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;
  const extent = Math.max(width, height);

  // Noise for subtle bathymetric variation
  const noise = createNoiseSource2D(hashCombine(seed, 9973));
  const noiseScale = 1 / extent;

  // Beach shelving width — depth transitions gradually from shore
  const shelvingWidth = extent * 0.15;

  for (let row = 0; row < resolution; row++) {
    for (let col = 0; col < resolution; col++) {
      const idx = row * resolution + col;
      if ((landMask[idx] ?? 0) === 1) continue; // Skip land cells

      const px = bounds.min.x + (col + 0.5) * (width / resolution);
      const py = bounds.min.y + (row + 0.5) * (height / resolution);

      // Distance offshore (positive value = how far from shore)
      const offshoreDist = Math.abs(shoreDistance[idx] ?? 0);

      // Shelving ramp: smoothly transitions from 0 (at shore) to 1 (deep water)
      const shelvingT = Math.min(1, offshoreDist / shelvingWidth);
      const shelvingRamp = shelvingT * shelvingT * (3 - 2 * shelvingT);

      // Interpolate depth from contours if available
      let contourDepth: number;

      if (depthContours.length > 0) {
        // Inverse-distance weighted interpolation from depth contours, with a
        // monotonicity fix (audit finding): plain unbounded IDW lets a point
        // beyond the outermost (deepest) contour be pulled back toward a
        // CLOSER-BY-ABSOLUTE-DISTANCE but shallower contour, producing a
        // shallow/deepen/shallow artifact past the last contour instead of a
        // monotonic deepening. Fix: find the single nearest contour by
        // distance-to-polyline. If that nearest contour is also the deepest
        // (or the point's offshore distance exceeds all contour distances so
        // there is nothing further out to blend toward), extrapolate by
        // holding at/beyond the deepest contour's depth rather than
        // re-blending with shallower ones. Otherwise, IDW-blend normally
        // between the (at most) two contours the point sits between.
        let nearestDist = Infinity;
        let nearestDepth = maxDepth;
        let deepestContourDepth = -Infinity;
        let deepestContourDist = 0;
        let weightSum = 0;
        let depthSum = 0;

        for (const contour of depthContours) {
          const contourDepthVal = contour.depth;
          if (contourDepthVal === undefined) continue;
          if (contour.points.length < 2) continue;

          const dist = distanceToPolyline(px, py, contour);
          const weight = 1 / (dist * dist + 1);
          weightSum += weight;
          depthSum += weight * contourDepthVal;

          if (dist < nearestDist) {
            nearestDist = dist;
            nearestDepth = contourDepthVal;
          }
          if (contourDepthVal > deepestContourDepth) {
            deepestContourDepth = contourDepthVal;
            deepestContourDist = dist;
          }
        }

        if (weightSum === 0) {
          contourDepth = maxDepth;
        } else if (nearestDepth === deepestContourDepth && nearestDist <= deepestContourDist) {
          // The nearest contour IS the deepest one, and we are at or beyond
          // it (not between it and something shallower) — extrapolate by
          // holding at the deepest contour's depth rather than blending back
          // toward a shallower one that happens to be numerically closer.
          contourDepth = deepestContourDepth;
        } else {
          contourDepth = depthSum / weightSum;
        }
      } else {
        // No contours — fall off linearly to maxDepth based on distance
        contourDepth = maxDepth * Math.min(1, offshoreDist / (extent * 0.5));
      }

      // Clamp to maxDepth
      contourDepth = Math.min(contourDepth, maxDepth);

      // Add subtle noise variation (±10% of local depth)
      const noiseVal = noise.fbm(px * noiseScale * 5, py * noiseScale * 5, 3, 2.0, 0.5);
      const noiseModulation = 1 + noiseVal * 0.1;

      // Apply shelving ramp so depth is zero at shore and transitions smoothly
      depths[idx] = -(contourDepth * shelvingRamp * noiseModulation);
    }
  }

  return depths;
}

/**
 * Build the combined heightfield: positive values on land, negative in water.
 */
function buildHeightfield(
  resolution: number,
  landRelief: Float32Array,
  bathymetry: Float32Array,
): Float32Array {
  const heightfield = new Float32Array(resolution * resolution);
  for (let i = 0; i < heightfield.length; i++) {
    const land = landRelief[i] ?? 0;
    const water = bathymetry[i] ?? 0;
    // land relief is positive (elevation), bathymetry is negative (depth)
    heightfield[i] = land + water;
  }
  return heightfield;
}

/**
 * Build a regular grid mesh from the heightfield.
 *
 * World space Y-up: grid X/Z from bounds, Y from heightfield.
 * Winding: CCW from above (looking down in -Y direction) so normals point up.
 *
 * For a Y-up terrain viewed from above, the upward normal is produced by:
 * cross(T_z, T_x) where T_x and T_z are the tangent vectors along the grid axes.
 * This gives CCW winding in the order: (r,c), (r+1,c), (r,c+1) for one triangle
 * and (r,c+1), (r+1,c), (r+1,c+1) for the other.
 *
 * We verify the winding by ensuring computeNormals produces predominantly
 * upward (+Y) normals for flat terrain.
 */
function buildTerrainMesh(
  resolution: number,
  bounds: { min: Vec2; max: Vec2 },
  heightfield: Float32Array,
): GeneratedMesh {
  const vertCount = resolution * resolution;
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);

  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;

  // Fill vertex positions and UVs
  for (let row = 0; row < resolution; row++) {
    for (let col = 0; col < resolution; col++) {
      const idx = row * resolution + col;
      const vIdx = idx * 3;
      const uIdx = idx * 2;

      // World X from bounds min.x, world Z from bounds min.y (Vec2 y → world Z)
      const worldX = bounds.min.x + (col + 0.5) * (width / resolution);
      const worldZ = bounds.min.y + (row + 0.5) * (height / resolution);
      const worldY = heightfield[idx] ?? 0;

      positions[vIdx] = worldX;
      positions[vIdx + 1] = worldY;
      positions[vIdx + 2] = worldZ;

      uvs[uIdx] = col / (resolution - 1);
      uvs[uIdx + 1] = row / (resolution - 1);
    }
  }

  // Build indices: two triangles per grid cell
  // Winding: CCW from above (+Y looking down)
  // For cell at (row, col):
  //   TL = row * resolution + col
  //   TR = row * resolution + col + 1
  //   BL = (row + 1) * resolution + col
  //   BR = (row + 1) * resolution + col + 1
  //
  // Triangle 1 (upper-left): TL, BL, TR  → CCW from above
  // Triangle 2 (lower-right): TR, BL, BR → CCW from above
  //
  // Verification: For flat terrain (all Y equal), edge vectors:
  //   TL→BL = (0, 0, dz), TL→TR = (dx, 0, 0)
  //   Normal = (TL→BL) × (TL→TR) = (0*0 - dz*0, dz*dx - 0*0, 0*0 - 0*dx)
  //          = (0, dz*dx, 0) → +Y ✓ (since dx > 0 and dz > 0)
  const cellCount = (resolution - 1) * (resolution - 1);
  const indices = new Uint32Array(cellCount * 6);
  let iIdx = 0;

  for (let row = 0; row < resolution - 1; row++) {
    for (let col = 0; col < resolution - 1; col++) {
      const tl = row * resolution + col;
      const tr = row * resolution + col + 1;
      const bl = (row + 1) * resolution + col;
      const br = (row + 1) * resolution + col + 1;

      // Triangle 1: TL, BL, TR
      indices[iIdx++] = tl;
      indices[iIdx++] = bl;
      indices[iIdx++] = tr;

      // Triangle 2: TR, BL, BR
      indices[iIdx++] = tr;
      indices[iIdx++] = bl;
      indices[iIdx++] = br;
    }
  }

  const normals = computeNormals(positions, indices);
  const meshBounds = computeBounds(positions);

  return {
    positions,
    normals,
    uvs,
    indices,
    bounds: meshBounds,
    meta: {
      vertexCount: vertCount,
      triangleCount: cellCount * 2,
    },
  };
}

// ─── Generator ───────────────────────────────────────────────────────────────

export const TerrainBuilder: Generator<TerrainParams, GeneratedTerrain> = {
  id: 'terrain',

  generate(params: TerrainParams, seed: Seed): GeneratedTerrain {
    const { bounds, coastlines, depthContours, relief, maxElevation, maxDepth, resolution } = params;

    // 1. Build land mask from closed coastline rings
    const landMask = buildLandMask(resolution, bounds, coastlines);

    // 2. Compute signed shore distance field
    const shoreDistance = buildShoreDistance(resolution, bounds, coastlines, landMask);

    // 3. Generate land relief using seeded noise
    const landRelief = buildRelief(
      resolution, bounds, landMask, shoreDistance,
      relief, maxElevation, seed,
    );

    // 4. Generate bathymetry from depth contours
    const bathymetry = buildBathymetry(
      resolution, bounds, landMask, shoreDistance,
      depthContours, maxDepth, seed,
    );

    // 5. Combine into signed heightfield
    const heightfield = buildHeightfield(resolution, landRelief, bathymetry);

    // 6. Build terrain render mesh
    const mesh = buildTerrainMesh(resolution, bounds, heightfield);

    // 7. Gather transferable buffers
    const transferables: ArrayBufferLike[] = [
      mesh.positions.buffer,
      mesh.normals.buffer,
      mesh.uvs.buffer,
      mesh.indices.buffer,
      heightfield.buffer,
      landMask.buffer,
      shoreDistance.buffer,
    ];

    return {
      mesh,
      heightfield,
      resolution,
      bounds,
      landMask,
      shoreDistance,
      transferables,
    };
  },
};


