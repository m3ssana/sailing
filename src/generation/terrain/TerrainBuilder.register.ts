/**
 * Side-effect module: registers TerrainBuilder in the generator registry.
 *
 * Imported by the geometry worker so the terrain generator is available for jobs.
 * Separate from TerrainBuilder.ts itself so that test code can import the
 * generator without triggering registration side effects.
 *
 * Note: The registry expects Generator<unknown, GeneratedModel> but TerrainBuilder
 * produces GeneratedTerrain (which has a different shape). We cast through unknown
 * because the registry is heterogeneous and callers know the concrete type.
 */

import { registerGenerator } from '../GeneratorRegistry';
import { TerrainBuilder } from './TerrainBuilder';

registerGenerator(TerrainBuilder as unknown as Parameters<typeof registerGenerator>[0]);
