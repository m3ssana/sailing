/**
 * ROTATION-INVARIANCE harness and regression suite.
 *
 * A real boat's rigid-body physics must be INVARIANT to a rotation of the whole
 * world (boat pose + wind + waves) about the vertical (+Y) axis. If you run a
 * scenario, then run the SAME scenario with everything rotated by an arbitrary
 * compass angle θ about +Y, the two runs must produce identical BODY-FRAME
 * trajectories — the boat must do the same thing relative to the wind no matter
 * which way the compass happens to be pointing. Anything that depends on the
 * absolute compass heading is a bug.
 *
 * ## Status: the bug is FIXED (this suite now ASSERTS invariance)
 *
 * This file originally CHARACTERISED a bug: the engine carried two opposite-
 * handed heading frames (the force generators + velocity used the PHYSICAL
 * `forward = (sin h, 0, −cos h)`, while the orientation quaternion built by
 * `fromAxisAngle({0,1,0}, +h)` rotated `(0,0,−1)` to the X-MIRROR `(−sin h, 0,
 * −cos h)`), and RightingMoment/HydrodynamicDamping injected their couples about
 * fixed WORLD axes while the inertia tensor transposed roll↔pitch. Stability,
 * speed and capsizing therefore depended on the compass heading.
 *
 * The fix unified the convention engine-wide:
 *   • `quatFromHeading(h)` = rotation about +Y by −h, so the quaternion forward
 *     equals the physical forward; the two frames are now one frame.
 *   • RightingMoment / HydrodynamicDamping build their couples in the BODY frame
 *     and inject via `pushBodyAxisTorque` (rotated through the orientation).
 *   • The inertia axis mapping (BoatFactory ↔ Integrator) agrees: `.x` = pitch
 *     (body X), `.y` = yaw (body Y), `.z` = roll (body Z).
 *
 * This suite proves it: every force generator in isolation AND the full sim over
 * 20 s produce heading-invariant body-frame trajectories to a tight tolerance.
 *
 * ## Rotation operator (about +Y by θ)
 *
 * World +X east, +Z south, bearing b → forward (sin b, 0, −cos b). A rotation of
 * the compass by θ maps:
 *   - a horizontal position/velocity/force (x, z) → R_θ(x, z) where R_θ is the
 *     standard rotation that takes bearing b → b + θ:
 *       x' =  x·cosθ + z·sinθ
 *       z' = −x·sinθ + z·cosθ
 *     Y is unchanged.
 *   - heading b → wrap(b + θ); heel, pitch unchanged (they are about body axes).
 *   - wind FROM bearing → wrap(b + θ); wind velocity vector rotates by R_θ.
 *   - controls UNCHANGED — they are body-relative.
 *
 * Body-frame invariants we compare (heading-independent by construction):
 *   speed, heel, pitch, |yaw-rate|, and leeway = wrap(heading − velHeading).
 *
 * Conventions: SI/radians; world Y-up right-handed, +X east, +Z south.
 */

import { describe, it, expect } from 'vitest';
import type {
  BoatState,
  ControlState,
  Environment,
  Vec3,
} from '@/types';
import { PHYSICS_CONSTANTS, UNITS } from '@/types';
import { createBoatSimulation, DINGHY } from '@boats/index';

const DT = 1 / 120;
const THETAS_DEG = [0, 37, 90, 142, 200, 305];

// ── Uniform wind environment whose FROM bearing we can set ────────────────────
function uniformEnv(windKnots: number, windFromBearing: number): Environment {
  const speedMs = windKnots * UNITS.KNOTS_TO_MS;
  const vel: Vec3 = {
    x: -Math.sin(windFromBearing) * speedMs,
    y: 0,
    z: Math.cos(windFromBearing) * speedMs,
  };
  const scratch: Vec3 = { x: 0, y: 0, z: 0 };
  return {
    waterDensity: PHYSICS_CONSTANTS.WATER_DENSITY,
    wind: {
      sample: () => ({ velocity: { ...vel }, speed: speedMs, direction: windFromBearing }),
    },
    waves: {
      params: {
        significantHeight: 0,
        windDirection: windFromBearing,
        swellPeriod: 6,
      },
      height: () => 0,
      orbitalVelocity: (_x: number, _z: number, _y: number, _t: number, out?: Vec3) => {
        const dst = out ?? scratch;
        dst.x = 0;
        dst.y = 0;
        dst.z = 0;
        return dst;
      },
    },
  } as unknown as Environment;
}

// ── Angle helpers ─────────────────────────────────────────────────────────────

function wrapPi(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

function leewayOf(state: BoatState): number {
  const vh = Math.atan2(state.linearVelocity.x, -state.linearVelocity.z);
  return wrapPi(state.heading - vh);
}

const ALL_GEN_IDS = [
  'buoyancy',
  'foil-lift',
  'side-force-bridge',
  'hydro-resistance',
  'waveDrag',
  'aero',
  'righting-moment',
  'hydrodynamic-damping',
];

interface BodyTrace {
  speed: number[];
  heel: number[];
  pitch: number[];
  leeway: number[];
  yawRate: number[];
}

function runIsolatedTrace(
  keep: readonly string[],
  heading: number,
  windFrom: number,
  seconds: number,
): BodyTrace {
  const env = uniformEnv(11, windFrom);
  const bundle = createBoatSimulation(DINGHY, { id: `iso-${keep.join('-')}-${heading.toFixed(3)}` });
  for (const id of ALL_GEN_IDS) {
    if (!keep.includes(id)) bundle.sim.removeForceGenerator(id);
  }
  bundle.sim.reset({ x: 0, y: -0.12, z: 0 }, heading);
  bundle.sim.state.linearVelocity.x = 3 * Math.sin(heading);
  bundle.sim.state.linearVelocity.z = -3 * Math.cos(heading);
  bundle.sim.state.controls.board = 1;
  bundle.sim.state.controls.mainsheet = 0.5;
  bundle.sim.state.controls.hike = 0.5;
  const trace: BodyTrace = { speed: [], heel: [], pitch: [], leeway: [], yawRate: [] };
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    bundle.sim.step(env, i * DT, DT);
    if (i % 12 === 0) {
      const st = bundle.sim.state;
      trace.speed.push(st.speed);
      trace.heel.push(st.heel);
      trace.pitch.push(st.pitch);
      trace.leeway.push(leewayOf(st));
      trace.yawRate.push(st.angularVelocity.y);
    }
  }
  return trace;
}

/**
 * Max body-frame divergence (heel/pitch/speed/leeway/|yaw-rate|) between the
 * base close reach and the same scenario rotated to every θ. Scalars are read
 * off `sim.state` and are convention-free, so this is an unambiguous measure of
 * how much the boat's behaviour depends on its absolute compass heading.
 */
function maxHeadingDivergence(
  keep: readonly string[],
  seconds: number,
): { speed: number; angle: number } {
  const h0 = (50 * Math.PI) / 180;
  const base = runIsolatedTrace(keep, h0, 0, seconds);
  let worstSpeed = 0;
  let worstAngle = 0;
  for (const degTheta of THETAS_DEG) {
    if (degTheta === 0) continue;
    const theta = (degTheta * Math.PI) / 180;
    const rot = runIsolatedTrace(keep, h0 + theta, theta, seconds);
    const count = base.speed.length;
    for (let i = 0; i < count; i++) {
      worstSpeed = Math.max(worstSpeed, Math.abs((base.speed[i] ?? 0) - (rot.speed[i] ?? 0)));
      worstAngle = Math.max(
        worstAngle,
        Math.abs((base.heel[i] ?? 0) - (rot.heel[i] ?? 0)),
        Math.abs((base.pitch[i] ?? 0) - (rot.pitch[i] ?? 0)),
        Math.abs(wrapPi((base.leeway[i] ?? 0) - (rot.leeway[i] ?? 0))),
        Math.abs((base.yawRate[i] ?? 0) - (rot.yawRate[i] ?? 0)),
      );
    }
  }
  return { speed: worstSpeed, angle: worstAngle };
}

// Tolerances: 1% of a few m/s of speed ≈ a few cm/s; 0.5° ≈ 0.0087 rad. We use a
// small absolute floor to absorb the ~4 mm hull-loft geometry asymmetry and FP.
const SPEED_TOL = 0.03; // m/s
const ANGLE_TOL = 0.0087; // rad ≈ 0.5°

describe('rotation invariance: each force generator is heading-independent', () => {
  it('Buoyancy alone', () => {
    const d = maxHeadingDivergence(['buoyancy'], 1);
    expect(d.speed).toBeLessThan(SPEED_TOL);
    expect(d.angle).toBeLessThan(ANGLE_TOL);
  });
  it('Buoyancy + FoilLift', () => {
    const d = maxHeadingDivergence(['buoyancy', 'foil-lift'], 1);
    expect(d.speed).toBeLessThan(SPEED_TOL);
    expect(d.angle).toBeLessThan(ANGLE_TOL);
  });
  it('Buoyancy + RightingMoment (was the core bug — WORLD-axis roll couple)', () => {
    const d = maxHeadingDivergence(['buoyancy', 'righting-moment'], 1);
    expect(d.speed).toBeLessThan(SPEED_TOL);
    expect(d.angle).toBeLessThan(ANGLE_TOL);
  });
  it('Buoyancy + HydrodynamicDamping (was the core bug — WORLD-axis couples)', () => {
    const d = maxHeadingDivergence(['buoyancy', 'hydrodynamic-damping'], 1);
    expect(d.speed).toBeLessThan(SPEED_TOL);
    expect(d.angle).toBeLessThan(ANGLE_TOL);
  });
  it('Buoyancy + Aero + HydroResistance + Damping (driven reach)', () => {
    const d = maxHeadingDivergence(
      ['buoyancy', 'foil-lift', 'side-force-bridge', 'hydro-resistance', 'aero', 'hydrodynamic-damping'],
      1,
    );
    expect(d.speed).toBeLessThan(SPEED_TOL);
    expect(d.angle).toBeLessThan(ANGLE_TOL);
  });
});

// ── Full-sim rotation invariance ──────────────────────────────────────────────

function runBodyTrajectory(
  windFromBearing: number,
  heading0: number,
  controls: Partial<ControlState>,
  id: string,
  seconds: number,
): BodyTrace {
  const env = uniformEnv(11, windFromBearing);
  const bundle = createBoatSimulation(DINGHY, { id });
  bundle.sim.reset({ x: 0, y: -0.12, z: 0 }, heading0);
  bundle.sim.state.linearVelocity.x = 3 * Math.sin(heading0);
  bundle.sim.state.linearVelocity.z = -3 * Math.cos(heading0);
  bundle.sim.setControls(controls);
  for (const k of Object.keys(controls) as (keyof ControlState)[]) {
    const v = controls[k];
    if (v !== undefined) bundle.sim.state.controls[k] = v;
  }
  const trace: BodyTrace = { speed: [], heel: [], pitch: [], leeway: [], yawRate: [] };
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    bundle.sim.setControls(controls);
    bundle.sim.step(env, i * DT, DT);
    if (i % 24 === 0) {
      const st = bundle.sim.state;
      trace.speed.push(st.speed);
      trace.heel.push(st.heel);
      trace.pitch.push(st.pitch);
      trace.leeway.push(leewayOf(st));
      trace.yawRate.push(st.angularVelocity.y);
    }
  }
  return trace;
}

describe('rotation invariance: the FULL sim is heading-independent over 20 s', () => {
  it('same close reach at θ ∈ {0,37,90,142,200,305}° agrees within 1% / 0.5°', () => {
    const twaOffset = (50 * Math.PI) / 180;
    const controls: Partial<ControlState> = {
      rudder: 0.1,
      mainsheet: 0.55,
      board: 1,
      hike: 1,
      crewLateral: -1,
    };
    const base = runBodyTrajectory(0, twaOffset, controls, 'rot-base', 20);
    let worstSpeed = 0;
    let worstAngleDeg = 0;
    for (const degTheta of THETAS_DEG) {
      if (degTheta === 0) continue;
      const theta = (degTheta * Math.PI) / 180;
      const rotated = runBodyTrajectory(theta, twaOffset + theta, controls, `rot-${degTheta}`, 20);
      for (let i = 0; i < base.heel.length; i++) {
        worstSpeed = Math.max(worstSpeed, Math.abs((base.speed[i] ?? 0) - (rotated.speed[i] ?? 0)));
        worstAngleDeg = Math.max(
          worstAngleDeg,
          Math.abs((base.heel[i] ?? 0) - (rotated.heel[i] ?? 0)) * (180 / Math.PI),
          Math.abs((base.pitch[i] ?? 0) - (rotated.pitch[i] ?? 0)) * (180 / Math.PI),
          Math.abs(wrapPi((base.leeway[i] ?? 0) - (rotated.leeway[i] ?? 0))) * (180 / Math.PI),
          Math.abs((base.yawRate[i] ?? 0) - (rotated.yawRate[i] ?? 0)) * (180 / Math.PI),
        );
      }
    }
    // A correct, heading-invariant model keeps these near zero (FP + hull-loft
    // geometry floor only).
    expect(worstSpeed).toBeLessThan(0.05); // m/s
    expect(worstAngleDeg).toBeLessThan(0.5);
  });
});
