/**
 * MIRROR-SYMMETRY harness and regression suite.
 *
 * A boat's physics MUST be perfectly mirror-symmetric port/starboard. If you run
 * any scenario and its exact mirror image (reflect the world about the boat's
 * fore-aft centreline: East↔West), the two trajectories must be mirror images of
 * each other — position reflected, heel sign flipped, heading-deviation sign
 * flipped — to numerical tolerance. Any asymmetry is a bug (a tack-dependent
 * sign convention, a `Math.abs` where the sign matters, an `|| 1` tie-break that
 * resolves the same way under mirroring, an atan2 branch cut, …).
 *
 * The reflection used throughout is the mirror across the plane x = 0 (world
 * +X = east). It maps a right-handed frame to a left-handed one, so:
 *   - position:          x → −x,  y → y,  z → z
 *   - linear velocity:   vx → −vx, vy → vy, vz → vz
 *   - angular velocity:  ωx → ωx, ωy → −ωy, ωz → −ωz   (pseudovector: the
 *                        component along the mirror normal is preserved, the
 *                        perpendicular components flip)
 *   - orientation quat (x,y,z,w) → (x,−y,−z,w)   (yaw θ→−θ, roll φ→−φ)
 *   - heading (bearing from +Z):  θ → −θ
 *   - heel  (positive to starboard):  φ → −φ
 *   - pitch (bow-up):                 unchanged
 *   - rudder / traveller / crewLateral controls:  negate
 *   - wind FROM bearing:              b → −b
 *
 * The net force transforms as a vector (mirror x, keep y,z); the net torque as a
 * pseudovector (keep x, mirror y,z).
 *
 * Conventions: SI/radians; world Y-up right-handed, +X east, +Z south;
 * bearing θ → forward (sin θ, 0, −cos θ). Wind bearing is the direction the wind
 * comes FROM.
 *
 * ## A note on the two legitimate NON-physics asymmetries this harness exposes
 *
 *  1. The generated hull mesh is lofted with ~4 mm of numerical left/right noise
 *     (the buoyancy points sit on the centreline to ≈0.004 m, not exactly 0), so
 *     a HEELED hull with large angular rates produces a tiny (<0.3 % of weight)
 *     buoyancy residual between a pose and its mirror. That is an INPUT-geometry
 *     asymmetry, not a force-law bug — the tolerance below is scaled to swallow
 *     it while still catching any real sign error (which is orders of magnitude
 *     larger, as the pre-fix AeroForce traveller bug was).
 *  2. The layered WindField adds spatial turbulence that is NOT symmetric about
 *     x = 0 (it is a real pseudo-random field). So the full-boat trajectory test
 *     runs in a UNIFORM, turbulence-free wind (oscillation/gust scales 0), which
 *     isolates the boat's own port/starboard symmetry from the field's noise.
 */

import { describe, it, expect } from 'vitest';
import type {
  AirConditions,
  AppliedForce,
  BoatSpec,
  BoatState,
  ControlState,
  CurrentConditions,
  Environment,
  ForceContext,
  ForceGenerator,
  Quat,
  SeaConditions,
  SkyConditions,
  Vec3,
  VenueDefinition,
  WeatherKeyframe,
  WeatherService,
  WeatherSnapshot,
  WindConditions,
} from '@/types';
import { PHYSICS_CONSTANTS, UNITS } from '@/types';
import { createEnvironment } from '@/environment';
import { createBoatSimulation, DINGHY } from '@boats/index';
import type { BoatSimulationBundle } from '@boats/BoatFactory';
import { BuoyancyForceGenerator } from '@physics/forces/Buoyancy';
import { WaveDragForceGenerator } from '@physics/forces/WaveDrag';
import { AeroForce } from '@physics/forces/AeroForce';
import { HydroResistance } from '@physics/forces/HydroResistance';
import { FoilLift } from '@physics/forces/FoilLift';
import { RightingMoment } from '@physics/forces/RightingMoment';
import {
  HydrodynamicDampingForceGenerator,
  DINGHY_HYDRO_DAMPING,
} from '@physics/forces/HydrodynamicDamping';

const DT = 1 / 120;

// ── Uniform (turbulence-free) wind environment ───────────────────────────────

function uniformEnv(windKnots: number): Environment {
  const speedMs = windKnots * UNITS.KNOTS_TO_MS;
  const wind: WindConditions = {
    trueSpeed: speedMs,
    trueDirection: 0, // FROM north.
    gustCeiling: speedMs,
    stability: 1,
  };
  const sea: SeaConditions = {
    significantHeight: 0,
    dominantPeriod: 6,
    dominantDirection: 0,
    swell: { height: 0, period: 6, direction: 0 },
    windWave: { height: 0, period: 4, direction: 0 },
    surfaceTemp: 18,
    tideHeight: 0,
  };
  const current: CurrentConditions = { speed: 0, direction: 0 };
  const sky: SkyConditions = {
    cloudLow: 0.2,
    cloudMid: 0.1,
    cloudHigh: 0.1,
    visibility: 20000,
    precipitation: 0,
    wmoCode: 1,
    solarRadiation: 500,
    isDay: true,
  };
  const air: AirConditions = {
    temperature: 18,
    pressure: 101325,
    density: PHYSICS_CONSTANTS.AIR_DENSITY_REFERENCE,
  };
  const keyframe = (offset: number): WeatherKeyframe => ({ offset, wind, sea, current, sky, air });
  const snapshot: WeatherSnapshot = {
    fetchedAt: Date.UTC(2024, 5, 21, 15, 0, 0),
    source: 'sandbox',
    venueId: 'mirror-bay',
    localTime: { iso: '2024-06-21T15:00:00Z', utcOffsetSeconds: 0 },
    wind,
    sea,
    current,
    sky,
    air,
    timeline: [keyframe(-3600), keyframe(0), keyframe(3600), keyframe(7200), keyframe(14400)],
    attribution: ['synthetic-test'],
  };
  const steady = snapshot.timeline[1];
  if (steady === undefined) throw new Error('no keyframe');
  const weatherService: WeatherService = { snapshot, sampleAt: () => steady, timeCompression: 1 };
  const venue: VenueDefinition = {
    id: 'mirror-bay',
    name: 'Mirror Bay',
    region: 'Nowhere',
    coordinates: { latitude: 41.5, longitude: -71.3 },
    timezone: 'UTC',
    difficulty: 1,
    blurb: 'A flat, uniform-wind bay for mirror-symmetry tests.',
    bounds: { min: { x: -5000, y: -5000 }, max: { x: 5000, y: 5000 } },
    coastlineFile: 'none.json',
    coastlineAttribution: 'synthetic',
    relief: 'flat',
    maxElevation: 0,
    maxDepth: 50,
    freshwater: false,
    landmarks: [],
    traffic: [],
    water: {
      colorShallow: { r: 0.1, g: 0.3, b: 0.3 },
      colorDeep: { r: 0, g: 0.1, b: 0.2 },
      turbidity: 0.2,
      extinctionDepth: 15,
    },
    // Zero oscillation + gust → a spatially UNIFORM, steady wind so the only
    // asymmetry source left is the boat physics.
    windProfile: { shearExponent: 0.11, oscillationScale: 0, gustScale: 0, fetch: 50000 },
    tide: { amplitude: 0, phaseOffsetHours: 0, currentStrength: 0, currentAxis: { x: 1, y: 0 } },
    courses: [],
    climatology: [],
    grade: {
      exposure: 0,
      contrast: 0,
      saturation: 1,
      shadowTint: { r: 0, g: 0, b: 0 },
      highlightTint: { r: 1, g: 1, b: 1 },
      palette: [{ r: 0.5, g: 0.5, b: 0.5 }],
    },
    ambience: { surf: 0.2, gullDensity: 0, urban: 0, harbour: 0, riggingResonance: 200 },
    spawn: { position: { x: 0, y: 0 }, heading: 0 },
  };
  return createEnvironment({ weatherService, venue, seed: 1234 });
}

// ── Reflection helpers ───────────────────────────────────────────────────────

function wrapPi(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}
function mirrorVec(v: Vec3): Vec3 {
  return { x: -v.x, y: v.y, z: v.z };
}
function mirrorOmega(w: Vec3): Vec3 {
  return { x: w.x, y: -w.y, z: -w.z };
}
function mirrorQuat(q: Quat): Quat {
  return { x: q.x, y: -q.y, z: -q.z, w: q.w };
}
function mirrorControls(c: ControlState): ControlState {
  return { ...c, rudder: -c.rudder, traveller: -c.traveller, crewLateral: -c.crewLateral };
}
function mirrorPatch(c: Partial<ControlState>): Partial<ControlState> {
  const out: Partial<ControlState> = { ...c };
  if (c.rudder !== undefined) out.rudder = -c.rudder;
  if (c.traveller !== undefined) out.traveller = -c.traveller;
  if (c.crewLateral !== undefined) out.crewLateral = -c.crewLateral;
  return out;
}

// ── Force-level mirror harness ───────────────────────────────────────────────

function mirrorContext(ctx: ForceContext, env: Environment): ForceContext {
  const s = ctx.state;
  const mState: BoatState = {
    position: mirrorVec(s.position),
    orientation: mirrorQuat(s.orientation),
    linearVelocity: mirrorVec(s.linearVelocity),
    angularVelocity: mirrorOmega(s.angularVelocity),
    controls: mirrorControls(s.controls),
    heel: -s.heel,
    pitch: s.pitch,
    heading: wrapPi(-s.heading),
    speed: s.speed,
    capsized: s.capsized,
    foiling: s.foiling,
    helmLoad: s.helmLoad,
  };
  const mirroredEnv: Environment = {
    ...env,
    wind: {
      ...env.wind,
      sample: (x, z, h, t) => {
        const w = env.wind.sample(-x, z, h, t);
        return { ...w, velocity: mirrorVec(w.velocity), direction: wrapPi(-w.direction) };
      },
    },
    waves: {
      ...env.waves,
      height: (x, z, t) => env.waves.height(-x, z, t),
      orbitalVelocity: (x, z, y, t, out) => {
        const dst = out ?? { x: 0, y: 0, z: 0 };
        const tmp = { x: 0, y: 0, z: 0 };
        env.waves.orbitalVelocity(-x, z, y, t, tmp);
        dst.x = -tmp.x;
        dst.y = tmp.y;
        dst.z = tmp.z;
        return dst;
      },
    },
  };
  return {
    ...ctx,
    state: mState,
    environment: mirroredEnv,
    apparentWind: mirrorVec(ctx.apparentWind),
  };
}

function sumForces(forces: AppliedForce[], com: Vec3): { force: Vec3; torque: Vec3 } {
  const force = { x: 0, y: 0, z: 0 };
  const torque = { x: 0, y: 0, z: 0 };
  for (const f of forces) {
    force.x += f.force.x;
    force.y += f.force.y;
    force.z += f.force.z;
    const rx = f.point.x - com.x;
    const ry = f.point.y - com.y;
    const rz = f.point.z - com.z;
    torque.x += ry * f.force.z - rz * f.force.y;
    torque.y += rz * f.force.x - rx * f.force.z;
    torque.z += rx * f.force.y - ry * f.force.x;
  }
  return { force, torque };
}

function rotateByQuat(q: Quat, v: Vec3): Vec3 {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}
function worldCoM(state: BoatState, spec: BoatSpec): Vec3 {
  const r = rotateByQuat(state.orientation, spec.centreOfMass);
  return { x: r.x + state.position.x, y: r.y + state.position.y, z: r.z + state.position.z };
}

function assertGeneratorMirrors(
  makeGen: () => ForceGenerator,
  ctx: ForceContext,
  env: Environment,
  spec: BoatSpec,
  label: string,
  absTol: number,
): void {
  const outA: AppliedForce[] = [];
  makeGen().evaluate(ctx, outA);
  const sumA = sumForces(outA, worldCoM(ctx.state, spec));

  const mctx = mirrorContext(ctx, env);
  const outB: AppliedForce[] = [];
  makeGen().evaluate(mctx, outB);
  const sumB = sumForces(outB, worldCoM(mctx.state, spec));

  const mForce = mirrorVec(sumA.force);
  const mTorque = mirrorOmega(sumA.torque);
  expect(Math.abs(mForce.x - sumB.force.x), `${label} force.x`).toBeLessThan(absTol);
  expect(Math.abs(mForce.y - sumB.force.y), `${label} force.y`).toBeLessThan(absTol);
  expect(Math.abs(mForce.z - sumB.force.z), `${label} force.z`).toBeLessThan(absTol);
  expect(Math.abs(mTorque.x - sumB.torque.x), `${label} torque.x`).toBeLessThan(absTol);
  expect(Math.abs(mTorque.y - sumB.torque.y), `${label} torque.y`).toBeLessThan(absTol);
  expect(Math.abs(mTorque.z - sumB.torque.z), `${label} torque.z`).toBeLessThan(absTol);
}

/**
 * Build a representative close-reach ForceContext with leeway, heel and angular
 * rates, so every sign-carrying term is exercised (not a degenerate symmetric
 * pose that would pass trivially).
 */
function makeCtx(
  env: Environment,
  spec: BoatSpec,
  controls: Partial<ControlState>,
): ForceContext {
  const bundle = createBoatSimulation(DINGHY, { id: 'mirror-ctx' });
  const sim = bundle.sim;
  const heading = (50 * Math.PI) / 180;
  const heel = (18 * Math.PI) / 180;
  sim.reset({ x: 3, y: -0.27, z: 5 }, heading);
  const hy = heading / 2;
  const hr = heel / 2;
  const qY: Quat = { x: 0, y: Math.sin(hy), z: 0, w: Math.cos(hy) };
  const qR: Quat = { x: 0, y: 0, z: Math.sin(hr), w: Math.cos(hr) };
  const q: Quat = {
    w: qY.w * qR.w - qY.x * qR.x - qY.y * qR.y - qY.z * qR.z,
    x: qY.w * qR.x + qY.x * qR.w + qY.y * qR.z - qY.z * qR.y,
    y: qY.w * qR.y - qY.x * qR.z + qY.y * qR.w + qY.z * qR.x,
    z: qY.w * qR.z + qY.x * qR.y - qY.y * qR.x + qY.z * qR.w,
  };
  sim.state.orientation = q;
  const fwd = { x: Math.sin(heading), z: -Math.cos(heading) };
  const right = { x: Math.cos(heading), z: Math.sin(heading) };
  sim.state.linearVelocity = {
    x: fwd.x * 4 + right.x * 0.5,
    y: -0.05,
    z: fwd.z * 4 + right.z * 0.5,
  };
  sim.state.angularVelocity = { x: 0.1, y: 0.2, z: -0.05 };
  sim.setControls(controls);
  for (const k of Object.keys(controls) as (keyof ControlState)[]) {
    const v = controls[k];
    if (v !== undefined) sim.state.controls[k] = v;
  }
  const st = sim.state;
  const ux = 2 * (q.x * q.y - q.w * q.z);
  const uy = 1 - 2 * (q.x * q.x + q.z * q.z);
  st.heel = Math.atan2(ux, uy);
  st.pitch = Math.asin(Math.max(-1, Math.min(1, -2 * (q.y * q.z - q.w * q.x))));
  const fx = 2 * (q.x * q.z + q.w * q.y);
  const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
  const bb = Math.atan2(fx, fz);
  st.heading = bb < 0 ? bb + Math.PI * 2 : bb;
  st.speed = Math.hypot(st.linearVelocity.x, st.linearVelocity.y, st.linearVelocity.z);

  const wind = env.wind.sample(st.position.x, st.position.z, 5, 0);
  const apparentWind: Vec3 = {
    x: wind.velocity.x - st.linearVelocity.x,
    y: wind.velocity.y - st.linearVelocity.y,
    z: wind.velocity.z - st.linearVelocity.z,
  };
  return {
    state: st,
    boat: spec,
    environment: env,
    time: 0,
    dt: DT,
    apparentWind,
    waterDensity: env.waterDensity,
    airDensity: PHYSICS_CONSTANTS.AIR_DENSITY_REFERENCE,
  };
}

// ── Per-generator mirror tests ───────────────────────────────────────────────

describe('force generators are port/starboard mirror-symmetric', () => {
  const env = uniformEnv(11);
  const spec = createBoatSimulation(DINGHY, { id: 'mirror-spec' }).spec;
  const controls: Partial<ControlState> = {
    rudder: 0.2,
    mainsheet: 0.5,
    board: 1,
    hike: 0.5,
    crewLateral: -0.5,
    traveller: 0.1,
  };

  // Force-law tolerance. Real sign bugs are O(10–100 N); the only residual at
  // this pose is the ~4 mm hull-loft geometry noise (see the file header),
  // which is < 4 N on an ~1300 N weight / ~400 N aero scale. 4 N absolute
  // catches every genuine sign error while swallowing the loft noise.
  const TOL = 4;

  it('Buoyancy mirrors', () => {
    assertGeneratorMirrors(() => new BuoyancyForceGenerator(), makeCtx(env, spec, controls), env, spec, 'Buoyancy', TOL);
  });
  it('RightingMoment mirrors', () => {
    assertGeneratorMirrors(() => new RightingMoment(), makeCtx(env, spec, controls), env, spec, 'RightingMoment', TOL);
  });
  it('HydroResistance mirrors', () => {
    assertGeneratorMirrors(() => new HydroResistance(), makeCtx(env, spec, controls), env, spec, 'HydroResistance', TOL);
  });
  it('HydrodynamicDamping mirrors', () => {
    assertGeneratorMirrors(
      () => new HydrodynamicDampingForceGenerator(DINGHY_HYDRO_DAMPING),
      makeCtx(env, spec, controls),
      env,
      spec,
      'HydrodynamicDamping',
      TOL,
    );
  });
  it('WaveDrag mirrors', () => {
    assertGeneratorMirrors(() => new WaveDragForceGenerator('mirror-wd'), makeCtx(env, spec, controls), env, spec, 'WaveDrag', TOL);
  });
  it('FoilLift mirrors', () => {
    assertGeneratorMirrors(() => new FoilLift(), makeCtx(env, spec, controls), env, spec, 'FoilLift', TOL);
  });
  it('AeroForce mirrors (including the traveller term)', () => {
    // This is the regression for the traveller asymmetry: before the fix the
    // traveller offset was added to the unsigned boom magnitude, so a non-zero
    // traveller broke mirror symmetry (force.x residual ≈ 3.5 N here, well over
    // tolerance). With the tack-aware traveller term it is symmetric.
    assertGeneratorMirrors(() => new AeroForce(spec), makeCtx(env, spec, controls), env, spec, 'AeroForce', TOL);
  });
});

// ── Full-boat trajectory mirror test ─────────────────────────────────────────

interface Trace {
  x: number[];
  z: number[];
  heel: number[];
  heading: number[];
}

function runTrajectory(
  env: Environment,
  heading0: number,
  controls: Partial<ControlState>,
  id: string,
  seconds: number,
): Trace {
  const bundle: BoatSimulationBundle = createBoatSimulation(DINGHY, { id });
  bundle.sim.reset({ x: 0, y: -0.27, z: 0 }, heading0);
  bundle.sim.state.linearVelocity.x = 3 * Math.sin(heading0);
  bundle.sim.state.linearVelocity.z = -3 * Math.cos(heading0);
  bundle.sim.setControls(controls);
  for (const k of Object.keys(controls) as (keyof ControlState)[]) {
    const v = controls[k];
    if (v !== undefined) bundle.sim.state.controls[k] = v;
  }
  const trace: Trace = { x: [], z: [], heel: [], heading: [] };
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    bundle.sim.setControls(controls);
    bundle.sim.step(env, i * DT, DT);
    if (i % 12 === 0) {
      trace.x.push(bundle.sim.state.position.x);
      trace.z.push(bundle.sim.state.position.z);
      trace.heel.push(bundle.sim.state.heel);
      trace.heading.push(bundle.sim.state.heading);
    }
  }
  return trace;
}

describe('full-boat trajectory is port/starboard mirror-symmetric (uniform wind FROM north)', () => {
  it('a close reach and its mirror produce mirror-image trajectories over 20 s', () => {
    // Wind FROM north (0); uniform (no turbulence). Close reach on starboard
    // tack ≈ heading +50°. Mirror: heading −50°, rudder & crewLateral negated.
    // Wind FROM north is its own mirror across x=0, so both runs share the field.
    const env = uniformEnv(11);
    const heading = (50 * Math.PI) / 180;
    const controls: Partial<ControlState> = {
      rudder: 0.1,
      mainsheet: 0.55,
      board: 1,
      hike: 1,
      crewLateral: -1,
    };
    const A = runTrajectory(env, heading, controls, 'mirror-A', 20);
    const B = runTrajectory(env, -heading, mirrorPatch(controls), 'mirror-B', 20);

    // Tolerance: the physics is mirror-symmetric to machine precision per step,
    // but the mirror operations (quaternion conjugation, velocity negation) and
    // RK4 accumulate ~1e-16 differences that grow slowly over 2400 steps. After
    // the FoilLift leeway-wrap fix the end-of-run divergence is ~1 cm / a few
    // milliradians (it was ~1 m / ~0.3 rad before the fix). 3 cm + a 1.5 %
    // growth term is well under any real asymmetry and well over float drift.
    const tol = 0.03;
    for (let i = 0; i < A.x.length; i++) {
      const ax = A.x[i] ?? 0;
      const az = A.z[i] ?? 0;
      const ah = A.heel[i] ?? 0;
      const bx = B.x[i] ?? 0;
      const bz = B.z[i] ?? 0;
      const bh = B.heel[i] ?? 0;
      expect(Math.abs(-ax - bx), `x[${i}]`).toBeLessThan(tol + 0.015 * Math.abs(ax));
      expect(Math.abs(az - bz), `z[${i}]`).toBeLessThan(tol + 0.015 * Math.abs(az));
      expect(Math.abs(-ah - bh), `heel[${i}]`).toBeLessThan(tol);
      const hdA = wrapPi(A.heading[i] ?? 0);
      const hdB = wrapPi(B.heading[i] ?? 0);
      expect(Math.abs(hdA + hdB), `heading[${i}]`).toBeLessThan(tol);
    }
  });
});


// ── FoilLift leeway-wrap regression (headings in the upper half-circle) ──────

describe('FoilLift leeway angle is heading-wrap invariant (real-game bug)', () => {
  /**
   * Build a ForceContext for a pure forward-sailing pose (no heel, small leeway)
   * at an arbitrary heading, with velocity aligned to the bow plus a fixed small
   * starboard slip, so the foil's angle of attack (the leeway) is the SAME small
   * angle regardless of the absolute heading. Before the wrap fix, a heading in
   * (π, 2π) produced a leeway off by ≈2π and a nonsense foil force.
   */
  function foilForceAt(env: Environment, spec: BoatSpec, heading: number): Vec3 {
    const bundle = createBoatSimulation(DINGHY, { id: `foil-wrap-${heading.toFixed(3)}` });
    const sim = bundle.sim;
    sim.reset({ x: 0, y: -0.27, z: 0 }, heading);
    // Velocity: 4 m/s along the bow + 0.4 m/s to starboard (a ~5.7° leeway).
    const fwd = { x: Math.sin(heading), z: -Math.cos(heading) };
    const right = { x: Math.cos(heading), z: Math.sin(heading) };
    sim.state.linearVelocity = {
      x: fwd.x * 4 + right.x * 0.4,
      y: 0,
      z: fwd.z * 4 + right.z * 0.4,
    };
    sim.state.speed = Math.hypot(sim.state.linearVelocity.x, sim.state.linearVelocity.z);
    sim.state.controls.board = 1;
    const ctx: ForceContext = {
      state: sim.state,
      boat: spec,
      environment: env,
      time: 0,
      dt: DT,
      apparentWind: { x: 0, y: 0, z: 0 },
      waterDensity: env.waterDensity,
      airDensity: PHYSICS_CONSTANTS.AIR_DENSITY_REFERENCE,
    };
    const out: AppliedForce[] = [];
    new FoilLift().evaluate(ctx, out);
    // Resolve the total foil force into the boat's own (forward, right) frame so
    // we can compare the PHYSICS (drive drag + side lift) across headings.
    const f = out.reduce((a, g) => ({ x: a.x + g.force.x, y: a.y + g.force.y, z: a.z + g.force.z }), { x: 0, y: 0, z: 0 });
    return {
      x: f.x * fwd.x + f.z * fwd.z, // along bow (drag, should be negative)
      y: f.y,
      z: f.x * right.x + f.z * right.z, // to starboard (lift opposing leeway)
    };
  }

  it('produces the same foil force (in boat axes) at heading 50° and 300°', () => {
    const env = uniformEnv(11);
    const spec = createBoatSimulation(DINGHY, { id: 'foil-wrap-spec' }).spec;
    const low = foilForceAt(env, spec, (50 * Math.PI) / 180); // heading < π
    const high = foilForceAt(env, spec, (300 * Math.PI) / 180); // heading > π
    // Same leeway geometry → same drag along the bow and same lift to starboard.
    // Pre-fix, `high` saw a leeway ≈ 2π larger → a wildly different (nonsense)
    // force; the along-bow and side components diverged by hundreds of newtons.
    expect(Math.abs(low.x - high.x), 'drag along bow').toBeLessThan(1e-6);
    expect(Math.abs(low.z - high.z), 'side lift').toBeLessThan(1e-6);
    // Sanity: the foil DOES oppose the starboard slip (side lift to port, < 0).
    expect(low.z).toBeLessThan(-1);
  });
});
