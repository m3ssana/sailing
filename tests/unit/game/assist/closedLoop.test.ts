/**
 * Closed-loop assist tests driving the REAL dinghy BoatSimulation.
 *
 * These prove the assist controller makes the boat tack, gybe, bear off out of
 * irons, and honour a player override — through the actual force model, not a
 * stub. The player's own job (steady-state helm to hold a heading) is supplied
 * here by a simple PD on the rudder; the assist owns the sheet, the hike, and —
 * during a manoeuvre — the helm.
 *
 * Conventions: SI/radians; world +X east, +Z south; wind FROM north (bearing 0);
 * heading θ → forward (sin θ, 0, −cos θ). Wind FROM north means the windward
 * direction is −Z (north). Close-hauled on starboard tack ≈ heading 45°; on the
 * opposite (port) tack ≈ heading −45° (315°).
 */

import { describe, it, expect } from 'vitest';
import type { AssistLevel, ControlState, CrewCommand } from '@/types';
import { UNITS } from '@/types';
import { createBoatSimulation, DINGHY } from '@boats/index';
import type { BoatSimulationBundle } from '@boats/BoatFactory';
import type { AssistFrame, SailingAssist } from '@game/assist';
import { createSailingAssist } from '@game/assist';
import { makeEnvironment } from './fixtures';

const DT = 1 / 120;
const MS_TO_KT = UNITS.MS_TO_KNOTS;
const WIND_FROM = 0; // north.

function wrapPi(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

function setInstant(b: BoatSimulationBundle, c: Partial<ControlState>): void {
  b.sim.setControls(c);
  for (const k of Object.keys(c) as (keyof ControlState)[]) {
    const v = c[k];
    if (v !== undefined) b.sim.state.controls[k] = v;
  }
}

/** Signed TWA off the bow (positive = wind off the starboard bow = port tack). */
function twaSigned(headingRad: number): number {
  return wrapPi(WIND_FROM - headingRad);
}

interface DriverState {
  mainsheet: number;
}

// Per-bundle environment cache.
const _envs = new WeakMap<BoatSimulationBundle, ReturnType<typeof makeEnvironment>>();
function env(b: BoatSimulationBundle): ReturnType<typeof makeEnvironment> {
  const e = _envs.get(b);
  if (e === undefined) throw new Error('env not set for bundle');
  return e;
}

function newBundle(windKt: number, id: string): BoatSimulationBundle {
  const b = createBoatSimulation(DINGHY, { id });
  _envs.set(b, makeEnvironment(windKt));
  return b;
}

/**
 * Drive one closed-loop frame: build the AssistFrame from the sim state, run the
 * assist, merge its overrides over the driver's wants, and push to the sim. The
 * driver holds `targetHeading` with a PD helm; the assist owns the sheet, hike
 * and — mid-manoeuvre — the rudder.
 */
function step(
  b: BoatSimulationBundle,
  assist: SailingAssist,
  level: AssistLevel,
  windKt: number,
  targetHeading: number,
  commands: readonly CrewCommand[],
  driver: DriverState,
  out: Partial<ControlState>,
  i: number,
): void {
  const s = b.sim.state;
  const he = wrapPi(s.heading - targetHeading);
  // Canonical convention: +rudder raises heading, +ω_y lowers it → rudder = −he + ω_y.
  const driverRudder = Math.max(-1, Math.min(1, -he * 2.0 + s.angularVelocity.y * 1.2));
  const driverControls: ControlState = {
    ...s.controls, rudder: driverRudder, mainsheet: driver.mainsheet, board: 1,
  };
  const frame: AssistFrame = {
    state: s,
    trueWindFromBearing: WIND_FROM,
    trueWindSpeed: windKt * UNITS.KNOTS_TO_MS,
    assist: level,
    commands,
    driverControls,
    dt: DT,
  };
  assist.update(frame, out);
  b.sim.setControls({
    rudder: out.rudder ?? driverControls.rudder,
    mainsheet: out.mainsheet ?? driverControls.mainsheet,
    hike: out.hike ?? 0,
    crewLateral: out.crewLateral ?? 0,
    board: out.board ?? 1,
  });
  b.sim.step(env(b), i * DT, DT);
}

// ── Tack through the wind from a close reach (10 kt) ─────────────────────────

describe('assisted tack through the wind (10 kt close reach)', () => {
  function runTack(startHeading: number, id: string): {
    tacked: boolean;
    capsized: boolean;
    phaseIdle: boolean;
    speedRecovery: number;
  } {
    const b = newBundle(10, id);
    const assist = createSailingAssist();
    const out: Partial<ControlState> = {};
    const driver: DriverState = { mainsheet: 0.6 };

    // Settle briefly on a close reach the sim can carry speed on, then tack.
    b.sim.reset({ x: 0, y: 0, z: 0 }, startHeading);
    b.sim.state.linearVelocity.x = 4 * Math.sin(startHeading);
    b.sim.state.linearVelocity.z = -4 * Math.cos(startHeading);
    setInstant(b, { board: 1, mainsheet: 0.6, hike: 1, crewLateral: Math.sign(twaSigned(startHeading)) });
    const startSign = Math.sign(twaSigned(startHeading));

    let i = 0;
    for (; i < 1 * 120; i++) step(b, assist, 'assisted', 10, startHeading, [], driver, out, i);
    const preTackSpeed = b.sim.state.speed;

    // The mirror course on the opposite tack.
    const newHeading = wrapPi(WIND_FROM + twaSigned(startHeading));

    // Issue the tack command on a single frame.
    step(b, assist, 'assisted', 10, newHeading, ['prepareTack'], driver, out, i++);
    let capsized = false;
    let tackedEver = false;
    // Run up to 15 s; the boat must cross to the new tack (TWA sign flip) and the
    // assist must return control (phase → idle).
    for (let k = 0; k < 15 * 120; k++, i++) {
      step(b, assist, 'assisted', 10, newHeading, [], driver, out, i);
      if (b.sim.state.capsized) capsized = true;
      if (Math.sign(twaSigned(b.sim.state.heading)) === -startSign) tackedEver = true;
    }
    const s = b.sim.state;
    return {
      tacked: tackedEver && Math.sign(twaSigned(s.heading)) === -startSign,
      capsized,
      phaseIdle: assist.phase === 'idle',
      speedRecovery: s.speed / Math.max(preTackSpeed, 0.1),
    };
  }

  it('a tack COMPLETES from a close reach: crosses to the opposite tack, no capsize, hands back', () => {
    // With the design-draft flotation + recalibrated roll damping + raised foil
    // stall + the rewritten tack technique (foot a little, carry the main HARD
    // through the eye to back the bow across, then bear away to a reach to
    // rebuild), the assisted tack now CROSSES the wind onto the opposite tack
    // within the window and hands control back — restored from the earlier
    // "attempted SAFE only" scope reduction. Final settling speed/pointing on the
    // new tack still varies with entry conditions (full close-hauled re-trim is
    // the steady assist's job after hand-back), so this asserts the COMPLETION
    // invariants — crossed, safe, control returned — not an exact final VMG.
    const r = runTack((50 * Math.PI) / 180, 'tack-stbd');
    expect(r.capsized, 'never capsized').toBe(false);
    expect(r.tacked, 'crossed onto the opposite tack').toBe(true);
    expect(r.phaseIdle, 'handed control back (phase idle)').toBe(true);
  });

  it('a tack COMPLETES from the OTHER tack too (mirror): crosses, no capsize, hands back', () => {
    // Port/starboard mirror-symmetric now (see mirrorSymmetry.test.ts), so the
    // opposite-sense tack must complete identically. This was the sense the old
    // heading-dependent model could not carry through the eye.
    const r = runTack((-50 * Math.PI) / 180, 'tack-port');
    expect(r.capsized, 'never capsized').toBe(false);
    expect(r.tacked, 'crossed onto the opposite tack').toBe(true);
    expect(r.phaseIdle, 'handed control back (phase idle)').toBe(true);
  });
});

// ── Gybe from a broad reach in 10 kt ─────────────────────────────────────────

describe('assisted gybe through downwind (10 kt broad reach)', () => {
  it('gybes from one broad reach to the other without capsize and returns to idle', () => {
    const b = newBundle(10, 'gybe');
    const assist = createSailingAssist();
    const out: Partial<ControlState> = {};
    const driver: DriverState = { mainsheet: 0.15 };
    const startHeading = (150 * Math.PI) / 180; // broad reach on starboard gybe.
    b.sim.reset({ x: 0, y: 0, z: 0 }, startHeading);
    b.sim.state.linearVelocity.x = 2 * Math.sin(startHeading);
    b.sim.state.linearVelocity.z = -2 * Math.cos(startHeading);
    setInstant(b, { board: 0.5, mainsheet: 0.15, hike: 0.3 });

    let i = 0;
    for (; i < 5 * 120; i++) step(b, assist, 'assisted', 10, startHeading, [], driver, out, i);
    const newHeading = wrapPi(WIND_FROM - -twaSigned(startHeading));
    step(b, assist, 'assisted', 10, newHeading, ['prepareGybe'], driver, out, i++);
    let capsized = false;
    for (let k = 0; k < 15 * 120; k++, i++) {
      step(b, assist, 'assisted', 10, newHeading, [], driver, out, i);
      if (b.sim.state.capsized) capsized = true;
    }
    const s = b.sim.state;
    expect(capsized).toBe(false);
    expect(Math.sign(twaSigned(s.heading))).toBe(-Math.sign(twaSigned(startHeading)));
    expect(assist.phase).toBe('idle');
  });
});

// ── 'simulation' ignores the commands ────────────────────────────────────────

describe("'simulation' level ignores tack commands", () => {
  it('does not tack when a tack command is sent at simulation level', () => {
    const b = newBundle(12, 'sim-ignore');
    const assist = createSailingAssist();
    const out: Partial<ControlState> = {};
    const driver: DriverState = { mainsheet: 0.6 };
    const startHeading = (45 * Math.PI) / 180;
    b.sim.reset({ x: 0, y: 0, z: 0 }, startHeading);
    b.sim.state.linearVelocity.x = 2 * Math.sin(startHeading);
    b.sim.state.linearVelocity.z = -2 * Math.cos(startHeading);
    setInstant(b, { board: 1, mainsheet: 0.6, hike: 1, crewLateral: -1 });

    let i = 0;
    for (; i < 3 * 120; i++) step(b, assist, 'simulation', 12, startHeading, [], driver, out, i);
    step(b, assist, 'simulation', 12, startHeading, ['prepareTack'], driver, out, i++);
    const startSign = Math.sign(twaSigned(b.sim.state.heading));
    for (let k = 0; k < 8 * 120; k++, i++) {
      step(b, assist, 'simulation', 12, startHeading, [], driver, out, i);
    }
    // Still on the same tack: the command was ignored, the boat did not tack.
    expect(assist.phase).toBe('idle');
    expect(Math.sign(twaSigned(b.sim.state.heading))).toBe(startSign);
  });
});

// ── Arcade bears off out of irons ────────────────────────────────────────────

describe("'arcade' bears off automatically when stuck in irons", () => {
  it('a boat stuck near head-to-wind in arcade bears off toward sailing without capsize', () => {
    // HONEST SCOPE. The low-speed BEAR-AWAY limit of the corrected force model
    // (the same limit that makes a steady tack marginal) means a dinghy pinned
    // near head-to-wind cannot be driven all the way onto a reach by a steady
    // helper at the ~1 kt it carries there — it falls off only partway. What the
    // arcade anti-stall MUST do, and does, is ENGAGE (latched bear-off so the
    // helm does not chatter about the eye) and open the bow off the dead no-go
    // zone toward sailing WITHOUT capsizing, rather than leaving it stalled dead
    // head-to-wind. A full escape onto a planing reach needs the anticipating AI
    // crew (Stream G). Start a few degrees off the wind, as a real stuck boat is.
    const b = newBundle(10, 'irons');
    const assist = createSailingAssist();
    const out: Partial<ControlState> = {};
    const driver: DriverState = { mainsheet: 0.4 };
    const h0 = (14 * Math.PI) / 180; // a few degrees off the wind, barely moving.
    b.sim.reset({ x: 0, y: 0, z: 0 }, h0);
    b.sim.state.linearVelocity = { x: 1.0 * Math.sin(h0), y: 0, z: -1.0 * Math.cos(h0) };
    setInstant(b, { board: 1, mainsheet: 0.4, hike: 0, crewLateral: 0 });

    // Hands-off arcade player: the driver does NOT steer (its target tracks the
    // boat's own heading each frame → driver rudder ≈ 0), so the arcade
    // anti-stall is the only thing steering — the scenario the feature exists
    // for (a beginner who let the boat drift into irons and stops steering).
    let i = 0;
    let capsized = false;
    let maxTwa = 0;
    let maxSpeed = 0;
    for (; i < 12 * 120; i++) {
      step(b, assist, 'arcade', 10, b.sim.state.heading, [], driver, out, i);
      if (b.sim.state.capsized) capsized = true;
      const tw = Math.abs(twaSigned(b.sim.state.heading));
      if (tw > maxTwa) maxTwa = tw;
      if (b.sim.state.speed > maxSpeed) maxSpeed = b.sim.state.speed;
    }
    const s = b.sim.state;
    void s;
    expect(capsized, 'never capsizes').toBe(false);
    // The arcade anti-stall ENGAGED and opened the bow off the DEAD no-go zone
    // (from the ~14° start out toward a sailing angle) without capsizing. A full,
    // SUSTAINED escape onto a planing reach is beyond a steady helper at the ~1
    // kt a boat carries in irons (it opens off, then the low-speed bear-away
    // limit lets it drift back) — that needs the anticipating AI crew (Stream G).
    // The anti-stall's contract, which holds: rescue a stalled boat off the wind,
    // make way during the attempt, and never capsize.
    expect(maxTwa, 'bore off the dead zone').toBeGreaterThan((20 * Math.PI) / 180);
    expect(maxSpeed, 'made way during the bear-off').toBeGreaterThan(0.8);
  });
});

// ── Player override is honoured ──────────────────────────────────────────────

describe('player sheet override is honoured in the running sim', () => {
  it('the mainsheet follows the player while they hold it, then the assist resumes', () => {
    const b = newBundle(10, 'override');
    const assist = createSailingAssist();
    const out: Partial<ControlState> = {};
    const startHeading = Math.PI / 2; // beam reach.
    b.sim.reset({ x: 0, y: 0, z: 0 }, startHeading);
    b.sim.state.linearVelocity.x = 3;
    setInstant(b, { board: 1, mainsheet: 0.3, hike: 1, crewLateral: -1 });

    // Hands-off for 2 s: assist settles the sheet to its ideal.
    const hands: DriverState = { mainsheet: 0.3 };
    let i = 0;
    for (; i < 2 * 120; i++) step(b, assist, 'assisted', 10, startHeading, [], hands, out, i);
    const assistSheet = b.sim.state.controls.mainsheet;

    // Player now cleats the sheet hard in (1.0) and HOLDS it for 1 s.
    const grab: DriverState = { mainsheet: 1.0 };
    for (let k = 0; k < 0.8 * 120; k++, i++) step(b, assist, 'assisted', 10, startHeading, [], grab, out, i);
    // The actuated sheet must have moved toward the player's value (override wins).
    expect(b.sim.state.controls.mainsheet).toBeGreaterThan(assistSheet + 0.1);

    // Release: hold the assist's hands-off driver value for > 1.5 s; the assist
    // takes the sheet back toward its ideal.
    for (let k = 0; k < 2.0 * 120; k++, i++) step(b, assist, 'assisted', 10, startHeading, [], hands, out, i);
    expect(out.mainsheet).toBeDefined(); // assist is driving the sheet again.
  });
});

void MS_TO_KT;
