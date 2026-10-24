/**
 * Newport, Rhode Island — hand-digitised coastline and bathymetry.
 *
 * ## Provenance (read this before trusting any coordinate here)
 *
 * These polylines are **hand-digitised approximations**, drawn from the author's
 * general geographic knowledge of Narragansett Bay's East Passage near Newport
 * Harbor and Fort Adams. They are NOT surveyed, NOT sourced from NOAA ENC charts,
 * and NOT traced from any copyrighted vector dataset. They are deliberately
 * low-vertex caricatures whose only jobs are:
 *   - to put land roughly where land is and water roughly where water is, so the
 *     TerrainBuilder land mask, shore-distance field and bathymetry are plausible;
 *   - to keep the sailable East Passage channel open and deep between the islands.
 *
 * Do not present these as chart-accurate. Shoreline detail, island size, and the
 * exact channel edges are simplified by tens to hundreds of metres. For a
 * production venue these should be replaced with properly licensed data (e.g.
 * NOAA ENC / OpenStreetMap coastline under its ODbL attribution), at which point
 * {@link NEWPORT_COASTLINE_ATTRIBUTION} must be updated accordingly.
 *
 * ## Coordinate system
 *
 * All points are in **venue-local metres**, origin at the venue centre
 * (41.4901 N, -71.3128 W) on the Newport (Aquidneck) waterfront, +X east,
 * +Z south — i.e. `Vec2 { x = east, y = south }`. This matches the world-space
 * convention (+X east, +Z south) and the Vec2 ground-plane convention used
 * throughout the engine. In this frame the East Passage, Goat Island, Rose
 * Island, Fort Adams and the Conanicut (Jamestown) shore all lie WEST (−X) of
 * the origin; Aquidneck Island's land fills the EAST (+X) margin.
 *
 * Every coordinate below was produced by projecting an approximate real lat/lon
 * through the SAME equirectangular tangent-plane projection the venue uses
 * ({@link latLonToVenueLocal}), so the digitised geometry and the projection are
 * consistent by construction.
 *
 * ## Ring winding (IMPORTANT — enforced by a test)
 *
 * `TerrainBuilder.signedArea2D` treats, in this x-east / y-south Vec2 space:
 *   - **negative** signed area → OUTER ring → land inside;
 *   - **positive** signed area → HOLE ring → water inside (lagoon).
 *
 * Every island here is a solid landmass, so every ring is authored with
 * **negative** signed area. The test `coastline winding is consistent` asserts
 * this, and a separate test asserts `closed: true` on every ring — because
 * TerrainBuilder silently ignores open polylines (a documented Stream-D
 * follow-up we deliberately guard against here).
 */

import type { Polyline, Vec2 } from '@/types';

/** Attribution / provenance string surfaced in {@link VenueDefinition.coastlineAttribution}. */
export const NEWPORT_COASTLINE_ATTRIBUTION =
  'Coastline and bathymetry hand-digitised (approximate, not chart-accurate) from ' +
  'general geographic knowledge of Narragansett Bay. Not derived from NOAA ENC or ' +
  'any licensed vector dataset. For illustration only — do not use for navigation.';

/**
 * Half-extent of the sailable venue box, metres. The venue spans
 * [-HALF_EXTENT, +HALF_EXTENT] on both axes (a 12 km square centred on the
 * Newport waterfront), which contains the East Passage, Fort Adams, Goat Island,
 * Rose Island, the near Conanicut (Jamestown) shore and the southern approach to
 * the Claiborne Pell Bridge.
 */
export const NEWPORT_HALF_EXTENT = 6000;

/** Build a closed ring from raw [x, z] pairs (first point not duplicated). */
function closedRing(pairs: ReadonlyArray<readonly [number, number]>): Polyline {
  const points: Vec2[] = pairs.map(([x, y]) => ({ x, y }));
  return { points, closed: true };
}

// ─── Islands (outer rings, land inside → negative signed area) ────────────────

/** Goat Island — elongated N–S island off the Newport waterfront. */
const GOAT_ISLAND = closedRing([
  [-1349, 100],
  [-1333, 322],
  [-1249, 478],
  [-1116, 434],
  [-1058, 256],
  [-1083, 33],
  [-1183, -78],
  [-1308, -44],
]);

/** Rose Island — smaller oval island north-west of Goat Island, mid-passage. */
const ROSE_ISLAND = closedRing([
  [-2082, -434],
  [-1932, -322],
  [-1782, -434],
  [-1766, -634],
  [-1891, -745],
  [-2057, -678],
]);

/**
 * Aquidneck Island west shore (Newport side) — the EASTERN land margin of the
 * venue, bulging west at the Fort Adams peninsula. The ring runs down the
 * sailable (western) shoreline, then closes off-map far to the east so the whole
 * eastern margin reads as solid land.
 */
const AQUIDNECK_WEST_SHORE = closedRing([
  // North end of the Newport waterfront, running south.
  [300, -6000],
  [120, -3600],
  [-20, -1800],
  [-120, -700],
  [-160, -120],
  // Fort Adams peninsula bulges WEST into the passage (apex near -2182,1290).
  [-430, 760],
  [-1200, 1040],
  [-2182, 1290],
  [-1500, 1560],
  [-700, 1700],
  // South of Fort Adams the shore falls back east toward Brenton.
  [-300, 2400],
  [120, 3600],
  [600, 5200],
  [900, 6000],
  // Close off-map to the east — solid land fills the eastern margin.
  [6000, 6000],
  [6000, -6000],
]);

/**
 * Conanicut Island (Jamestown) east shore — the WESTERN land margin of the
 * venue. The sailable shore runs north–south on the eastern edge of the island
 * (around x ≈ −4600), and the ring closes off-map to the west.
 */
const CONANICUT_EAST_SHORE = closedRing([
  [-6000, -6000],
  [-6000, 6000],
  [-5100, 6000],
  [-4900, 4200],
  [-4700, 2400],
  [-4600, 800],
  [-4650, -400],
  [-4550, -1800],
  [-4450, -3600],
  [-4300, -6000],
]);

/** All coastline rings, in the order TerrainBuilder will rasterise them. */
export const NEWPORT_COASTLINES: readonly Polyline[] = [
  AQUIDNECK_WEST_SHORE,
  CONANICUT_EAST_SHORE,
  GOAT_ISLAND,
  ROSE_ISLAND,
];

// ─── Depth contours (metres, positive = depth below MSL) ──────────────────────
//
// The East Passage main channel is genuinely deep (~15–30 m) down its centre
// (around x ≈ −3000, between the islands and the Jamestown shore); it shoals
// toward both shores and near Fort Adams, with 3–5 m flats along the harbour
// edges. Same hand-digitised approximation class as the coastline.

function depthContour(
  depth: number,
  pairs: ReadonlyArray<readonly [number, number]>,
): Polyline {
  const points: Vec2[] = pairs.map(([x, y]) => ({ x, y }));
  return { points, closed: false, depth };
}

/** 4 m flats hugging the Newport (east) harbour shore and the Fort Adams shoal. */
const CONTOUR_4M_EAST = depthContour(4, [
  [-500, -2200],
  [-650, -800],
  [-760, 200],
  [-1600, 1290], // Fort Adams shoal — shallow water off the fort.
  [-900, 2200],
  [-500, 3600],
]);

/** 4 m flats along the Conanicut (west) shore. */
const CONTOUR_4M_WEST = depthContour(4, [
  [-4100, -2200],
  [-4250, -600],
  [-4350, 800],
  [-4450, 2400],
  [-4650, 4200],
]);

/** 10 m mid-slope on the Newport (east) side of the channel. */
const CONTOUR_10M_EAST = depthContour(10, [
  [-1600, -2600],
  [-1900, -1000],
  [-2100, 200],
  [-2300, 1800],
  [-2200, 3600],
]);

/** 10 m mid-slope on the Conanicut (west) side of the channel. */
const CONTOUR_10M_WEST = depthContour(10, [
  [-3700, -2600],
  [-3850, -1000],
  [-3950, 400],
  [-4050, 2000],
  [-4200, 3800],
]);

/** 20 m — the deep channel axis running north–south down the East Passage. */
const CONTOUR_20M_AXIS = depthContour(20, [
  [-2900, -3200],
  [-2950, -1600],
  [-2900, 0],
  [-2850, 1600],
  [-2900, 3200],
]);

/** 28 m — the deepest hole, a short reach mid-passage. */
const CONTOUR_28M_HOLE = depthContour(28, [
  [-2900, -1200],
  [-2880, -400],
  [-2900, 400],
  [-2880, 1200],
]);

/** All bathymetric contours, shallow→deep. */
export const NEWPORT_DEPTH_CONTOURS: readonly Polyline[] = [
  CONTOUR_4M_EAST,
  CONTOUR_4M_WEST,
  CONTOUR_10M_EAST,
  CONTOUR_10M_WEST,
  CONTOUR_20M_AXIS,
  CONTOUR_28M_HOLE,
];

/**
 * Digitised real-world reference positions, in venue-local metres, used by tests
 * that check the lat/lon projection lands where we drew things.
 *
 * Fort Adams sits on the Newport-side peninsula at roughly 41.4785 N, -71.3390 W.
 * Its digitised local position is the apex of the Fort Adams bulge in
 * {@link AQUIDNECK_WEST_SHORE}, placed at the exact projection of that lat/lon so
 * the projection test can check `latLonToVenueLocal(FortAdams)` lands on it.
 */
export const NEWPORT_FORT_ADAMS = {
  latitude: 41.4785,
  longitude: -71.339,
  /** Hand-placed local position of the fort apex (the western bulge). */
  local: { x: -2182, y: 1290 } as Vec2,
} as const;
