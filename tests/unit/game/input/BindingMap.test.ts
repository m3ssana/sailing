import { describe, it, expect } from 'vitest';
import {
  BindingMap,
  BINDING_SCHEMA_VERSION,
  ESSENTIAL_ACTIONS,
  defaultBindings,
  oneHandedBindings,
} from '@game/input';
import type { InputAction, InputBinding } from '@game/input';

describe('BindingMap — defaults', () => {
  it('binds A/D and arrows to steering', () => {
    const m = new BindingMap();
    const left = m.bindingsFor('steerLeft');
    expect(left).toContainEqual({ kind: 'key', code: 'KeyA' });
    expect(left).toContainEqual({ kind: 'key', code: 'ArrowLeft' });
    const right = m.bindingsFor('steerRight');
    expect(right).toContainEqual({ kind: 'key', code: 'KeyD' });
    expect(right).toContainEqual({ kind: 'key', code: 'ArrowRight' });
  });

  it('binds W/S and Q/E to main trim', () => {
    const m = new BindingMap();
    expect(m.bindingsFor('mainTrimIn')).toContainEqual({ kind: 'key', code: 'KeyW' });
    expect(m.bindingsFor('mainTrimIn')).toContainEqual({ kind: 'key', code: 'KeyQ' });
    expect(m.bindingsFor('mainTrimOut')).toContainEqual({ kind: 'key', code: 'KeyS' });
    expect(m.bindingsFor('mainTrimOut')).toContainEqual({ kind: 'key', code: 'KeyE' });
  });

  it('binds Z/X to jib and Shift to hike and T to tack', () => {
    const m = new BindingMap();
    expect(m.bindingsFor('jibTrimIn')).toContainEqual({ kind: 'key', code: 'KeyZ' });
    expect(m.bindingsFor('jibTrimOut')).toContainEqual({ kind: 'key', code: 'KeyX' });
    expect(m.bindingsFor('hike')).toContainEqual({ kind: 'key', code: 'ShiftLeft' });
    expect(m.bindingsFor('cmdTack')).toContainEqual({ kind: 'key', code: 'KeyT' });
  });

  it('has no physical input bound to two different actions', () => {
    const m = new BindingMap();
    const seen = new Map<string, InputAction>();
    for (const action of m.actions()) {
      for (const b of m.bindingsFor(action)) {
        const key = JSON.stringify(b);
        expect(seen.has(key), `${key} bound to both ${seen.get(key)} and ${action}`).toBe(false);
        seen.set(key, action);
      }
    }
  });
});

describe('BindingMap — rebind + conflict detection', () => {
  it('reports no conflict when binding a free input', () => {
    const m = new BindingMap();
    const conflicts = m.rebind('vangOn', { kind: 'key', code: 'F13' });
    expect(conflicts).toEqual([]);
    expect(m.bindingsFor('vangOn')).toContainEqual({ kind: 'key', code: 'F13' });
  });

  it('detects and clears a conflict when stealing an input from another action', () => {
    const m = new BindingMap();
    // KeyT is bound to cmdTack by default; steal it for vangOn.
    const conflicts = m.rebind('vangOn', { kind: 'key', code: 'KeyT' });
    expect(conflicts).toContainEqual({ action: 'cmdTack', binding: { kind: 'key', code: 'KeyT' } });
    // cmdTack no longer has KeyT.
    expect(m.bindingsFor('cmdTack')).not.toContainEqual({ kind: 'key', code: 'KeyT' });
    // vangOn now has it.
    expect(m.bindingsFor('vangOn')).toContainEqual({ kind: 'key', code: 'KeyT' });
  });

  it('actionForBinding finds the owner', () => {
    const m = new BindingMap();
    expect(m.actionForBinding({ kind: 'key', code: 'KeyA' })).toBe('steerLeft');
    expect(m.actionForBinding({ kind: 'key', code: 'F24' })).toBeNull();
  });

  it('unbind removes a specific binding', () => {
    const m = new BindingMap();
    m.unbind('steerLeft', { kind: 'key', code: 'KeyA' });
    expect(m.bindingsFor('steerLeft')).not.toContainEqual({ kind: 'key', code: 'KeyA' });
    expect(m.bindingsFor('steerLeft')).toContainEqual({ kind: 'key', code: 'ArrowLeft' });
  });
});

describe('BindingMap — serialisation', () => {
  it('round-trips through JSON', () => {
    const m = new BindingMap();
    m.rebind('vangOn', { kind: 'key', code: 'F13' });
    const json = m.toJSON();
    const restored = BindingMap.fromJSON(json);
    expect(restored).not.toBeNull();
    expect(restored?.bindingsFor('vangOn')).toContainEqual({ kind: 'key', code: 'F13' });
    expect(restored?.bindingsFor('steerLeft')).toContainEqual({ kind: 'key', code: 'KeyA' });
  });

  it('carries the current schema version', () => {
    const m = new BindingMap();
    expect(m.serialise().version).toBe(BINDING_SCHEMA_VERSION);
  });

  it('rejects malformed JSON', () => {
    expect(BindingMap.fromJSON('not json {')).toBeNull();
  });

  it('rejects a payload missing a version', () => {
    expect(BindingMap.deserialise({ bindings: {} })).toBeNull();
  });

  it('rejects a payload with a malformed binding entry', () => {
    const bad = { version: BINDING_SCHEMA_VERSION, bindings: { steerLeft: [{ kind: 'nope' }] } };
    expect(BindingMap.deserialise(bad)).toBeNull();
  });

  it('rejects a non-array binding list', () => {
    const bad = { version: BINDING_SCHEMA_VERSION, bindings: { steerLeft: 'KeyA' } };
    expect(BindingMap.deserialise(bad)).toBeNull();
  });

  it('migrates an unknown version to defaults instead of failing', () => {
    const future = { version: 9999, bindings: { steerLeft: [{ kind: 'key', code: 'KeyZZ' }] } };
    const m = BindingMap.deserialise(future);
    expect(m).not.toBeNull();
    // Migrated to defaults — so steerLeft is the default A/arrow, not KeyZZ.
    expect(m?.bindingsFor('steerLeft')).toContainEqual({ kind: 'key', code: 'KeyA' });
    expect(m?.bindingsFor('steerLeft')).not.toContainEqual({ kind: 'key', code: 'KeyZZ' });
  });

  it('accepts a partial payload and fills the rest from defaults', () => {
    const partial = {
      version: BINDING_SCHEMA_VERSION,
      bindings: { vangOn: [{ kind: 'key', code: 'F13' }] },
    };
    const m = BindingMap.deserialise(partial);
    expect(m?.bindingsFor('vangOn')).toContainEqual({ kind: 'key', code: 'F13' });
    // Unspecified actions keep their defaults.
    expect(m?.bindingsFor('steerLeft')).toContainEqual({ kind: 'key', code: 'KeyA' });
  });
});

describe('BindingMap — one-handed preset (requirement 12.4)', () => {
  // Keys reachable by a single hand on the arrow / navigation cluster, plus
  // Enter/Backspace/right-Shift and the numpad, plus mouse-only inputs.
  const ONE_HAND_KEYS = new Set([
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'Enter',
    'Backspace',
    'ShiftRight',
    'Insert',
    'Delete',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'NumpadEnter',
    'NumpadAdd',
    'NumpadSubtract',
    'Numpad5',
    'Numpad7',
    'Numpad8',
    'Numpad9',
    'Backslash',
    'Quote',
    'BracketLeft',
    'BracketRight',
    'Semicolon',
    'Slash',
    'Minus',
    'Equal',
    'Escape',
  ]);

  function reachableOneHand(b: InputBinding): boolean {
    switch (b.kind) {
      case 'key':
        return ONE_HAND_KEYS.has(b.code);
      // Mouse inputs are reachable with one hand by definition.
      case 'mouseButton':
      case 'mouseAxis':
      case 'wheel':
        return true;
      // Gamepad is a separate device, irrelevant to the one-handed keyboard test.
      default:
        return false;
    }
  }

  it('binds every essential action to at least one one-hand-reachable input', () => {
    const m = new BindingMap(oneHandedBindings());
    for (const action of ESSENTIAL_ACTIONS) {
      const bindings = m.bindingsFor(action);
      expect(bindings.length, `${action} is unbound`).toBeGreaterThan(0);
      const reachable = bindings.some(reachableOneHand);
      expect(reachable, `${action} has no one-hand-reachable binding`).toBe(true);
    }
  });

  it('every bound input in the preset is one-hand reachable (or gamepad)', () => {
    const m = new BindingMap(oneHandedBindings());
    for (const action of m.actions()) {
      for (const b of m.bindingsFor(action)) {
        if (b.kind === 'gamepadButton' || b.kind === 'gamepadAxis') continue;
        expect(reachableOneHand(b), `${action} → ${JSON.stringify(b)} not reachable`).toBe(true);
      }
    }
  });

  it('steers with mouse X and trims the sheet with the wheel', () => {
    const m = new BindingMap(oneHandedBindings());
    expect(m.bindingsFor('steerLeft')).toContainEqual({ kind: 'mouseAxis', axis: 'x' });
    expect(m.bindingsFor('steerRight')).toContainEqual({ kind: 'mouseAxis', axis: 'x' });
    expect(m.bindingsFor('mainTrimIn')).toContainEqual({ kind: 'wheel', dir: -1 });
    expect(m.bindingsFor('mainTrimOut')).toContainEqual({ kind: 'wheel', dir: 1 });
  });

  it('default preset essential actions are also fully bound', () => {
    const m = new BindingMap(defaultBindings());
    for (const action of ESSENTIAL_ACTIONS) {
      expect(m.bindingsFor(action).length).toBeGreaterThan(0);
    }
  });
});
