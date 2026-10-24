import { describe, it, expect } from 'vitest';
import {
  ControlsAdapter,
  InputMapper,
  BindingMap,
  steerScale,
  TRIM_RATE,
  oneHandedBindings,
} from '@game/input';
import type { DeviceSnapshot, GamepadSnapshot } from '@game/input';

const DT = 1 / 120;

function snapshot(opts: {
  keys?: string[];
  wheel?: number;
  ndcX?: number;
  buttons?: number[];
  gamepad?: GamepadSnapshot | null;
  pointerLocked?: boolean;
  dx?: number;
  dy?: number;
} = {}): DeviceSnapshot {
  return {
    keyboard: { held: new Set(opts.keys ?? []) },
    mouse: {
      dx: opts.dx ?? 0,
      dy: opts.dy ?? 0,
      ndcX: opts.ndcX ?? 0,
      wheel: opts.wheel ?? 0,
      buttons: new Set(opts.buttons ?? []),
    },
    gamepad: opts.gamepad ?? null,
    pointerLocked: opts.pointerLocked ?? false,
  };
}

function gamepad(axes: number[], buttonValues: number[] = []): GamepadSnapshot {
  return {
    connected: true,
    axes,
    buttons: buttonValues.map((v) => v > 0.5),
    buttonValues,
  };
}

describe('steerScale — speed & assist', () => {
  it('reduces authority at low speed so steering is not twitchy', () => {
    const atRest = steerScale(0, 'simulation');
    const fast = steerScale(20, 'simulation');
    expect(atRest).toBeLessThan(fast);
  });

  it('never kills steering entirely (floor > 0)', () => {
    expect(steerScale(0, 'simulation')).toBeGreaterThan(0);
    expect(steerScale(0, 'arcade')).toBeGreaterThan(0);
  });

  it('simulation has more authority at speed than arcade (documented assist diff)', () => {
    // Assist affects assists only: arcade damps steering for forgiveness,
    // simulation gives the full 1:1 authority.
    expect(steerScale(20, 'simulation')).toBeGreaterThan(steerScale(20, 'arcade'));
  });

  it('is monotone non-decreasing in speed', () => {
    let prev = -Infinity;
    for (let s = 0; s <= 30; s += 2) {
      const v = steerScale(s, 'assisted');
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
  });
});

describe('InputMapper — steering', () => {
  it('maps a held steer key to rudder, scaled by speed', () => {
    const m = new InputMapper();
    const b = new BindingMap();
    const dev = snapshot({ keys: ['KeyD'] });
    let patch = m.target;
    for (let i = 0; i < 200; i++) {
      patch = m.step(b, dev, 0, 10, DT, 'simulation');
    }
    expect(patch.rudder).toBeGreaterThan(0);
    expect(patch.rudder).toBeLessThanOrEqual(1);
  });

  it('low-speed steering is gentler than high-speed for the same hold', () => {
    const run = (speed: number): number => {
      const m = new InputMapper();
      const b = new BindingMap();
      const dev = snapshot({ keys: ['KeyD'] });
      let p = m.target;
      for (let i = 0; i < 200; i++) p = m.step(b, dev, 0, speed, DT, 'simulation');
      return p.rudder;
    };
    expect(run(1)).toBeLessThan(run(20));
  });

  it('analog stick drives rudder directly (gamepad axis 0)', () => {
    const m = new InputMapper();
    const b = new BindingMap();
    const dev = snapshot({ gamepad: gamepad([0.9, 0, 0, 0]) });
    let p = m.target;
    for (let i = 0; i < 200; i++) p = m.step(b, dev, 0, 15, DT, 'simulation');
    expect(p.rudder).toBeGreaterThan(0);
  });

  it('negative stick steers to port', () => {
    const m = new InputMapper();
    const b = new BindingMap();
    const dev = snapshot({ gamepad: gamepad([-0.9, 0, 0, 0]) });
    let p = m.target;
    for (let i = 0; i < 200; i++) p = m.step(b, dev, 0, 15, DT, 'simulation');
    expect(p.rudder).toBeLessThan(0);
  });

  it('mouse-X steers right for positive ndcX in the one-handed scheme', () => {
    const m = new InputMapper();
    const b = new BindingMap(oneHandedBindings());
    const dev = snapshot({ ndcX: 0.8 });
    let p = m.target;
    for (let i = 0; i < 200; i++) p = m.step(b, dev, 0, 15, DT, 'simulation');
    expect(p.rudder).toBeGreaterThan(0);
  });
});

describe('InputMapper — trim (rate-integrated)', () => {
  it('holding mainTrimIn increases mainsheet at roughly TRIM_RATE', () => {
    const m = new InputMapper();
    const b = new BindingMap();
    const dev = snapshot({ keys: ['KeyW'] });
    const start = m.target.mainsheet;
    const seconds = 0.25;
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      m.step(b, dev, 0, 5, DT, 'simulation');
    }
    const delta = m.target.mainsheet - start;
    expect(delta).toBeCloseTo(TRIM_RATE * seconds, 1);
  });

  it('mainsheet stays within [0,1]', () => {
    const m = new InputMapper();
    const b = new BindingMap();
    const dev = snapshot({ keys: ['KeyW'] });
    for (let i = 0; i < 2000; i++) m.step(b, dev, 0, 5, DT, 'simulation');
    expect(m.target.mainsheet).toBeLessThanOrEqual(1);
    expect(m.target.mainsheet).toBeGreaterThanOrEqual(0);
  });

  it('wheel trims the mainsheet (mouse-only scheme)', () => {
    const m = new InputMapper();
    const b = new BindingMap(oneHandedBindings());
    const start = m.target.mainsheet;
    const dev = snapshot({ wheel: -1 }); // dir -1 = trim in
    m.step(b, dev, 0, 5, DT, 'simulation');
    expect(m.target.mainsheet).toBeGreaterThan(start);
  });

  it('arcade trims faster than simulation (documented assist diff)', () => {
    const trimFor = (assist: 'arcade' | 'simulation'): number => {
      const m = new InputMapper();
      const b = new BindingMap();
      const dev = snapshot({ keys: ['KeyW'] });
      const start = m.target.mainsheet;
      for (let i = 0; i < 30; i++) m.step(b, dev, 0, 5, DT, assist);
      return m.target.mainsheet - start;
    };
    expect(trimFor('arcade')).toBeGreaterThan(trimFor('simulation'));
  });

  it('jib, traveller, vang, board, spinnaker all respond to their keys', () => {
    const m = new InputMapper();
    const b = new BindingMap();
    const dev = snapshot({
      keys: ['KeyZ', 'Period', 'KeyR', 'KeyB', 'KeyV'],
    });
    const startBoard = m.target.board;
    for (let i = 0; i < 60; i++) m.step(b, dev, 0, 5, DT, 'simulation');
    expect(m.target.jibsheet).toBeGreaterThan(0.5); // KeyZ = jibTrimIn
    expect(m.target.traveller).toBeGreaterThan(0); // Period = travellerRight
    expect(m.target.vang).toBeGreaterThan(0.5); // KeyR = vangOn
    expect(m.target.board).toBeLessThan(startBoard); // KeyB = boardUp
    expect(m.target.spinnaker).toBeGreaterThan(0); // KeyV = spinnakerSet
  });

  it('hike ramps up while held and relaxes when released', () => {
    const m = new InputMapper();
    const b = new BindingMap();
    const held = snapshot({ keys: ['ShiftLeft'] });
    for (let i = 0; i < 60; i++) m.step(b, held, 0, 5, DT, 'simulation');
    const hiked = m.target.hike;
    expect(hiked).toBeGreaterThan(0);
    const released = snapshot({});
    for (let i = 0; i < 300; i++) m.step(b, released, 0, 5, DT, 'simulation');
    expect(m.target.hike).toBeLessThan(hiked);
  });
});

describe('InputMapper — crew commands (edge-triggered)', () => {
  it('issues prepareTack once on key press, not every frame while held', () => {
    const m = new InputMapper();
    const b = new BindingMap();
    const dev = snapshot({ keys: ['KeyT'] }); // cmdTack
    m.step(b, dev, 0, 5, DT, 'simulation');
    expect([...m.commands]).toContain('prepareTack');
    // Still held next frame → no repeat.
    m.step(b, dev, 0, 5, DT, 'simulation');
    expect([...m.commands]).not.toContain('prepareTack');
    // Release then press again → fires again.
    m.step(b, snapshot({}), 0, 5, DT, 'simulation');
    m.step(b, dev, 0, 5, DT, 'simulation');
    expect([...m.commands]).toContain('prepareTack');
  });

  it('maps gybe and hoist/douse commands', () => {
    const m = new InputMapper();
    const b = new BindingMap();
    m.step(b, snapshot({ keys: ['KeyY'] }), 0, 5, DT, 'simulation');
    expect([...m.commands]).toContain('prepareGybe');
    m.step(b, snapshot({ keys: ['Digit3'] }), 0, 5, DT, 'simulation');
    expect([...m.commands]).toContain('hoistSpinnaker');
  });
});

describe('ControlsAdapter — frame output', () => {
  it('produces a controls patch, rumble, and frozen InputState', () => {
    const a = new ControlsAdapter();
    const b = new BindingMap();
    const res = a.frame(b, snapshot({ keys: ['KeyD'] }), 0.3, 10, DT, 'simulation');
    expect(res.controlsPatch).toBeDefined();
    expect(res.rumble.strong).toBeGreaterThan(0); // helmLoad 0.3 → some rumble
    expect(res.input.controls).toBe(res.controlsPatch); // same owned object
    expect(Array.isArray(res.input.crewCommands)).toBe(true);
  });

  it('derives rumble from helmLoad, zero when de-powered', () => {
    const a = new ControlsAdapter();
    const b = new BindingMap();
    const res = a.frame(b, snapshot({}), 0, 10, DT, 'simulation');
    expect(res.rumble.weak).toBe(0);
    expect(res.rumble.strong).toBe(0);
  });

  it('is allocation-free in steady state: returns identical object references', () => {
    const a = new ControlsAdapter();
    const b = new BindingMap();
    const dev = snapshot({ keys: ['KeyD'] });
    const r1 = a.frame(b, dev, 0.2, 10, DT, 'simulation');
    const patch1 = r1.controlsPatch;
    const rumble1 = r1.rumble;
    const input1 = r1.input;
    const cmds1 = r1.input.crewCommands;
    const look1 = r1.input.lookDelta;
    const r2 = a.frame(b, dev, 0.5, 12, DT, 'simulation');
    // Every returned object must be the SAME reference across frames.
    expect(r2).toBe(r1);
    expect(r2.controlsPatch).toBe(patch1);
    expect(r2.rumble).toBe(rumble1);
    expect(r2.input).toBe(input1);
    expect(r2.input.crewCommands).toBe(cmds1);
    expect(r2.input.lookDelta).toBe(look1);
  });

  it('surfaces camera look delta only while pointer-locked', () => {
    const a = new ControlsAdapter();
    const b = new BindingMap();
    const unlocked = a.frame(b, snapshot({ dx: 5, dy: -3 }), 0, 10, DT, 'simulation');
    expect(unlocked.input.lookDelta.x).toBe(0);
    const locked = a.frame(
      b,
      snapshot({ dx: 5, dy: -3, pointerLocked: true }),
      0,
      10,
      DT,
      'simulation',
    );
    expect(locked.input.lookDelta.x).toBe(5);
    expect(locked.input.lookDelta.y).toBe(-3);
  });

  it('edge-triggers pause and camera cycle', () => {
    const a = new ControlsAdapter();
    const b = new BindingMap();
    const pauseDev = snapshot({ keys: ['Escape'] });
    expect(a.frame(b, pauseDev, 0, 5, DT, 'simulation').input.pausePressed).toBe(true);
    expect(a.frame(b, pauseDev, 0, 5, DT, 'simulation').input.pausePressed).toBe(false);
  });
});
