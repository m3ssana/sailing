/**
 * Sail surface generator — D.4.
 *
 * Produces a parametric cloth grid from SailSurfaceParams (luff/foot/leech
 * lengths, luff round, broadseam, twist) that is directly usable as the PBD
 * simulation mesh for task I.2.
 *
 * ## Geometry layout
 *
 * The sail is a triangular-ish surface defined by three corners:
 * - **Tack** (foot/luff junction) — placed at the origin.
 * - **Head** (top of the luff) — placed at (0, luffLength, 0) along the Y axis.
 * - **Clew** (foot/leech junction) — solved via law of cosines to satisfy
 *   footLength from tack and leechLength from head.
 *
 * The sail plane is XY, with the luff aligned to the Y axis. This matches
 * the convention where the sail is later attached to the rig with the luff
 * running up the mast and the foot running aft.
 *
 * ## Parametric grid (luffSegments × footSegments)
 *
 * Each row `i` (0..luffSegments) is at height fraction `v = i / luffSegments`.
 * At each height, the sail spans from the luff edge to the leech/foot edge.
 * The parametrisation is a ruled surface between the luff curve and the leech:
 *
 *   P(u, v) = (1 - u) * luffPoint(v) + u * leechPoint(v)
 *
 * where `u` is the girth fraction (0 at luff, 1 at leech).
 *
 * This gives a regular grid with `(luffSegments + 1) * (footSegments + 1)` vertices.
 *
 * ## Luff round
 *
 * Applied as a quadratic (parabolic) offset perpendicular to the straight
 * tack→head line (i.e. in the +X direction). Maximum displacement at the
 * midpoint (v=0.5) equal to `luffRound * luffLength`, tapering to zero at
 * tack (v=0) and head (v=1). The formula is: `offset = luffRound * luffLength * 4 * v * (1 - v)`.
 *
 * A parabolic profile is chosen over a Bezier because it's simpler, produces
 * the same physical effect (extra cloth that becomes camber when constrained
 * to a straight luff wire), and is trivially differentiable.
 *
 * ## Broadseam
 *
 * Applied similarly along the foot edge: perpendicular offset in the +Y
 * direction away from the straight tack→clew line, maximum at u=0.5.
 * `offset = broadseam * footLength * 4 * u * (1 - u)`.
 * Only applied to the v=0 row (foot edge); higher rows interpolate to zero.
 *
 * ## Twist
 *
 * **Design decision:** Twist is applied to the REST (flat reference) shape by
 * rotating each height-row's girth direction about the luff axis (Y axis) by
 * `twist * v` radians, where v is the luff fraction. This encodes the designed
 * twist into the reference mesh so the PBD cloth sim (I.2) starts from a
 * realistic rest shape rather than a flat panel. The actual dynamic twist under
 * load remains the responsibility of the cloth simulation's aerodynamic
 * pressure field.
 *
 * ## Panel encoding
 *
 * `panelCount` evenly-spaced seam lines across the girth (u direction). Each
 * vertex gets a `panelFraction` value in mesh.meta via a separate UV2 channel
 * (stored as colors.r for minimal overhead). The panel fraction is
 * `(u * panelCount) % 1.0`, which a future shader can threshold to draw seams.
 * Panel boundaries encode at: u = k / panelCount for k = 0..panelCount.
 *
 * ## Winding convention
 *
 * Triangles are wound counter-clockwise when viewed from the **starboard**
 * (positive-Z) side. This makes the sail's pressure side (leeward / starboard
 * for a port-tack configuration) the "outside" per the GeneratedMesh contract.
 * The convention is consistent with a right-hand-rule normal pointing from
 * pressure to suction side (+Z in the reference frame).
 *
 * Engine-agnostic — no three.js.
 */

import type { GeneratedMesh, GeneratedModel, Generator, SailSurfaceParams, Seed, Vec3 } from '@/types';
import { computeBounds, computeNormals, gatherTransferables } from '../common/meshUtils';

/**
 * Solve for the clew position given the three side lengths.
 *
 * Tack is at origin (0, 0, 0). Head is at (0, luffLength, 0).
 * Clew must be at distance footLength from tack and leechLength from head.
 *
 * Using circle-circle intersection in the XY plane:
 *   clew.x² + clew.y² = footLength²
 *   clew.x² + (clew.y - luffLength)² = leechLength²
 *
 * Solving for clew.y:
 *   clew.y = (footLength² + luffLength² - leechLength²) / (2 * luffLength)
 *   clew.x = sqrt(footLength² - clew.y²)
 *
 * We place the clew on the +X side (starboard convention).
 */
function solveClew(luffLength: number, footLength: number, leechLength: number): Vec3 {
  const y = (footLength * footLength + luffLength * luffLength - leechLength * leechLength) /
    (2 * luffLength);
  const xSq = footLength * footLength - y * y;
  // Guard against floating-point errors producing a tiny negative
  const x = Math.sqrt(Math.max(0, xSq));
  return { x, y, z: 0 };
}

/**
 * Compute the polyline length of an edge defined by a sequence of vertices.
 * Each vertex is referenced by index into the flat positions buffer.
 */
function measureEdge(positions: Float32Array, vertexIndices: number[]): number {
  let length = 0;
  for (let i = 1; i < vertexIndices.length; i++) {
    const prev = vertexIndices[i - 1];
    const curr = vertexIndices[i];
    if (prev === undefined || curr === undefined) continue;
    const dx = (positions[curr * 3] ?? 0) - (positions[prev * 3] ?? 0);
    const dy = (positions[curr * 3 + 1] ?? 0) - (positions[prev * 3 + 1] ?? 0);
    const dz = (positions[curr * 3 + 2] ?? 0) - (positions[prev * 3 + 2] ?? 0);
    length += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return length;
}

export const SailSurfaceGenerator: Generator<SailSurfaceParams, GeneratedModel> = {
  id: 'sailSurface',

  generate(params: SailSurfaceParams, _seed: Seed): GeneratedModel {
    const {
      luffLength,
      footLength,
      leechLength,
      luffRound,
      broadseam,
      twist,
      luffSegments,
      footSegments,
      panelCount,
    } = params;

    // ─── Solve corners ───────────────────────────────────────────────────────
    const tack: Vec3 = { x: 0, y: 0, z: 0 };
    const head: Vec3 = { x: 0, y: luffLength, z: 0 };
    const clew = solveClew(luffLength, footLength, leechLength);

    // ─── Build the grid ──────────────────────────────────────────────────────
    const rows = luffSegments + 1;
    const cols = footSegments + 1;
    const vertexCount = rows * cols;
    const triCount = luffSegments * footSegments * 2;

    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const colors = new Float32Array(vertexCount * 3); // panel encoding in R channel
    const indices = new Uint32Array(triCount * 3);

    // The sail narrows from foot-width at the bottom to near-zero at the head.
    // To avoid degenerate triangles in the top row, we compute a minimum girth
    // width (headboard width) — a real sail has a small headboard, and for PBD
    // mesh regularity we ensure the top row never collapses to zero width.
    // The headboard fraction keeps the top row at ~1% of foot width.
    const headboardFraction = 0.01;
    const headboardHalfWidth = footLength * headboardFraction * 0.5;

    for (let i = 0; i < rows; i++) {
      const v = i / luffSegments; // luff fraction: 0 = tack/foot, 1 = head

      // Luff point at height v (with luff round applied)
      // Parabolic offset: max at v=0.5, zero at v=0 and v=1
      const luffOffset = luffRound * luffLength * 4 * v * (1 - v);
      const luffPt: Vec3 = {
        x: tack.x + luffOffset,
        y: tack.y + (head.y - tack.y) * v,
        z: 0,
      };

      // Leech point at height v (linear interpolation from clew to head)
      // At v=1 (head), the naive interpolation collapses luff and leech to the
      // same point, creating degenerate triangles. Instead, ensure a minimum
      // separation (headboard) that keeps the grid non-degenerate.
      let leechX = clew.x + (head.x - clew.x) * v;
      const leechY = clew.y + (head.y - clew.y) * v;

      // Ensure minimum girth at each row: at least headboardHalfWidth * 2 wide
      const naiveGirth = leechX - luffPt.x;
      if (naiveGirth < headboardHalfWidth * 2) {
        leechX = luffPt.x + headboardHalfWidth * 2;
      }

      const leechPt: Vec3 = {
        x: leechX,
        y: leechY,
        z: 0,
      };

      for (let j = 0; j < cols; j++) {
        const u = j / footSegments; // girth fraction: 0 = luff, 1 = leech

        // Ruled surface interpolation between luff and leech
        let px = luffPt.x + (leechPt.x - luffPt.x) * u;
        let py = luffPt.y + (leechPt.y - luffPt.y) * u;
        let pz = 0;

        // Apply broadseam: offset perpendicular to the foot line,
        // maximum at mid-girth, tapering from foot (v=0) to head (v=1).
        // The broadseam creates fullness in the lower part of the sail.
        // Applied in Y direction (perpendicular to foot in the sail plane)
        // but only effective near the foot row, decaying with height.
        const broadseamOffset = broadseam * footLength * 4 * u * (1 - u) * (1 - v);
        py += broadseamOffset;

        // Apply twist: rotate each height-row about the Y axis (luff axis)
        // by twist * v radians. This twists the reference shape.
        if (twist !== 0) {
          const angle = twist * v;
          const cosA = Math.cos(angle);
          const sinA = Math.sin(angle);
          // Rotate around Y axis: x' = x*cos - z*sin, z' = x*sin + z*cos
          const rx = px * cosA - pz * sinA;
          const rz = px * sinA + pz * cosA;
          px = rx;
          pz = rz;
        }

        const vtxIdx = i * cols + j;
        positions[vtxIdx * 3] = px;
        positions[vtxIdx * 3 + 1] = py;
        positions[vtxIdx * 3 + 2] = pz;

        // UVs map directly to (girth-fraction, luff-fraction) for PBD use
        uvs[vtxIdx * 2] = u;
        uvs[vtxIdx * 2 + 1] = v;

        // Panel fraction encoding: sawtooth across panels
        const panelFraction = (u * panelCount) % 1.0;
        colors[vtxIdx * 3] = panelFraction; // R: panel fraction
        colors[vtxIdx * 3 + 1] = v; // G: luff fraction (useful for shading)
        colors[vtxIdx * 3 + 2] = u; // B: girth fraction
      }
    }

    // ─── Triangulate the grid ────────────────────────────────────────────────
    // CCW when viewed from +Z (starboard side / pressure side)
    let idx = 0;
    for (let i = 0; i < luffSegments; i++) {
      for (let j = 0; j < footSegments; j++) {
        const a = i * cols + j; // current row, current col
        const b = i * cols + j + 1; // current row, next col
        const c = (i + 1) * cols + j; // next row, current col
        const d = (i + 1) * cols + j + 1; // next row, next col

        // Triangle 1: a, b, d — CCW from +Z
        indices[idx] = a;
        indices[idx + 1] = b;
        indices[idx + 2] = d;
        idx += 3;

        // Triangle 2: a, d, c — CCW from +Z
        indices[idx] = a;
        indices[idx + 1] = d;
        indices[idx + 2] = c;
        idx += 3;
      }
    }

    // ─── Compute normals and bounds ──────────────────────────────────────────
    const normals = computeNormals(positions, indices);
    const bounds = computeBounds(positions);

    // ─── Measure actual edge lengths ─────────────────────────────────────────
    // Luff edge: column 0, all rows (u=0)
    const luffVertices: number[] = [];
    for (let i = 0; i < rows; i++) {
      luffVertices.push(i * cols);
    }
    const actualLuff = measureEdge(positions, luffVertices);

    // Foot edge: row 0, all columns (v=0)
    const footVertices: number[] = [];
    for (let j = 0; j < cols; j++) {
      footVertices.push(j);
    }
    const actualFoot = measureEdge(positions, footVertices);

    // Leech edge: column footSegments, all rows (u=1)
    const leechVertices: number[] = [];
    for (let i = 0; i < rows; i++) {
      leechVertices.push(i * cols + footSegments);
    }
    const actualLeech = measureEdge(positions, leechVertices);

    // Compute surface area from the triangulated mesh
    let area = 0;
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

    const mesh: GeneratedMesh = {
      positions,
      normals,
      uvs,
      indices,
      colors,
      bounds,
      meta: {
        actualLuffLength: actualLuff,
        actualFootLength: actualFoot,
        actualLeechLength: actualLeech,
        area,
        vertexCount,
        triangleCount: triCount,
        luffSegments,
        footSegments,
        panelCount,
      },
    };

    const model: GeneratedModel = {
      meshes: [mesh],
      groups: [{ name: 'sail', start: 0, count: indices.length, materialId: 'sailcloth' }],
      transferables: [],
    };

    model.transferables = gatherTransferables(model);
    return model;
  },
};
