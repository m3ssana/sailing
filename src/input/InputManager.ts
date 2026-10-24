/**
 * InputManager — merges the three device adapters into a single, reused
 * `DeviceSnapshot` per frame. Owns one snapshot object and mutates it in place
 * so the per-frame path allocates nothing beyond what the adapters return.
 *
 * It does not interpret bindings or produce controls — that is the pure
 * ControlsAdapter's job (src/game/input). This layer is purely about reading the
 * DOM and shaping it into the engine-agnostic DeviceSnapshot.
 */

import type { DeviceSnapshot, GamepadSnapshot } from '@game/input';
import type { KeyboardInput } from './KeyboardInput';
import type { MouseInput } from './MouseInput';
import type { GamepadInput } from './GamepadInput';

export class InputManager {
  private readonly keyboard: KeyboardInput;
  private readonly mouse: MouseInput;
  private readonly gamepad: GamepadInput;

  // Owned snapshot, reused each frame.
  private readonly _snapshot: {
    keyboard: { held: ReadonlySet<string> };
    mouse: {
      dx: number;
      dy: number;
      ndcX: number;
      wheel: number;
      buttons: ReadonlySet<number>;
    };
    gamepad: GamepadSnapshot | null;
    pointerLocked: boolean;
  } = {
    keyboard: { held: new Set<string>() },
    mouse: { dx: 0, dy: 0, ndcX: 0, wheel: 0, buttons: new Set<number>() },
    gamepad: null,
    pointerLocked: false,
  };

  constructor(keyboard: KeyboardInput, mouse: MouseInput, gamepad: GamepadInput) {
    this.keyboard = keyboard;
    this.mouse = mouse;
    this.gamepad = gamepad;
  }

  attach(): void {
    this.keyboard.attach();
    this.mouse.attach();
    this.gamepad.attach();
  }

  detach(): void {
    this.keyboard.detach();
    this.mouse.detach();
    this.gamepad.detach();
  }

  dispose(): void {
    this.keyboard.dispose();
    this.mouse.dispose();
    this.gamepad.dispose();
  }

  /** The gamepad adapter, exposed so the session can drive rumble. */
  get gamepadInput(): GamepadInput {
    return this.gamepad;
  }

  /**
   * Produce this frame's merged snapshot. Reads and resets the per-frame
   * accumulators in MouseInput, polls the gamepad, and reflects held keys.
   * Returns the owned snapshot by reference.
   */
  sample(): DeviceSnapshot {
    const m = this.mouse.snapshotMouse();
    this._snapshot.keyboard.held = this.keyboard.heldCodes();
    this._snapshot.mouse.dx = m.dx;
    this._snapshot.mouse.dy = m.dy;
    this._snapshot.mouse.ndcX = m.ndcX;
    this._snapshot.mouse.wheel = m.wheel;
    this._snapshot.mouse.buttons = m.buttons;
    this._snapshot.gamepad = this.gamepad.poll();
    this._snapshot.pointerLocked = m.locked;
    return this._snapshot as DeviceSnapshot;
  }
}
