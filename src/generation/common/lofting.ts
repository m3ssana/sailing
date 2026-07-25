/**
 * Surface lofting from ordered cross-section rings.
 *
 * The hull generator builds station curves (transverse slices) and then
 * connects them into a continuous surface. `loftSurface` bridges that gap:
 * given N rings of M points each, it emits the quad-strip mesh between
 * consecutive rings, triangulated with counter-clockwise outward winding.
 *
 * The sections MUST already be resampled to equal point counts (use
 * `resampleByArcLength2D` from curves.ts). If counts differ, lofting is
 * undefined — the caller gets an early error, not a corrupt mesh.
 *
 * Engine-agnostic — no three.js.
 */

import type { GeneratedMesh, Vec3 } from '@/types';
import { computeBounds, computeNormals } from './meshUtils';

export interface LoftOptions {
  /**
   * Whether each ring closes on itself (first point connects back to last).
   * True for a watertight hull cross-section, false for an open profile.
   */
  closedRings?: boolean;
  /** Cap the first section with a polygon fan. */
  capStart?: boolean;
  /** Cap the last section with a polygon fan. */
  capEnd?: boolean;
}

/**
 * Loft a surface between ordered cross-section rings.
 *
 * Each section is an array of 3D points forming a ring. All sections MUST have
 * the same length. Adjacent pairs of rings form quad strips, each quad split
 * into two triangles with CCW-outward winding.
 *
 * Winding convention: for a ring ordered counter-clockwise when viewed from the
 * direction of travel (i.e. from section[i] looking toward section[i+1]), the
 * outward normal points away from the surface interior.
 */
export function loftSurface(sections: readonly Vec3[][], options?: LoftOptions): GeneratedMesh {
  if (sections.length < 2) {
    throw new Error(`loftSurface requires at least 2 sections, got ${sections.length}`);
  }

  const ringSize = sections[0]?.length ?? 0;
  if (ringSize < 3) {
    throw new Error(`loftSurface requires at least 3 points per section, got ${ringSize}`);
  }

  // Validate uniform point counts — mismatched counts produce corrupt topology
  for (let i = 1; i < sections.length; i++) {
    const section = sections[i];
    if (section === undefined) continue;
    if (section.length !== ringSize) {
      throw new Error(
        `All sections must have equal point counts. Section 0 has ${ringSize}, ` +
          `section ${i} has ${section.length}. Use resampleByArcLength to match counts.`,
      );
    }
  }

  const closedRings = options?.closedRings === true;
  const capStart = options?.capStart === true;
  const capEnd = options?.capEnd === true;

  const numSections = sections.length;
  // For closed rings, the last point connects back to the first — so we have
  // ringSize quads around the ring. For open rings, ringSize-1 quads.
  const quadsAroundRing = closedRings ? ringSize : ringSize - 1;
  const quadsAlongLength = numSections - 1;

  // Count vertices and triangles
  const bodyVertexCount = numSections * ringSize;
  const bodyTriCount = quadsAlongLength * quadsAroundRing * 2;

  // Caps share the body's boundary vertices but add one centroid vertex each.
  // This guarantees watertightness: the cap fan edges align with the body's
  // boundary edges because they reference the SAME vertex indices.
  const capStartTriCount = capStart ? ringSize : 0;
  const capEndTriCount = capEnd ? ringSize : 0;
  const capVertexCount = (capStart ? 1 : 0) + (capEnd ? 1 : 0);

  const totalVertices = bodyVertexCount + capVertexCount;
  const totalTriangles = bodyTriCount + capStartTriCount + capEndTriCount;

  const positions = new Float32Array(totalVertices * 3);
  const uvs = new Float32Array(totalVertices * 2);
  const indices = new Uint32Array(totalTriangles * 3);

  // ─── Body vertices ───────────────────────────────────────────────────────

  let vIdx = 0;
  let uvIdx = 0;

  for (let s = 0; s < numSections; s++) {
    const section = sections[s];
    if (section === undefined) continue;
    const vFrac = s / (numSections - 1); // longitudinal UV

    for (let r = 0; r < ringSize; r++) {
      const pt = section[r];
      if (pt === undefined) continue;
      positions[vIdx] = pt.x;
      positions[vIdx + 1] = pt.y;
      positions[vIdx + 2] = pt.z;
      vIdx += 3;

      uvs[uvIdx] = r / (ringSize - (closedRings ? 0 : 1));
      uvs[uvIdx + 1] = vFrac;
      uvIdx += 2;
    }
  }

  // ─── Body indices ────────────────────────────────────────────────────────

  let iIdx = 0;

  for (let s = 0; s < quadsAlongLength; s++) {
    for (let r = 0; r < quadsAroundRing; r++) {
      const nextR = (r + 1) % ringSize;

      // Current ring vertices
      const a = s * ringSize + r;
      const b = s * ringSize + nextR;
      // Next ring vertices
      const c = (s + 1) * ringSize + r;
      const d = (s + 1) * ringSize + nextR;

      // Two triangles per quad, CCW from outside the solid.
      // Convention: counter-clockwise winding viewed from OUTSIDE yields
      // positive signed volume under the divergence-theorem integral.
      // With rings ordered CCW when viewed from the positive-path direction,
      // the outward normal points away from the tube axis. The correct split:
      //   Triangle 1: a, d, c  (advances along ring then along path)
      //   Triangle 2: a, b, d  (advances along ring on both rings)
      indices[iIdx] = a;
      indices[iIdx + 1] = d;
      indices[iIdx + 2] = c;
      indices[iIdx + 3] = a;
      indices[iIdx + 4] = b;
      indices[iIdx + 5] = d;
      iIdx += 6;
    }
  }

  // ─── Caps ────────────────────────────────────────────────────────────────
  // Caps share the body's boundary vertices (first/last ring) and only add a
  // centroid vertex. This makes the mesh genuinely watertight — cap edges are
  // the same half-edges as the body boundary, just traversed in the opposite
  // direction.

  if (capStart) {
    const centroidIdx = bodyVertexCount;
    const firstSection = sections[0];

    // Compute and write centroid vertex
    let cx = 0;
    let cy = 0;
    let cz = 0;
    if (firstSection !== undefined) {
      for (let r = 0; r < ringSize; r++) {
        const pt = firstSection[r];
        if (pt === undefined) continue;
        cx += pt.x;
        cy += pt.y;
        cz += pt.z;
      }
      cx /= ringSize;
      cy /= ringSize;
      cz /= ringSize;
    }
    positions[vIdx] = cx;
    positions[vIdx + 1] = cy;
    positions[vIdx + 2] = cz;
    vIdx += 3;
    uvs[uvIdx] = 0.5;
    uvs[uvIdx + 1] = 0;
    uvIdx += 2;

    // Fan triangles referencing body vertices in the first ring (indices 0..ringSize-1).
    // The start cap faces "backward" (toward negative path direction).
    // Body exposes half-edge (r → nextR) on ring 0 from triangle (a,b,d).
    // Cap must provide the opposite half-edge (nextR → r) to pair, so:
    // triangle (centroid, nextR, r) gives half-edge nextR→r on its second edge.
    for (let r = 0; r < ringSize; r++) {
      const nextR = (r + 1) % ringSize;
      indices[iIdx] = centroidIdx;
      indices[iIdx + 1] = nextR; // body vertex
      indices[iIdx + 2] = r; // body vertex
      iIdx += 3;
    }
  }

  if (capEnd) {
    const centroidIdx = bodyVertexCount + (capStart ? 1 : 0);
    const lastSection = sections[numSections - 1];

    let cx = 0;
    let cy = 0;
    let cz = 0;
    if (lastSection !== undefined) {
      for (let r = 0; r < ringSize; r++) {
        const pt = lastSection[r];
        if (pt === undefined) continue;
        cx += pt.x;
        cy += pt.y;
        cz += pt.z;
      }
      cx /= ringSize;
      cy /= ringSize;
      cz /= ringSize;
    }
    positions[vIdx] = cx;
    positions[vIdx + 1] = cy;
    positions[vIdx + 2] = cz;
    vIdx += 3;
    uvs[uvIdx] = 0.5;
    uvs[uvIdx + 1] = 1;
    uvIdx += 2;

    // End cap faces "forward". The last ring starts at vertex (numSections-1)*ringSize.
    // Body exposes half-edge (lastRing+nextR → lastRing+r) from triangle (a,d,c).
    // Cap must provide (lastRing+r → lastRing+nextR) to pair:
    // triangle (centroid, lastRing+r, lastRing+nextR).
    const lastRingStart = (numSections - 1) * ringSize;
    for (let r = 0; r < ringSize; r++) {
      const nextR = (r + 1) % ringSize;
      indices[iIdx] = centroidIdx;
      indices[iIdx + 1] = lastRingStart + r;
      indices[iIdx + 2] = lastRingStart + nextR;
      iIdx += 3;
    }
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
