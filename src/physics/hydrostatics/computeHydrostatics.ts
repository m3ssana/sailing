/**
 * Compute hydrostatic properties from a generated hull mesh.
 *
 * THIS IS THE KEYSTONE: every value is derived from geometry, never authored.
 * Change a station curve in the hull definition and both the rendered shape
 * and the buoyancy, displacement, righting behaviour, and drag all change
 * together. This eliminates the classic simulator bug where a boat looks like
 * one thing and behaves like another.
 *
 * The computation uses the divergence theorem with waterline-clipped triangles
 * for volume and centroid, triangle-area sums for wetted surface, and a
 * waterline-plane intersection for waterplane area and LCF.
 */

import type { GeneratedMesh, Hydrostatics, Vec3 } from '@/types';
import { PHYSICS_CONSTANTS } from '@/types';
import {
  clipTriangleAgainstWaterline,
  getClippedTriangle,
  triangleSignedVolume,
  triangleArea,
} from './waterlineClip';
import { distributeBuoyancyPoints } from './buoyancyPoints';
import { computeRightingCurve } from './rightingCurve';

/**
 * Compute all hydrostatic properties from a hull mesh.
 *
 * @param mesh - The hull mesh in hull-local coordinates (Y-up, Z-longitudinal)
 * @param waterlineHeight - Design waterline height in hull-local coords
 * @param waterDensity - Water density, kg/m³ (defaults to seawater)
 * @returns The complete Hydrostatics interface
 */
export function computeHydrostatics(
  mesh: GeneratedMesh,
  waterlineHeight: number,
  waterDensity: number = PHYSICS_CONSTANTS.WATER_DENSITY,
): Hydrostatics {
  const { positions, indices } = mesh;

  // ── Submerged volume and centre of buoyancy ─────────────────────────────────
  let displacedVolume = 0;
  let cobX = 0;
  let cobY = 0;
  let cobZ = 0;

  // ── Wetted surface area ─────────────────────────────────────────────────────
  let wettedSurface = 0;

  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i];
    const i1 = indices[i + 1];
    const i2 = indices[i + 2];
    if (i0 === undefined || i1 === undefined || i2 === undefined) continue;

    const ax = positions[i0 * 3] ?? 0;
    const ay = positions[i0 * 3 + 1] ?? 0;
    const az = positions[i0 * 3 + 2] ?? 0;
    const bx = positions[i1 * 3] ?? 0;
    const by = positions[i1 * 3 + 1] ?? 0;
    const bz = positions[i1 * 3 + 2] ?? 0;
    const cx = positions[i2 * 3] ?? 0;
    const cy = positions[i2 * 3 + 1] ?? 0;
    const cz = positions[i2 * 3 + 2] ?? 0;

    const count = clipTriangleAgainstWaterline(ax, ay, az, bx, by, bz, cx, cy, cz, waterlineHeight);

    for (let t = 0; t < count; t++) {
      const tri = getClippedTriangle(t);
      if (tri === undefined) continue;

      // Volume contribution via divergence theorem
      const vol = triangleSignedVolume(
        tri.v0x, tri.v0y, tri.v0z,
        tri.v1x, tri.v1y, tri.v1z,
        tri.v2x, tri.v2y, tri.v2z,
      );
      displacedVolume += vol;

      // Volume centroid contribution (weighted by tetrahedron volume)
      cobX += vol * (tri.v0x + tri.v1x + tri.v2x) * 0.25;
      cobY += vol * (tri.v0y + tri.v1y + tri.v2y) * 0.25;
      cobZ += vol * (tri.v0z + tri.v1z + tri.v2z) * 0.25;

      // Wetted surface area of the submerged portion
      wettedSurface += triangleArea(
        tri.v0x, tri.v0y, tri.v0z,
        tri.v1x, tri.v1y, tri.v1z,
        tri.v2x, tri.v2y, tri.v2z,
      );
    }
  }

  // Take absolute value — winding direction determines sign
  displacedVolume = Math.abs(displacedVolume);

  const centreOfBuoyancy: Vec3 =
    displacedVolume > 1e-10
      ? {
          x: cobX / displacedVolume,
          y: cobY / displacedVolume,
          z: cobZ / displacedVolume,
        }
      : { x: 0, y: 0, z: 0 };

  // ── Waterplane area and longitudinal centre of flotation ────────────────────
  // Computed by finding the intersection of the mesh with the waterline plane.
  // We compute it from the hull's bounding box cross-sections at the waterline.
  const { waterplaneArea, centreOfFlotation, waterlineLength, waterlineBeam } =
    computeWaterplaneProperties(mesh, waterlineHeight);

  // ── Buoyancy sample points ──────────────────────────────────────────────────
  const numPoints = 12; // Enough for good pitch/roll resolution
  const buoyancyPoints = distributeBuoyancyPoints(mesh, waterlineHeight, numPoints);

  // Scale point volumes so they sum to actual displaced volume
  const totalWeight = buoyancyPoints.reduce((s, p) => s + p.volume, 0);
  if (totalWeight > 1e-10) {
    for (let i = 0; i < buoyancyPoints.length; i++) {
      const pt = buoyancyPoints[i];
      if (pt === undefined) continue;
      pt.volume = (pt.volume / totalWeight) * displacedVolume;
    }
  }

  // ── Righting curve ──────────────────────────────────────────────────────────
  // Assume CoG is at the CoB height (conservative; will be overridden by BoatSpec)
  const cogHeight = centreOfBuoyancy.y + 0.1;
  const rightingCurve = computeRightingCurve(mesh, displacedVolume, cogHeight, 36, 150);

  // ── Displacement mass ───────────────────────────────────────────────────────
  const displacement = displacedVolume * waterDensity;

  return {
    displacedVolume,
    displacement,
    wettedSurface,
    waterplaneArea,
    centreOfBuoyancy,
    centreOfFlotation,
    buoyancyPoints,
    rightingCurve,
    waterlineLength,
    waterlineBeam,
  };
}

/**
 * Compute waterplane properties by scanning the mesh for vertices near the waterline.
 * The waterplane is the horizontal slice of the hull at the waterline height.
 */
function computeWaterplaneProperties(
  mesh: GeneratedMesh,
  waterlineHeight: number,
): {
  waterplaneArea: number;
  centreOfFlotation: number;
  waterlineLength: number;
  waterlineBeam: number;
} {
  const { positions, indices } = mesh;

  // Find edges that cross the waterline and compute their intersection points
  const waterlinePoints: Array<{ x: number; z: number }> = [];

  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i];
    const i1 = indices[i + 1];
    const i2 = indices[i + 2];
    if (i0 === undefined || i1 === undefined || i2 === undefined) continue;

    const verts = [
      { x: positions[i0 * 3] ?? 0, y: positions[i0 * 3 + 1] ?? 0, z: positions[i0 * 3 + 2] ?? 0 },
      { x: positions[i1 * 3] ?? 0, y: positions[i1 * 3 + 1] ?? 0, z: positions[i1 * 3 + 2] ?? 0 },
      { x: positions[i2 * 3] ?? 0, y: positions[i2 * 3 + 1] ?? 0, z: positions[i2 * 3 + 2] ?? 0 },
    ];

    // Check each edge for waterline crossing
    for (let e = 0; e < 3; e++) {
      const v0 = verts[e];
      const v1 = verts[(e + 1) % 3];
      if (v0 === undefined || v1 === undefined) continue;

      if ((v0.y - waterlineHeight) * (v1.y - waterlineHeight) < 0) {
        // Edge crosses the waterline
        const t = (waterlineHeight - v0.y) / (v1.y - v0.y);
        waterlinePoints.push({
          x: v0.x + t * (v1.x - v0.x),
          z: v0.z + t * (v1.z - v0.z),
        });
      }
    }
  }

  if (waterlinePoints.length < 2) {
    return { waterplaneArea: 0, centreOfFlotation: 0, waterlineLength: 0, waterlineBeam: 0 };
  }

  // Compute bounding box of the waterplane
  let xMin = Infinity;
  let xMax = -Infinity;
  let zMin = Infinity;
  let zMax = -Infinity;

  for (let i = 0; i < waterlinePoints.length; i++) {
    const p = waterlinePoints[i];
    if (p === undefined) continue;
    if (p.x < xMin) xMin = p.x;
    if (p.x > xMax) xMax = p.x;
    if (p.z < zMin) zMin = p.z;
    if (p.z > zMax) zMax = p.z;
  }

  const waterlineLength = zMax - zMin;
  const waterlineBeam = xMax - xMin;

  // Approximate waterplane area using the trapezoidal rule along the length.
  // Sort points by Z, then for each Z-slice compute the beam.
  const numSlices = 20;
  const sliceWidth = waterlineLength / numSlices;
  let area = 0;
  let momentZ = 0;

  for (let s = 0; s < numSlices; s++) {
    const sliceZ = zMin + (s + 0.5) * sliceWidth;
    const sliceZLo = sliceZ - sliceWidth * 0.5;
    const sliceZHi = sliceZ + sliceWidth * 0.5;

    // Find the beam at this Z position
    let localXMin = Infinity;
    let localXMax = -Infinity;

    for (let i = 0; i < waterlinePoints.length; i++) {
      const p = waterlinePoints[i];
      if (p === undefined) continue;
      if (p.z >= sliceZLo && p.z < sliceZHi) {
        if (p.x < localXMin) localXMin = p.x;
        if (p.x > localXMax) localXMax = p.x;
      }
    }

    if (localXMin < localXMax) {
      const beam = localXMax - localXMin;
      const sliceArea = beam * sliceWidth;
      area += sliceArea;
      momentZ += sliceArea * sliceZ;
    }
  }

  const centreOfFlotation = area > 1e-10 ? momentZ / area : (zMin + zMax) * 0.5;

  return { waterplaneArea: area, centreOfFlotation, waterlineLength, waterlineBeam };
}
