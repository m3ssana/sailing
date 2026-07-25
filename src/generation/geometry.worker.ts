/**
 * Web worker entry point for procedural geometry generation.
 *
 * Receives {generatorId, params, seed}, looks up the generator in the registry,
 * runs it, and posts back the GeneratedModel with all buffers transferred
 * (zero-copy to the main thread).
 *
 * Generators must be registered in this worker's scope. Importing a generator
 * module triggers its self-registration.
 *
 * Engine-agnostic — no three.js.
 */

import type { WorkerRequest, WorkerResponseError, WorkerResponseSuccess } from './WorkerPool';
import { getGenerator } from './GeneratorRegistry';
import { gatherTransferables } from './common/meshUtils';

// ─── Import generators so they self-register ─────────────────────────────────
// Each generator module calls registerGenerator() at the top level.
import './common/BoxGenerator.register';

// ─── Message handler ─────────────────────────────────────────────────────────

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { jobId, generatorId, params, seed } = event.data;

  try {
    const generator = getGenerator(generatorId);
    if (!generator) {
      const error: WorkerResponseError = {
        type: 'error',
        jobId,
        message: `Unknown generator: ${generatorId}`,
      };
      self.postMessage(error);
      return;
    }

    const model = generator.generate(params, seed);

    // Gather transferables (deduplicated) for zero-copy transfer
    const transferables = gatherTransferables(model);
    model.transferables = transferables;

    const response: WorkerResponseSuccess = {
      type: 'success',
      jobId,
      model,
      transferables,
    };

    self.postMessage(response, { transfer: transferables as Transferable[] });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown generation error';
    const error: WorkerResponseError = {
      type: 'error',
      jobId,
      message,
    };
    self.postMessage(error);
  }
};
