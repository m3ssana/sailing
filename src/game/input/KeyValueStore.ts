/**
 * KeyValueStore — the tiny persistence seam behind binding storage.
 *
 * The game/input layer only knows this interface; a localStorage adapter lives
 * in src/input (DOM layer), and a MemoryKeyValueStore here serves tests and any
 * headless caller. Synchronous string get/set is sufficient for a few kilobytes
 * of bindings and keeps the per-frame path free of promises.
 */
export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** In-memory store for tests and headless use. */
export class MemoryKeyValueStore implements KeyValueStore {
  private readonly map = new Map<string, string>();

  get(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) ?? null) : null;
  }

  set(key: string, value: string): void {
    this.map.set(key, value);
  }

  remove(key: string): void {
    this.map.delete(key);
  }
}

/** The key bindings persist under. */
export const BINDINGS_STORAGE_KEY = 'sailing.bindings.v1';
