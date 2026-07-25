/**
 * Generation phase orchestrator — batches generation jobs with aggregate
 * progress reporting suitable for a loading screen.
 *
 * Coordinates multiple generation jobs (hull, rig, sails, terrain, landmarks)
 * and reports overall progress. Designed for the venue+boat loading path where
 * the target budget is <3 seconds (requirement 8.7).
 *
 * Emits progress via a callback (the core EventBus is not yet available —
 * Phase 0.3 core/events hasn't shipped — so we use a plain callback that
 * the integration layer can wire to the bus).
 *
 * Engine-agnostic — no three.js.
 */

import type { GeneratedModel, GenerationProgress, Seed } from '@/types';
import { getCached, putCached } from './cache';
import { WorkerPool } from './WorkerPool';

/** A single job specification in a generation batch. */
export interface GenerationJob {
  /** Human-readable stage name, e.g. "Hull" or "Terrain". */
  stage: string;
  /** The generator id to invoke. */
  generatorId: string;
  /** Parameters for the generator. */
  params: unknown;
  /** Seed for deterministic generation. */
  seed: Seed;
  /** Priority hint: lower numbers run first. Default 0. */
  priority?: number;
}

/** Result of a completed generation batch. */
export interface GenerationBatchResult {
  /** Results keyed by stage name. */
  models: Map<string, GeneratedModel>;
  /** Total wall-clock time in milliseconds. */
  elapsed: number;
  /** Number of cache hits (skipped generation). */
  cacheHits: number;
}

/** Options for configuring the generation phase. */
export interface GenerationPhaseOptions {
  /** Progress callback, called as jobs complete. */
  onProgress?: (progress: GenerationProgress) => void;
  /** Worker pool to use. If not provided, creates a temporary one. */
  pool?: WorkerPool;
  /** Whether to use the IndexedDB cache. Default true. */
  useCache?: boolean;
}

/**
 * Run a batch of generation jobs with progress reporting.
 *
 * Jobs are sorted by priority and dispatched to the worker pool. Cache hits
 * skip the worker entirely. Progress is reported as a fraction of total jobs.
 *
 * In the browser, this uses real workers. In tests (Node), the worker pool
 * isn't available — use `runGenerationPhaseDirect` instead for unit testing
 * the orchestration logic without workers.
 */
export async function runGenerationPhase(
  jobs: GenerationJob[],
  options: GenerationPhaseOptions = {},
): Promise<GenerationBatchResult> {
  const { onProgress, useCache = true } = options;
  const start = performance.now();

  // Sort by priority (lower first)
  const sorted = [...jobs].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

  const models = new Map<string, GeneratedModel>();
  let completed = 0;
  let cacheHits = 0;
  const total = sorted.length;

  // Create a temporary pool if one wasn't provided
  const ownPool = !options.pool;
  const pool = options.pool ?? new WorkerPool();

  function reportProgress(stage: string): void {
    if (onProgress) {
      onProgress({
        stage,
        progress: total === 0 ? 1 : completed / total,
        message: `Generating ${stage}...`,
      });
    }
  }

  try {
    // Process jobs — check cache first, then dispatch to workers
    const pending: Array<Promise<void>> = [];

    for (const job of sorted) {
      const jobPromise = (async () => {
        // Try cache first
        if (useCache) {
          try {
            const cached = await getCached(job.generatorId, job.params, job.seed);
            if (cached) {
              models.set(job.stage, cached);
              cacheHits++;
              completed++;
              reportProgress(job.stage);
              return;
            }
          } catch {
            // Cache miss or error — proceed to generation
          }
        }

        // Dispatch to worker pool
        const { promise } = pool.submit(job.generatorId, job.params, job.seed, (progress) => {
          if (onProgress) {
            // Blend per-job progress into overall progress
            const baseProgress = completed / total;
            const jobFraction = 1 / total;
            onProgress({
              stage: job.stage,
              progress: baseProgress + progress.progress * jobFraction,
              message: progress.message,
            });
          }
        });

        const model = await promise;
        models.set(job.stage, model);

        // Cache the result asynchronously (don't await — caching is best-effort)
        if (useCache) {
          void putCached(job.generatorId, job.params, job.seed, model);
        }

        completed++;
        reportProgress(job.stage);
      })();

      pending.push(jobPromise);
    }

    await Promise.all(pending);
  } finally {
    if (ownPool) {
      pool.dispose();
    }
  }

  // Final progress report
  if (onProgress) {
    onProgress({
      stage: 'complete',
      progress: 1,
      message: 'Generation complete',
    });
  }

  return {
    models,
    elapsed: performance.now() - start,
    cacheHits,
  };
}

// ─── Direct execution (for testing without workers) ──────────────────────────

/**
 * Run generation jobs directly on the main thread, bypassing the worker pool.
 *
 * This is for unit testing the orchestration logic in Node.js where web workers
 * aren't available. It exercises the same cache-check → generate → store flow.
 *
 * The generator map uses a broad type to accept generators with any params type.
 * Internally it passes `job.params` through — the caller is responsible for
 * matching job params to the correct generator.
 */
export async function runGenerationPhaseDirect(
  jobs: GenerationJob[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  generators: Map<string, { generate: (params: any, seed: Seed) => GeneratedModel }>,
  options: Omit<GenerationPhaseOptions, 'pool'> = {},
): Promise<GenerationBatchResult> {
  const { onProgress, useCache = false } = options;
  const start = performance.now();

  const sorted = [...jobs].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  const models = new Map<string, GeneratedModel>();
  let completed = 0;
  let cacheHits = 0;
  const total = sorted.length;

  for (const job of sorted) {
    // Try cache (only in browser, but allows testing the path)
    if (useCache) {
      try {
        const cached = await getCached(job.generatorId, job.params, job.seed);
        if (cached) {
          models.set(job.stage, cached);
          cacheHits++;
          completed++;
          continue;
        }
      } catch {
        // proceed to generation
      }
    }

    const generator = generators.get(job.generatorId);
    if (!generator) {
      throw new Error(`Unknown generator: ${job.generatorId}`);
    }

    const model = generator.generate(job.params, job.seed);
    models.set(job.stage, model);
    completed++;

    if (onProgress) {
      onProgress({
        stage: job.stage,
        progress: total === 0 ? 1 : completed / total,
        message: `Generated ${job.stage}`,
      });
    }
  }

  if (onProgress) {
    onProgress({
      stage: 'complete',
      progress: 1,
      message: 'Generation complete',
    });
  }

  return {
    models,
    elapsed: performance.now() - start,
    cacheHits,
  };
}
