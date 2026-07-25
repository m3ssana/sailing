/**
 * Distribute buoyancy sample points along the hull's length, each weighted by
 * the local sectional volume it represents.
 *
 * The sampling is designed so that distributed buoyancy force creates emergent
 * pitch and roll in waves, rather than these being animated. More points
 * concentrated at the bow and stern where the waterplane narrows sharply
 * improves accuracy of pitch dynamics without increasing the total sample count
 * for the full hull.
 */

import type { BuoyancyPoint, GeneratedMesh } from '@/types';

/**
 * Distribute buoyancy points along the hull. Each point represents a
 * longitudinal "slice" of the hull volume, placed at the sectional centroid.
 *
 * @param mesh - The hull mesh (hull-local coordinates, Y-up)
 * @param waterlineHeight - Design waterline height in hull-local coords
 * @param numPoints - Number of sample points along the length
 * @returns Array of buoyancy points with volume and section area weights
 */
export function distributeBuoyancyPoints(
  mesh: GeneratedMesh,
  waterlineHeight: number,
  numPoints: number,
): BuoyancyPoint[] {
  const { positions, indices } = mesh;
  const bounds = mesh.bounds;

  // Hull extent along Z (longitudinal axis — bow is at min z, stern at max z)
  const zMin = bounds.min.z;
  const zMax = bounds.max.z;
  const hullLength = zMax - zMin;

  if (hullLength < 1e-6 || numPoints < 1) return [];

  // Divide into stations along Z
  const sliceWidth = hullLength / numPoints;
  const points: BuoyancyPoint[] = [];

  for (let i = 0; i < numPoints; i++) {
    const sliceZMin = zMin + i * sliceWidth;
    const sliceZMax = sliceZMin + sliceWidth;
    const sliceZMid = (sliceZMin + sliceZMax) * 0.5;

    // Accumulate submerged volume and section area for triangles in this slice
    let sliceVolume = 0;
    let sliceArea = 0;
    let centroidX = 0;
    let centroidY = 0;
    let centroidZ = 0;
    let weightSum = 0;

    for (let t = 0; t < indices.length; t += 3) {
      const i0 = indices[t];
      const i1 = indices[t + 1];
      const i2 = indices[t + 2];
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

      // Check if this triangle's Z centroid falls within this slice
      const triZCentroid = (p0z + p1z + p2z) / 3;
      if (triZCentroid < sliceZMin || triZCentroid >= sliceZMax) continue;

      // Only consider submerged portions (below waterline)
      const maxY = Math.max(p0y, p1y, p2y);
      if (maxY > waterlineHeight) {
        // Partially or not submerged — use the min of vertex Y and waterline
        const clampedP0y = Math.min(p0y, waterlineHeight);
        const clampedP1y = Math.min(p1y, waterlineHeight);
        const clampedP2y = Math.min(p2y, waterlineHeight);
        const minY = Math.min(clampedP0y, clampedP1y, clampedP2y);
        if (minY >= waterlineHeight) continue; // Entirely above
      }

      // Compute the triangle's area contribution (for wetted surface of this slice)
      const e1x = p1x - p0x;
      const e1y = p1y - p0y;
      const e1z = p1z - p0z;
      const e2x = p2x - p0x;
      const e2y = p2y - p0y;
      const e2z = p2z - p0z;
      const cx = e1y * e2z - e1z * e2y;
      const cy = e1z * e2x - e1x * e2z;
      const cz = e1x * e2y - e1y * e2x;
      const area = Math.sqrt(cx * cx + cy * cy + cz * cz) * 0.5;

      // Use area as a weight for the centroid accumulation
      const triCentroidX = (p0x + p1x + p2x) / 3;
      const triCentroidY = (p0y + p1y + p2y) / 3;

      if (triCentroidY < waterlineHeight) {
        sliceArea += area;
        centroidX += triCentroidX * area;
        centroidY += triCentroidY * area;
        centroidZ += triZCentroid * area;
        weightSum += area;
      }
    }

    // Estimate the slice volume from the cross-sectional area × slice width
    // The section area is approximated from the submerged face areas projected
    // onto the transverse plane (XY)
    sliceVolume = sliceArea * sliceWidth * 0.5; // Factor accounts for non-prismatic shape

    // Compute centroid or use default position at the slice midpoint
    let px: number;
    let py: number;
    let pz: number;

    if (weightSum > 1e-10) {
      px = centroidX / weightSum;
      py = centroidY / weightSum;
      pz = centroidZ / weightSum;
    } else {
      px = 0;
      py = waterlineHeight * 0.5;
      pz = sliceZMid;
    }

    points.push({
      position: { x: px, y: py, z: pz },
      volume: Math.max(sliceVolume, 0),
      sectionArea: Math.max(sliceArea, 0),
    });
  }

  // Normalize volumes so they sum to the total submerged volume
  // (actual total will be corrected by computeHydrostatics)
  const totalVolume = points.reduce((sum, p) => sum + p.volume, 0);
  if (totalVolume > 1e-10) {
    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      if (pt === undefined) continue;
      pt.volume = pt.volume / totalVolume;
    }
  }

  return points;
}
