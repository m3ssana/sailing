/**
 * Geometry test assertions for procedural generators.
 *
 * Every generation-workstream agent uses these to validate their output. The
 * functions are designed for use in Vitest tests but are plain functions, not
 * test framework-coupled — they return results or throw descriptive errors.
 *
 * Engine-agnostic — no three.js.
 */

import type { GeneratedMesh, GeneratedModel, Generator, Seed } from '@/types';

// ─── Volume ──────────────────────────────────────────────────────────────────

/**
 * Compute the signed volume of a closed mesh via the divergence theorem.
 *
 * For each triangle, we compute the signed volume of the tetrahedron formed by
 * the triangle and the origin. For a watertight mesh with consistent outward
 * winding (counter-clockwise from outside), the sum is the enclosed volume.
 *
 * This is the foundation of hydrostatics-from-geometry: if you can integrate
 * volume, you can integrate displaced mass, and from that buoyancy force and
 * its centre of application.
 *
 * Mathematical basis: V = (1/6) Σ (v0 · (v1 × v2)) over all triangles.
 */
export function computeVolume(mesh: GeneratedMesh): number {
  const { positions, indices } = mesh;
  let volume = 0;

  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i];
    const i1 = indices[i + 1];
    const i2 = indices[i + 2];

    if (i0 === undefined || i1 === undefined || i2 === undefined) continue;

    const v0x = positions[i0 * 3] ?? 0;
    const v0y = positions[i0 * 3 + 1] ?? 0;
    const v0z = positions[i0 * 3 + 2] ?? 0;

    const v1x = positions[i1 * 3] ?? 0;
    const v1y = positions[i1 * 3 + 1] ?? 0;
    const v1z = positions[i1 * 3 + 2] ?? 0;

    const v2x = positions[i2 * 3] ?? 0;
    const v2y = positions[i2 * 3 + 1] ?? 0;
    const v2z = positions[i2 * 3 + 2] ?? 0;

    // Signed volume of tetrahedron (origin, v0, v1, v2) = v0 · (v1 × v2) / 6
    const crossX = v1y * v2z - v1z * v2y;
    const crossY = v1z * v2x - v1x * v2z;
    const crossZ = v1x * v2y - v1y * v2x;

    volume += v0x * crossX + v0y * crossY + v0z * crossZ;
  }

  return volume / 6;
}

// ─── Surface area ────────────────────────────────────────────────────────────

/**
 * Compute total surface area of a mesh by summing triangle areas.
 */
export function computeSurfaceArea(mesh: GeneratedMesh): number {
  const { positions, indices } = mesh;
  let area = 0;

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

    // Cross product of edge vectors
    const e1x = p1x - p0x;
    const e1y = p1y - p0y;
    const e1z = p1z - p0z;
    const e2x = p2x - p0x;
    const e2y = p2y - p0y;
    const e2z = p2z - p0z;

    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;

    area += Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
  }

  return area;
}

// ─── Watertightness ──────────────────────────────────────────────────────────

/**
 * Create a canonical edge key that is order-independent for undirected edge
 * testing (watertight) or order-dependent for half-edge testing (winding).
 */
function undirectedEdgeKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

function directedEdgeKey(a: number, b: number): string {
  return `${a}-${b}`;
}

/**
 * Assert the mesh is watertight: every edge is shared by exactly two triangles.
 *
 * A watertight mesh is required for:
 * - Volume computation (divergence theorem only works on closed surfaces)
 * - Hydrostatics (displacement integration needs a closed hull)
 * - Rendering without edge artefacts
 *
 * Throws with a descriptive message listing the offending edges on failure.
 */
export function assertWatertight(mesh: GeneratedMesh): void {
  const { indices } = mesh;
  const edgeCounts = new Map<string, number>();

  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i];
    const i1 = indices[i + 1];
    const i2 = indices[i + 2];

    if (i0 === undefined || i1 === undefined || i2 === undefined) continue;

    const edges = [
      undirectedEdgeKey(i0, i1),
      undirectedEdgeKey(i1, i2),
      undirectedEdgeKey(i2, i0),
    ];

    for (const edge of edges) {
      edgeCounts.set(edge, (edgeCounts.get(edge) ?? 0) + 1);
    }
  }

  const badEdges: string[] = [];
  for (const [edge, count] of edgeCounts) {
    if (count !== 2) {
      badEdges.push(`${edge} (count: ${count})`);
    }
  }

  if (badEdges.length > 0) {
    const preview = badEdges.slice(0, 10).join(', ');
    const suffix = badEdges.length > 10 ? ` ... and ${badEdges.length - 10} more` : '';
    throw new Error(
      `Mesh is not watertight: ${badEdges.length} edges not shared by exactly 2 triangles. ` +
        `Offending edges: ${preview}${suffix}`,
    );
  }
}

// ─── Consistent winding ──────────────────────────────────────────────────────

/**
 * Assert consistent winding: all faces agree on orientation.
 *
 * For a mesh with consistent counter-clockwise winding (viewed from outside),
 * every directed half-edge (a→b) from one triangle must have a matching
 * opposite half-edge (b→a) from an adjacent triangle. If any half-edge appears
 * more than once in the same direction, the winding is inconsistent.
 *
 * Additionally, for a convex or mostly-convex mesh, we verify that the signed
 * volume is positive — negative volume means the normals point inward.
 */
export function assertConsistentWinding(mesh: GeneratedMesh): void {
  const { indices } = mesh;
  const halfEdges = new Map<string, number>();

  for (let i = 0; i < indices.length; i += 3) {
    const i0 = indices[i];
    const i1 = indices[i + 1];
    const i2 = indices[i + 2];

    if (i0 === undefined || i1 === undefined || i2 === undefined) continue;

    const edges = [
      directedEdgeKey(i0, i1),
      directedEdgeKey(i1, i2),
      directedEdgeKey(i2, i0),
    ];

    for (const edge of edges) {
      halfEdges.set(edge, (halfEdges.get(edge) ?? 0) + 1);
    }
  }

  // Check that no directed half-edge appears more than once
  const duplicates: string[] = [];
  for (const [edge, count] of halfEdges) {
    if (count > 1) {
      duplicates.push(`${edge} (count: ${count})`);
    }
  }

  if (duplicates.length > 0) {
    const preview = duplicates.slice(0, 10).join(', ');
    throw new Error(
      `Mesh has inconsistent winding: ${duplicates.length} half-edges appear more than once. ` +
        `Offending: ${preview}`,
    );
  }

  // For a closed mesh with outward normals, the signed volume should be positive.
  // A negative volume means all normals point inward (inverted winding).
  const volume = computeVolume(mesh);
  if (volume < 0) {
    throw new Error(
      `Mesh has inverted winding: signed volume is ${volume.toFixed(6)} (expected positive ` +
        `for outward-facing normals with counter-clockwise winding from outside).`,
    );
  }
}

// ─── Degenerate triangles ────────────────────────────────────────────────────

/**
 * Assert no degenerate triangles (zero or near-zero area).
 *
 * Degenerate triangles cause NaN normals, division-by-zero in UV mapping, and
 * invisible rendering artefacts. Epsilon is the minimum allowed cross-product
 * magnitude (twice the triangle area).
 */
export function assertNoDegenerateTriangles(mesh: GeneratedMesh, epsilon = 1e-10): void {
  const { positions, indices } = mesh;
  const degenerate: number[] = [];

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

    const e1x = p1x - p0x;
    const e1y = p1y - p0y;
    const e1z = p1z - p0z;
    const e2x = p2x - p0x;
    const e2y = p2y - p0y;
    const e2z = p2z - p0z;

    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    const areaSq = cx * cx + cy * cy + cz * cz;

    if (areaSq < epsilon * epsilon) {
      degenerate.push(i / 3);
    }
  }

  if (degenerate.length > 0) {
    const preview = degenerate.slice(0, 10).join(', ');
    const suffix = degenerate.length > 10 ? ` ... and ${degenerate.length - 10} more` : '';
    throw new Error(
      `Mesh has ${degenerate.length} degenerate triangles (area < ${epsilon}). ` +
        `Face indices: ${preview}${suffix}`,
    );
  }
}

// ─── Finite buffers ──────────────────────────────────────────────────────────

/**
 * Assert no NaN or Infinity in any buffer. These would cause silent rendering
 * corruption or physics blowups.
 */
export function assertFiniteBuffers(mesh: GeneratedMesh): void {
  const buffers: Array<{ name: string; data: Float32Array | Uint32Array }> = [
    { name: 'positions', data: mesh.positions },
    { name: 'normals', data: mesh.normals },
    { name: 'uvs', data: mesh.uvs },
    { name: 'indices', data: mesh.indices },
  ];

  if (mesh.colors) buffers.push({ name: 'colors', data: mesh.colors });
  if (mesh.tangents) buffers.push({ name: 'tangents', data: mesh.tangents });

  for (const { name, data } of buffers) {
    for (let i = 0; i < data.length; i++) {
      const val = data[i];
      if (val === undefined || !isFinite(val)) {
        throw new Error(
          `Buffer '${name}' contains non-finite value at index ${i}: ${String(val)}`,
        );
      }
    }
  }
}

// ─── Determinism ─────────────────────────────────────────────────────────────

/**
 * Assert a generator produces byte-identical output for the same (params, seed).
 *
 * This is the fundamental contract of the generation system: identical inputs
 * always produce identical outputs, which enables caching without invalidation
 * and makes tests stable.
 */
export function assertDeterministic<TParams>(
  generator: Generator<TParams, GeneratedModel>,
  params: TParams,
  seed: Seed,
): void {
  const a = generator.generate(params, seed);
  const b = generator.generate(params, seed);

  if (a.meshes.length !== b.meshes.length) {
    throw new Error(
      `Non-deterministic: first run produced ${a.meshes.length} meshes, ` +
        `second produced ${b.meshes.length}`,
    );
  }

  for (let m = 0; m < a.meshes.length; m++) {
    const meshA = a.meshes[m];
    const meshB = b.meshes[m];
    if (!meshA || !meshB) continue;

    const buffersToCheck: Array<{ name: string; a: ArrayLike<number>; b: ArrayLike<number> }> = [
      { name: `mesh[${m}].positions`, a: meshA.positions, b: meshB.positions },
      { name: `mesh[${m}].normals`, a: meshA.normals, b: meshB.normals },
      { name: `mesh[${m}].uvs`, a: meshA.uvs, b: meshB.uvs },
      { name: `mesh[${m}].indices`, a: meshA.indices, b: meshB.indices },
    ];

    for (const buf of buffersToCheck) {
      if (buf.a.length !== buf.b.length) {
        throw new Error(
          `Non-deterministic: ${buf.name} has length ${buf.a.length} on first run ` +
            `but ${buf.b.length} on second`,
        );
      }
      for (let i = 0; i < buf.a.length; i++) {
        if (buf.a[i] !== buf.b[i]) {
          throw new Error(
            `Non-deterministic: ${buf.name} differs at index ${i}: ` +
              `${String(buf.a[i])} vs ${String(buf.b[i])}`,
          );
        }
      }
    }
  }
}
