import { describe, it, expect } from 'vitest';
import { MouseInput } from '@/input';
import type { LockableElement, PointerLockDocument } from '@/input';

class FakeTarget {
  private readonly listeners = new Map<string, Array<(ev: unknown) => void>>();
  addEventListener(type: string, listener: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, listener: (ev: unknown) => void): void {
    const list = this.listeners.get(type);
    if (!list) return;
    const idx = list.indexOf(listener);
    if (idx !== -1) list.splice(idx, 1);
  }
  emit(type: string, ev: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
  listenerCount(type: string): number {
    return (this.listeners.get(type) ?? []).length;
  }
}

class FakeElement extends FakeTarget implements LockableElement {
  clientWidth = 1000;
  lockRequested = false;
  requestPointerLock(): void {
    this.lockRequested = true;
  }
}

class FakeDoc extends FakeTarget implements PointerLockDocument {
  pointerLockElement: unknown = null;
  exited = false;
  exitPointerLock(): void {
    this.exited = true;
  }
}

describe('MouseInput', () => {
  it('accumulates movement and resets on snapshot', () => {
    const el = new FakeElement();
    const doc = new FakeDoc();
    const mouse = new MouseInput(el, doc);
    mouse.attach();
    el.emit('mousemove', { movementX: 3, movementY: -2 });
    el.emit('mousemove', { movementX: 1, movementY: 1 });
    const s1 = mouse.snapshotMouse();
    expect(s1.dx).toBe(4);
    expect(s1.dy).toBe(-1);
    // Second snapshot with no movement is back to zero.
    const s2 = mouse.snapshotMouse();
    expect(s2.dx).toBe(0);
    expect(s2.dy).toBe(0);
  });

  it('accumulates and resets wheel per frame', () => {
    const el = new FakeElement();
    const mouse = new MouseInput(el, new FakeDoc());
    mouse.attach();
    el.emit('wheel', { deltaY: 100 }); // → +1
    el.emit('wheel', { deltaY: 50 }); // → +0.5
    expect(mouse.snapshotMouse().wheel).toBeCloseTo(1.5, 6);
    expect(mouse.snapshotMouse().wheel).toBe(0);
  });

  it('tracks absolute ndcX from clientX when unlocked', () => {
    const el = new FakeElement();
    el.clientWidth = 1000;
    const mouse = new MouseInput(el, new FakeDoc());
    mouse.attach();
    el.emit('mousemove', { clientX: 750 }); // 0.75*2-1 = 0.5
    expect(mouse.snapshotMouse().ndcX).toBeCloseTo(0.5, 6);
  });

  it('tracks held buttons', () => {
    const el = new FakeElement();
    const mouse = new MouseInput(el, new FakeDoc());
    mouse.attach();
    el.emit('mousedown', { button: 0 });
    el.emit('mousedown', { button: 2 });
    expect(mouse.snapshotMouse().buttons.has(0)).toBe(true);
    expect(mouse.snapshotMouse().buttons.has(2)).toBe(true);
    el.emit('mouseup', { button: 0 });
    expect(mouse.snapshotMouse().buttons.has(0)).toBe(false);
  });

  it('reflects pointer lock state', () => {
    const el = new FakeElement();
    const doc = new FakeDoc();
    const mouse = new MouseInput(el, doc);
    mouse.attach();
    expect(mouse.isLocked()).toBe(false);
    doc.pointerLockElement = el;
    doc.emit('pointerlockchange', {});
    expect(mouse.isLocked()).toBe(true);
    expect(mouse.snapshotMouse().locked).toBe(true);
  });

  it('requests and exits pointer lock through the element/document', () => {
    const el = new FakeElement();
    const doc = new FakeDoc();
    const mouse = new MouseInput(el, doc);
    mouse.requestLock();
    expect(el.lockRequested).toBe(true);
    mouse.exitLock();
    expect(doc.exited).toBe(true);
  });

  it('detach removes listeners', () => {
    const el = new FakeElement();
    const doc = new FakeDoc();
    const mouse = new MouseInput(el, doc);
    mouse.attach();
    mouse.detach();
    expect(el.listenerCount('mousemove')).toBe(0);
    expect(el.listenerCount('wheel')).toBe(0);
    expect(doc.listenerCount('pointerlockchange')).toBe(0);
  });
});
