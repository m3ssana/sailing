/**
 * BindingMap — the player's action→input bindings, with rebinding, conflict
 * detection, and versioned JSON (de)serialisation.
 *
 * An action may have more than one binding (e.g. `steerLeft` is both `KeyA` and
 * `ArrowLeft` by default). A single physical input may NOT be bound to more than
 * one action — that is the conflict `rebind` detects and reports.
 *
 * Serialisation is versioned: an unknown or malformed payload is rejected rather
 * than silently loaded, and a payload whose version we do not recognise migrates
 * to the current defaults (never throws on load).
 */

import type { InputAction, InputBinding } from './types';
import { COMMAND_ACTION_MAP } from './types';

/** Current persisted-schema version. Bump when the binding shape changes. */
export const BINDING_SCHEMA_VERSION = 1;

/** The complete set of actions that must be reachable to actually sail a boat. */
export const ESSENTIAL_ACTIONS: readonly InputAction[] = [
  'steerLeft',
  'steerRight',
  'mainTrimIn',
  'mainTrimOut',
  'hike',
  'cmdTack',
];

/** Serialised binding payload. */
export interface SerialisedBindings {
  version: number;
  /** action → list of bindings. */
  bindings: Partial<Record<InputAction, InputBinding[]>>;
}

/** A conflict surfaced by `rebind`: the input already belongs to `action`. */
export interface BindingConflict {
  action: InputAction;
  binding: InputBinding;
}

function bindingKey(b: InputBinding): string {
  switch (b.kind) {
    case 'key':
      return `key:${b.code}`;
    case 'mouseButton':
      return `mb:${b.button}`;
    case 'mouseAxis':
      return `ma:${b.axis}`;
    case 'wheel':
      return `wh:${b.dir}`;
    case 'gamepadButton':
      return `gb:${b.index}`;
    case 'gamepadAxis':
      return `ga:${b.index}:${b.sign}`;
  }
}

function bindingsEqual(a: InputBinding, b: InputBinding): boolean {
  return bindingKey(a) === bindingKey(b);
}

/** Default keyboard + gamepad + mouse bindings (two-handed, full scheme). */
export function defaultBindings(): Record<InputAction, InputBinding[]> {
  return {
    steerLeft: [
      { kind: 'key', code: 'KeyA' },
      { kind: 'key', code: 'ArrowLeft' },
      { kind: 'gamepadAxis', index: 0, sign: -1 },
    ],
    steerRight: [
      { kind: 'key', code: 'KeyD' },
      { kind: 'key', code: 'ArrowRight' },
      { kind: 'gamepadAxis', index: 0, sign: 1 },
    ],
    mainTrimIn: [
      { kind: 'key', code: 'KeyW' },
      { kind: 'key', code: 'KeyQ' },
      { kind: 'gamepadButton', index: 7 }, // right trigger
    ],
    mainTrimOut: [
      { kind: 'key', code: 'KeyS' },
      { kind: 'key', code: 'KeyE' },
      { kind: 'gamepadButton', index: 6 }, // left trigger
    ],
    jibTrimIn: [{ kind: 'key', code: 'KeyZ' }],
    jibTrimOut: [{ kind: 'key', code: 'KeyX' }],
    travellerLeft: [{ kind: 'key', code: 'Comma' }],
    travellerRight: [{ kind: 'key', code: 'Period' }],
    vangOn: [{ kind: 'key', code: 'KeyR' }],
    vangOff: [{ kind: 'key', code: 'KeyF' }],
    boardDown: [{ kind: 'key', code: 'KeyG' }],
    boardUp: [{ kind: 'key', code: 'KeyB' }],
    spinnakerSet: [{ kind: 'key', code: 'KeyV' }],
    spinnakerDouse: [{ kind: 'key', code: 'KeyC' }],
    hike: [
      { kind: 'key', code: 'ShiftLeft' },
      { kind: 'gamepadButton', index: 0 }, // A
    ],
    crewForward: [{ kind: 'key', code: 'KeyI' }],
    crewAft: [{ kind: 'key', code: 'KeyK' }],
    crewToPort: [{ kind: 'key', code: 'KeyJ' }],
    crewToStarboard: [{ kind: 'key', code: 'KeyL' }],
    cmdTack: [
      { kind: 'key', code: 'KeyT' },
      { kind: 'gamepadButton', index: 2 }, // X
    ],
    cmdGybe: [
      { kind: 'key', code: 'KeyY' },
      { kind: 'gamepadButton', index: 1 }, // B
    ],
    cmdHikeHarder: [{ kind: 'key', code: 'Digit1' }],
    cmdEaseOut: [{ kind: 'key', code: 'Digit2' }],
    cmdHoistSpinnaker: [{ kind: 'key', code: 'Digit3' }],
    cmdDouseSpinnaker: [{ kind: 'key', code: 'Digit4' }],
    cmdMoveForward: [{ kind: 'key', code: 'Digit5' }],
    cmdMoveAft: [{ kind: 'key', code: 'Digit6' }],
    pause: [
      { kind: 'key', code: 'Escape' },
      { kind: 'gamepadButton', index: 9 }, // Start
    ],
    cameraCycle: [
      { kind: 'key', code: 'KeyP' },
      { kind: 'gamepadButton', index: 3 }, // Y
    ],
  };
}

/**
 * One-handed preset (requirement 12.4). Everything essential is reachable with a
 * single hand resting on the arrow-cluster / navigation block of a keyboard
 * (arrows, Enter, Backspace, right Shift, Insert/Delete/Home/End) OR with the
 * mouse alone: mouse X steers, the wheel trims the mainsheet. No action requires
 * a key the same hand cannot reach without repositioning.
 */
export function oneHandedBindings(): Record<InputAction, InputBinding[]> {
  return {
    // Mouse X steers; arrows are the keyboard equivalent, both one-hand reachable.
    steerLeft: [
      { kind: 'key', code: 'ArrowLeft' },
      { kind: 'mouseAxis', axis: 'x' },
    ],
    steerRight: [
      { kind: 'key', code: 'ArrowRight' },
      { kind: 'mouseAxis', axis: 'x' },
    ],
    // Up/Down trim the main; wheel is the mouse-only equivalent.
    mainTrimIn: [
      { kind: 'key', code: 'ArrowUp' },
      { kind: 'wheel', dir: -1 },
    ],
    mainTrimOut: [
      { kind: 'key', code: 'ArrowDown' },
      { kind: 'wheel', dir: 1 },
    ],
    // Jib shares the nav cluster.
    jibTrimIn: [{ kind: 'key', code: 'Home' }],
    jibTrimOut: [{ kind: 'key', code: 'End' }],
    travellerLeft: [{ kind: 'key', code: 'Delete' }],
    travellerRight: [{ kind: 'key', code: 'PageDown' }],
    vangOn: [{ kind: 'key', code: 'Insert' }],
    vangOff: [{ kind: 'key', code: 'PageUp' }],
    boardDown: [{ kind: 'key', code: 'Backslash' }],
    boardUp: [{ kind: 'key', code: 'Quote' }],
    spinnakerSet: [{ kind: 'key', code: 'BracketLeft' }],
    spinnakerDouse: [{ kind: 'key', code: 'BracketRight' }],
    // Right Shift sits under the same hand as the arrows.
    hike: [
      { kind: 'key', code: 'ShiftRight' },
      { kind: 'mouseButton', button: 2 },
    ],
    crewForward: [{ kind: 'key', code: 'Semicolon' }],
    crewAft: [{ kind: 'key', code: 'Slash' }],
    crewToPort: [{ kind: 'key', code: 'Minus' }],
    crewToStarboard: [{ kind: 'key', code: 'Equal' }],
    // Enter / Backspace: the two big one-hand-reachable action keys.
    cmdTack: [
      { kind: 'key', code: 'Enter' },
      { kind: 'mouseButton', button: 0 },
    ],
    cmdGybe: [
      { kind: 'key', code: 'Backspace' },
      { kind: 'mouseButton', button: 1 },
    ],
    cmdHikeHarder: [{ kind: 'key', code: 'NumpadAdd' }],
    cmdEaseOut: [{ kind: 'key', code: 'NumpadSubtract' }],
    cmdHoistSpinnaker: [{ kind: 'key', code: 'Numpad7' }],
    cmdDouseSpinnaker: [{ kind: 'key', code: 'Numpad9' }],
    cmdMoveForward: [{ kind: 'key', code: 'Numpad8' }],
    cmdMoveAft: [{ kind: 'key', code: 'Numpad5' }],
    pause: [{ kind: 'key', code: 'Escape' }],
    cameraCycle: [{ kind: 'key', code: 'NumpadEnter' }],
  };
}

export class BindingMap {
  private _map: Map<InputAction, InputBinding[]>;

  constructor(initial?: Record<InputAction, InputBinding[]>) {
    const source = initial ?? defaultBindings();
    this._map = new Map();
    for (const action of Object.keys(source) as InputAction[]) {
      this._map.set(action, [...source[action]]);
    }
  }

  /** The command action→CrewCommand map, for the mapper. */
  static readonly commandMap = COMMAND_ACTION_MAP;

  /** All bindings for an action (never null; empty array if unbound). */
  bindingsFor(action: InputAction): readonly InputBinding[] {
    return this._map.get(action) ?? [];
  }

  /** Every action currently known to the map. */
  actions(): InputAction[] {
    return [...this._map.keys()];
  }

  /**
   * Which action a given physical input currently belongs to, or null if free.
   */
  actionForBinding(binding: InputBinding): InputAction | null {
    for (const [action, list] of this._map) {
      if (list.some((b) => bindingsEqual(b, binding))) return action;
    }
    return null;
  }

  /**
   * Bind `input` to `action`, returning any conflicts (other actions that held
   * the same input and were cleared of it). The rebind is applied regardless —
   * the caller decides whether to keep it given the reported conflicts.
   */
  rebind(action: InputAction, input: InputBinding): BindingConflict[] {
    const conflicts: BindingConflict[] = [];
    for (const [other, list] of this._map) {
      if (other === action) continue;
      const idx = list.findIndex((b) => bindingsEqual(b, input));
      if (idx !== -1) {
        conflicts.push({ action: other, binding: input });
        list.splice(idx, 1);
      }
    }
    const current = this._map.get(action) ?? [];
    if (!current.some((b) => bindingsEqual(b, input))) current.push(input);
    this._map.set(action, current);
    return conflicts;
  }

  /** Remove a specific binding from an action. */
  unbind(action: InputAction, input: InputBinding): void {
    const list = this._map.get(action);
    if (list === undefined) return;
    const idx = list.findIndex((b) => bindingsEqual(b, input));
    if (idx !== -1) list.splice(idx, 1);
  }

  /** Reset every action to the default scheme. */
  resetToDefaults(): void {
    this._map = new BindingMap(defaultBindings())._map;
  }

  /** Serialise to a versioned, JSON-safe payload. */
  serialise(): SerialisedBindings {
    const bindings: Partial<Record<InputAction, InputBinding[]>> = {};
    for (const [action, list] of this._map) {
      bindings[action] = list.map((b) => ({ ...b }));
    }
    return { version: BINDING_SCHEMA_VERSION, bindings };
  }

  /**
   * Parse a payload. Returns a BindingMap, or null if the payload is malformed.
   * An unrecognised version is MIGRATED to defaults (returns the default map),
   * never rejected — an old save should still launch the game.
   */
  static deserialise(raw: unknown): BindingMap | null {
    if (!isSerialised(raw)) return null;
    if (raw.version !== BINDING_SCHEMA_VERSION) {
      // Unknown version → migrate to defaults rather than fail.
      return new BindingMap(defaultBindings());
    }
    const base = defaultBindings();
    const result: Record<InputAction, InputBinding[]> = base;
    for (const action of Object.keys(result) as InputAction[]) {
      const list = raw.bindings[action];
      if (list !== undefined) result[action] = list.map((b) => ({ ...b }));
    }
    return new BindingMap(result);
  }

  /** Parse a JSON string. Returns null on parse error or malformed payload. */
  static fromJSON(json: string): BindingMap | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return null;
    }
    return BindingMap.deserialise(parsed);
  }

  toJSON(): string {
    return JSON.stringify(this.serialise());
  }
}

/** Structural validation of an untrusted payload. */
function isSerialised(raw: unknown): raw is SerialisedBindings {
  if (typeof raw !== 'object' || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  if (typeof obj['version'] !== 'number') return false;
  const bindings = obj['bindings'];
  if (typeof bindings !== 'object' || bindings === null) return false;
  for (const value of Object.values(bindings as Record<string, unknown>)) {
    if (!Array.isArray(value)) return false;
    for (const entry of value) {
      if (!isValidBinding(entry)) return false;
    }
  }
  return true;
}

function isValidBinding(raw: unknown): raw is InputBinding {
  if (typeof raw !== 'object' || raw === null) return false;
  const b = raw as Record<string, unknown>;
  switch (b['kind']) {
    case 'key':
      return typeof b['code'] === 'string';
    case 'mouseButton':
      return typeof b['button'] === 'number';
    case 'mouseAxis':
      return b['axis'] === 'x' || b['axis'] === 'y';
    case 'wheel':
      return b['dir'] === 1 || b['dir'] === -1;
    case 'gamepadButton':
      return typeof b['index'] === 'number';
    case 'gamepadAxis':
      return typeof b['index'] === 'number' && (b['sign'] === 1 || b['sign'] === -1);
    default:
      return false;
  }
}
