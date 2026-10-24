/**
 * Local tangent-plane (equirectangular) projection between geographic
 * coordinates and venue-local metres.
 *
 * ## Why equirectangular about the venue centre
 *
 * A sailing venue spans a few kilometres. Over that extent an equirectangular
 * projection centred on the venue — scaling longitude by `cos(centreLatitude)` —
 * is accurate to well under a metre, far below the fidelity of the hand-digitised
 * coastline it serves. It is also exactly invertible in closed form, which the
 * round-trip test relies on.
 *
 * ## Conventions
 *
 * - Output `Vec2`: `x` = east metres, `y` = south metres (the engine's
 *   ground-plane convention, matching world-space +X east / +Z south).
 * - North (increasing latitude) therefore maps to DECREASING `y`.
 * - East (increasing longitude) maps to INCREASING `x`.
 * - Origin `(x, y) = (0, 0)` is the venue centre `(venue.coordinates)`.
 *
 * ## Earth radius
 *
 * Uses the IUGG mean Earth radius R₁ = 6371008.8 m. With it, one degree of
 * latitude is `R · π/180 ≈ 111195 m`, i.e. 111.195 km — within 0.005% of the
 * commonly quoted 111.19 km. The 1°-latitude test checks 111.19 km ± 0.2%.
 */

import type { Vec2 } from '@/types';
import type { VenueDefinition } from '@/types';

/** IUGG mean Earth radius R₁, metres. */
export const EARTH_MEAN_RADIUS_M = 6371008.8;

const DEG = Math.PI / 180;

/** Metres per degree of latitude (constant for the spherical model). */
export const METRES_PER_DEGREE_LATITUDE = EARTH_MEAN_RADIUS_M * DEG;

/** The subset of a venue the projection needs: its centre coordinates. */
export interface ProjectionCentre {
  coordinates: { latitude: number; longitude: number };
}

/**
 * Metres per degree of longitude at the venue's centre latitude.
 * Longitude lines converge toward the poles, hence the `cos(lat)` factor.
 */
export function metresPerDegreeLongitude(centreLatitudeDeg: number): number {
  return EARTH_MEAN_RADIUS_M * DEG * Math.cos(centreLatitudeDeg * DEG);
}

/**
 * Project a geographic coordinate to venue-local metres (x east, y south),
 * origin at the venue centre.
 */
export function latLonToVenueLocal(
  latitude: number,
  longitude: number,
  venue: ProjectionCentre,
  out?: Vec2,
): Vec2 {
  const latC = venue.coordinates.latitude;
  const lonC = venue.coordinates.longitude;
  const mPerLon = metresPerDegreeLongitude(latC);

  const x = (longitude - lonC) * mPerLon;
  // North (lat increasing) → −y, because +y is south.
  const y = -(latitude - latC) * METRES_PER_DEGREE_LATITUDE;

  if (out) {
    out.x = x;
    out.y = y;
    return out;
  }
  return { x, y };
}

/** Inverse of {@link latLonToVenueLocal}: venue-local metres → lat/lon degrees. */
export function venueLocalToLatLon(
  local: Vec2,
  venue: ProjectionCentre,
): { latitude: number; longitude: number } {
  const latC = venue.coordinates.latitude;
  const lonC = venue.coordinates.longitude;
  const mPerLon = metresPerDegreeLongitude(latC);

  const longitude = lonC + local.x / mPerLon;
  const latitude = latC - local.y / METRES_PER_DEGREE_LATITUDE;

  return { latitude, longitude };
}

/** Narrowing helper so the public API can accept a full {@link VenueDefinition}. */
export function projectionCentreOf(venue: VenueDefinition): ProjectionCentre {
  return { coordinates: venue.coordinates };
}
