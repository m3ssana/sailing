/**
 * Extrusion and revolution — the workhorses of landmark generation.
 *
 * `extrudePolygon` takes a 2D outline, triangulates it, and lifts it into 3D
 * with optional bevel edges. `revolve` sweeps a 2D profile around the Y axis
 * for columns, domes, and lighthouse bodies.
 *
 * Engine-agnostic — no three.js.
 */

import type { GeneratedMesh, Vec2 } from '@/types';
import { computeBounds, computeNormals } from './meshUtils';
import { triangulate } from './triangulate';

export interface ExtrudeOptions {
  /** Bevel distance at top and bottom edges. Default 0 (no bevel). */
  bevel?: number;
  /** Number of bevel segments. More = rounder. Default 1. */
  bevelSegments?: number;
  /** Whether to include top and bottom faces. Default true. */
  caps?: boolean;
}

/**
 * Extrude a 2D polygon along the Y axis by `height` units.
 *
 * Input outline is in the XZ plane (x → X, y → Z). Extrusion lifts along +Y.
 * The bottom face sits at Y=0, the top at Y=height.
 *
 * Bevel insets both top and bottom caps and connects them with angled side
 * strips, giving chamfered edges that catch specular highlights per the
 * art-direction mandate (1–2% of major dimension).
 */
export function extrudePolygon(
  outline: readonly Vec2[],
  height: number,
  options?: ExtrudeOptions,
): GeneratedMesh {
  if (outline.length < 3) {
    throw new Error(`extrudePolygon requires at least 3 outline points, got ${outline.length}`);
  }

  const bevel = options?.bevel ?? 0;
  const bevelSegments = options?.bevelSegments ?? 1;
  const caps = options?.caps !== false;

  // With bevel=0 there are just 2 layers: bottom and top.
  // With bevel>0, we add bevelSegments layers at each end for the chamfered edges.
  const hasBevel = bevel > 0;
  const bevelLayers = hasBevel ? bevelSegments : 0;

  const n = outline.length;

  // Compute inset outline for bevel
  const insetOutline = hasBevel ? computeInset(outline, bevel) : outline;

  // Build layer profiles (Y heights and which outline to use)
  interface LayerDef {
    y: number;
    outline: readonly Vec2[];
  }
  const layers: LayerDef[] = [];

  if (hasBevel) {
    // Bottom bevel: from Y=0 (original outline) transitioning to Y=bevel (inset)
    for (let i = 0; i <= bevelLayers; i++) {
      const t = i / bevelLayers;
      const y = t * bevel;
      const blended = blendOutlines(outline, insetOutline, t);
      layers.push({ y, outline: blended });
    }
    // Top bevel: from Y=(height-bevel) (inset) to Y=height (original)
    for (let i = 0; i <= bevelLayers; i++) {
      const t = i / bevelLayers;
      const y = height - bevel + t * bevel;
      const blended = blendOutlines(insetOutline, outline, t);
      layers.push({ y, outline: blended });
    }
  } else {
    layers.push({ y: 0, outline });
    layers.push({ y: height, outline });
  }

  // ─── Side wall vertices and indices
  const sideVertCount = layers.length * n;
  const sideTriCount = (layers.length - 1) * n * 2;

  // ─── Cap vertices and indices
  const capIndices = caps ? triangulate(insetOutline.length > 0 ? insetOutline : outline) : [];
  const capTriCount = caps ? (capIndices.length / 3) * 2 : 0;
  // Caps reuse the side wall's boundary vertices (first and last layer) to
  // guarantee watertightness — cap edges ARE the body boundary edges traversed
  // in the opposite direction. No extra cap vertices needed.
  const capVertCount = 0;

  const totalVerts = sideVertCount + capVertCount;
  const totalTris = sideTriCount + capTriCount;

  const positions = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const indices = new Uint32Array(totalTris * 3);

  // ─── Side vertices
  let vIdx = 0;
  let uvIdx = 0;

  for (let l = 0; l < layers.length; l++) {
    const layer = layers[l];
    if (layer === undefined) continue;
    const vFrac = layer.y / height;

    for (let i = 0; i < n; i++) {
      const pt = layer.outline[i];
      if (pt === undefined) continue;
      positions[vIdx] = pt.x;
      positions[vIdx + 1] = layer.y;
      positions[vIdx + 2] = pt.y; // Vec2.y maps to world Z
      vIdx += 3;

      uvs[uvIdx] = i / n;
      uvs[uvIdx + 1] = vFrac;
      uvIdx += 2;
    }
  }

  // ─── Side indices
  let iIdx = 0;
  for (let l = 0; l < layers.length - 1; l++) {
    for (let i = 0; i < n; i++) {
      const nextI = (i + 1) % n;
      const a = l * n + i;
      const b = l * n + nextI;
      const c = (l + 1) * n + i;
      const d = (l + 1) * n + nextI;

      // Counter-clockwise winding viewed from OUTSIDE the solid. For a CCW
      // polygon in XZ (viewed from +Y), the outward normal on the side wall
      // between vertex i and nextI points away from the polygon interior.
      // Looking from outside at the quad (a=lower-curr, b=lower-next,
      // c=upper-curr, d=upper-next): CCW order is (a,c,d) then (a,d,b).
      indices[iIdx] = a;
      indices[iIdx + 1] = c;
      indices[iIdx + 2] = d;
      indices[iIdx + 3] = a;
      indices[iIdx + 4] = d;
      indices[iIdx + 5] = b;
      iIdx += 6;
    }
  }

  // ─── Cap indices ───────────────────────────────────────────────────────────
  // Caps reference the side wall's boundary vertices directly. The bottom ring
  // occupies side indices [0..n-1] and the top ring occupies
  // [(layers.length-1)*n .. layers.length*n - 1]. This eliminates duplicate
  // boundary vertices and guarantees watertightness (shared half-edges).

  if (caps) {
    // For bevel: the cap outline sits at the inset ring. With bevel the bottom
    // inset ring is at layer index `bevelLayers` and top inset is at
    // `bevelLayers + 1 + bevelLayers` (where +1 accounts for the first point
    // of the second bevel sequence duplicating the last of the first).
    // Without bevel: bottom = layer 0, top = layer 1.
    const bottomLayerIdx = hasBevel ? bevelLayers : 0;
    const topLayerIdx = hasBevel ? bevelLayers + 1 + bevelLayers : layers.length - 1;
    const bottomBase = bottomLayerIdx * n;
    const topBase = topLayerIdx * n;

    // Bottom cap triangles — faces -Y (outward below the solid). The
    // triangulator emits CCW in the 2D (x,y)→(X,Z) plane, which maps to -Y
    // normal in 3D. Use UNREVERSED output so boundary half-edges go CCW,
    // cancelling the side wall's CW boundary on layer 0.
    for (let i = 0; i < capIndices.length; i += 3) {
      const ci0 = capIndices[i];
      const ci1 = capIndices[i + 1];
      const ci2 = capIndices[i + 2];
      if (ci0 === undefined || ci1 === undefined || ci2 === undefined) continue;
      indices[iIdx] = bottomBase + ci0;
      indices[iIdx + 1] = bottomBase + ci1;
      indices[iIdx + 2] = bottomBase + ci2;
      iIdx += 3;
    }

    // Top cap triangles — faces +Y (outward above the solid). Reversing the
    // triangulator output flips the normal to +Y and makes boundary half-edges
    // go CW, cancelling the side wall's CCW boundary on the top layer.
    for (let i = 0; i < capIndices.length; i += 3) {
      const ci0 = capIndices[i];
      const ci1 = capIndices[i + 1];
      const ci2 = capIndices[i + 2];
      if (ci0 === undefined || ci1 === undefined || ci2 === undefined) continue;
      indices[iIdx] = topBase + ci0;
      indices[iIdx + 1] = topBase + ci2;
      indices[iIdx + 2] = topBase + ci1;
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
    meta: {
      volume: computePolygonArea(outline) * height,
    },
  };
}

// ─── Revolve ─────────────────────────────────────────────────────────────────

/**
 * Revolve a 2D profile around the Y axis.
 *
 * Profile is in the XY plane: x is distance from the axis, y is height.
 * `segments` is the number of divisions around the full circle.
 * `arc` is the sweep angle in radians (default 2π for a full revolution).
 */
export function revolve(
  profile: readonly Vec2[],
  segments: number,
  arc = Math.PI * 2,
): GeneratedMesh {
  if (profile.length < 2) {
    throw new Error(`revolve requires at least 2 profile points, got ${profile.length}`);
  }
  if (segments < 3) {
    throw new Error(`revolve requires at least 3 segments, got ${segments}`);
  }

  const profileLen = profile.length;
  const isClosed = Math.abs(arc - Math.PI * 2) < 1e-6;
  const slices = isClosed ? segments : segments + 1;

  const totalVerts = profileLen * slices;
  const quadsAlong = profileLen - 1;
  // For closed arcs we have `segments` quad-rings; for open arcs, `slices - 1`.
  const actualQuadsAround = isClosed ? segments : slices - 1;
  const totalTris = quadsAlong * actualQuadsAround * 2;

  const positions = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const indices = new Uint32Array(totalTris * 3);

  // ─── Vertices
  let vIdx = 0;
  let uvIdx = 0;

  for (let s = 0; s < slices; s++) {
    const angle = (s / segments) * arc;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const uFrac = s / (isClosed ? segments : slices - 1);

    for (let p = 0; p < profileLen; p++) {
      const pt = profile[p];
      if (pt === undefined) continue;
      // Revolve: (x, y) in profile → (x*cos, y, x*sin) in 3D
      positions[vIdx] = pt.x * cosA;
      positions[vIdx + 1] = pt.y;
      positions[vIdx + 2] = pt.x * sinA;
      vIdx += 3;

      uvs[uvIdx] = uFrac;
      uvs[uvIdx + 1] = p / (profileLen - 1);
      uvIdx += 2;
    }
  }

  // ─── Indices
  let iIdx = 0;
  for (let s = 0; s < actualQuadsAround; s++) {
    const nextS = (s + 1) % slices;
    for (let p = 0; p < quadsAlong; p++) {
      const a = s * profileLen + p;
      const b = s * profileLen + p + 1;
      const c = nextS * profileLen + p;
      const d = nextS * profileLen + p + 1;

      // CCW from outside
      indices[iIdx] = a;
      indices[iIdx + 1] = b;
      indices[iIdx + 2] = d;
      indices[iIdx + 3] = a;
      indices[iIdx + 4] = d;
      indices[iIdx + 5] = c;
      iIdx += 6;
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Compute signed area of a 2D polygon (positive = CCW). */
function computePolygonArea(ring: readonly Vec2[]): number {
  let area = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const curr = ring[i];
    const next = ring[(i + 1) % n];
    if (curr === undefined || next === undefined) continue;
    area += curr.x * next.y - next.x * curr.y;
  }
  return Math.abs(area) / 2;
}

/** Inset a polygon by `distance` (shrink). Simple parallel-offset approach. */
function computeInset(outline: readonly Vec2[], distance: number): Vec2[] {
  const n = outline.length;
  const result: Vec2[] = [];

  for (let i = 0; i < n; i++) {
    const prev = outline[((i - 1) + n) % n];
    const curr = outline[i];
    const next = outline[(i + 1) % n];
    if (prev === undefined || curr === undefined || next === undefined) {
      result.push({ x: 0, y: 0 });
      continue;
    }

    // Edge normals (pointing inward for CCW polygon)
    const e1x = curr.x - prev.x;
    const e1y = curr.y - prev.y;
    const e1Len = Math.sqrt(e1x * e1x + e1y * e1y);
    const n1x = e1Len > 0 ? e1y / e1Len : 0;
    const n1y = e1Len > 0 ? -e1x / e1Len : 0;

    const e2x = next.x - curr.x;
    const e2y = next.y - curr.y;
    const e2Len = Math.sqrt(e2x * e2x + e2y * e2y);
    const n2x = e2Len > 0 ? e2y / e2Len : 0;
    const n2y = e2Len > 0 ? -e2x / e2Len : 0;

    // Average normal at the vertex (bisector direction)
    let avgNx = n1x + n2x;
    let avgNy = n1y + n2y;
    const avgLen = Math.sqrt(avgNx * avgNx + avgNy * avgNy);
    if (avgLen > 1e-10) {
      avgNx /= avgLen;
      avgNy /= avgLen;
      // Scale by 1/cos(half-angle) to maintain distance at corners
      const dot = n1x * avgNx + n1y * avgNy;
      const scale = dot > 0.1 ? distance / dot : distance;
      result.push({
        x: curr.x + avgNx * scale,
        y: curr.y + avgNy * scale,
      });
    } else {
      result.push({
        x: curr.x + n1x * distance,
        y: curr.y + n1y * distance,
      });
    }
  }

  return result;
}

/** Linearly interpolate between two outlines vertex-by-vertex. */
function blendOutlines(a: readonly Vec2[], b: readonly Vec2[], t: number): Vec2[] {
  const result: Vec2[] = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const pa = a[i];
    const pb = b[i];
    if (pa === undefined || pb === undefined) continue;
    result.push({
      x: pa.x + (pb.x - pa.x) * t,
      y: pa.y + (pb.y - pa.y) * t,
    });
  }
  return result;
}
