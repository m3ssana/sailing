/**
 * The HUD store — a vanilla Zustand store (`createStore`, no React binding) that
 * holds the latest view model plus the player's HUD settings (preset, opaque
 * backdrop, units).
 *
 * Why vanilla: the render loop (not React) owns the per-frame cadence. It calls
 * `publish(vm)` with a freshly built view model; the store THROTTLES those pushes
 * to a UI rate (default 10 Hz, art-direction §8.5 "update at 10 Hz, not frame
 * rate") so React re-renders are bounded regardless of the 120 Hz sim. React
 * subscribes to the store; it never touches the render loop.
 *
 * Settings persist through the `KeyValueStore` seam (reused from the input layer),
 * so the DOM layer injects a localStorage adapter and tests inject an in-memory
 * one. No DOM, no three.js here — this is importable headlessly.
 */

import { createStore } from 'zustand/vanilla';
import type { StoreApi } from 'zustand/vanilla';
import type { KeyValueStore } from '@game/input/KeyValueStore';
import type { HudPreset, HudViewModel, UnitSystem } from '@game/hud';
import { nextPreset } from '@game/hud';

/** Persisted HUD settings. */
export interface HudSettings {
  preset: HudPreset;
  opaqueBackdrop: boolean;
  units: UnitSystem;
}

/** The store's state and actions. */
export interface HudStoreState {
  /** Latest published view model (null until the first publish). */
  vm: HudViewModel | null;
  settings: HudSettings;
  /** Replace the view model. Called by the throttle in `publish`. */
  setViewModel(vm: HudViewModel): void;
  setPreset(preset: HudPreset): void;
  cyclePreset(): void;
  setOpaqueBackdrop(opaque: boolean): void;
  setUnits(units: UnitSystem): void;
}

/** Zustand store API type alias. */
export type HudStore = StoreApi<HudStoreState>;

/** Default settings used when nothing is persisted. */
export const DEFAULT_HUD_SETTINGS: HudSettings = {
  preset: 'full',
  opaqueBackdrop: false,
  units: 'knotsNm',
};

/** Storage key HUD settings persist under. */
export const HUD_SETTINGS_STORAGE_KEY = 'sailing.hud.v1';

const VALID_PRESETS: readonly HudPreset[] = ['full', 'moderate', 'minimal', 'none'];
const VALID_UNITS: readonly UnitSystem[] = ['knotsNm', 'metricSI'];

/**
 * Parse persisted settings defensively: unknown/malformed JSON falls back to
 * defaults (never throws), and each field is validated independently so a
 * partial payload is filled from defaults.
 */
export function parseHudSettings(raw: string | null): HudSettings {
  if (raw === null) return { ...DEFAULT_HUD_SETTINGS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_HUD_SETTINGS };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_HUD_SETTINGS };
  const obj = parsed as Record<string, unknown>;
  const preset =
    typeof obj['preset'] === 'string' && VALID_PRESETS.includes(obj['preset'] as HudPreset)
      ? (obj['preset'] as HudPreset)
      : DEFAULT_HUD_SETTINGS.preset;
  const units =
    typeof obj['units'] === 'string' && VALID_UNITS.includes(obj['units'] as UnitSystem)
      ? (obj['units'] as UnitSystem)
      : DEFAULT_HUD_SETTINGS.units;
  const opaqueBackdrop =
    typeof obj['opaqueBackdrop'] === 'boolean'
      ? obj['opaqueBackdrop']
      : DEFAULT_HUD_SETTINGS.opaqueBackdrop;
  return { preset, opaqueBackdrop, units };
}

function serializeHudSettings(settings: HudSettings): string {
  return JSON.stringify(settings);
}

/**
 * Create the HUD store.
 *
 * @param storage optional KeyValueStore for settings persistence. When supplied,
 *                settings load from it on creation and persist on every change.
 */
export function createHudStore(storage?: KeyValueStore): HudStore {
  const initialSettings = parseHudSettings(storage?.get(HUD_SETTINGS_STORAGE_KEY) ?? null);

  const persist = (settings: HudSettings): void => {
    storage?.set(HUD_SETTINGS_STORAGE_KEY, serializeHudSettings(settings));
  };

  return createStore<HudStoreState>((set) => ({
    vm: null,
    settings: initialSettings,
    setViewModel(vm: HudViewModel): void {
      set({ vm });
    },
    setPreset(preset: HudPreset): void {
      set((state) => {
        const settings = { ...state.settings, preset };
        persist(settings);
        return { settings };
      });
    },
    cyclePreset(): void {
      set((state) => {
        const settings = { ...state.settings, preset: nextPreset(state.settings.preset) };
        persist(settings);
        return { settings };
      });
    },
    setOpaqueBackdrop(opaque: boolean): void {
      set((state) => {
        const settings = { ...state.settings, opaqueBackdrop: opaque };
        persist(settings);
        return { settings };
      });
    },
    setUnits(units: UnitSystem): void {
      set((state) => {
        const settings = { ...state.settings, units };
        persist(settings);
        return { settings };
      });
    },
  }));
}

/**
 * A throttled publisher the render loop drives. It forwards at most one view
 * model per `intervalMs` into the store (leading edge + trailing latest), so a
 * 120 Hz sim produces ~10 Hz UI updates.
 *
 * The render loop builds its view model (reusing one `out` object for
 * allocation-free steady state) and calls `publish(vm)` every frame; the throttle
 * drops the excess. The view model is cloned on store entry is NOT needed because
 * the store only reads it for rendering within the same macrotask boundary —
 * however, since the caller reuses `out`, the publisher takes a SNAPSHOT via the
 * provided clone function so React sees stable immutable frames.
 */
export interface HudPublisher {
  /** Offer a view model; may be dropped by the throttle. */
  publish(vm: HudViewModel): void;
  /** Force the latest pending view model through immediately (e.g. on pause). */
  flush(): void;
  /** Stop the trailing timer. */
  dispose(): void;
}

/** Options for {@link createHudPublisher}. */
export interface HudPublisherOptions {
  /** Minimum interval between store updates, ms. Default 100 (10 Hz). */
  intervalMs?: number;
  /** Monotonic clock, ms. Defaults to `performance.now`/`Date.now`. Injectable for tests. */
  now?: () => number;
  /** Timer scheduler. Injectable for tests. Defaults to setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  /**
   * Snapshot function applied before the view model enters the store. Because the
   * render loop reuses one `out` object, the default deep-clones via
   * `structuredClone` so React receives an immutable frame. Pass the identity
   * function if the caller already hands over fresh objects.
   */
  snapshot?: (vm: HudViewModel) => HudViewModel;
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Build a throttling publisher bound to a store. Leading-edge: the first publish
 * in an idle window goes through immediately; subsequent publishes within the
 * window are coalesced and the latest is flushed on a trailing timer.
 */
export function createHudPublisher(store: HudStore, options: HudPublisherOptions = {}): HudPublisher {
  const intervalMs = options.intervalMs ?? 100;
  const now = options.now ?? defaultNow;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h));
  const snapshot = options.snapshot ?? ((vm) => structuredClone(vm));

  let lastEmit = Number.NEGATIVE_INFINITY;
  let pending: HudViewModel | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const emit = (vm: HudViewModel): void => {
    lastEmit = now();
    store.getState().setViewModel(snapshot(vm));
  };

  const onTimer = (): void => {
    timer = null;
    if (pending !== null) {
      const vm = pending;
      pending = null;
      emit(vm);
    }
  };

  return {
    publish(vm: HudViewModel): void {
      const elapsed = now() - lastEmit;
      if (elapsed >= intervalMs) {
        // Leading edge — emit immediately.
        pending = null;
        if (timer !== null) {
          clearTimer(timer);
          timer = null;
        }
        emit(vm);
      } else {
        // Within the window — coalesce; schedule a trailing emit for the latest.
        pending = vm;
        if (timer === null) {
          timer = setTimer(onTimer, intervalMs - elapsed);
        }
      }
    },
    flush(): void {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      if (pending !== null) {
        const vm = pending;
        pending = null;
        emit(vm);
      }
    },
    dispose(): void {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      pending = null;
    },
  };
}
