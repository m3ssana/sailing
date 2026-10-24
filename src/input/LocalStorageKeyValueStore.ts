/**
 * LocalStorageKeyValueStore — the DOM-side persistence adapter behind the
 * game/input `KeyValueStore` seam. Guards every call so a disabled or quota-full
 * localStorage degrades to an in-memory no-op rather than throwing (private
 * browsing, storage disabled, SSR).
 *
 * The injectable `storage` parameter lets a test pass a fake Storage without a
 * real browser.
 */

import type { KeyValueStore } from '@game/input';

/** The minimal Storage surface we use (a subset of the DOM Storage). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class LocalStorageKeyValueStore implements KeyValueStore {
  private readonly storage: StorageLike | null;

  constructor(storage?: StorageLike) {
    if (storage !== undefined) {
      this.storage = storage;
    } else {
      // Resolve a real localStorage if available; otherwise disable gracefully.
      let resolved: StorageLike | null = null;
      try {
        const g = globalThis as { localStorage?: StorageLike };
        if (g.localStorage) resolved = g.localStorage;
      } catch {
        resolved = null;
      }
      this.storage = resolved;
    }
  }

  get(key: string): string | null {
    if (!this.storage) return null;
    try {
      return this.storage.getItem(key);
    } catch {
      return null;
    }
  }

  set(key: string, value: string): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(key, value);
    } catch {
      /* quota / disabled — ignore */
    }
  }

  remove(key: string): void {
    if (!this.storage) return;
    try {
      this.storage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}
