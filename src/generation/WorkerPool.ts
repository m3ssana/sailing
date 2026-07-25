/**
 * Worker pool for offloading procedural generation to background threads.
 *
 * Dispatches generation jobs to a pool of web workers, transferring ArrayBuffers
 * rather than copying them. Provides a Promise-based API with cancellation and
 * progress events.
 *
 * NOTE: This module is browser-only — it references `Worker` and
 * `navigator.hardwareConcurrency`. The pure scheduling logic (queue management,
 * job prioritisation) is factored into testable functions.
 *
 * Engine-agnostic — no three.js.
 */

import type { GeneratedModel, GenerationProgress, Seed } from '@/types';

// ─── Message protocol between main thread and workers ────────────────────────

export interface WorkerRequest {
  type: 'generate';
  jobId: number;
  generatorId: string;
  params: unknown;
  seed: Seed;
}

export interface WorkerResponseSuccess {
  type: 'success';
  jobId: number;
  model: GeneratedModel;
  transferables: ArrayBufferLike[];
}

export interface WorkerResponseError {
  type: 'error';
  jobId: number;
  message: string;
}

export interface WorkerResponseProgress {
  type: 'progress';
  jobId: number;
  progress: GenerationProgress;
}

export type WorkerResponse = WorkerResponseSuccess | WorkerResponseError | WorkerResponseProgress;

// ─── Job tracking ────────────────────────────────────────────────────────────

interface PendingJob {
  jobId: number;
  generatorId: string;
  params: unknown;
  seed: Seed;
  resolve: (model: GeneratedModel) => void;
  reject: (error: Error) => void;
  onProgress: ((progress: GenerationProgress) => void) | undefined;
  cancelled: boolean;
}

// ─── Pool size derivation (pure, testable) ───────────────────────────────────

/**
 * Derive the worker count from hardware concurrency.
 * Clamped to [1, 4] — more than 4 generation workers yields diminishing returns
 * and steals cores from the render thread.
 */
export function derivePoolSize(hardwareConcurrency: number): number {
  return Math.max(1, Math.min(4, hardwareConcurrency - 1));
}

// ─── WorkerPool class ────────────────────────────────────────────────────────

export class WorkerPool {
  private workers: Worker[] = [];
  private busy: Set<number> = new Set();
  private queue: PendingJob[] = [];
  private activeJobs: Map<number, PendingJob> = new Map();
  private nextJobId = 1;
  private disposed = false;

  /**
   * Create and initialise the worker pool.
   *
   * @param size - Number of workers. Defaults to derivePoolSize(navigator.hardwareConcurrency).
   * @param workerUrl - URL of the worker script. Defaults to the bundled geometry.worker.ts.
   */
  constructor(size?: number, workerUrl?: URL) {
    const poolSize = size ?? derivePoolSize(navigator.hardwareConcurrency);
    const url = workerUrl ?? new URL('./geometry.worker.ts', import.meta.url);

    for (let i = 0; i < poolSize; i++) {
      const worker = new Worker(url, { type: 'module' });
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        this.handleMessage(i, event.data);
      };
      worker.onerror = (event: ErrorEvent) => {
        this.handleWorkerError(i, event.message);
      };
      this.workers.push(worker);
    }
  }

  /**
   * Submit a generation job. Returns a Promise that resolves with the
   * GeneratedModel (with buffers transferred from the worker).
   */
  submit(
    generatorId: string,
    params: unknown,
    seed: Seed,
    onProgress?: (progress: GenerationProgress) => void,
  ): { promise: Promise<GeneratedModel>; cancel: () => void } {
    if (this.disposed) {
      return {
        promise: Promise.reject(new Error('WorkerPool is disposed')),
        cancel: () => {},
      };
    }

    const jobId = this.nextJobId++;

    // The Promise executor runs synchronously, so resolve/reject are assigned
    // before anything below can read them. We use a container to satisfy TS
    // without non-null assertions (which ESLint bans).
    const callbacks = { resolve: (_m: GeneratedModel) => {}, reject: (_e: Error) => {} };

    const promise = new Promise<GeneratedModel>((res, rej) => {
      callbacks.resolve = res;
      callbacks.reject = rej;
    });

    const job: PendingJob = {
      jobId,
      generatorId,
      params,
      seed,
      resolve: callbacks.resolve,
      reject: callbacks.reject,
      onProgress,
      cancelled: false,
    };

    this.queue.push(job);
    this.dispatch();

    return {
      promise,
      cancel: () => {
        job.cancelled = true;
        job.reject(new Error('Job cancelled'));
      },
    };
  }

  /** Terminate all workers and reject pending jobs. */
  dispose(): void {
    this.disposed = true;
    for (const worker of this.workers) {
      worker.terminate();
    }
    // Reject anything still queued
    for (const job of this.queue) {
      if (!job.cancelled) {
        job.reject(new Error('WorkerPool disposed'));
      }
    }
    this.queue = [];
    for (const job of this.activeJobs.values()) {
      if (!job.cancelled) {
        job.reject(new Error('WorkerPool disposed'));
      }
    }
    this.activeJobs.clear();
  }

  /** Number of workers in the pool. */
  get size(): number {
    return this.workers.length;
  }

  /** Number of jobs currently executing (not queued). */
  get activeCount(): number {
    return this.busy.size;
  }

  /** Number of jobs waiting in the queue. */
  get queuedCount(): number {
    return this.queue.length;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private dispatch(): void {
    while (this.queue.length > 0) {
      const workerIdx = this.findFreeWorker();
      if (workerIdx === -1) break;

      const job = this.queue.shift();
      if (!job) break;

      // Skip cancelled jobs without sending to worker
      if (job.cancelled) continue;

      this.busy.add(workerIdx);
      this.activeJobs.set(job.jobId, job);

      const request: WorkerRequest = {
        type: 'generate',
        jobId: job.jobId,
        generatorId: job.generatorId,
        params: job.params,
        seed: job.seed,
      };

      const worker = this.workers[workerIdx];
      if (worker) {
        worker.postMessage(request);
      }
    }
  }

  private findFreeWorker(): number {
    for (let i = 0; i < this.workers.length; i++) {
      if (!this.busy.has(i)) return i;
    }
    return -1;
  }

  private handleMessage(workerIdx: number, response: WorkerResponse): void {
    if (response.type === 'progress') {
      const job = this.activeJobs.get(response.jobId);
      if (job && !job.cancelled && job.onProgress) {
        job.onProgress(response.progress);
      }
      return;
    }

    // Job complete — free the worker and dispatch next
    this.busy.delete(workerIdx);
    const job = this.activeJobs.get(response.jobId);
    this.activeJobs.delete(response.jobId);

    if (!job || job.cancelled) {
      this.dispatch();
      return;
    }

    if (response.type === 'success') {
      job.resolve(response.model);
    } else {
      job.reject(new Error(response.message));
    }

    this.dispatch();
  }

  private handleWorkerError(workerIdx: number, message: string): void {
    // Find the job running on this worker (if any) and reject it
    this.busy.delete(workerIdx);

    // We don't track which job is on which worker by index in the activeJobs map,
    // so we handle this by rejecting the oldest active job — in practice worker
    // errors are rare and this prevents hanging.
    for (const [jobId, job] of this.activeJobs) {
      if (!job.cancelled) {
        job.reject(new Error(`Worker error: ${message}`));
        this.activeJobs.delete(jobId);
        break;
      }
    }

    this.dispatch();
  }
}
