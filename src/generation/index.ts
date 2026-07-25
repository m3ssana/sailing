/**
 * Generation module — procedural geometry system.
 *
 * Public API for the generation harness. Individual generators are in
 * subdirectories and register themselves when imported.
 */

export { registerGenerator, getGenerator, hasGenerator, clearRegistry } from './GeneratorRegistry';
export { WorkerPool, derivePoolSize } from './WorkerPool';
export type { WorkerRequest, WorkerResponse } from './WorkerPool';
export { deriveCacheKey, getCached, putCached, clearCache, CACHE_VERSION } from './cache';
export {
  runGenerationPhase,
  runGenerationPhaseDirect,
} from './GenerationPhase';
export type {
  GenerationJob,
  GenerationBatchResult,
  GenerationPhaseOptions,
} from './GenerationPhase';
export {
  computeBounds,
  computeNormals,
  mergeMeshes,
  gatherTransferables,
} from './common/meshUtils';
export { BoxGenerator } from './common/BoxGenerator';
export type { BoxParams } from './common/BoxGenerator';
export { TerrainBuilder } from './terrain/TerrainBuilder';
export { StationLofter } from './hull/StationLofter';
export { generateWindInfluenceField } from './wind/WindInfluenceField';
export type { WindInfluenceFieldParams, WindInfluenceFieldResult } from './wind/WindInfluenceField';
export { MooredFleetGenerator } from './ambient/MooredFleet';
export type { MooredFleetParams } from './ambient/MooredFleet';
export { NavigationBuoyGenerator } from './ambient/NavigationBuoy';
export type { NavigationBuoyParams, BuoyKind } from './ambient/NavigationBuoy';
export { HarbourFurnitureGenerator } from './ambient/HarbourFurniture';
export type { HarbourFurnitureParams, FurnitureKind } from './ambient/HarbourFurniture';
export { SignatureVesselGenerator } from './ambient/SignatureVessels';
export type { SignatureVesselParams, SignatureVesselKind } from './ambient/SignatureVessels';
export { WildlifeGenerator } from './ambient/Wildlife';
export type { WildlifeParams, WildlifeKind } from './ambient/Wildlife';
