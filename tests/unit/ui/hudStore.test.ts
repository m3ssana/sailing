/**
 * HUD store tests: settings defaults, persistence round-trip through a
 * KeyValueStore, defensive parsing of malformed/partial payloads, and the
 * preset-cycle action.
 */

import { describe, it, expect } from 'vitest';
import {
  createHudStore,
  DEFAULT_HUD_SETTINGS,
  HUD_SETTINGS_STORAGE_KEY,
  parseHudSettings,
} from '@/ui/hud/hudStore';
import { MemoryKeyValueStore } from '@game/input/KeyValueStore';

describe('parseHudSettings', () => {
  it('returns defaults for null', () => {
    expect(parseHudSettings(null)).toEqual(DEFAULT_HUD_SETTINGS);
  });

  it('returns defaults for malformed JSON (never throws)', () => {
    expect(parseHudSettings('{not json')).toEqual(DEFAULT_HUD_SETTINGS);
  });

  it('returns defaults for a non-object payload', () => {
    expect(parseHudSettings('42')).toEqual(DEFAULT_HUD_SETTINGS);
  });

  it('fills missing fields from defaults (partial payload)', () => {
    const parsed = parseHudSettings(JSON.stringify({ preset: 'minimal' }));
    expect(parsed.preset).toBe('minimal');
    expect(parsed.units).toBe(DEFAULT_HUD_SETTINGS.units);
    expect(parsed.opaqueBackdrop).toBe(DEFAULT_HUD_SETTINGS.opaqueBackdrop);
  });

  it('rejects out-of-range enum values and falls back', () => {
    const parsed = parseHudSettings(JSON.stringify({ preset: 'ludicrous', units: 'furlongs' }));
    expect(parsed.preset).toBe(DEFAULT_HUD_SETTINGS.preset);
    expect(parsed.units).toBe(DEFAULT_HUD_SETTINGS.units);
  });

  it('accepts a full valid payload', () => {
    const settings = { preset: 'moderate', opaqueBackdrop: true, units: 'metricSI' };
    expect(parseHudSettings(JSON.stringify(settings))).toEqual(settings);
  });
});

describe('createHudStore', () => {
  it('starts with default settings and no view model', () => {
    const store = createHudStore();
    expect(store.getState().settings).toEqual(DEFAULT_HUD_SETTINGS);
    expect(store.getState().vm).toBeNull();
  });

  it('loads persisted settings from storage on creation', () => {
    const storage = new MemoryKeyValueStore();
    storage.set(
      HUD_SETTINGS_STORAGE_KEY,
      JSON.stringify({ preset: 'minimal', opaqueBackdrop: true, units: 'metricSI' }),
    );
    const store = createHudStore(storage);
    expect(store.getState().settings).toEqual({
      preset: 'minimal',
      opaqueBackdrop: true,
      units: 'metricSI',
    });
  });

  it('persists settings changes (round trip through storage)', () => {
    const storage = new MemoryKeyValueStore();
    const store = createHudStore(storage);

    store.getState().setPreset('moderate');
    store.getState().setOpaqueBackdrop(true);
    store.getState().setUnits('metricSI');

    // Re-create from the same storage: settings survive.
    const reloaded = createHudStore(storage);
    expect(reloaded.getState().settings).toEqual({
      preset: 'moderate',
      opaqueBackdrop: true,
      units: 'metricSI',
    });
  });

  it('cyclePreset advances full → moderate → minimal → none → full and persists', () => {
    const storage = new MemoryKeyValueStore();
    const store = createHudStore(storage);
    const seq = ['moderate', 'minimal', 'none', 'full'] as const;
    for (const expected of seq) {
      store.getState().cyclePreset();
      expect(store.getState().settings.preset).toBe(expected);
    }
    expect(parseHudSettings(storage.get(HUD_SETTINGS_STORAGE_KEY)).preset).toBe('full');
  });

  it('works without a storage adapter (no persistence, no throw)', () => {
    const store = createHudStore();
    expect(() => store.getState().setPreset('none')).not.toThrow();
    expect(store.getState().settings.preset).toBe('none');
  });
});
