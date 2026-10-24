/**
 * `src/venues` — public API.
 *
 * Venue definitions (pure data), the registry, the headless terrain builder, the
 * environment wiring, and the lat/lon ↔ venue-local projection. No three.js.
 */

// Registry.
export { getVenue, requireVenue, listVenues, listVenueIds } from './VenueRegistry';

// Definitions.
export { NEWPORT } from './definitions/newport';
export {
  NEWPORT_WATER,
  NEWPORT_WIND_PROFILE,
  NEWPORT_TIDE,
  NEWPORT_GRADE,
  NEWPORT_AMBIENCE,
  NEWPORT_CLIMATOLOGY,
  NEWPORT_LANDMARKS,
  NEWPORT_TRAFFIC,
  NEWPORT_WL_COURSE,
  srgbHexToLinear,
} from './definitions/newport';

// Coastline data + provenance.
export {
  NEWPORT_COASTLINES,
  NEWPORT_DEPTH_CONTOURS,
  NEWPORT_COASTLINE_ATTRIBUTION,
  NEWPORT_FORT_ADAMS,
  NEWPORT_HALF_EXTENT,
} from './data/newport.coastline';

// Geometry registry.
export { geometryForVenue } from './geometry';
export type { VenueGeometry } from './geometry';

// Terrain build.
export {
  buildVenueTerrain,
  DEFAULT_TERRAIN_RESOLUTION,
} from './buildVenueTerrain';
export type { VenueTerrain } from './buildVenueTerrain';

// Environment wiring.
export { createVenueEnvironment } from './createVenueEnvironment';
export type {
  VenueEnvironment,
  CreateVenueEnvironmentOptions,
} from './createVenueEnvironment';

// Projection.
export {
  latLonToVenueLocal,
  venueLocalToLatLon,
  projectionCentreOf,
  metresPerDegreeLongitude,
  EARTH_MEAN_RADIUS_M,
  METRES_PER_DEGREE_LATITUDE,
} from './projection';
export type { ProjectionCentre } from './projection';
