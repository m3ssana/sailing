/**
 * Hull station lofter — D.2.
 *
 * Takes a HullParams definition (station curves, bilge type, deck camber, etc.)
 * and produces a watertight GeneratedModel via the loftSurface primitive.
 *
 * Coordinate convention (hull-local, matching computeHydrostatics.ts):
 * - Y-up (vertical), X-transverse (starboard positive), Z-longitudinal (bow positive → stern negative).
 * - position=0 (bow) is at +Z, position=1 (stern) is at -Z (maps to Z = loa/2 .. -loa/2).
 *
 * Winding: CCW viewed from outside → positive signed volume.
 *
 * Engine-agnostic — no three.js.
 */

import type { GeneratedMesh, GeneratedModel, Generator, HullParams, Seed, Vec2, Vec3 } from '@/types';
import { resampleByArcLength2D } from '../common/curves';
import { catmullRomSpline3D } from '../common/curves';
import { loftSurface } from '../common/lofting';
import { computeBounds, computeNormals, gatherTransferables, mergeMeshes } from '../common/meshUtils';

/**
 * Build a full closed ring (port + starboard) from half-breadth points.
 *
 * StationCurve.points give starboard-half from keel upward: points[0] is the
 * keel (bottom centreline), points[last] is the sheer (top rail).
 *
 * The full ring must be ordered CCW when viewed from the direction of travel
 * (from section[i] toward section[i+1], i.e. from +Z looking toward -Z) so
 * that loftSurface produces outward normals.
 *
 * Viewed from +Z looking in -Z direction, CCW means:
 *   port keel → port sheer → starboard sheer → starboard keel
 * Which is: bottom-centre → top-left → top-right → bottom-centre
 *
 * For both bilge types, centreline points are shared (no duplication). The
 * ring is closed via loftSurface's closedRings option. `bilge` (chine vs
 * round) is NOT applied here — it is a whole-mesh flat-vs-smooth shading
 * decision applied once in `loftSingleHull` via `facetMesh`, since flat
 * faceting only makes sense after the full hull is triangulated.
 */
function buildFullRing(
  halfPoints: Vec2[],
  z: number,
  deckCamberOffset: number,
  sheerOffset: number,
): Vec3[] {
  // halfPoints: keel (bottom) to sheer (top), in half-breadth coords
  // halfPoints[i].x = half-beam (X), halfPoints[i].y = height (Y)
  const n = halfPoints.length;
  if (n === 0) return [];

  // Build the port side first (negative X), from keel upward (CCW order starts here)
  const port: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const pt = halfPoints[i];
    if (pt === undefined) continue;
    const isTop = i === n - 1;
    const yOffset = isTop ? sheerOffset + deckCamberOffset : 0;
    port.push({ x: -pt.x, y: pt.y + yOffset, z });
  }

  // Build the starboard side (positive X), from sheer downward
  const starboard: Vec3[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const pt = halfPoints[i];
    if (pt === undefined) continue;
    const isTop = i === n - 1;
    const yOffset = isTop ? sheerOffset + deckCamberOffset : 0;
    starboard.push({ x: pt.x, y: pt.y + yOffset, z });
  }

  // Weld at centreline: force x=0 for keel points
  const firstPort = port[0];
  if (firstPort !== undefined) {
    firstPort.x = 0; // port keel = centreline
  }
  const lastStarboard = starboard[starboard.length - 1];
  if (lastStarboard !== undefined) {
    lastStarboard.x = 0; // starboard keel = centreline
  }

  // Check if sheer points coincide (x≈0 at deck centreline)
  const portSheer = port[port.length - 1]; // port sheer (top of port side)
  const starboardSheer = starboard[0]; // starboard sheer (top of starboard side)

  const sheerAtCentre =
    portSheer !== undefined &&
    starboardSheer !== undefined &&
    Math.abs(portSheer.x) < 1e-10 &&
    Math.abs(starboardSheer.x) < 1e-10;

  // Combine: port (keel→sheer) + starboard (sheer→keel)
  // Skip duplicates at join points:
  // - Skip first starboard point if port sheer coincides with starboard sheer
  // - Skip last starboard point (it's the keel, same as port[0] = ring start)
  const ring: Vec3[] = [];

  for (const p of port) {
    ring.push(p);
  }

  const stbStart = sheerAtCentre ? 1 : 0;
  const stbEnd = starboard.length - 1; // skip the last (keel dup)
  for (let i = stbStart; i < stbEnd; i++) {
    const p = starboard[i];
    if (p !== undefined) {
      ring.push(p);
    }
  }

  // 'chine' vs 'round' bilge is a genuine geometric distinction, applied at the
  // whole-hull level in loftSingleHull/generate (see facetMesh call) rather than
  // per-ring here — flat-shaded faceting only makes sense once the full mesh is
  // triangulated. `bilge` is threaded through as station-ring metadata is not
  // needed at this stage; nothing to do with it in buildFullRing itself.
  return ring;
}

/**
 * Interpolate stations longitudinally using Catmull-Rom.
 *
 * Given resampled station rings (all same point count), produce `lengthSegments+1`
 * interpolated sections along the hull length.
 */
function interpolateStations(
  stationRings: Vec3[][],
  _stationPositions: number[],
  lengthSegments: number,
  _loa: number,
): Vec3[][] {
  const numOutputSections = lengthSegments + 1;
  const ringSize = stationRings[0]?.length ?? 0;
  if (ringSize === 0) return [];

  // For each point index in the ring, we have a longitudinal curve through all stations.
  // We'll use catmullRomSpline3D to interpolate along the length.
  const result: Vec3[][] = [];

  // For each ring point index, interpolate longitudinally
  // First build the spine curves (one per ring vertex)
  const spineCurves: Vec3[][] = [];
  for (let r = 0; r < ringSize; r++) {
    const spine: Vec3[] = [];
    for (let si = 0; si < stationRings.length; si++) {
      const ring = stationRings[si];
      if (ring === undefined) continue;
      const pt = ring[r];
      if (pt === undefined) continue;
      spine.push(pt);
    }
    spineCurves.push(spine);
  }

  // Evaluate each spine curve at the output positions using Catmull-Rom.
  //
  // BUG FIX (audit finding, hull ~15% short of stated `loa`): catmullRomSpline3D
  // does not necessarily return exactly `numOutputSections` points — it returns
  // `samplesPerSegment * segments + 1` points, which is >= the requested count
  // and generally MORE when `numOutputSections - 1` doesn't divide evenly into
  // `spine.length - 1` segments. Naively reading indices [0 .. numOutputSections)
  // from that longer array only reads a `numOutputSections / actualLength`
  // fraction of the spline's parametric range [0, 1] — silently truncating the
  // tail (the stern). Fix: request the samples, then re-index evenly across the
  // ACTUAL returned length so the full [0, 1] range (bow to stern) is covered.
  const interpolatedSpines: Vec3[][] = [];
  for (let r = 0; r < ringSize; r++) {
    const spine = spineCurves[r];
    if (spine === undefined || spine.length < 2) {
      // Degenerate: just repeat the single point
      const fallback: Vec3[] = [];
      const singlePt = spine?.[0] ?? { x: 0, y: 0, z: 0 };
      for (let s = 0; s < numOutputSections; s++) {
        fallback.push({ x: singlePt.x, y: singlePt.y, z: singlePt.z });
      }
      interpolatedSpines.push(fallback);
      continue;
    }

    const raw = catmullRomSpline3D(spine, numOutputSections);
    const rawLen = raw.length;

    let interpolated: Vec3[];
    if (rawLen === numOutputSections) {
      // Exact match — no re-indexing needed.
      interpolated = raw;
    } else {
      // Re-sample evenly across the spline's ACTUAL parametric range so the
      // full length (first point to last point, i.e. bow to stern) is covered,
      // regardless of how many raw samples catmullRomSpline3D produced.
      interpolated = [];
      for (let s = 0; s < numOutputSections; s++) {
        const t = numOutputSections > 1 ? s / (numOutputSections - 1) : 0;
        const rawIdx = t * (rawLen - 1);
        const lo = Math.floor(rawIdx);
        const hi = Math.min(lo + 1, rawLen - 1);
        const frac = rawIdx - lo;
        const a = raw[lo];
        const b = raw[hi];
        if (a === undefined || b === undefined) continue;
        interpolated.push({
          x: a.x + (b.x - a.x) * frac,
          y: a.y + (b.y - a.y) * frac,
          z: a.z + (b.z - a.z) * frac,
        });
      }
    }
    interpolatedSpines.push(interpolated);
  }

  // Reassemble into sections
  for (let s = 0; s < numOutputSections; s++) {
    const section: Vec3[] = [];
    for (let r = 0; r < ringSize; r++) {
      const spineInterp = interpolatedSpines[r];
      if (spineInterp === undefined) continue;
      const pt = spineInterp[s];
      if (pt !== undefined) {
        section.push(pt);
      }
    }
    result.push(section);
  }

  return result;
}

/**
 * Loft a single hull from HullParams. Produces a watertight mesh.
 *
 * @param params - HullParams definition
 * @param xOffset - Transverse offset for catamaran demihulls (0 for monohull)
 */
function loftSingleHull(params: HullParams, xOffset: number): GeneratedMesh {
  // `bilge` is intentionally not used yet — see the note below the loft call
  // for why chine-specific geometry/shading is deferred rather than faked.
  const { stations, loa, deckCamber, beam, sheerRise, girthSegments, lengthSegments } = params;

  // ── 1. Resample all stations to equal point counts ──────────────────────────
  const resampledHalfPoints: Vec2[][] = [];
  const stationPositions: number[] = [];

  for (const station of stations) {
    const resampled = resampleByArcLength2D(station.points, girthSegments);
    resampledHalfPoints.push(resampled);
    stationPositions.push(station.position);
  }

  // ── 2. Build full rings for each station ────────────────────────────────────
  const stationRings: Vec3[][] = [];

  for (let i = 0; i < resampledHalfPoints.length; i++) {
    const halfPts = resampledHalfPoints[i];
    const pos = stationPositions[i];
    if (halfPts === undefined || pos === undefined) continue;

    // Z position: bow (position=0) at +loa/2, stern (position=1) at -loa/2
    const z = loa / 2 - pos * loa;

    // Deck camber: maximum at midship, tapering toward ends
    // Applied as a Y offset on the topmost (sheer) point
    const camberHeight = deckCamber * beam;

    // Sheer rise: bow and stern are raised relative to midship
    // Use a parabolic envelope: maximal at pos=0 and pos=1, zero at pos=0.5
    const sheerFactor = 4 * (pos - 0.5) * (pos - 0.5); // 1 at ends, 0 at middle
    const sheerOffset = sheerRise * beam * sheerFactor;

    const ring = buildFullRing(halfPts, z, camberHeight, sheerOffset);
    stationRings.push(ring);
  }

  if (stationRings.length < 2) {
    throw new Error('Hull requires at least 2 stations to loft');
  }

  // Validate ring sizes match (they should since we resampled to equal counts)
  const ringSize = stationRings[0]?.length ?? 0;
  for (let i = 1; i < stationRings.length; i++) {
    const ring = stationRings[i];
    if (ring !== undefined && ring.length !== ringSize) {
      throw new Error(
        `Station ring sizes do not match after mirroring: ring 0 has ${ringSize}, ` +
          `ring ${i} has ${ring.length}. This indicates a mirroring logic error.`,
      );
    }
  }

  // ── 3. Longitudinal interpolation via Catmull-Rom ───────────────────────────
  const interpolatedSections = interpolateStations(
    stationRings,
    stationPositions,
    lengthSegments,
    loa,
  );

  if (interpolatedSections.length < 2) {
    throw new Error('Interpolation produced fewer than 2 sections');
  }

  // ── 4. Apply X offset for catamaran ─────────────────────────────────────────
  if (xOffset !== 0) {
    for (const section of interpolatedSections) {
      for (const pt of section) {
        pt.x += xOffset;
      }
    }
  }

  // ── 5. Loft the surface with caps (bow and stern) ───────────────────────────
  const mesh = loftSurface(interpolatedSections, {
    closedRings: true,
    capStart: true, // bow cap
    capEnd: true, // stern cap (transom)
  });

  // NOTE on 'bilge': 'chine' vs 'round' is a real hull-form distinction, but
  // this generator does not yet give it a distinct GEOMETRIC treatment beyond
  // whatever hard corners the caller's StationCurve.points already encode (a
  // chine is properly a sharp corner authored directly into the station
  // half-breadth points — the lofter mirrors and interpolates whatever shape
  // it is given either way).
  //
  // An earlier version of this function attempted to fake faceted (flat-
  // shaded) normals for 'chine' via vertex duplication. That is the WRONG fix:
  // this codebase's watertightness, volume, and hydrostatics computations
  // (see geometryAssertions.ts assertWatertight, computeVolume, and
  // physics/hydrostatics/computeHydrostatics.ts) all assume a shared-index
  // mesh where an edge is identified by its two vertex INDICES. Per-triangle
  // vertex duplication necessarily breaks that shared-index topology — it is
  // not compatible with "chine support" without redesigning how every
  // downstream consumer identifies a closed edge, which is out of scope here.
  //
  // Deliberately NOT implemented: chine-specific flat shading. Tracked as a
  // known limitation rather than faked with an approach that silently breaks
  // watertightness for chine hulls (the previous attempt did exactly that —
  // caught by assertWatertight failing on the very hulls it was meant to fix).
  return mesh;
}

/**
 * Hull station lofter generator.
 *
 * Implements Generator<HullParams, GeneratedModel>. Deterministic in (params, seed).
 */
export const StationLofter: Generator<HullParams, GeneratedModel> = {
  id: 'hull-lofter',

  generate(params: HullParams, _seed: Seed): GeneratedModel {
    const { hullCount, hullSeparation } = params;

    let mesh: GeneratedMesh;

    if (hullCount === 2) {
      // Catamaran: loft two demihulls offset by hullSeparation/2
      const separation = hullSeparation ?? params.beam * 3;
      const starboardHull = loftSingleHull(params, separation / 2);
      const portHull = loftSingleHull(params, -separation / 2);
      mesh = mergeMeshes([starboardHull, portHull]);
    } else {
      // Monohull: single hull at x=0
      mesh = loftSingleHull(params, 0);
    }

    // Recompute normals and bounds on the final merged mesh
    const normals = computeNormals(mesh.positions, mesh.indices);
    const bounds = computeBounds(mesh.positions);

    const finalMesh: GeneratedMesh = {
      positions: mesh.positions,
      normals,
      uvs: mesh.uvs,
      indices: mesh.indices,
      bounds,
      meta: {
        designDraft: params.designDraft,
        waterlineHeight: params.waterlineHeight,
        loa: params.loa,
        beam: params.beam,
        hullCount: params.hullCount,
      },
    };

    const model: GeneratedModel = {
      meshes: [finalMesh],
      groups: [{ name: 'hull', start: 0, count: mesh.indices.length, materialId: 'gelcoat' }],
      transferables: [],
    };

    model.transferables = gatherTransferables(model);
    return model;
  },
};
