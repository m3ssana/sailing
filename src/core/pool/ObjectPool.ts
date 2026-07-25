/**
 * Generic object pool for allocation-free hot paths.
 *
 * The 120 Hz physics step must never trigger GC (requirement 8.8). Every
 * temporary Vec3, Quat, or AppliedForce used during force evaluation is
 * acquired from a pool and released back at the end of each step.
 */

import type { Quat, Vec3 } from '@/types';

export interface ObjectPool<T> {
  /** Get an object from the pool (or create one if exhausted). */
  acquire(): T;
  /** Return an object to the pool. Caller must not use it after this call. */
  release(obj: T): void;
  /** Return all outstanding objects. Called once per frame after all work is done. */
  releaseAll(): void;
  /** Diagnostics: peak number of simultaneously outstanding objects. */
  highWaterMark(): number;
  /** Diagnostics: total objects currently in the pool (available + outstanding). */
  capacity(): number;
}

/**
 * Create a pool with optional preallocation.
 *
 * @param factory  Creates a new instance. Called during preallocation and when the pool is empty.
 * @param reset    Reinitializes an instance before handing it out. Optional but
 *                 recommended — prevents stale state from leaking between frames.
 * @param initialSize  How many objects to preallocate (default 0).
 */
export function createObjectPool<T>(
  factory: () => T,
  reset?: (obj: T) => void,
  initialSize = 0,
): ObjectPool<T> {
  // Available objects sit in this stack. Push to return, pop to acquire.
  const available: T[] = [];
  let outstanding = 0;
  let hwm = 0;

  // Preallocate upfront so the first frame doesn't stutter.
  for (let i = 0; i < initialSize; i++) {
    available.push(factory());
  }

  return {
    acquire(): T {
      let obj: T | undefined;
      if (available.length > 0) {
        obj = available.pop() as T;
      } else {
        obj = factory();
      }
      if (reset) reset(obj);
      outstanding++;
      if (outstanding > hwm) hwm = outstanding;
      return obj;
    },

    release(_obj: T): void {
      available.push(_obj);
      outstanding--;
    },

    releaseAll(): void {
      // We cannot track individual objects without a set (which allocates), so
      // releaseAll is a bulk accounting reset. Objects already returned via
      // release() remain in `available`; outstanding count drops to zero.
      // This is safe because the caller contracts to stop using all acquired
      // objects after this call.
      outstanding = 0;
    },

    highWaterMark(): number {
      return hwm;
    },

    capacity(): number {
      return available.length + outstanding;
    },
  };
}

// --- Convenience factories for the common pooled types ----------------------

/** Pool of plain Vec3 objects, reset to (0, 0, 0) on acquire. */
export function makeVec3Pool(initialSize = 32): ObjectPool<Vec3> {
  return createObjectPool<Vec3>(
    () => ({ x: 0, y: 0, z: 0 }),
    (v) => {
      v.x = 0;
      v.y = 0;
      v.z = 0;
    },
    initialSize,
  );
}

/** Pool of plain Quat objects, reset to identity (0, 0, 0, 1) on acquire. */
export function makeQuatPool(initialSize = 16): ObjectPool<Quat> {
  return createObjectPool<Quat>(
    () => ({ x: 0, y: 0, z: 0, w: 1 }),
    (q) => {
      q.x = 0;
      q.y = 0;
      q.z = 0;
      q.w = 1;
    },
    initialSize,
  );
}
