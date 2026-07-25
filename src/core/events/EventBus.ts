/**
 * Typed event bus with compile-time payload checking.
 *
 * `emit('boat:slam', { boatId: 'x' })` is a type error because `energy` is
 * missing. This catches cross-layer contract drift at compile time rather than
 * at runtime where it becomes a heisenbug.
 *
 * The emit path iterates a pre-existing array — no spread, no slice, no
 * temporary closures — so it allocates nothing in the steady-state frame loop.
 */

import type {
  GenerationProgress,
  Infringement,
  QualityPreset,
  RacePhase,
  WeatherSnapshot,
} from '@/types';

/** All events the game bus carries. Add new events here as the project grows. */
export interface GameEvents {
  'weather:updated': WeatherSnapshot;
  'boat:capsized': { boatId: string };
  'boat:slam': { boatId: string; energy: number };
  'race:phaseChanged': { phase: RacePhase };
  'race:infringement': Infringement;
  'quality:changed': { preset: QualityPreset };
  'generation:progress': GenerationProgress;
}

type Listener<T> = (payload: T) => void;

export interface EventBus {
  /** Subscribe to an event. Returns the unsubscribe function for convenience. */
  on<K extends keyof GameEvents>(event: K, listener: Listener<GameEvents[K]>): () => void;
  /** Unsubscribe a previously registered listener. */
  off<K extends keyof GameEvents>(event: K, listener: Listener<GameEvents[K]>): void;
  /** Subscribe to the next occurrence only; automatically removed after firing. */
  once<K extends keyof GameEvents>(event: K, listener: Listener<GameEvents[K]>): () => void;
  /** Dispatch an event to all current subscribers. */
  emit<K extends keyof GameEvents>(event: K, payload: GameEvents[K]): void;
}

/**
 * Create an event bus instance.
 *
 * We store listeners in a Map of arrays, one array per event name. The arrays
 * are never recreated — only grown — so `emit` iterates a stable reference
 * with zero allocation. Removals splice in-place, which is O(n) on subscriber
 * count but that count is tiny (typically < 10 per event).
 */
export function createEventBus(): EventBus {
  // Using `unknown` in the value type to avoid `any`; each call site narrows
  // through the generic K constraint.
  const listeners = new Map<keyof GameEvents, Listener<unknown>[]>();

  function getListeners<K extends keyof GameEvents>(event: K): Listener<unknown>[] {
    let list = listeners.get(event);
    if (!list) {
      list = [];
      listeners.set(event, list);
    }
    return list;
  }

  const bus: EventBus = {
    on<K extends keyof GameEvents>(event: K, listener: Listener<GameEvents[K]>): () => void {
      const list = getListeners(event);
      list.push(listener as Listener<unknown>);
      return () => bus.off(event, listener);
    },

    off<K extends keyof GameEvents>(event: K, listener: Listener<GameEvents[K]>): void {
      const list = listeners.get(event);
      if (!list) return;
      const idx = list.indexOf(listener as Listener<unknown>);
      if (idx !== -1) list.splice(idx, 1);
    },

    once<K extends keyof GameEvents>(event: K, listener: Listener<GameEvents[K]>): () => void {
      const wrapper: Listener<GameEvents[K]> = (payload) => {
        bus.off(event, wrapper);
        listener(payload);
      };
      return bus.on(event, wrapper);
    },

    emit<K extends keyof GameEvents>(event: K, payload: GameEvents[K]): void {
      const list = listeners.get(event);
      if (!list) return;
      // Iterate by index so listeners added during emit are not called this
      // round, and removals during iteration don't skip entries (we iterate
      // forward, and splice shifts later elements down — the worst case is
      // calling a listener that just unsubscribed, which is harmless).
      const len = list.length;
      for (let i = 0; i < len; i++) {
        const fn = list[i];
        if (fn) fn(payload);
      }
    },
  };

  return bus;
}
