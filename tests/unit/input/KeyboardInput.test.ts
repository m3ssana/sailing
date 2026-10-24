import { describe, it, expect } from 'vitest';
import { KeyboardInput } from '@/input';
import type { DomEventTarget } from '@/input';

/** A hand-written fake DOM event target — no jsdom needed. */
class FakeTarget implements DomEventTarget {
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

describe('KeyboardInput', () => {
  it('tracks held codes on keydown/keyup', () => {
    const t = new FakeTarget();
    const kb = new KeyboardInput(t, () => false);
    kb.attach();
    t.emit('keydown', { code: 'KeyA' });
    expect(kb.heldCodes().has('KeyA')).toBe(true);
    t.emit('keyup', { code: 'KeyA' });
    expect(kb.heldCodes().has('KeyA')).toBe(false);
  });

  it('clears all held keys on blur', () => {
    const t = new FakeTarget();
    const kb = new KeyboardInput(t, () => false);
    kb.attach();
    t.emit('keydown', { code: 'KeyA' });
    t.emit('keydown', { code: 'KeyD' });
    expect(kb.heldCodes().size).toBe(2);
    t.emit('blur', {});
    expect(kb.heldCodes().size).toBe(0);
  });

  it('calls preventDefault only for bound codes', () => {
    const t = new FakeTarget();
    const bound = new Set(['KeyA']);
    const kb = new KeyboardInput(t, (code) => bound.has(code));
    kb.attach();

    let prevented = false;
    t.emit('keydown', { code: 'KeyA', preventDefault: () => (prevented = true) });
    expect(prevented).toBe(true);

    prevented = false;
    t.emit('keydown', { code: 'Tab', preventDefault: () => (prevented = true) });
    expect(prevented).toBe(false);
  });

  it('ignores keystrokes while typing in an input/textarea', () => {
    const t = new FakeTarget();
    const kb = new KeyboardInput(t, () => true);
    kb.attach();
    t.emit('keydown', { code: 'KeyA', target: { tagName: 'INPUT' } });
    t.emit('keydown', { code: 'KeyB', target: { tagName: 'TEXTAREA' } });
    t.emit('keydown', { code: 'KeyC', target: { isContentEditable: true } });
    expect(kb.heldCodes().size).toBe(0);
    // A non-typing target still registers.
    t.emit('keydown', { code: 'KeyD', target: { tagName: 'CANVAS' } });
    expect(kb.heldCodes().has('KeyD')).toBe(true);
  });

  it('detach removes listeners and clears state', () => {
    const t = new FakeTarget();
    const kb = new KeyboardInput(t, () => false);
    kb.attach();
    t.emit('keydown', { code: 'KeyA' });
    kb.detach();
    expect(kb.heldCodes().size).toBe(0);
    expect(t.listenerCount('keydown')).toBe(0);
    expect(t.listenerCount('keyup')).toBe(0);
    expect(t.listenerCount('blur')).toBe(0);
  });

  it('uses a separate window target for blur when provided', () => {
    const el = new FakeTarget();
    const win = new FakeTarget();
    const kb = new KeyboardInput(el, () => false, win);
    kb.attach();
    el.emit('keydown', { code: 'KeyA' });
    win.emit('blur', {});
    expect(kb.heldCodes().size).toBe(0);
  });
});
