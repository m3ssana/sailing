/**
 * Swept geometry — tubes and ribbons along 3D paths.
 *
 * Uses parallel-transport (Bishop) frames rather than Frenet frames. Frenet
 * frames rotate 180° at inflection points where curvature crosses zero — on a
 * mast with even mild S-curvature, that produces a visible twist seam. Parallel
 * transport propagates the frame along the path with minimal rotation, avoiding
 * the discontinuity entirely.
 *
 * Engine-agnostic — no three.js.
 */

import type { GeneratedMesh, Vec3 } from '@/types';
import { computeBounds, computeNormals } from './meshUtils';

// ─── Parallel-transport frame computation ────────────────────────────────────

interface Frame {
  tangent: Vec3;
  normal: Vec3;
  binormal: Vec3;
}

/**
 * Compute parallel-transport (Bishop) frames along a 3D polyline.
 *
 * Algorithm: start with an arbitrary initial normal perpendicular to the first
 * tangent, then propagate along the path by rotating each frame minimally to
 * align with the next tangent. "Minimally" means rotating around the axis
 * perpendicular to both consecutive tangents — which is exactly the cross
 * product, normalised.
 */
function computeParallelTransportFrames(path: readonly Vec3[]): Frame[] {
  const n = path.length;
  if (n < 2) return [];

  // Compute tangents at each path point
  const tangents: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    let tx: number, ty: number, tz: number;
    if (i === 0) {
      const curr = path[0];
      const next = path[1];
      if (curr === undefined || next === undefined) {
        tangents.push({ x: 0, y: 0, z: 1 });
        continue;
      }
      tx = next.x - curr.x;
      ty = next.y - curr.y;
      tz = next.z - curr.z;
    } else if (i === n - 1) {
      const prev = path[i - 1];
      const curr = path[i];
      if (prev === undefined || curr === undefined) {
        tangents.push({ x: 0, y: 0, z: 1 });
        continue;
      }
      tx = curr.x - prev.x;
      ty = curr.y - prev.y;
      tz = curr.z - prev.z;
    } else {
      const prev = path[i - 1];
      const next = path[i + 1];
      if (prev === undefined || next === undefined) {
        tangents.push({ x: 0, y: 0, z: 1 });
        continue;
      }
      tx = next.x - prev.x;
      ty = next.y - prev.y;
      tz = next.z - prev.z;
    }

    const len = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (len < 1e-12) {
      tangents.push({ x: 0, y: 0, z: 1 });
    } else {
      tangents.push({ x: tx / len, y: ty / len, z: tz / len });
    }
  }

  // Choose initial normal perpendicular to the first tangent.
  // Pick the world axis least parallel to the tangent and cross with it.
  const t0 = tangents[0];
  if (t0 === undefined) return [];

  let initNormal: Vec3;
  const absX = Math.abs(t0.x);
  const absY = Math.abs(t0.y);
  const absZ = Math.abs(t0.z);

  // The axis with the smallest dot product gives the best cross product magnitude
  let refX: number, refY: number, refZ: number;
  if (absX <= absY && absX <= absZ) {
    refX = 1;
    refY = 0;
    refZ = 0;
  } else if (absY <= absZ) {
    refX = 0;
    refY = 1;
    refZ = 0;
  } else {
    refX = 0;
    refY = 0;
    refZ = 1;
  }

  // cross(tangent, ref) → initial normal direction
  let nx = t0.y * refZ - t0.z * refY;
  let ny = t0.z * refX - t0.x * refZ;
  let nz = t0.x * refY - t0.y * refX;
  let nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (nLen < 1e-12) {
    initNormal = { x: 0, y: 1, z: 0 };
  } else {
    initNormal = { x: nx / nLen, y: ny / nLen, z: nz / nLen };
  }

  // Compute binormal = tangent × normal
  const b0x = t0.y * initNormal.z - t0.z * initNormal.y;
  const b0y = t0.z * initNormal.x - t0.x * initNormal.z;
  const b0z = t0.x * initNormal.y - t0.y * initNormal.x;

  const frames: Frame[] = [
    {
      tangent: { x: t0.x, y: t0.y, z: t0.z },
      normal: { x: initNormal.x, y: initNormal.y, z: initNormal.z },
      binormal: { x: b0x, y: b0y, z: b0z },
    },
  ];

  // Propagate by rotating the previous normal to be perpendicular to the
  // current tangent, using the minimum rotation (parallel transport).
  for (let i = 1; i < n; i++) {
    const prevFrame = frames[i - 1];
    const tPrev = tangents[i - 1];
    const tCurr = tangents[i];

    if (prevFrame === undefined || tPrev === undefined || tCurr === undefined) {
      frames.push({
        tangent: { x: 0, y: 0, z: 1 },
        normal: { x: 1, y: 0, z: 0 },
        binormal: { x: 0, y: 1, z: 0 },
      });
      continue;
    }

    // Rotation axis = cross(tPrev, tCurr)
    const ax = tPrev.y * tCurr.z - tPrev.z * tCurr.y;
    const ay = tPrev.z * tCurr.x - tPrev.x * tCurr.z;
    const az = tPrev.x * tCurr.y - tPrev.y * tCurr.x;
    const sinAngle = Math.sqrt(ax * ax + ay * ay + az * az);
    const cosAngle = tPrev.x * tCurr.x + tPrev.y * tCurr.y + tPrev.z * tCurr.z;

    let curNormal: Vec3;

    if (sinAngle < 1e-10) {
      // Tangents are (nearly) parallel — no rotation needed
      curNormal = {
        x: prevFrame.normal.x,
        y: prevFrame.normal.y,
        z: prevFrame.normal.z,
      };
    } else {
      // Rodrigues' rotation: rotate prevNormal around the axis by the angle
      const invSin = 1 / sinAngle;
      const ux = ax * invSin;
      const uy = ay * invSin;
      const uz = az * invSin;
      const angle = Math.atan2(sinAngle, cosAngle);
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const oneMinusC = 1 - c;

      const pn = prevFrame.normal;
      // Rodrigues' formula: v' = v*cos(θ) + (u×v)*sin(θ) + u*(u·v)*(1-cos(θ))
      const dotUV = ux * pn.x + uy * pn.y + uz * pn.z;
      const crossX = uy * pn.z - uz * pn.y;
      const crossY = uz * pn.x - ux * pn.z;
      const crossZ = ux * pn.y - uy * pn.x;

      curNormal = {
        x: pn.x * c + crossX * s + ux * dotUV * oneMinusC,
        y: pn.y * c + crossY * s + uy * dotUV * oneMinusC,
        z: pn.z * c + crossZ * s + uz * dotUV * oneMinusC,
      };
    }

    // Re-orthogonalise to prevent drift over many segments.
    // binormal = tangent × normal, then normal = binormal × tangent
    const bx = tCurr.y * curNormal.z - tCurr.z * curNormal.y;
    const by = tCurr.z * curNormal.x - tCurr.x * curNormal.z;
    const bz = tCurr.x * curNormal.y - tCurr.y * curNormal.x;
    nLen = Math.sqrt(bx * bx + by * by + bz * bz);
    const bNorm =
      nLen < 1e-12
        ? { x: 0, y: 1, z: 0 }
        : { x: bx / nLen, y: by / nLen, z: bz / nLen };

    // normal = binormal × tangent
    nx = bNorm.y * tCurr.z - bNorm.z * tCurr.y;
    ny = bNorm.z * tCurr.x - bNorm.x * tCurr.z;
    nz = bNorm.x * tCurr.y - bNorm.y * tCurr.x;

    frames.push({
      tangent: { x: tCurr.x, y: tCurr.y, z: tCurr.z },
      normal: { x: nx, y: ny, z: nz },
      binormal: { x: bNorm.x, y: bNorm.y, z: bNorm.z },
    });
  }

  return frames;
}

// ─── Swept tube ──────────────────────────────────────────────────────────────

/**
 * Generate a tube mesh swept along a 3D polyline with per-station radius.
 *
 * Used for tapered masts, booms, spreaders. The radial cross-section is always
 * a regular polygon (circle approximation) with `radialSegments` sides.
 */
export function sweepTube(
  path: readonly Vec3[],
  radiusFn: (t: number) => number,
  radialSegments: number,
): GeneratedMesh {
  if (path.length < 2) {
    throw new Error(`sweepTube requires at least 2 path points, got ${path.length}`);
  }
  if (radialSegments < 3) {
    throw new Error(`sweepTube requires at least 3 radial segments, got ${radialSegments}`);
  }

  const frames = computeParallelTransportFrames(path);
  const n = path.length;

  // Vertices: n stations × radialSegments around each, plus 2 cap centre vertices
  const bodyVerts = n * radialSegments;
  const totalVerts = bodyVerts + 2; // +2 for cap centres
  const bodyQuads = (n - 1) * radialSegments;
  const bodyTris = bodyQuads * 2;
  const capTris = radialSegments * 2; // start cap + end cap
  const totalTris = bodyTris + capTris;

  const positions = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const indices = new Uint32Array(totalTris * 3);

  // ─── Body vertices
  let vIdx = 0;
  let uvIdx = 0;

  for (let s = 0; s < n; s++) {
    const pathPt = path[s];
    const frame = frames[s];
    if (pathPt === undefined || frame === undefined) continue;

    const t = n > 1 ? s / (n - 1) : 0;
    const radius = radiusFn(t);

    for (let r = 0; r < radialSegments; r++) {
      const angle = (r / radialSegments) * Math.PI * 2;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);

      // Position = path + radius * (cos * normal + sin * binormal)
      positions[vIdx] = pathPt.x + radius * (cosA * frame.normal.x + sinA * frame.binormal.x);
      positions[vIdx + 1] = pathPt.y + radius * (cosA * frame.normal.y + sinA * frame.binormal.y);
      positions[vIdx + 2] = pathPt.z + radius * (cosA * frame.normal.z + sinA * frame.binormal.z);
      vIdx += 3;

      uvs[uvIdx] = r / radialSegments;
      uvs[uvIdx + 1] = t;
      uvIdx += 2;
    }
  }

  // ─── Cap centre vertices
  const startCapIdx = bodyVerts;
  const endCapIdx = bodyVerts + 1;
  const p0 = path[0];
  const pn = path[n - 1];
  if (p0 !== undefined) {
    positions[startCapIdx * 3] = p0.x;
    positions[startCapIdx * 3 + 1] = p0.y;
    positions[startCapIdx * 3 + 2] = p0.z;
    uvs[startCapIdx * 2] = 0.5;
    uvs[startCapIdx * 2 + 1] = 0;
  }
  if (pn !== undefined) {
    positions[endCapIdx * 3] = pn.x;
    positions[endCapIdx * 3 + 1] = pn.y;
    positions[endCapIdx * 3 + 2] = pn.z;
    uvs[endCapIdx * 2] = 0.5;
    uvs[endCapIdx * 2 + 1] = 1;
  }

  // ─── Body indices
  let iIdx = 0;
  for (let s = 0; s < n - 1; s++) {
    for (let r = 0; r < radialSegments; r++) {
      const nextR = (r + 1) % radialSegments;
      const a = s * radialSegments + r;
      const b = s * radialSegments + nextR;
      const c = (s + 1) * radialSegments + r;
      const d = (s + 1) * radialSegments + nextR;

      // Counter-clockwise winding viewed from OUTSIDE the solid, yielding
      // positive signed volume under the divergence-theorem integral in
      // computeVolume. Matches lofting.ts quad convention: (a,d,c), (a,b,d).
      indices[iIdx] = a;
      indices[iIdx + 1] = d;
      indices[iIdx + 2] = c;
      indices[iIdx + 3] = a;
      indices[iIdx + 4] = b;
      indices[iIdx + 5] = d;
      iIdx += 6;
    }
  }

  // ─── Start cap (faces backward along the path)
  // Body exposes half-edge r→nextR on ring 0 (from triangle (a,b,d)).
  // Cap must provide the opposite half-edge nextR→r to close the manifold.
  for (let r = 0; r < radialSegments; r++) {
    const nextR = (r + 1) % radialSegments;
    indices[iIdx] = startCapIdx;
    indices[iIdx + 1] = nextR;
    indices[iIdx + 2] = r;
    iIdx += 3;
  }

  // ─── End cap (faces forward along the path)
  // Body exposes half-edge lastRing+nextR→lastRing+r (from triangle (a,d,c)).
  // Cap must provide lastRing+r→lastRing+nextR to close the manifold.
  const lastRingStart = (n - 1) * radialSegments;
  for (let r = 0; r < radialSegments; r++) {
    const nextR = (r + 1) % radialSegments;
    indices[iIdx] = endCapIdx;
    indices[iIdx + 1] = lastRingStart + r;
    indices[iIdx + 2] = lastRingStart + nextR;
    iIdx += 3;
  }

  const normals = computeNormals(positions, indices);
  const bounds = computeBounds(positions);

  return {
    positions,
    normals,
    uvs,
    indices,
    bounds,
    meta: {},
  };
}

// ─── Ribbon ──────────────────────────────────────────────────────────────────

/**
 * Generate a flat ribbon along a 3D path. Used for rigging lines and cables.
 *
 * The ribbon has two edges offset from the path by ±width/2 along the frame's
 * normal. This produces a camera-independent flat strip that catches highlights.
 */
export function ribbon(
  path: readonly Vec3[],
  widthFn: (t: number) => number,
): GeneratedMesh {
  if (path.length < 2) {
    throw new Error(`ribbon requires at least 2 path points, got ${path.length}`);
  }

  const frames = computeParallelTransportFrames(path);
  const n = path.length;

  // Two vertices per station (left and right of centre)
  const totalVerts = n * 2;
  const totalTris = (n - 1) * 2;

  const positions = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const indices = new Uint32Array(totalTris * 3);

  let vIdx = 0;
  let uvIdx = 0;

  for (let s = 0; s < n; s++) {
    const pathPt = path[s];
    const frame = frames[s];
    if (pathPt === undefined || frame === undefined) continue;

    const t = n > 1 ? s / (n - 1) : 0;
    const halfWidth = widthFn(t) * 0.5;

    // Left edge
    positions[vIdx] = pathPt.x - halfWidth * frame.normal.x;
    positions[vIdx + 1] = pathPt.y - halfWidth * frame.normal.y;
    positions[vIdx + 2] = pathPt.z - halfWidth * frame.normal.z;
    vIdx += 3;
    uvs[uvIdx] = 0;
    uvs[uvIdx + 1] = t;
    uvIdx += 2;

    // Right edge
    positions[vIdx] = pathPt.x + halfWidth * frame.normal.x;
    positions[vIdx + 1] = pathPt.y + halfWidth * frame.normal.y;
    positions[vIdx + 2] = pathPt.z + halfWidth * frame.normal.z;
    vIdx += 3;
    uvs[uvIdx] = 1;
    uvs[uvIdx + 1] = t;
    uvIdx += 2;
  }

  let iIdx = 0;
  for (let s = 0; s < n - 1; s++) {
    const a = s * 2; // current left
    const b = s * 2 + 1; // current right
    const c = (s + 1) * 2; // next left
    const d = (s + 1) * 2 + 1; // next right

    // CCW from the binormal side (the "top" of the ribbon)
    indices[iIdx] = a;
    indices[iIdx + 1] = c;
    indices[iIdx + 2] = d;
    indices[iIdx + 3] = a;
    indices[iIdx + 4] = d;
    indices[iIdx + 5] = b;
    iIdx += 6;
  }

  const normals = computeNormals(positions, indices);
  const bounds = computeBounds(positions);

  return {
    positions,
    normals,
    uvs,
    indices,
    bounds,
    meta: {},
  };
}

/** Expose frame computation for testing frame continuity. */
export { computeParallelTransportFrames };
export type { Frame };
