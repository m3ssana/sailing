/**
 * GamepadInput — DOM gamepad adapter (standard mapping).
 *
 * Polls `navigator.getGamepads()` (via an injected provider) once per frame,
 * applies a radial-ish per-axis deadzone, and exposes a `GamepadSnapshot`.
 * Handles hot-plug: if the active gamepad index disconnects, it falls back to
 * the first connected pad on the next poll; if none is connected it reports
 * `null`. Rumble is sent via `vibrationActuator.playEffect('dual-rumble')`,
 * guarded for browsers lacking the API.
 *
 * The provider is dependency-injected so tests can supply fake pads under
 * vitest node (no real Gamepad API).
 */

import type { GamepadSnapshot } from '@game/input';

/** The minimal gamepad shape we read (a subset of the DOM Gamepad). */
export interface GamepadLike {
  connected: boolean;
  index: number;
  axes: readonly number[];
  buttons: readonly { pressed: boolean; value: number }[];
  vibrationActuator?: {
    playEffect?: (type: string, params: Record<string, number>) => Promise<string> | void;
  };
}

/** Provider returning the current pads (like navigator.getGamepads). */
export type GamepadProvider = () => readonly (GamepadLike | null)[];

export const DEFAULT_GAMEPAD_DEADZONE = 0.08;

export class GamepadInput {
  private readonly provider: GamepadProvider;
  private readonly deadzone: number;
  private activeIndex: number | null = null;

  constructor(provider: GamepadProvider, deadzone = DEFAULT_GAMEPAD_DEADZONE) {
    this.provider = provider;
    this.deadzone = deadzone;
  }

  // These adapters are pollers, not listeners; attach/detach are no-ops kept for
  // a uniform lifecycle with the event-driven adapters.
  attach(): void {
    /* polling adapter — nothing to bind */
  }
  detach(): void {
    this.activeIndex = null;
  }
  dispose(): void {
    this.detach();
  }

  /** Pick the active pad, handling hot-plug. Returns null if none connected. */
  private pickPad(): GamepadLike | null {
    const pads = this.provider();
    // Keep the current active pad if still connected.
    if (this.activeIndex !== null) {
      const current = pads[this.activeIndex];
      if (current && current.connected) return current;
      this.activeIndex = null;
    }
    // Otherwise grab the first connected pad.
    for (const pad of pads) {
      if (pad && pad.connected) {
        this.activeIndex = pad.index;
        return pad;
      }
    }
    return null;
  }

  /** Poll once; returns the deadzoned snapshot or null if no pad. */
  poll(): GamepadSnapshot | null {
    const pad = this.pickPad();
    if (pad === null) return null;
    const axes = pad.axes.map((v) => this.applyDeadzone(v));
    const buttons = pad.buttons.map((b) => b.pressed);
    const buttonValues = pad.buttons.map((b) => b.value);
    return { connected: true, axes, buttons, buttonValues };
  }

  private applyDeadzone(v: number): number {
    if (Math.abs(v) < this.deadzone) return 0;
    // Rescale so the usable range starts at 0 just past the deadzone.
    const sign = v < 0 ? -1 : 1;
    return sign * ((Math.abs(v) - this.deadzone) / (1 - this.deadzone));
  }

  /**
   * Send a dual-rumble effect. Guarded: silently no-ops if the active pad has no
   * vibration actuator or the browser lacks playEffect.
   */
  rumble(weak: number, strong: number, durationMs = 100): void {
    if (this.activeIndex === null) return;
    const pads = this.provider();
    const pad = pads[this.activeIndex];
    const play = pad?.vibrationActuator?.playEffect;
    if (!pad || typeof play !== 'function') return;
    const result = play.call(pad.vibrationActuator, 'dual-rumble', {
      duration: durationMs,
      weakMagnitude: clamp01(weak),
      strongMagnitude: clamp01(strong),
    });
    // The spec returns a promise that may reject on unsupported effect types;
    // swallow it so a frame never throws on an unsupported browser.
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      (result as Promise<unknown>).catch(() => {
        /* unsupported — ignore */
      });
    }
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
