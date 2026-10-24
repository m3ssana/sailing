/**
 * InputMapper — resolves which actions are active this frame from a device
 * snapshot + a BindingMap, then integrates those into a target `ControlState`
 * patch suitable for `BoatSimulation.setControls`.
 *
 * Control model, per the frozen `ControlState` ranges:
 *  - rudder ∈ [-1,1]: produced by the SteeringFilter (ramp / analog curve /
 *    progressive resistance), then scaled by assist level and speed so low-speed
 *    steering is not twitchy. See `steerScale`.
 *  - mainsheet / jibsheet / spinnaker / vang ∈ [0,1], traveller ∈ [-1,1],
 *    board ∈ [0,1], crewFore / crewLateral ∈ [-1,1], hike ∈ [0,1]: rate-integrated
 *    analog values. Keyboard "in/out" keys trim at TRIM_RATE while held; a
 *    gamepad trigger pair drives the mainsheet directly by its analog value.
 *
 * The mapper OWNS the integrated trim state (the frozen ControlState lives in the
 * simulation; this is the player's *target* before actuator rate limits). It is
 * allocation-free in `step`: it mutates a single owned `_patch` object and
 * returns it by reference.
 *
 * Assist levels (requirement 5.5 — assists only, never physics constants):
 *  - 'arcade':     gentle steering (more low-speed damping, softer authority),
 *                  faster trim so the boat is easy to sail one-handed.
 *  - 'assisted':   between the two.
 *  - 'simulation': direct steering authority and realistic (slower) trim; the
 *                  player feels the full helm. This is the only level where
 *                  steering is 1:1 with intent at speed.
 */

import type { ControlState, CrewCommand, AssistLevel } from '@/types';
import { clamp, saturate } from '@core/math';
import type { BindingMap } from './BindingMap';
import { SteeringFilter } from './SteeringFilter';
import type { DeviceSnapshot, InputAction } from './types';
import { COMMAND_ACTION_MAP } from './types';

/** Trim rate (units/second) for keyboard hold-to-trim. */
export const TRIM_RATE = 0.8;
/** Crew-weight slew rate (units/second) for keyboard. */
export const CREW_RATE = 1.5;

/** Per-assist tuning. Pure assist layer — does not touch physics constants. */
interface AssistProfile {
  /** Extra low-speed steering damping: higher → gentler at rest. */
  lowSpeedDamping: number;
  /** Trim-rate multiplier. */
  trimScale: number;
  /** Overall steering authority multiplier at speed. */
  steerAuthority: number;
}

const ASSIST: Record<AssistLevel, AssistProfile> = {
  arcade: { lowSpeedDamping: 1.6, trimScale: 1.5, steerAuthority: 0.8 },
  assisted: { lowSpeedDamping: 1.2, trimScale: 1.2, steerAuthority: 0.9 },
  simulation: { lowSpeedDamping: 1.0, trimScale: 1.0, steerAuthority: 1.0 },
};

/**
 * Speed/assist scaling of rudder authority. At low speed the rudder bites
 * little in reality, so a full-lock command near zero speed would be twitchy and
 * unrealistic; we scale authority up with speed toward a reference, modulated by
 * the assist profile. Returns a factor in [0,1].
 *
 * @param speed  boat speed through the water, m/s.
 */
export function steerScale(speed: number, assist: AssistLevel): number {
  const p = ASSIST[assist];
  // smooth ramp: near-zero at rest, →1 by ~referenceSpeed. Higher damping in
  // arcade keeps the ramp gentle so beginners don't over-steer at low speed.
  const reference = 4 * p.lowSpeedDamping; // m/s to reach ~full authority
  const ramped = saturate(Math.abs(speed) / reference);
  // Never kill steering entirely (you can still scull off the dock): floor 0.25.
  const floored = 0.25 + 0.75 * ramped;
  return floored * p.steerAuthority;
}

/** A target-control patch; every field optional for `setControls`. */
export type ControlPatch = Partial<ControlState>;

export class InputMapper {
  private readonly steering = new SteeringFilter();

  // Integrated trim/target state. Initialised to sensible neutral positions
  // matching BoatSimulation's own target defaults.
  private _state: ControlState = {
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

  // Owned, reused patch object — returned by reference for allocation-free use.
  private readonly _patch: ControlState = { ...this._state };

  // Owned crew-command buffer, cleared and refilled each frame.
  private readonly _commands: CrewCommand[] = [];

  // Edge-trigger memory for discrete command actions.
  private readonly _prevActive = new Set<InputAction>();

  /** Reset integrated state (e.g. on respawn). */
  reset(): void {
    this._state = {
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
    this.steering.set(0);
    this._prevActive.clear();
  }

  /** Current integrated target state (read-only view). */
  get target(): Readonly<ControlState> {
    return this._state;
  }

  /** Crew commands issued this frame (valid until the next `step`). */
  get commands(): readonly CrewCommand[] {
    return this._commands;
  }

  /**
   * Resolve whether an action is active this frame and, for analog actions, its
   * magnitude. Keyboard/button actions return 1 when held; analog axes return
   * the shaped axis value.
   */
  private resolve(
    action: InputAction,
    bindings: BindingMap,
    dev: DeviceSnapshot,
  ): number {
    let value = 0;
    for (const b of bindings.bindingsFor(action)) {
      switch (b.kind) {
        case 'key':
          if (dev.keyboard.held.has(b.code)) value = Math.max(value, 1);
          break;
        case 'mouseButton':
          if (dev.mouse.buttons.has(b.button)) value = Math.max(value, 1);
          break;
        case 'wheel': {
          // Wheel is an impulse: contribute its magnitude when sign matches.
          const w = dev.mouse.wheel;
          if (b.dir === 1 && w > 0) value = Math.max(value, w);
          else if (b.dir === -1 && w < 0) value = Math.max(value, -w);
          break;
        }
        case 'mouseAxis': {
          // Only meaningful for steering; sign handled by caller.
          const axis = b.axis === 'x' ? dev.mouse.ndcX : 0;
          if (Math.abs(axis) > Math.abs(value)) value = axis;
          break;
        }
        case 'gamepadButton':
          if (dev.gamepad && dev.gamepad.connected) {
            value = Math.max(value, dev.gamepad.buttonValues[b.index] ?? 0);
          }
          break;
        case 'gamepadAxis':
          if (dev.gamepad && dev.gamepad.connected) {
            const raw = dev.gamepad.axes[b.index] ?? 0;
            const signed = raw * b.sign;
            if (signed > value) value = signed;
          }
          break;
      }
    }
    return value;
  }

  /**
   * Steering intent and whether it came from an analog source. Combines the
   * left/right actions: analog (stick/mouse) sources win when present, else the
   * discretised keyboard hold.
   */
  private steerIntent(
    bindings: BindingMap,
    dev: DeviceSnapshot,
  ): { intent: number; analog: boolean } {
    // Analog steering: read each distinct physical axis ONCE and interpret its
    // signed value as "positive = steer right". A steerRight binding declares the
    // axis' positive direction (sign +1) steers right; a steerLeft binding on the
    // SAME axis declares the same physical axis — counting it under both actions
    // would cancel to zero. We therefore key by physical source and keep the
    // largest-magnitude signed contribution.
    let analogVal = 0;
    let analogActive = false;
    const seen = new Set<string>();

    const consider = (action: 'steerLeft' | 'steerRight', signedRight: number): void => {
      // signedRight is already oriented so +1 ⇒ steer right.
      const contribution = action === 'steerRight' ? signedRight : -signedRight;
      if (Math.abs(contribution) > Math.abs(analogVal)) analogVal = contribution;
      if (Math.abs(contribution) > 0) analogActive = true;
    };

    for (const action of ['steerRight', 'steerLeft'] as const) {
      for (const b of bindings.bindingsFor(action)) {
        if (b.kind === 'gamepadAxis' && dev.gamepad?.connected) {
          const key = `ga:${b.index}`;
          if (seen.has(key)) continue;
          seen.add(key);
          // raw*sign puts the binding's declared positive direction at +1.
          const rightward = (dev.gamepad.axes[b.index] ?? 0) * b.sign;
          consider(action, rightward);
        } else if (b.kind === 'mouseAxis' && !dev.pointerLocked) {
          const key = `ma:${b.axis}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const rightward = b.axis === 'x' ? dev.mouse.ndcX : 0;
          consider(action, rightward);
        }
      }
    }
    if (analogActive) return { intent: clamp(analogVal, -1, 1), analog: true };

    // Keyboard hold: left vs right.
    const left = this.resolve('steerLeft', bindings, dev) > 0 ? 1 : 0;
    const right = this.resolve('steerRight', bindings, dev) > 0 ? 1 : 0;
    return { intent: right - left, analog: false };
  }

  /**
   * Advance one frame. Returns the owned `_patch` (by reference, allocation-free
   * in steady state). Also updates `commands` (edge-triggered crew commands) and
   * exposes the steering filter's helm-aware rudder.
   */
  step(
    bindings: BindingMap,
    dev: DeviceSnapshot,
    helmLoad: number,
    speed: number,
    dt: number,
    assist: AssistLevel,
  ): ControlState {
    const p = ASSIST[assist];
    const s = this._state;

    // ── Steering ──────────────────────────────────────────────────────────
    const { intent, analog } = this.steerIntent(bindings, dev);
    const filtered = this.steering.update(intent, analog, helmLoad, dt);
    s.rudder = clamp(filtered * steerScale(speed, assist), -1, 1);

    // ── Trim (rate-integrated) ────────────────────────────────────────────
    const trimStep = TRIM_RATE * p.trimScale * dt;

    // Mainsheet: keyboard in/out, wheel, OR analog gamepad trigger pair (rate
    // control — the trigger's analog depth sets how fast the sheet comes in/out).
    const mainTriggerIn = this.triggerValue(bindings, dev, 'mainTrimIn');
    const mainTriggerOut = this.triggerValue(bindings, dev, 'mainTrimOut');
    if (mainTriggerIn !== null || mainTriggerOut !== null) {
      const rate = ((mainTriggerIn ?? 0) - (mainTriggerOut ?? 0)) * trimStep * 2;
      s.mainsheet = saturate(s.mainsheet + rate);
    } else {
      s.mainsheet = this.integrateTrim(
        s.mainsheet,
        this.held(bindings, dev, 'mainTrimIn') + this.wheelMag(bindings, dev, 'mainTrimIn'),
        this.held(bindings, dev, 'mainTrimOut') + this.wheelMag(bindings, dev, 'mainTrimOut'),
        trimStep,
        0,
        1,
      );
    }

    s.jibsheet = this.integrateTrim(
      s.jibsheet,
      this.held(bindings, dev, 'jibTrimIn'),
      this.held(bindings, dev, 'jibTrimOut'),
      trimStep,
      0,
      1,
    );
    s.vang = this.integrateTrim(
      s.vang,
      this.held(bindings, dev, 'vangOn'),
      this.held(bindings, dev, 'vangOff'),
      trimStep,
      0,
      1,
    );
    s.traveller = this.integrateTrim(
      s.traveller,
      this.held(bindings, dev, 'travellerRight'),
      this.held(bindings, dev, 'travellerLeft'),
      trimStep,
      -1,
      1,
    );
    s.board = this.integrateTrim(
      s.board,
      this.held(bindings, dev, 'boardDown'),
      this.held(bindings, dev, 'boardUp'),
      trimStep,
      0,
      1,
    );
    s.spinnaker = this.integrateTrim(
      s.spinnaker,
      this.held(bindings, dev, 'spinnakerSet'),
      this.held(bindings, dev, 'spinnakerDouse'),
      trimStep,
      0,
      1,
    );

    // ── Crew weight ───────────────────────────────────────────────────────
    const crewStep = CREW_RATE * dt;
    // Hike is a 0..1 effort: held → ramp up, released → ramp down.
    s.hike = this.integrateTrim(
      s.hike,
      this.held(bindings, dev, 'hike'),
      this.held(bindings, dev, 'hike') > 0 ? 0 : 1,
      crewStep,
      0,
      1,
    );
    s.crewFore = this.integrateTrim(
      s.crewFore,
      this.held(bindings, dev, 'crewForward'),
      this.held(bindings, dev, 'crewAft'),
      crewStep,
      -1,
      1,
    );
    s.crewLateral = this.integrateTrim(
      s.crewLateral,
      this.held(bindings, dev, 'crewToStarboard'),
      this.held(bindings, dev, 'crewToPort'),
      crewStep,
      -1,
      1,
    );

    // ── Discrete crew commands (edge-triggered) ─────────────────────────────
    this._commands.length = 0;
    for (const action of Object.keys(COMMAND_ACTION_MAP) as InputAction[]) {
      const cmd = COMMAND_ACTION_MAP[action];
      if (cmd === undefined) continue;
      const active = this.held(bindings, dev, action) > 0;
      const was = this._prevActive.has(action);
      if (active && !was) this._commands.push(cmd);
      if (active) this._prevActive.add(action);
      else this._prevActive.delete(action);
    }

    // ── Copy integrated state into the owned patch (no allocation) ──────────
    this._patch.rudder = s.rudder;
    this._patch.mainsheet = s.mainsheet;
    this._patch.jibsheet = s.jibsheet;
    this._patch.spinnaker = s.spinnaker;
    this._patch.vang = s.vang;
    this._patch.traveller = s.traveller;
    this._patch.board = s.board;
    this._patch.crewFore = s.crewFore;
    this._patch.crewLateral = s.crewLateral;
    this._patch.hike = s.hike;
    return this._patch;
  }

  /** 1 when any binding for the action is held (digital), else 0. */
  private held(bindings: BindingMap, dev: DeviceSnapshot, action: InputAction): number {
    return this.resolve(action, bindings, dev) > 0 ? 1 : 0;
  }

  /** Wheel-impulse magnitude bound to the action this frame (0 if none). */
  private wheelMag(bindings: BindingMap, dev: DeviceSnapshot, action: InputAction): number {
    let mag = 0;
    for (const b of bindings.bindingsFor(action)) {
      if (b.kind === 'wheel') {
        const w = dev.mouse.wheel;
        if (b.dir === 1 && w > 0) mag = Math.max(mag, w);
        else if (b.dir === -1 && w < 0) mag = Math.max(mag, -w);
      }
    }
    return mag;
  }

  /**
   * Analog trigger value for a mainsheet action if a gamepad-button (trigger)
   * binding exists and the gamepad is connected; null if no analog source.
   */
  private triggerValue(
    bindings: BindingMap,
    dev: DeviceSnapshot,
    action: InputAction,
  ): number | null {
    if (!dev.gamepad?.connected) return null;
    let found: number | null = null;
    for (const b of bindings.bindingsFor(action)) {
      if (b.kind === 'gamepadButton') {
        const v = dev.gamepad.buttonValues[b.index] ?? 0;
        found = Math.max(found ?? 0, v);
      }
    }
    return found;
  }

  /** Integrate a trim value by `up` keys (toward max) and `down` (toward min). */
  private integrateTrim(
    current: number,
    up: number,
    down: number,
    step: number,
    min: number,
    max: number,
  ): number {
    const delta = (up > 0 ? step : 0) - (down > 0 ? step : 0);
    return clamp(current + delta, min, max);
  }
}
