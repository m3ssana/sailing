/**
 * Venue geometry registry — maps a venue id to its digitised coastline and
 * bathymetry polylines. Kept separate so both {@link buildVenueTerrain} and
 * {@link createVenueEnvironment} share one source of truth without the top-level
 * registry eagerly importing every data module.
 */

import type { Polyline } from '@/types';
import {
  NEWPORT_COASTLINES,
  NEWPORT_DEPTH_CONTOURS,
} from './data/newport.coastline';

/** Digitised coastline + bathymetry for a venue. */
export interface VenueGeometry {
  coastlines: readonly Polyline[];
  depthContours: readonly Polyline[];
}

/**
 * Look up the digitised geometry for a venue id.
 * @throws if no geometry is registered for the id.
 */
export function geometryForVenue(venueId: string): VenueGeometry {
  switch (venueId) {
    case 'newport':
      return { coastlines: NEWPORT_COASTLINES, depthContours: NEWPORT_DEPTH_CONTOURS };
    default:
      throw new Error(`No digitised coastline geometry registered for venue '${venueId}'.`);
  }
}
