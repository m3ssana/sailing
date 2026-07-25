/**
 * Triangle clipping against a horizontal waterline plane.
 *
 * The waterline is at y = waterlineHeight. A vertex is "below" (submerged)
 * when its y < waterlineHeight.
 *
 * We handle the three cases:
 * - All 3 vertices below → triangle is fully submerged
 * - 1 vertex below → clip to one smaller triangle
 * - 2 vertices below → clip to a quad (two triangles)
 *
 * The clipping is exact (linear interpolation along the edge to the waterline),
 * which is why a half-submerged triangle contributes the analytically correct
 * half-volume rather than either 0 or the full triangle.
 *
 * Output writes into caller-provided arrays to stay allocation-free in
 * the righting-curve sweep where this is called hundreds of times.
 */


/**
 * A clipped triangle returned by the waterline clipper. Vertices are in the
 * same coordinate system as the input — hull-local or world, depending on caller.
 */
export interface ClippedTriangle {
  v0x: number; v0y: number; v0z: number;
  v1x: number; v1y: number; v1z: number;
  v2x: number; v2y: number; v2z: number;
}

/** Pre-allocated output buffer: at most 2 triangles per input triangle. */
const _clipped: ClippedTriangle[] = [
  { v0x: 0, v0y: 0, v0z: 0, v1x: 0, v1y: 0, v1z: 0, v2x: 0, v2y: 0, v2z: 0 },
  { v0x: 0, v0y: 0, v0z: 0, v1x: 0, v1y: 0, v1z: 0, v2x: 0, v2y: 0, v2z: 0 },
];

/**
 * Clip a triangle against the waterline. Returns the number of output
 * triangles (0, 1, or 2) that represent the SUBMERGED portion.
 *
 * The output triangles can be read from the module-scope `getClippedTriangle(index)`.
 *
 * @param ax,ay,az - first vertex
 * @param bx,by,bz - second vertex
 * @param cx,cy,cz - third vertex
 * @param wl - waterline height (y coordinate)
 * @returns Number of submerged triangles (0, 1, or 2)
 */
export function clipTriangleAgainstWaterline(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  wl: number,
): number {
  const aBelow = ay < wl;
  const bBelow = by < wl;
  const cBelow = cy < wl;

  const belowCount = (aBelow ? 1 : 0) + (bBelow ? 1 : 0) + (cBelow ? 1 : 0);

  if (belowCount === 0) return 0;

  if (belowCount === 3) {
    // Fully submerged — output the original triangle
    const t = _clipped[0];
    if (t === undefined) return 0;
    t.v0x = ax; t.v0y = ay; t.v0z = az;
    t.v1x = bx; t.v1y = by; t.v1z = bz;
    t.v2x = cx; t.v2y = cy; t.v2z = cz;
    return 1;
  }

  if (belowCount === 1) {
    // One vertex below: clip to a single triangle.
    // Re-order so the submerged vertex is 'p0'.
    let p0x: number, p0y: number, p0z: number;
    let p1x: number, p1y: number, p1z: number;
    let p2x: number, p2y: number, p2z: number;

    if (aBelow) {
      p0x = ax; p0y = ay; p0z = az;
      p1x = bx; p1y = by; p1z = bz;
      p2x = cx; p2y = cy; p2z = cz;
    } else if (bBelow) {
      p0x = bx; p0y = by; p0z = bz;
      p1x = cx; p1y = cy; p1z = cz;
      p2x = ax; p2y = ay; p2z = az;
    } else {
      p0x = cx; p0y = cy; p0z = cz;
      p1x = ax; p1y = ay; p1z = az;
      p2x = bx; p2y = by; p2z = bz;
    }

    // Interpolate edges p0→p1 and p0→p2 to the waterline
    const t01 = (wl - p0y) / (p1y - p0y);
    const t02 = (wl - p0y) / (p2y - p0y);

    const i01x = p0x + t01 * (p1x - p0x);
    const i01z = p0z + t01 * (p1z - p0z);

    const i02x = p0x + t02 * (p2x - p0x);
    const i02z = p0z + t02 * (p2z - p0z);

    const out = _clipped[0];
    if (out === undefined) return 0;
    out.v0x = p0x; out.v0y = p0y; out.v0z = p0z;
    out.v1x = i01x; out.v1y = wl; out.v1z = i01z;
    out.v2x = i02x; out.v2y = wl; out.v2z = i02z;
    return 1;
  }

  // belowCount === 2: two vertices below. Clip to a quad (2 triangles).
  // Re-order so the ABOVE vertex is 'p0'.
  let p0x: number, p0y: number, p0z: number;
  let p1x: number, p1y: number, p1z: number;
  let p2x: number, p2y: number, p2z: number;

  if (!aBelow) {
    p0x = ax; p0y = ay; p0z = az;
    p1x = bx; p1y = by; p1z = bz;
    p2x = cx; p2y = cy; p2z = cz;
  } else if (!bBelow) {
    p0x = bx; p0y = by; p0z = bz;
    p1x = cx; p1y = cy; p1z = cz;
    p2x = ax; p2y = ay; p2z = az;
  } else {
    p0x = cx; p0y = cy; p0z = cz;
    p1x = ax; p1y = ay; p1z = az;
    p2x = bx; p2y = by; p2z = bz;
  }

  // Interpolate edges p0→p1 and p0→p2 to the waterline (from the above vertex down)
  const t01 = (wl - p0y) / (p1y - p0y);
  const t02 = (wl - p0y) / (p2y - p0y);

  const i01x = p0x + t01 * (p1x - p0x);
  const i01z = p0z + t01 * (p1z - p0z);

  const i02x = p0x + t02 * (p2x - p0x);
  const i02z = p0z + t02 * (p2z - p0z);

  // First triangle: i01, p1, p2
  const out0 = _clipped[0];
  if (out0 === undefined) return 0;
  out0.v0x = i01x; out0.v0y = wl; out0.v0z = i01z;
  out0.v1x = p1x; out0.v1y = p1y; out0.v1z = p1z;
  out0.v2x = p2x; out0.v2y = p2y; out0.v2z = p2z;

  // Second triangle: i01, p2, i02
  const out1 = _clipped[1];
  if (out1 === undefined) return 0;
  out1.v0x = i01x; out1.v0y = wl; out1.v0z = i01z;
  out1.v1x = p2x; out1.v1y = p2y; out1.v1z = p2z;
  out1.v2x = i02x; out1.v2y = wl; out1.v2z = i02z;

  return 2;
}

/** Retrieve a clipped triangle by index (0 or 1). */
export function getClippedTriangle(index: number): ClippedTriangle | undefined {
  return _clipped[index];
}

/**
 * Compute the signed volume contribution of a triangle using the divergence theorem.
 * V = (1/6) * v0 · (v1 × v2) for the tetrahedron formed with the origin.
 */
export function triangleSignedVolume(
  v0x: number, v0y: number, v0z: number,
  v1x: number, v1y: number, v1z: number,
  v2x: number, v2y: number, v2z: number,
): number {
  const crossX = v1y * v2z - v1z * v2y;
  const crossY = v1z * v2x - v1x * v2z;
  const crossZ = v1x * v2y - v1y * v2x;
  return (v0x * crossX + v0y * crossY + v0z * crossZ) / 6;
}

/**
 * Compute the volume centroid contribution of a triangle.
 * The centroid of the tetrahedron (origin, v0, v1, v2) is at (v0+v1+v2)/4,
 * weighted by its signed volume.
 */
export function triangleCentroidContribution(
  v0x: number, v0y: number, v0z: number,
  v1x: number, v1y: number, v1z: number,
  v2x: number, v2y: number, v2z: number,
  outX: { value: number },
  outY: { value: number },
  outZ: { value: number },
): number {
  const vol = triangleSignedVolume(v0x, v0y, v0z, v1x, v1y, v1z, v2x, v2y, v2z);
  const cx = (v0x + v1x + v2x) * 0.25;
  const cy = (v0y + v1y + v2y) * 0.25;
  const cz = (v0z + v1z + v2z) * 0.25;
  outX.value += vol * cx;
  outY.value += vol * cy;
  outZ.value += vol * cz;
  return vol;
}

/** Compute the area of a triangle from its three vertices. */
export function triangleArea(
  v0x: number, v0y: number, v0z: number,
  v1x: number, v1y: number, v1z: number,
  v2x: number, v2y: number, v2z: number,
): number {
  const e1x = v1x - v0x;
  const e1y = v1y - v0y;
  const e1z = v1z - v0z;
  const e2x = v2x - v0x;
  const e2y = v2y - v0y;
  const e2z = v2z - v0z;
  const cx = e1y * e2z - e1z * e2y;
  const cy = e1z * e2x - e1x * e2z;
  const cz = e1x * e2y - e1y * e2x;
  return Math.sqrt(cx * cx + cy * cy + cz * cz) * 0.5;
}
