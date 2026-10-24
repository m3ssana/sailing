import { describe, it, expect } from 'vitest';
import {
  GamepadInput,
  InputManager,
  KeyboardInput,
  MouseInput,
  LocalStorageKeyValueStore,
  DEFAULT_GAMEPAD_DEADZONE,
} from '@/input';
import type { GamepadLike, LockableElement, PointerLockDocument, StorageLike } from '@/input';

function makePad(
  index: number,
  axes: number[],
  buttons: Array<{ pressed: boolean; value: number }>,
  actuator?: GamepadLike['vibrationActuator'],
): GamepadLike {
  const pad: GamepadLike = { connected: true, index, axes, buttons };
  if (actuator !== undefined) pad.vibrationActuator = actuator;
  return pad;
}

describe('GamepadInput', () => {
  it('applies a deadzone to axes', () => {
    const pad = makePad(0, [0.03, 0.9], []);
    const gp = new GamepadInput(() => [pad]);
    const snap = gp.poll();
    expect(snap).not.toBeNull();
    expect(snap?.axes[0]).toBe(0); // inside deadzone
    expect(snap?.axes[1]).toBeGreaterThan(0); // outside, rescaled
  });

  it('returns null when no pad is connected', () => {
    const gp = new GamepadInput(() => [null, null]);
    expect(gp.poll()).toBeNull();
  });

  it('hot-plug: picks up a pad that appears later', () => {
    let pads: (GamepadLike | null)[] = [null];
    const gp = new GamepadInput(() => pads);
    expect(gp.poll()).toBeNull();
    pads = [makePad(0, [0.5, 0], [])];
    const snap = gp.poll();
    expect(snap?.connected).toBe(true);
  });

  it('hot-plug: falls back to another pad when the active one disconnects', () => {
    const pad0 = makePad(0, [0.5, 0], []);
    const pad1 = makePad(1, [-0.5, 0], []);
    let pads: (GamepadLike | null)[] = [pad0, pad1];
    const gp = new GamepadInput(() => pads);
    expect(gp.poll()?.axes[0]).toBeGreaterThan(0); // pad0 active
    // pad0 disconnects.
    pads = [null, pad1];
    const snap = gp.poll();
    expect(snap).not.toBeNull();
    expect(snap?.axes[0]).toBeLessThan(0); // now pad1
  });

  it('reads analog button (trigger) values', () => {
    const pad = makePad(0, [0, 0], [
      { pressed: false, value: 0 },
      { pressed: true, value: 1 },
    ]);
    const gp = new GamepadInput(() => [pad]);
    const snap = gp.poll();
    expect(snap?.buttonValues[1]).toBe(1);
    expect(snap?.buttons[1]).toBe(true);
  });

  it('rumble calls playEffect with dual-rumble params when supported', () => {
    let called: { type: string; params: Record<string, number> } | null = null;
    const actuator = {
      playEffect: (type: string, params: Record<string, number>) => {
        called = { type, params };
        return Promise.resolve('complete');
      },
    };
    const pad = makePad(0, [0, 0], [], actuator);
    const gp = new GamepadInput(() => [pad]);
    gp.poll(); // establish active pad
    gp.rumble(0.3, 0.7);
    expect(called).not.toBeNull();
    expect(called!.type).toBe('dual-rumble');
    expect(called!.params['weakMagnitude']).toBeCloseTo(0.3, 6);
    expect(called!.params['strongMagnitude']).toBeCloseTo(0.7, 6);
  });

  it('rumble is a no-op (no throw) when the actuator is missing', () => {
    const pad = makePad(0, [0, 0], []);
    const gp = new GamepadInput(() => [pad]);
    gp.poll();
    expect(() => gp.rumble(1, 1)).not.toThrow();
  });

  it('swallows a rejected playEffect promise (unsupported effect type)', () => {
    const actuator = {
      playEffect: () => Promise.reject(new Error('unsupported')),
    };
    const pad = makePad(0, [0, 0], [], actuator);
    const gp = new GamepadInput(() => [pad]);
    gp.poll();
    expect(() => gp.rumble(0.5, 0.5)).not.toThrow();
  });

  it('exposes the default deadzone constant', () => {
    expect(DEFAULT_GAMEPAD_DEADZONE).toBeGreaterThan(0);
    expect(DEFAULT_GAMEPAD_DEADZONE).toBeLessThan(0.3);
  });
});

// ── InputManager merge ────────────────────────────────────────────────────────

class FakeTarget {
  private readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
  addEventListener(type: string, listener: (ev: unknown) => void): void {
    const l = this.listeners.get(type) ?? [];
    l.push(listener);
    this.listeners.set(type, l);
  }
  removeEventListener(): void {
    /* unused in these tests */
  }
  emit(type: string, ev: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
}
class FakeEl extends FakeTarget implements LockableElement {
  clientWidth = 800;
}
class FakeDoc extends FakeTarget implements PointerLockDocument {
  pointerLockElement: unknown = null;
}

describe('InputManager — merged DeviceSnapshot', () => {
  it('merges keyboard, mouse and gamepad into one snapshot', () => {
    const kbTarget = new FakeTarget();
    const el = new FakeEl();
    const doc = new FakeDoc();
    const pad = makePad(0, [0.6, 0], [{ pressed: true, value: 1 }]);

    const kb = new KeyboardInput(kbTarget, () => true);
    const mouse = new MouseInput(el, doc);
    const gp = new GamepadInput(() => [pad]);
    const mgr = new InputManager(kb, mouse, gp);
    mgr.attach();

    kbTarget.emit('keydown', { code: 'KeyW' });
    el.emit('mousemove', { movementX: 2, movementY: 0 });
    el.emit('wheel', { deltaY: 100 });

    const snap = mgr.sample();
    expect(snap.keyboard.held.has('KeyW')).toBe(true);
    expect(snap.mouse.dx).toBe(2);
    expect(snap.mouse.wheel).toBeCloseTo(1, 6);
    expect(snap.gamepad?.connected).toBe(true);
    expect(snap.gamepad?.axes[0]).toBeGreaterThan(0);
  });

  it('reuses the same snapshot object across frames (allocation-free)', () => {
    const kb = new KeyboardInput(new FakeTarget(), () => false);
    const mouse = new MouseInput(new FakeEl(), new FakeDoc());
    const gp = new GamepadInput(() => [null]);
    const mgr = new InputManager(kb, mouse, gp);
    mgr.attach();
    const a = mgr.sample();
    const b = mgr.sample();
    expect(b).toBe(a);
  });
});

// ── LocalStorageKeyValueStore ───────────────────────────────────────────────────

class FakeStorage implements StorageLike {
  private readonly m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) ?? null) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

describe('LocalStorageKeyValueStore', () => {
  it('reads and writes through an injected Storage', () => {
    const store = new LocalStorageKeyValueStore(new FakeStorage());
    expect(store.get('k')).toBeNull();
    store.set('k', 'v');
    expect(store.get('k')).toBe('v');
    store.remove('k');
    expect(store.get('k')).toBeNull();
  });

  it('degrades to a no-op when storage throws (private browsing / quota)', () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('disabled');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('disabled');
      },
    };
    const store = new LocalStorageKeyValueStore(throwing);
    expect(() => store.set('k', 'v')).not.toThrow();
    expect(store.get('k')).toBeNull();
    expect(() => store.remove('k')).not.toThrow();
  });
});
