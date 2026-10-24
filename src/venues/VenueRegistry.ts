/**
 * Venue registry — the single lookup for venue definitions.
 *
 * Venues are plain {@link VenueDefinition} data; adding one is a data module
 * plus an entry here. No three.js, no side effects at import time beyond
 * building the id → definition map.
 */

import type { VenueDefinition } from '@/types';
import { NEWPORT } from './definitions/newport';

/** All registered venues, in display order. */
const VENUES: readonly VenueDefinition[] = [NEWPORT];

/** id → definition, built once. */
const BY_ID: ReadonlyMap<string, VenueDefinition> = new Map(
  VENUES.map((v) => [v.id, v]),
);

/**
 * Look up a venue by id.
 * @returns the definition, or `undefined` if no venue has that id.
 */
export function getVenue(id: string): VenueDefinition | undefined {
  return BY_ID.get(id);
}

/**
 * Look up a venue by id, throwing if it is not registered.
 * Convenience for call sites that know the id must exist.
 */
export function requireVenue(id: string): VenueDefinition {
  const venue = BY_ID.get(id);
  if (venue === undefined) {
    throw new Error(`Unknown venue id '${id}'. Registered: ${listVenueIds().join(', ')}.`);
  }
  return venue;
}

/** List all registered venue definitions, in display order. */
export function listVenues(): readonly VenueDefinition[] {
  return VENUES;
}

/** List all registered venue ids. */
export function listVenueIds(): readonly string[] {
  return VENUES.map((v) => v.id);
}
