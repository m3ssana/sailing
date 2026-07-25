/**
 * Shared geometry utilities for procedural generators.
 *
 * Every generator needs bounds computation, normal calculation, mesh merging,
 * and transferable gathering. Centralising these prevents subtle divergence
 * (e.g. different winding conventions in area-weighted normals).
 *
 * Engine-agnostic — no three.js.
 */

import type { GeneratedMesh, GeneratedModel, Vec3 } from '@/types';

// ─── Bounds ──────────────────────────────────────────────────────────────────

/**
 * Compute axis-aligned bounding box from a flat position buffer (xyz triples).
 */
export function computeBounds(positions: Float32Array): { min: Vec3; max: Vec3 } {
  if (positions.length < 3) {
    return { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] ?? 0;
    const y = positions[i + 1] ?? 0;
    const z = positions[i + 2] ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
  };
}

// ─── Normals ─────────────────────────────────────────────────────────────────

/**
 * Compute area-weighted vertex normals from positions and indices.
 *
 * Each triangle's normal contributes proportionally to its area (which is half
 * the magnitude of the cross product). This is the standard approach for smooth
 * shading on procedural geometry — it handles non-uniform triangle sizes
 * gracefully without requiring angle-weighting.
 *
 * Writes into a new Float32Array of the same length as positions.
 */
export function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);

  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i];
    const i1 = indices[i + 1];
    const i2 = indices[i + 2];

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

    // Edge vectors
    const e1x = p1x - p0x;
    const e1y = p1y - p0y;
    const e1z = p1z - p0z;
    const e2x = p2x - p0x;
    const e2y = p2y - p0y;
    const e2z = p2z - p0z;

    // Cross product (un-normalised — magnitude is 2× triangle area)
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;

    // Accumulate area-weighted normal to each vertex of the triangle.
    // Direct indexed assignment is safe — indices are validated in-bounds by the
    // loop structure, but TS can't prove it, so we use the (x ?? 0) + delta form.
    normals[i0 * 3] = (normals[i0 * 3] ?? 0) + nx;
    normals[i0 * 3 + 1] = (normals[i0 * 3 + 1] ?? 0) + ny;
    normals[i0 * 3 + 2] = (normals[i0 * 3 + 2] ?? 0) + nz;
    normals[i1 * 3] = (normals[i1 * 3] ?? 0) + nx;
    normals[i1 * 3 + 1] = (normals[i1 * 3 + 1] ?? 0) + ny;
    normals[i1 * 3 + 2] = (normals[i1 * 3 + 2] ?? 0) + nz;
    normals[i2 * 3] = (normals[i2 * 3] ?? 0) + nx;
    normals[i2 * 3 + 1] = (normals[i2 * 3 + 1] ?? 0) + ny;
    normals[i2 * 3 + 2] = (normals[i2 * 3 + 2] ?? 0) + nz;
  }

  // Normalise each vertex normal
  for (let i = 0; i < normals.length; i += 3) {
    const nx = normals[i] ?? 0;
    const ny = normals[i + 1] ?? 0;
    const nz = normals[i + 2] ?? 0;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-10) {
      normals[i] = nx / len;
      normals[i + 1] = ny / len;
      normals[i + 2] = nz / len;
    }
  }

  return normals;
}

// ─── Merge ───────────────────────────────────────────────────────────────────

/**
 * Merge multiple meshes into one, offsetting indices and concatenating buffers.
 * The resulting mesh has no groups — callers should track offsets externally if
 * material segmentation is needed.
 */
export function mergeMeshes(meshes: GeneratedMesh[]): GeneratedMesh {
  if (meshes.length === 0) {
    return {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      uvs: new Float32Array(0),
      indices: new Uint32Array(0),
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
      meta: {},
    };
  }

  if (meshes.length === 1) {
    const single = meshes[0];
    if (!single) {
      return {
        positions: new Float32Array(0),
        normals: new Float32Array(0),
        uvs: new Float32Array(0),
        indices: new Uint32Array(0),
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
        meta: {},
      };
    }
    return single;
  }

  let totalPositions = 0;
  let totalIndices = 0;
  let totalUvs = 0;
  let hasColors = false;
  let hasTangents = false;

  for (const mesh of meshes) {
    totalPositions += mesh.positions.length;
    totalIndices += mesh.indices.length;
    totalUvs += mesh.uvs.length;
    if (mesh.colors) hasColors = true;
    if (mesh.tangents) hasTangents = true;
  }

  const positions = new Float32Array(totalPositions);
  const normals = new Float32Array(totalPositions);
  const uvs = new Float32Array(totalUvs);
  const indices = new Uint32Array(totalIndices);
  const colors = hasColors ? new Float32Array(totalPositions) : undefined;
  const tangents = hasTangents ? new Float32Array((totalPositions / 3) * 4) : undefined;

  let posOffset = 0;
  let idxOffset = 0;
  let uvOffset = 0;
  let vertexOffset = 0;
  let tangentOffset = 0;

  for (const mesh of meshes) {
    positions.set(mesh.positions, posOffset);
    normals.set(mesh.normals, posOffset);
    uvs.set(mesh.uvs, uvOffset);

    // Offset indices by the current vertex count
    for (let i = 0; i < mesh.indices.length; i++) {
      indices[idxOffset + i] = (mesh.indices[i] ?? 0) + vertexOffset;
    }

    if (colors && mesh.colors) {
      colors.set(mesh.colors, posOffset);
    }
    if (tangents && mesh.tangents) {
      tangents.set(mesh.tangents, tangentOffset);
    }

    posOffset += mesh.positions.length;
    uvOffset += mesh.uvs.length;
    idxOffset += mesh.indices.length;
    vertexOffset += mesh.positions.length / 3;
    tangentOffset += mesh.tangents ? mesh.tangents.length : (mesh.positions.length / 3) * 4;
  }

  const result: GeneratedMesh = {
    positions,
    normals,
    uvs,
    indices,
    bounds: computeBounds(positions),
    meta: {},
  };

  if (colors) result.colors = colors;
  if (tangents) result.tangents = tangents;

  return result;
}

// ─── Transferables ───────────────────────────────────────────────────────────

/**
 * Gather all ArrayBuffers from a GeneratedModel for postMessage transfer.
 * Deduplicates by reference identity so shared buffers aren't listed twice.
 */
export function gatherTransferables(model: GeneratedModel): ArrayBufferLike[] {
  const seen = new Set<ArrayBufferLike>();
  const result: ArrayBufferLike[] = [];

  function add(buffer: ArrayBufferLike): void {
    if (!seen.has(buffer)) {
      seen.add(buffer);
      result.push(buffer);
    }
  }

  for (const mesh of model.meshes) {
    add(mesh.positions.buffer);
    add(mesh.normals.buffer);
    add(mesh.uvs.buffer);
    add(mesh.indices.buffer);
    if (mesh.colors) add(mesh.colors.buffer);
    if (mesh.tangents) add(mesh.tangents.buffer);
  }

  return result;
}
