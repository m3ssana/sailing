/**
 * ControlsAdapter — the single pure per-frame entry point the session layer
 * calls. Given the current bindings, the merged device snapshot, the boat's
 * `helmLoad` and speed, the frame dt, and the assist level, it returns:
 *
 *   - `controlsPatch`: a `Partial<ControlState>` to hand to
 *     `BoatSimulation.setControls`;
 *   - `rumble`: dual-rumble intensities derived from helmLoad (and speed/slam);
 *   - `input`: a frozen-shape `InputState` snapshot (controls + crewCommands +
 *     lookDelta + cameraCycle + pausePressed) for anything that consumes the
 *     frozen contract directly.
 *
 * Allocation discipline: the adapter owns its output objects and returns them by
 * reference every frame. In steady state (same call pattern) no allocation
 * occurs — `frame()` returns the *same object references* each call, which the
 * tests assert. The InputMapper it wraps is likewise allocation-free.
 */

import type { AssistLevel, ControlState, InputState, Vec2 } from '@/types';
import { InputMapper } from './InputMapper';
import type { ControlPatch } from './InputMapper';
import type { BindingMap } from './BindingMap';
import { rumbleFromHelmLoad } from './SteeringFilter';
import type { DeviceSnapshot, RumbleOutput } from './types';

export interface FrameResult {
  /** Target control patch for BoatSimulation.setControls. */
  controlsPatch: ControlPatch;
  /** Dual-rumble intensities for the gamepad. */
  rumble: RumbleOutput;
  /** Frozen-shape input snapshot. */
  input: InputState;
}

export class ControlsAdapter {
  private readonly mapper = new InputMapper();

  // Owned outputs, reused every frame (allocation-free steady state).
  private readonly _rumble: RumbleOutput = { weak: 0, strong: 0 };
  private readonly _lookDelta: Vec2 = { x: 0, y: 0 };
  private readonly _controls: ControlState = {
    rudder: 0,
    mainsheet: 0.5,
    jibsheet: 0.5,
    spinnaker: 0,
    vang: 0.5,
    traveller: 0,
    board: 1,
    crewFore: 0,
    crewLateral: 0,
    hike: 0,
  };
  private readonly _crewCommands: InputState['crewCommands'] = [];
  private readonly _input: InputState = {
    controls: this._controls,
    crewCommands: this._crewCommands,
    lookDelta: this._lookDelta,
    cameraCycle: 0,
    pausePressed: false,
  };
  private readonly _result: FrameResult = {
    controlsPatch: this._controls,
    rumble: this._rumble,
    input: this._input,
  };

  // Edge-trigger memory for pause / camera (discrete meta actions).
  private _pauseWasDown = false;
  private _cameraWasDown = false;

  /** Reset integrated control state (e.g. on respawn). */
  reset(): void {
    this.mapper.reset();
    this._pauseWasDown = false;
    this._cameraWasDown = false;
  }

  /**
   * Compute one frame. Returns owned objects by reference — do not retain the
   * returned references across frames expecting them to be stable snapshots;
   * they are deliberately mutated in place for the zero-allocation hot path.
   */
  frame(
    bindings: BindingMap,
    dev: DeviceSnapshot,
    helmLoad: number,
    speed: number,
    dt: number,
    assist: AssistLevel,
    slam = 0,
  ): FrameResult {
    // ── Controls (mapper mutates its own state; copy fields into owned patch) ─
    const patch = this.mapper.step(bindings, dev, helmLoad, speed, dt, assist);
    this._controls.rudder = patch.rudder;
    this._controls.mainsheet = patch.mainsheet;
    this._controls.jibsheet = patch.jibsheet;
    this._controls.spinnaker = patch.spinnaker;
    this._controls.vang = patch.vang;
    this._controls.traveller = patch.traveller;
    this._controls.board = patch.board;
    this._controls.crewFore = patch.crewFore;
    this._controls.crewLateral = patch.crewLateral;
    this._controls.hike = patch.hike;

    // ── Rumble from helmLoad (allocation-free: copy into owned object) ───────
    const r = rumbleFromHelmLoad(helmLoad, speed, slam);
    this._rumble.weak = r.weak;
    this._rumble.strong = r.strong;

    // ── Crew commands (copy mapper's buffer into the owned array) ────────────
    this._crewCommands.length = 0;
    for (const cmd of this.mapper.commands) this._crewCommands.push(cmd);

    // ── Camera look delta: relative mouse while pointer-locked ───────────────
    if (dev.pointerLocked) {
      this._lookDelta.x = dev.mouse.dx;
      this._lookDelta.y = dev.mouse.dy;
    } else {
      this._lookDelta.x = 0;
      this._lookDelta.y = 0;
    }

    // ── Meta: pause / camera cycle (edge-triggered) ──────────────────────────
    const pauseDown = this.metaHeld(bindings, dev, 'pause');
    this._input.pausePressed = pauseDown && !this._pauseWasDown;
    this._pauseWasDown = pauseDown;

    const camDown = this.metaHeld(bindings, dev, 'cameraCycle');
    this._input.cameraCycle = camDown && !this._cameraWasDown ? 1 : 0;
    this._cameraWasDown = camDown;

    return this._result;
  }

  private metaHeld(
    bindings: BindingMap,
    dev: DeviceSnapshot,
    action: 'pause' | 'cameraCycle',
  ): boolean {
    for (const b of bindings.bindingsFor(action)) {
      if (b.kind === 'key' && dev.keyboard.held.has(b.code)) return true;
      if (b.kind === 'mouseButton' && dev.mouse.buttons.has(b.button)) return true;
      if (
        b.kind === 'gamepadButton' &&
        dev.gamepad?.connected &&
        (dev.gamepad.buttonValues[b.index] ?? 0) > 0.5
      ) {
        return true;
      }
    }
    return false;
  }
}
