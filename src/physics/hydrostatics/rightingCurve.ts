/**
 * Righting curve computation: sweep heel angle from 0 to 90°+, recompute
 * the buoyancy centroid at each angle, and derive GZ (the righting arm) and
 * the righting moment.
 *
 * This makes capsize an emergent outcome: once the GZ curve goes negative
 * (around 120-130° for most keelboats, 70-90° for dinghies), the restoring
 * moment becomes an INVERTING moment and the boat goes over. No state flag
 * is set by hand — it happens because the geometry says it should.
 */

import type { CurvePoint, GeneratedMesh } from '@/types';
import {
  clipTriangleAgainstWaterline,
  getClippedTriangle,
  triangleSignedVolume,
} from './waterlineClip';

/**
 * Compute the righting curve for a hull mesh.
 *
 * For each heel angle, we rotate the mesh about the longitudinal axis (Z),
 * find the waterline that gives the correct displacement volume, compute
 * the centre of buoyancy, and derive GZ = horizontal distance between CoB
 * and the centre of gravity (projected onto the heeling plane).
 *
 * @param mesh - Hull mesh in hull-local coordinates
 * @param displacement - Target displacement volume in m³
 * @param centreOfGravityHeight - CoG height above the baseline, m
 * @param numAngles - Number of angles to sample (0 to maxAngle)
 * @param maxAngleDeg - Maximum heel angle in degrees (default 150)
 * @returns CurvePoint[] with x = heel in radians, y = GZ in metres
 */
export function computeRightingCurve(
  mesh: GeneratedMesh,
  displacement: number,
  centreOfGravityHeight: number,
  numAngles: number = 37,
  maxAngleDeg: number = 150,
): CurvePoint[] {
  const { positions, indices } = mesh;
  const curve: CurvePoint[] = [];
  const vertexCount = positions.length / 3;

  // Pre-allocate rotated vertex buffer
  const rotated = new Float32Array(positions.length);

  for (let ai = 0; ai <= numAngles; ai++) {
    const angleDeg = (ai / numAngles) * maxAngleDeg;
    const angle = angleDeg * (Math.PI / 180);
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    // Rotate all vertices about the Z axis (longitudinal axis, unchanged by heel)
    for (let v = 0; v < vertexCount; v++) {
      const x = positions[v * 3] ?? 0;
      const y = positions[v * 3 + 1] ?? 0;
      const z = positions[v * 3 + 2] ?? 0;

      // Rotation about Z: x' = x*cos - y*sin, y' = x*sin + y*cos
      rotated[v * 3] = x * cosA - y * sinA;
      rotated[v * 3 + 1] = x * sinA + y * cosA;
      rotated[v * 3 + 2] = z;
    }

    // Find the waterline that produces the target displacement volume.
    // Binary search between the hull's min and max Y in the rotated frame.
    let yMin = Infinity;
    let yMax = -Infinity;
    for (let v = 0; v < vertexCount; v++) {
      const y = rotated[v * 3 + 1] ?? 0;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }

    let wlLo = yMin;
    let wlHi = yMax;
    let waterline = (wlLo + wlHi) * 0.5;

    // Binary search for the correct waterline (15 iterations gives ~0.003% precision)
    for (let iter = 0; iter < 15; iter++) {
      waterline = (wlLo + wlHi) * 0.5;
      const vol = computeSubmergedVolumeRotated(rotated, indices, waterline);
      if (vol < displacement) {
        wlLo = waterline;
      } else {
        wlHi = waterline;
      }
    }

    // Compute the centre of buoyancy at this waterline and heel
    const cob = computeSubmergedCentroidRotated(rotated, indices, waterline);

    // GZ = horizontal distance between CoG and CoB in the heeling plane.
    // CoG position after rotation: (cogX_original*cos - cogY_original*sin, cogX_original*sin + cogY_original*cos)
    // For a symmetric hull, CoG is on the centreline: cogX_original = 0
    const cogXrotated = -centreOfGravityHeight * sinA;

    // GZ is positive when the restoring couple opposes the heel.
    // The buoyancy force at CoB and gravity at CoG form a couple whose arm
    // is the transverse separation. When heel is positive (rotation moves the
    // mast towards -X in this convention), the submerged volume shifts to -X,
    // moving CoB further than CoG for a stable hull. The restoring lever is
    // the amount by which CoG is OUTBOARD of CoB in the rotation direction.
    const gz = cogXrotated - cob.x;

    curve.push({ x: angle, y: gz });
  }

  return curve;
}

function computeSubmergedVolumeRotated(
  rotated: Float32Array,
  indices: Uint32Array,
  waterline: number,
): number {
  let volume = 0;

  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i];
    const i1 = indices[i + 1];
    const i2 = indices[i + 2];
    if (i0 === undefined || i1 === undefined || i2 === undefined) continue;

    const ax = rotated[i0 * 3] ?? 0;
    const ay = rotated[i0 * 3 + 1] ?? 0;
    const az = rotated[i0 * 3 + 2] ?? 0;
    const bx = rotated[i1 * 3] ?? 0;
    const by = rotated[i1 * 3 + 1] ?? 0;
    const bz = rotated[i1 * 3 + 2] ?? 0;
    const cx = rotated[i2 * 3] ?? 0;
    const cy = rotated[i2 * 3 + 1] ?? 0;
    const cz = rotated[i2 * 3 + 2] ?? 0;

    const count = clipTriangleAgainstWaterline(ax, ay, az, bx, by, bz, cx, cy, cz, waterline);

    for (let t = 0; t < count; t++) {
      const tri = getClippedTriangle(t);
      if (tri === undefined) continue;
      volume += triangleSignedVolume(
        tri.v0x, tri.v0y, tri.v0z,
        tri.v1x, tri.v1y, tri.v1z,
        tri.v2x, tri.v2y, tri.v2z,
      );
    }
  }

  return Math.abs(volume);
}

function computeSubmergedCentroidRotated(
  rotated: Float32Array,
  indices: Uint32Array,
  waterline: number,
): { x: number; y: number; z: number } {
  let totalVolume = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;

  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i];
    const i1 = indices[i + 1];
    const i2 = indices[i + 2];
    if (i0 === undefined || i1 === undefined || i2 === undefined) continue;

    const ax = rotated[i0 * 3] ?? 0;
    const ay = rotated[i0 * 3 + 1] ?? 0;
    const az = rotated[i0 * 3 + 2] ?? 0;
    const bx = rotated[i1 * 3] ?? 0;
    const by = rotated[i1 * 3 + 1] ?? 0;
    const bz = rotated[i1 * 3 + 2] ?? 0;
    const cx2 = rotated[i2 * 3] ?? 0;
    const cy2 = rotated[i2 * 3 + 1] ?? 0;
    const cz2 = rotated[i2 * 3 + 2] ?? 0;

    const count = clipTriangleAgainstWaterline(ax, ay, az, bx, by, bz, cx2, cy2, cz2, waterline);

    for (let t = 0; t < count; t++) {
      const tri = getClippedTriangle(t);
      if (tri === undefined) continue;

      const vol = triangleSignedVolume(
        tri.v0x, tri.v0y, tri.v0z,
        tri.v1x, tri.v1y, tri.v1z,
        tri.v2x, tri.v2y, tri.v2z,
      );

      // Centroid of the tetrahedron is at (v0 + v1 + v2) / 4
      const tetCx = (tri.v0x + tri.v1x + tri.v2x) * 0.25;
      const tetCy = (tri.v0y + tri.v1y + tri.v2y) * 0.25;
      const tetCz = (tri.v0z + tri.v1z + tri.v2z) * 0.25;

      totalVolume += vol;
      cx += vol * tetCx;
      cy += vol * tetCy;
      cz += vol * tetCz;
    }
  }

  if (Math.abs(totalVolume) < 1e-10) {
    return { x: 0, y: 0, z: 0 };
  }

  return { x: cx / totalVolume, y: cy / totalVolume, z: cz / totalVolume };
}
