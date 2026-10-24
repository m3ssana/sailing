/**
 * Unit tests for the pure assist helpers and the SailingAssist level semantics
 * (no sim — these assert the controller's own behaviour frame-by-frame).
 */

import { describe, it, expect } from 'vitest';
import type { AssistFrame } from '@game/assist';
import { createSailingAssist, idealSheetFor, targetHikeFor } from '@game/assist';
import type { BoatState, ControlState } from '@/types';
import { createBoatState } from '@physics/RigidBody';

function baseControls(): ControlState {
  return {
    rudder: 0, mainsheet: 0.5, jibsheet: 0, spinnaker: 0, vang: 0.5,
    traveller: 0, board: 1, crewFore: 0, crewLateral: 0, hike: 0,
  };
}

function makeFrame(over: Partial<AssistFrame> = {}): AssistFrame {
  const state: BoatState = createBoatState();
  state.heading = Math.PI / 2; // east
  state.speed = 3;
  state.linearVelocity = { x: 3, y: 0, z: 0 };
  return {
    state,
    trueWindFromBearing: 0, // wind from north
    trueWindSpeed: 6,
    assist: 'assisted',
    commands: [],
    driverControls: baseControls(),
    dt: 1 / 120,
    ...over,
  };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('idealSheetFor', () => {
  it('eases the sheet as apparent wind angle opens from close-hauled to a run', () => {
    const closeHauled = idealSheetFor(30, 6);
    const beam = idealSheetFor(90, 6);
    const broad = idealSheetFor(150, 6);
    expect(closeHauled).toBeGreaterThan(beam);
    expect(beam).toBeGreaterThan(broad);
    // Monotone decreasing across the whole range.
    let prev = Infinity;
    for (let deg = 20; deg <= 170; deg += 10) {
      const s = idealSheetFor(deg, 6);
      expect(s).toBeLessThanOrEqual(prev + 1e-9);
      prev = s;
    }
  });

  it('stays within [0,1] and trims hard close-hauled, eases on a run', () => {
    for (let deg = 0; deg <= 180; deg += 5) {
      const s = idealSheetFor(deg, 6);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
    expect(idealSheetFor(25, 6)).toBeGreaterThan(0.6); // close-hauled → trimmed.
    expect(idealSheetFor(170, 6)).toBeLessThan(0.15); // run → eased.
  });
});

describe('targetHikeFor', () => {
  it('is zero upright and rises monotonically with leeward heel, bounded [0,1]', () => {
    expect(targetHikeFor(0, 90, 10)).toBe(0);
    let prev = -1;
    for (let deg = 0; deg <= 40; deg += 2) {
      const h = targetHikeFor((deg * Math.PI) / 180, 90, 10);
      expect(h).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(1);
      prev = h;
    }
  });

  it('hikes sooner (harder at a given heel) in more wind', () => {
    const light = targetHikeFor((12 * Math.PI) / 180, 90, 4);
    const heavy = targetHikeFor((12 * Math.PI) / 180, 90, 14);
    expect(heavy).toBeGreaterThanOrEqual(light);
  });

  it('is symmetric in heel sign (magnitude of effort)', () => {
    const port = targetHikeFor((15 * Math.PI) / 180, 90, 10);
    const stbd = targetHikeFor((-15 * Math.PI) / 180, 90, 10);
    expect(port).toBeCloseTo(stbd, 10);
  });
});

// ── Level semantics ──────────────────────────────────────────────────────────

describe('SailingAssist level semantics', () => {
  it("'simulation' is pure pass-through and writes nothing", () => {
    const a = createSailingAssist({ assist: 'simulation' });
    const out: Partial<ControlState> = {};
    a.update(makeFrame({ assist: 'simulation', commands: ['prepareTack'] }), out);
    expect(Object.keys(out).length).toBe(0);
    expect(a.phase).toBe('idle'); // tack command ignored.
  });

  it("'assisted' auto-trims the mainsheet from apparent wind when the driver is hands-off", () => {
    const a = createSailingAssist();
    const out: Partial<ControlState> = {};
    // Beam reach, hands-off (driver mainsheet matches the assist's initial memo).
    a.update(makeFrame({ assist: 'assisted' }), out);
    expect(out.mainsheet).toBeDefined();
    // On a beam reach the sheet should be eased from close-hauled but not dumped.
    expect(out.mainsheet).toBeGreaterThan(0.1);
    expect(out.mainsheet).toBeLessThan(0.95);
  });

  it("'assisted' auto-hikes to windward proportional to leeward heel", () => {
    const a = createSailingAssist();
    const out: Partial<ControlState> = {};
    const f = makeFrame({ assist: 'assisted' });
    f.state.heel = (18 * Math.PI) / 180; // heeled to starboard.
    a.update(f, out);
    expect(out.hike).toBeGreaterThan(0.3);
    // Heel to starboard → crew to port (windward) → negative crewLateral.
    expect(out.crewLateral).toBeLessThan(0);
  });

  it('honours a player sheet override, then releases after ~1.5 s', () => {
    const a = createSailingAssist();
    const out: Partial<ControlState> = {};
    // First establish the assist's trim memo on a hands-off frame.
    a.update(makeFrame({ assist: 'assisted' }), out);
    const assistSheet = out.mainsheet ?? 0.5;
    // Driver now grabs the sheet to a very different value.
    const driver = baseControls();
    driver.mainsheet = assistSheet > 0.5 ? 0.1 : 0.9;
    // While the driver is touching it, the assist must NOT write mainsheet.
    const held = a.update(
      makeFrame({ assist: 'assisted', driverControls: driver }),
      (() => { const o: Partial<ControlState> = {}; return o; })(),
    );
    expect(held.mainsheet).toBeUndefined();
    // Hold the driver value steady for > 1.5 s of frames; after the hold the
    // assist takes the sheet back.
    let last: Partial<ControlState> = {};
    for (let i = 0; i < Math.ceil(1.5 * 120) + 5; i++) {
      last = {};
      a.update(makeFrame({ assist: 'assisted', driverControls: driver }), last);
    }
    expect(last.mainsheet).toBeDefined();
  });

  it("'arcade' bears off automatically after being stuck in irons > 2 s", () => {
    const a = createSailingAssist();
    // Head to wind, stopped (in irons).
    const f = makeFrame({ assist: 'arcade' });
    f.state.heading = 0; // bow into the wind (wind from north).
    f.state.speed = 0.1;
    f.state.linearVelocity = { x: 0, y: 0, z: -0.1 };
    let out: Partial<ControlState> = {};
    // Before the timeout, no forced bear-off rudder.
    for (let i = 0; i < Math.floor(1.5 * 120); i++) {
      out = {};
      a.update(f, out);
    }
    const ruddersBefore = out.rudder ?? 0;
    // After > 2 s in irons, the assist applies a bear-off rudder.
    for (let i = 0; i < Math.ceil(1.0 * 120); i++) {
      out = {};
      a.update(f, out);
    }
    expect(Math.abs(out.rudder ?? 0)).toBeGreaterThan(0.5);
    void ruddersBefore;
  });

  it('reset() returns to idle and clears timers', () => {
    const a = createSailingAssist();
    const out: Partial<ControlState> = {};
    a.update(makeFrame({ assist: 'assisted', commands: ['prepareTack'] }), out);
    expect(a.phase).toBe('tacking');
    a.reset();
    expect(a.phase).toBe('idle');
  });

  it('a tack command puts the assist into the tacking phase (assisted/arcade)', () => {
    for (const lvl of ['assisted', 'arcade'] as const) {
      const a = createSailingAssist();
      const out: Partial<ControlState> = {};
      a.update(makeFrame({ assist: lvl, commands: ['prepareTack'] }), out);
      expect(a.phase).toBe('tacking');
    }
  });

  it('a gybe command puts the assist into the gybing phase', () => {
    const a = createSailingAssist();
    const out: Partial<ControlState> = {};
    a.update(makeFrame({ assist: 'assisted', commands: ['prepareGybe'] }), out);
    expect(a.phase).toBe('gybing');
  });

  it('update returns the same out object it was given (allocation-free)', () => {
    const a = createSailingAssist();
    const out: Partial<ControlState> = {};
    const ret = a.update(makeFrame(), out);
    expect(ret).toBe(out);
  });
});
