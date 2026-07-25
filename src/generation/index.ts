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
