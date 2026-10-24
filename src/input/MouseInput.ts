/**
 * MouseInput — DOM mouse adapter.
 *
 * Accumulates relative movement (movementX/Y, used for camera look while pointer
 * is locked) and absolute normalised X in [-1,1] (used for mouse-only steering
 * when pointer lock is off), plus a per-frame wheel delta and the set of held
 * buttons. Pointer lock is optional and requested/exited through the injected
 * element.
 *
 * `snapshotMouse()` returns the accumulated deltas for the frame and resets the
 * per-frame accumulators (movement and wheel), while preserving sticky state
 * (absolute position, held buttons, lock status).
 *
 * The element and document targets are dependency-injected so the adapter is
 * testable with fakes under vitest node (no jsdom).
 */

import type { DomEventTarget } from './KeyboardInput';

export interface MouseEventLike {
  movementX?: number;
  movementY?: number;
  clientX?: number;
  button?: number;
  deltaY?: number;
  preventDefault?: () => void;
}

/** Element supporting optional pointer lock. */
export interface LockableElement extends DomEventTarget {
  requestPointerLock?: () => void;
  clientWidth?: number;
}

export interface PointerLockDocument extends DomEventTarget {
  pointerLockElement?: unknown;
  exitPointerLock?: () => void;
}

export class MouseInput {
  private dx = 0;
  private dy = 0;
  private wheel = 0;
  private ndcX = 0;
  private readonly buttons = new Set<number>();
  private locked = false;

  private readonly element: LockableElement;
  private readonly doc: PointerLockDocument;
  private readonly viewportWidth: () => number;
  private attached = false;

  private readonly onMove = (ev: unknown): void => {
    const e = ev as MouseEventLike;
    this.dx += e.movementX ?? 0;
    this.dy += e.movementY ?? 0;
    if (!this.locked && e.clientX !== undefined) {
      const w = this.viewportWidth();
      if (w > 0) this.ndcX = (e.clientX / w) * 2 - 1;
    }
  };

  private readonly onDown = (ev: unknown): void => {
    const e = ev as MouseEventLike;
    if (e.button !== undefined) this.buttons.add(e.button);
  };

  private readonly onUp = (ev: unknown): void => {
    const e = ev as MouseEventLike;
    if (e.button !== undefined) this.buttons.delete(e.button);
  };

  private readonly onWheel = (ev: unknown): void => {
    const e = ev as MouseEventLike;
    // Normalise to roughly ±1 per notch (browsers report ~100 px/notch).
    this.wheel += (e.deltaY ?? 0) / 100;
  };

  private readonly onLockChange = (): void => {
    this.locked = this.doc.pointerLockElement === this.element;
  };

  private readonly onBlur = (): void => {
    this.buttons.clear();
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
  };

  constructor(element: LockableElement, doc: PointerLockDocument, viewportWidth?: () => number) {
    this.element = element;
    this.doc = doc;
    this.viewportWidth = viewportWidth ?? (() => element.clientWidth ?? 0);
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.element.addEventListener('mousemove', this.onMove);
    this.element.addEventListener('mousedown', this.onDown);
    this.element.addEventListener('mouseup', this.onUp);
    this.element.addEventListener('wheel', this.onWheel);
    this.doc.addEventListener('pointerlockchange', this.onLockChange);
    this.element.addEventListener('blur', this.onBlur);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.element.removeEventListener('mousemove', this.onMove);
    this.element.removeEventListener('mousedown', this.onDown);
    this.element.removeEventListener('mouseup', this.onUp);
    this.element.removeEventListener('wheel', this.onWheel);
    this.doc.removeEventListener('pointerlockchange', this.onLockChange);
    this.element.removeEventListener('blur', this.onBlur);
    this.buttons.clear();
  }

  dispose(): void {
    this.detach();
  }

  /** Request pointer lock (camera look). No-op if unsupported. */
  requestLock(): void {
    this.element.requestPointerLock?.();
  }

  /** Exit pointer lock. */
  exitLock(): void {
    this.doc.exitPointerLock?.();
  }

  isLocked(): boolean {
    return this.locked;
  }

  /**
   * Read the frame's accumulated movement/wheel and reset those accumulators.
   * Sticky state (ndcX, held buttons, lock) is preserved.
   */
  snapshotMouse(): {
    dx: number;
    dy: number;
    wheel: number;
    ndcX: number;
    buttons: ReadonlySet<number>;
    locked: boolean;
  } {
    const out = {
      dx: this.dx,
      dy: this.dy,
      wheel: this.wheel,
      ndcX: this.ndcX,
      buttons: this.buttons,
      locked: this.locked,
    };
    this.dx = 0;
    this.dy = 0;
    this.wheel = 0;
    return out;
  }
}
