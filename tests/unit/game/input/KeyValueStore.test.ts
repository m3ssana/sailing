import { describe, it, expect } from 'vitest';
import {
  MemoryKeyValueStore,
  BindingMap,
  BINDINGS_STORAGE_KEY,
} from '@game/input';

describe('MemoryKeyValueStore', () => {
  it('stores and retrieves values', () => {
    const s = new MemoryKeyValueStore();
    expect(s.get('x')).toBeNull();
    s.set('x', 'hello');
    expect(s.get('x')).toBe('hello');
    s.remove('x');
    expect(s.get('x')).toBeNull();
  });

  it('persists bindings across a save/load cycle', () => {
    const store = new MemoryKeyValueStore();
    const m = new BindingMap();
    m.rebind('vangOn', { kind: 'key', code: 'F13' });
    store.set(BINDINGS_STORAGE_KEY, m.toJSON());

    const raw = store.get(BINDINGS_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const restored = BindingMap.fromJSON(raw as string);
    expect(restored?.bindingsFor('vangOn')).toContainEqual({ kind: 'key', code: 'F13' });
  });

  it('a missing key yields defaults, not a crash', () => {
    const store = new MemoryKeyValueStore();
    const raw = store.get(BINDINGS_STORAGE_KEY);
    const m = raw === null ? new BindingMap() : BindingMap.fromJSON(raw);
    expect(m).not.toBeNull();
    expect(m?.bindingsFor('steerLeft')).toContainEqual({ kind: 'key', code: 'KeyA' });
  });
});
