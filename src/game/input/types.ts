/**
 * Input-layer types local to the game/input models.
 *
 * These are NOT the frozen contract. The frozen `InputState` (src/types/game.ts)
 * is the game-facing snapshot the session consumes; everything here is private to
 * the input mapping layer. Where the input layer needs something the frozen type
 * does not express (a raw device snapshot, per-action bindings, rate state) it is
 * defined here rather than by editing the frozen surface.
 *
 * Conventions: SI / radians internally; all analog values normalised to the same
 * ranges the frozen `ControlState` uses (rudder/traveller/crew ∈ [-1,1]; sheets,
 * board, hike ∈ [0,1]).
 */

import type { CrewCommand } from '@/types';

/** Every discrete or continuous thing the player can bind an input to. */
export type InputAction =
  // Steering (analog-capable: keyboard ramps, stick is direct)
  | 'steerLeft'
  | 'steerRight'
  // Trim — each sheet has an "in" (trim) and "out" (ease) action for keyboard
  | 'mainTrimIn'
  | 'mainTrimOut'
  | 'jibTrimIn'
  | 'jibTrimOut'
  | 'travellerLeft'
  | 'travellerRight'
  | 'vangOn'
  | 'vangOff'
  | 'boardDown'
  | 'boardUp'
  | 'spinnakerSet'
  | 'spinnakerDouse'
  // Crew weight (the player's own body on a single-hander)
  | 'hike'
  | 'crewForward'
  | 'crewAft'
  | 'crewToPort'
  | 'crewToStarboard'
  // Crew commands (discrete, edge-triggered) — map to frozen CrewCommand
  | 'cmdTack'
  | 'cmdGybe'
  | 'cmdHikeHarder'
  | 'cmdEaseOut'
  | 'cmdHoistSpinnaker'
  | 'cmdDouseSpinnaker'
  | 'cmdMoveForward'
  | 'cmdMoveAft'
  // Meta
  | 'pause'
  | 'cameraCycle';

/** Which frozen CrewCommand a discrete command action issues, if any. */
export const COMMAND_ACTION_MAP: Partial<Record<InputAction, CrewCommand>> = {
  cmdTack: 'prepareTack',
  cmdGybe: 'prepareGybe',
  cmdHikeHarder: 'hikeHarder',
  cmdEaseOut: 'easeOut',
  cmdHoistSpinnaker: 'hoistSpinnaker',
  cmdDouseSpinnaker: 'douseSpinnaker',
  cmdMoveForward: 'moveForward',
  cmdMoveAft: 'moveAft',
};

/**
 * A bindable physical input. `kind` disambiguates how the raw value is read from
 * a device snapshot. Keyboard uses `KeyboardEvent.code` strings (layout-stable).
 */
export type InputBinding =
  | { readonly kind: 'key'; readonly code: string }
  | { readonly kind: 'mouseButton'; readonly button: number }
  | { readonly kind: 'mouseAxis'; readonly axis: 'x' | 'y' }
  | { readonly kind: 'wheel'; readonly dir: 1 | -1 }
  | { readonly kind: 'gamepadButton'; readonly index: number }
  | { readonly kind: 'gamepadAxis'; readonly index: number; readonly sign: 1 | -1 };

/** A raw keyboard snapshot for one frame: which bound codes are currently held. */
export interface KeyboardSnapshot {
  /** Codes currently held down this frame. */
  readonly held: ReadonlySet<string>;
}

/** A raw mouse snapshot accumulated over the frame. */
export interface MouseSnapshot {
  /** Accumulated pointer movement in device pixels this frame. */
  readonly dx: number;
  readonly dy: number;
  /** Absolute normalised X in [-1,1] when pointer-lock is off (mouse-only steer). */
  readonly ndcX: number;
  /** Accumulated wheel delta this frame (sign: positive = scroll down/away). */
  readonly wheel: number;
  /** Buttons currently held, by button index. */
  readonly buttons: ReadonlySet<number>;
}

/** One gamepad's raw, deadzone-free snapshot (standard mapping). */
export interface GamepadSnapshot {
  readonly connected: boolean;
  /** Axis values in [-1,1], standard mapping order. */
  readonly axes: readonly number[];
  /** Button pressed-flags. */
  readonly buttons: readonly boolean[];
  /** Analog button values in [0,1] (triggers live at 6/7 in standard mapping). */
  readonly buttonValues: readonly number[];
}

/** Everything a frame needs about every device, produced by the DOM layer. */
export interface DeviceSnapshot {
  readonly keyboard: KeyboardSnapshot;
  readonly mouse: MouseSnapshot;
  /** The active gamepad, or null when none is connected. */
  readonly gamepad: GamepadSnapshot | null;
  /** True when pointer lock is active (relative mouse → camera look). */
  readonly pointerLocked: boolean;
}

/** Dual-rumble actuator intensities, each 0..1. */
export interface RumbleOutput {
  weak: number;
  strong: number;
}
