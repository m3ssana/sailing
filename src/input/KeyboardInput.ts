/**
 * KeyboardInput — DOM keyboard adapter.
 *
 * Tracks held keys by `KeyboardEvent.code` (layout-stable), so that bindings
 * reference physical keys rather than produced characters. It:
 *   - clears all held keys on window blur (so a key held while focus leaves does
 *     not stick down forever);
 *   - calls preventDefault ONLY for codes that are currently bound (so the page
 *     still scrolls / tabs when the player presses an unbound key);
 *   - ignores keystrokes while the user is typing in an <input>/<textarea> or a
 *     contentEditable element (rebinding UI, chat, etc.).
 *
 * The event target is dependency-injected so the adapter can be driven by a
 * hand-written fake under vitest's node environment (no jsdom required).
 */

/** The minimal surface KeyboardInput needs from an event target. */
export interface DomEventTarget {
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  removeEventListener(type: string, listener: (ev: unknown) => void): void;
}

/** Minimal shape of the keyboard events we read. */
export interface KeyEventLike {
  code: string;
  preventDefault?: () => void;
  target?: { tagName?: string; isContentEditable?: boolean } | null;
}

/** Returns true if the given binding code is currently bound to any action. */
export type IsBoundFn = (code: string) => boolean;

function isTypingTarget(target: KeyEventLike['target']): boolean {
  if (!target) return false;
  const tag = target.tagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable === true;
}

export class KeyboardInput {
  private readonly held = new Set<string>();
  private readonly target: DomEventTarget;
  private readonly windowTarget: DomEventTarget;
  private readonly isBound: IsBoundFn;
  private attached = false;

  private readonly onKeyDown = (ev: unknown): void => {
    const e = ev as KeyEventLike;
    if (isTypingTarget(e.target)) return;
    if (this.isBound(e.code)) {
      e.preventDefault?.();
    }
    this.held.add(e.code);
  };

  private readonly onKeyUp = (ev: unknown): void => {
    const e = ev as KeyEventLike;
    this.held.delete(e.code);
  };

  private readonly onBlur = (): void => {
    this.held.clear();
  };

  /**
   * @param target        element/document receiving key events.
   * @param isBound       predicate: is this code bound to anything? (controls preventDefault)
   * @param windowTarget  target for the blur event (defaults to `target`).
   */
  constructor(target: DomEventTarget, isBound: IsBoundFn, windowTarget?: DomEventTarget) {
    this.target = target;
    this.isBound = isBound;
    this.windowTarget = windowTarget ?? target;
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.target.addEventListener('keydown', this.onKeyDown);
    this.target.addEventListener('keyup', this.onKeyUp);
    this.windowTarget.addEventListener('blur', this.onBlur);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.windowTarget.removeEventListener('blur', this.onBlur);
    this.held.clear();
  }

  dispose(): void {
    this.detach();
  }

  /** The set of codes currently held (live view — copied by InputManager). */
  heldCodes(): ReadonlySet<string> {
    return this.held;
  }

  /** Test/aid hook: force-clear (e.g. simulating blur). */
  clear(): void {
    this.held.clear();
  }
}
