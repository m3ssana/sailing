/**
 * Unit tests for the pure session helpers (headless — no DOM, no renderer).
 */

import { describe, it, expect } from 'vitest';
import type { BoatState, ControlState, Environment, PolarDiagram } from '@/types';
import type { CameraFrame } from '@game/camera';
import {
  sessionTimeFor,
  signedAngleOffBow,
  computeApparentWind,
  courseOverGround,
  buildHudInput,
  buildCameraFrame,
  runFixedStep,
  parseLaunchOptions,
  ScriptedInputProvider,
  toAssistLevel,
  sampleTrueWind,
} from '@/app/sessionHelpers';
import { UNITS } from '@/types/units';

// ─── Fixtures ──────────────────────────────────────────────────────────────────

function makeBoatState(over: Partial<BoatState> = {}): BoatState {
  return {
    position: { x: 0, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    linearVelocity: { x: 0, y: 0, z: 0 },
    angularVelocity: { x: 0, y: 0, z: 0 },
    controls: makeControls(),
    heel: 0,
    pitch: 0,
    heading: 0,
    speed: 0,
    capsized: false,
    foiling: false,
    helmLoad: 0,
    ...over,
  };
}

function makeControls(over: Partial<ControlState> = {}): ControlState {
  return {
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
    ...over,
  };
}

const fakePolar: PolarDiagram = {
  windSpeeds: [5, 10],
  windAngles: [0, Math.PI],
  boatSpeeds: [[0, 0], [0, 0]],
  optimalUpwindAngle: [0.7, 0.7],
  optimalDownwindAngle: [2.6, 2.6],
  targetSpeed: () => 3,
};

// ─── sessionTimeFor ──────────────────────────────────────────────────────────

describe('sessionTimeFor', () => {
  it('is identity at speed 1', () => {
    expect(sessionTimeFor(12.5, 1)).toBe(12.5);
  });
  it('scales for the test harness', () => {
    expect(sessionTimeFor(10, 4)).toBe(40);
  });
});

// ─── signedAngleOffBow ─────────────────────────────────────────────────────────

describe('signedAngleOffBow', () => {
  it('is zero when the wind is dead ahead', () => {
    expect(signedAngleOffBow(0, 0)).toBeCloseTo(0, 6);
  });
  it('is positive when the source is on the starboard bow', () => {
    // bow pointing north (0), wind from the east (π/2) → starboard → positive.
    expect(signedAngleOffBow(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2, 6);
  });
  it('is negative when the source is on the port bow', () => {
    expect(signedAngleOffBow(0, -Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 6);
  });
  it('wraps to (−π, π]', () => {
    const r = signedAngleOffBow(0, Math.PI * 1.5);
    expect(r).toBeGreaterThan(-Math.PI);
    expect(r).toBeLessThanOrEqual(Math.PI);
  });
});

// ─── computeApparentWind ───────────────────────────────────────────────────────

describe('computeApparentWind', () => {
  it('equals true wind when the boat is stationary', () => {
    // Air moving east at 5 m/s → comes FROM the west (bearing 270°).
    const boat = makeBoatState({ heading: 0 });
    const ap = computeApparentWind({ x: 5, y: 0, z: 0 }, boat);
    expect(ap.speed).toBeCloseTo(5, 6);
  });
  it('adds boat motion into the headwind (apparent > true upwind)', () => {
    // Air moving south (+Z) at 5 → from north. Boat sailing north (−Z) at 3.
    const boat = makeBoatState({ heading: 0, linearVelocity: { x: 0, y: 0, z: -3 } });
    const ap = computeApparentWind({ x: 0, y: 0, z: 5 }, boat);
    // relative velocity z = 5 − (−3) = 8 → apparent 8 m/s.
    expect(ap.speed).toBeCloseTo(8, 6);
  });
});

// ─── courseOverGround ──────────────────────────────────────────────────────────

describe('courseOverGround', () => {
  it('is 0 (north) for a northbound velocity', () => {
    expect(courseOverGround({ x: 0, y: 0, z: -4 })).toBeCloseTo(0, 6);
  });
  it('is east for an eastbound velocity', () => {
    expect(courseOverGround({ x: 4, y: 0, z: 0 })).toBeCloseTo(Math.PI / 2, 6);
  });
  it('is 0 when stationary', () => {
    expect(courseOverGround({ x: 0, y: 0, z: 0 })).toBe(0);
  });
});

// ─── buildHudInput ─────────────────────────────────────────────────────────────

describe('buildHudInput', () => {
  it('keeps inputs in SI (speeds in m/s, angles in radians) — no knots leak in', () => {
    const boat = makeBoatState({ speed: 5, linearVelocity: { x: 0, y: 0, z: -5 } });
    const input = buildHudInput({
      boat,
      controls: boat.controls,
      trueWind: { fromBearing: 1.2, speed: 6 },
      apparentWind: { angle: 0.3, speed: 7 },
      current: { speed: 0.5, towardsBearing: 2 },
      visibility: 20000,
      weatherSource: 'live',
      polar: fakePolar,
      nextMark: null,
      preset: 'full',
      units: 'knotsNm',
      opaqueBackdrop: false,
    });
    // SI preserved — NOT converted to knots.
    expect(input.trueWind.speed).toBe(6);
    expect(input.apparentWind.speed).toBe(7);
    expect(input.speedOverGround).toBeCloseTo(5, 6);
    // Sanity: 6 m/s is ~11.66 kt — the input must NOT already be that.
    expect(input.trueWind.speed).not.toBeCloseTo(6 * UNITS.MS_TO_KNOTS, 1);
  });

  it('passes the weather source label through for the conditions panel', () => {
    const boat = makeBoatState();
    const input = buildHudInput({
      boat,
      controls: boat.controls,
      trueWind: { fromBearing: 0, speed: 5 },
      apparentWind: { angle: 0, speed: 5 },
      current: { speed: 0, towardsBearing: 0 },
      visibility: 10000,
      weatherSource: 'climatology',
      polar: fakePolar,
      nextMark: null,
      preset: 'full',
      units: 'knotsNm',
      opaqueBackdrop: false,
    });
    expect(input.weatherSource).toBe('climatology');
  });
});

// ─── buildCameraFrame ──────────────────────────────────────────────────────────

describe('buildCameraFrame', () => {
  it('copies boat state into the reused frame and clears optional fields when absent', () => {
    const boat = makeBoatState({ heading: 1, heel: 0.2, pitch: 0.1 });
    const out = {} as CameraFrame;
    const frame = buildCameraFrame(
      {
        boatState: boat,
        geometry: { mastHeight: 6, loa: 4, eyeOffset: { x: 0, y: 1, z: 0 } },
        slam: 0.5,
        time: 3,
        lookDelta: { x: 0, y: 0 },
        marks: [],
        otherBoats: [],
      },
      out,
    );
    expect(frame.heading).toBe(1);
    expect(frame.heel).toBeCloseTo(0.2);
    expect(frame.slam).toBe(0.5);
    expect(frame.sunDirection).toBeUndefined();
    expect(frame.isLand).toBeUndefined();
  });
});

// ─── runFixedStep ordering ─────────────────────────────────────────────────────

describe('runFixedStep', () => {
  it('fires input → assist → setControls → step exactly once, in order', () => {
    const calls: string[] = [];
    const order = runFixedStep({
      readInput() {
        calls.push('input');
        return { controls: { rudder: 0.3 }, commands: [] };
      },
      runAssist(driver, _cmds) {
        calls.push('assist');
        expect(driver.rudder).toBe(0.3); // assist sees the driver patch
        return driver;
      },
      setControls(patch) {
        calls.push('setControls');
        expect(patch.rudder).toBe(0.3);
      },
      stepSim() {
        calls.push('step');
      },
    });
    expect(calls).toEqual(['input', 'assist', 'setControls', 'step']);
    expect(order).toEqual(['input', 'assist', 'setControls', 'step']);
  });
});

// ─── parseLaunchOptions ────────────────────────────────────────────────────────

describe('parseLaunchOptions', () => {
  it('parses backend=webgl → forceWebGL', () => {
    const o = parseLaunchOptions('?backend=webgl&autosail=1&offline=1');
    expect(o.forceWebGL).toBe(true);
    expect(o.autosail).toBe(true);
    expect(o.offline).toBe(true);
    expect(o.preferWebGPU).toBe(false);
  });
  it('parses backend=webgpu → preferWebGPU', () => {
    const o = parseLaunchOptions('?backend=webgpu');
    expect(o.preferWebGPU).toBe(true);
    expect(o.forceWebGL).toBe(false);
  });
  it('clamps speed into [1,60] and defaults to 1', () => {
    expect(parseLaunchOptions('').speed).toBe(1);
    expect(parseLaunchOptions('?speed=10').speed).toBe(10);
    expect(parseLaunchOptions('?speed=999').speed).toBe(60);
    expect(parseLaunchOptions('?speed=0').speed).toBe(1);
  });
});

// ─── ScriptedInputProvider ─────────────────────────────────────────────────────

describe('ScriptedInputProvider', () => {
  it('trims in, steers to close-hauled, then issues exactly one tack at 20 s', () => {
    const s = new ScriptedInputProvider();

    // Early: bear away to build speed.
    const f0 = s.frame(1);
    expect(f0.controls.mainsheet).toBeCloseTo(0.7);
    expect(f0.commands.length).toBe(0);

    // Mid: steady helm toward close-hauled, hiking.
    const f10 = s.frame(10);
    expect(f10.controls.rudder).toBeLessThan(0);
    expect(f10.controls.hike).toBe(1);
    expect(f10.commands.length).toBe(0);

    // At 20 s: a single prepareTack, helm centred.
    const f20 = s.frame(20.1);
    expect(f20.commands).toContain('prepareTack');
    expect(s.tackIssued).toBe(true);

    // After: no second tack.
    const f25 = s.frame(25);
    expect(f25.commands.length).toBe(0);
  });

  it('with a PD helm, runs the full close-hauled→tack→bear-away→gybe sequence', () => {
    const s = new ScriptedInputProvider();
    const windFromBearing = 0; // wind FROM north.
    // Spawn close-hauled on starboard tack (TWA +50 → heading = −50°).
    const helm = (heading: number) => ({ heading, yawRate: 0, windFromBearing });

    // Early close-hauled leg: a single prepareTack fires once at ~26 s.
    let tackCount = 0;
    for (let t = 0; t < 46; t += 0.5) {
      const f = s.frame(t, helm((-50 * Math.PI) / 180));
      tackCount += f.commands.filter((c) => c === 'prepareTack').length;
    }
    expect(tackCount, 'exactly one tack').toBe(1);
    expect(s.tackIssued).toBe(true);

    // Later broad-reach leg: a single prepareGybe fires once at ~56 s.
    let gybeCount = 0;
    for (let t = 46; t < 70; t += 0.5) {
      const f = s.frame(t, helm((40 * Math.PI) / 180));
      gybeCount += f.commands.filter((c) => c === 'prepareGybe').length;
    }
    expect(gybeCount, 'exactly one gybe').toBe(1);
    expect(s.gybeIssued).toBe(true);

    // The PD helm produces a bounded rudder command in [−1, 1].
    const f = s.frame(10, helm(0));
    expect(f.controls.rudder).toBeGreaterThanOrEqual(-1);
    expect(f.controls.rudder).toBeLessThanOrEqual(1);
  });
});

// ─── toAssistLevel ─────────────────────────────────────────────────────────────

describe('toAssistLevel', () => {
  it('passes valid levels through and defaults to assisted', () => {
    expect(toAssistLevel('arcade')).toBe('arcade');
    expect(toAssistLevel('simulation')).toBe('simulation');
    expect(toAssistLevel('assisted')).toBe('assisted');
    expect(toAssistLevel(undefined)).toBe('assisted');
    expect(toAssistLevel('nonsense')).toBe('assisted');
  });
});

// ─── sampleTrueWind ────────────────────────────────────────────────────────────

describe('sampleTrueWind', () => {
  it('reads the environment wind field FROM-bearing + speed through', () => {
    const env = {
      wind: {
        sample: () => ({
          velocity: { x: 0, y: 0, z: 0 },
          speed: 6,
          direction: 1.9,
          gustFactor: 1,
        }),
      },
    } as unknown as Environment;
    const tw = sampleTrueWind(env, makeBoatState(), 0);
    expect(tw.speed).toBe(6);
    expect(tw.fromBearing).toBe(1.9);
  });
});
