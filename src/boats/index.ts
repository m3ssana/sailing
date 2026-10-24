/**
 * Boats module — the registry of boat definitions plus the factory that turns
 * a definition into a runnable simulation.
 *
 * Public API:
 *   - `getBoatDefinition(id)` — look up a registered BoatDefinition by id.
 *   - `listBoatDefinitions()` — all registered definitions.
 *   - `buildBoatSpec(def)` / `createBoatSimulation(def, opts?)` — the factory.
 *   - `DINGHY` — the ILCA/Laser definition (the "first sail" boat).
 */

import type { BoatDefinition } from '@/types';
import { DINGHY } from './definitions/dinghy';

export { DINGHY } from './definitions/dinghy';
export {
  buildBoatSpec,
  createBoatSimulation,
} from './BoatFactory';
export type {
  BuiltBoatSpec,
  BoatSimulationBundle,
  CreateBoatSimulationOptions,
} from './BoatFactory';

/** Internal registry, keyed by definition id. */
const _registry = new Map<string, BoatDefinition>();

function register(def: BoatDefinition): void {
  _registry.set(def.id, def);
}

// Register all built-in boats.
register(DINGHY);

/** Look up a boat definition by id. Returns undefined if not registered. */
export function getBoatDefinition(id: string): BoatDefinition | undefined {
  return _registry.get(id);
}

/** All registered boat definitions. */
export function listBoatDefinitions(): BoatDefinition[] {
  return Array.from(_registry.values());
}
