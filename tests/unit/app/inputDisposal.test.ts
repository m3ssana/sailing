/**
 * Unit test for the input-manager disposal contract the session relies on.
 *
 * The session attaches `InputManager` on start and calls `dispose()` on
 * teardown. This verifies that disposal removes every listener the adapters
 * added, using fake event targets (no jsdom) — so the session's teardown does
 * not leak keyboard/mouse listeners.
 */

import { describe, it, expect } from 'vitest';
import {
  InputManager,
  KeyboardInput,
  MouseInput,
  GamepadInput,
} from '@/input';

/** A fake DOM event target that counts add/remove calls. */
class FakeTarget {
  readonly listeners = new Map<string, Set<(ev: unknown) => void>>();
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    let set = this.listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }
  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  /** Total live listeners across all event types. */
  count(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
  // Pointer-lock surface used by MouseInput.
  pointerLockElement: unknown = null;
}

describe('InputManager disposal releases all listeners', () => {
  it('attach then dispose leaves zero live listeners', () => {
    const canvas = new FakeTarget();
    const win = new FakeTarget();
    const doc = new FakeTarget();

    const keyboard = new KeyboardInput(canvas, () => true, win);
    const mouse = new MouseInput(canvas, doc, () => 1280);
    const gamepad = new GamepadInput(() => []);
    const manager = new InputManager(keyboard, mouse, gamepad);

    manager.attach();
    // Both the canvas and the document/window must have gained listeners.
    expect(canvas.count()).toBeGreaterThan(0);

    manager.dispose();
    // Every listener added to every target is removed on dispose.
    expect(canvas.count()).toBe(0);
    expect(win.count()).toBe(0);
    expect(doc.count()).toBe(0);
  });
});
