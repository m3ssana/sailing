/**
 * Regression test for the BoatSimulation force-accumulation wiring bug.
 *
 * BUG (found while wiring Phase 2 task 2.1 "first sail"): BoatSimulationImpl.step
 * passed `this._forces` (the `out` array) to every ForceGenerator.evaluate, but
 * then integrated the forces read from the GLOBAL FORCE POOL
 * (getForcePoolSlice()/getForceCount()) rather than from `out`. Generators that
 * use `allocForce()` (Buoyancy, WaveDrag) happen to land in the pool, so they
 * worked — but the four generators that push plain object literals into `out`
 * (AeroForce, FoilLift, HydroResistance, RightingMoment) were SILENTLY DROPPED:
 * their forces never reached the integrator. The entire sail-force path was
 * dead. Additionally `this._forces` was never cleared, so it grew unbounded.
 *
 * FIX: BoatSimulation.step now clears `this._forces` each step and accumulates
 * from it (the actual contract of ForceGenerator.evaluate(ctx, out)). The pool
 * remains an allocation buffer whose objects are pushed into `out`.
 *
 * This test asserts the fixed behaviour directly, independent of any boat
 * definition, so it cannot silently regress.
 */

import { describe, it, expect } from 'vitest';
import type {
  BoatSpec,
  Environment,
  ForceGenerator,
  Hydrostatics,
  WeatherSnapshot,
} from '@/types';
import { PHYSICS_CONSTANTS } from '@/types';
import { BoatSimulationImpl } from '@physics/BoatSimulation';

function makeHydrostatics(): Hydrostatics {
  return {
    displacedVolume: 1,
    displacement: PHYSICS_CONSTANTS.WATER_DENSITY,
    wettedSurface: 5,
    waterplaneArea: 2,
    centreOfBuoyancy: { x: 0, y: -0.1, z: 0 },
    centreOfFlotation: 0,
    buoyancyPoints: [{ position: { x: 0, y: -0.1, z: 0 }, volume: 1, sectionArea: 1 }],
    rightingCurve: [
      { x: 0, y: 0 },
      { x: 1, y: 0.1 },
    ],
    waterlineLength: 4,
    waterlineBeam: 1.4,
  };
}

function makeSpec(): BoatSpec {
  return {
    id: 'bug-boat',
    name: 'Bug Boat',
    mass: 100,
    inertia: { x: 100, y: 500, z: 400 },
    centreOfMass: { x: 0, y: 0, z: 0 },
    hydrostatics: makeHydrostatics(),
    sails: [],
    foils: [],
    residuaryCurve: [
      { x: 0, y: 0 },
      { x: 0.4, y: 0.01 },
    ],
    ballastMass: 0,
    crewMass: 0,
    crewMovementRange: { x: 1, y: 0.2, z: 1 },
    capsizeAngle: Math.PI * 0.5,
    hullCount: 1,
  };
}

function makeEnv(): Environment {
  return {
    wind: {
      sample: () => ({ velocity: { x: 0, y: 0, z: 0 }, speed: 0, direction: 0, gustFactor: 1 }),
      sampleGustGridInto: () => {},
      meanDirection: () => 0,
      meanSpeed: () => 0,
    },
    waves: {
      height: () => 0,
      displacement: (_x, _z, _t, out) => out ?? { x: 0, y: 0, z: 0 },
      normal: (_x, _z, _t, out) => {
        const o = out ?? { x: 0, y: 1, z: 0 };
        o.x = 0;
        o.y = 1;
        o.z = 0;
        return o;
      },
      orbitalVelocity: (_x, _z, _y, _t, out) => out ?? { x: 0, y: 0, z: 0 },
      components: [],
      params: {
        windSpeed: 0,
        windDirection: 0,
        fetch: 1000,
        significantHeight: 0,
        swellHeight: 0,
        swellPeriod: 8,
        swellDirection: 0,
        peakEnhancement: 3.3,
        directionalSpread: 20,
        depth: 50,
        currentVelocity: { x: 0, y: 0 },
        seed: 1,
      },
    },
    current: {
      sample: (_x, _z, _t, out) => out ?? { x: 0, y: 0 },
      tideHeight: () => 0,
    },
    skyAt: () => ({
      sunDirection: { x: 0, y: 1, z: 0 },
      sunElevation: 0.5,
      sunAzimuth: Math.PI,
      moonDirection: { x: 0, y: -1, z: 0 },
      moonElevation: -0.5,
      moonPhase: 0.5,
      siderealTime: 0,
      cloudLow: 0,
      cloudMid: 0,
      cloudHigh: 0,
      isNight: false,
    }),
    depthAt: () => 50,
    isLand: () => false,
    waterDensity: PHYSICS_CONSTANTS.WATER_DENSITY,
    snapshot: {} as WeatherSnapshot,
  };
}

describe('BoatSimulation force accumulation (regression)', () => {
  it('integrates forces pushed as object literals (not via the pool)', () => {
    const sim = new BoatSimulationImpl(makeSpec());
    sim.reset({ x: 0, y: 0, z: 0 }, 0);

    // A generator that pushes a PLAIN OBJECT LITERAL (the AeroForce/FoilLift/
    // HydroResistance/RightingMoment pattern), NOT via allocForce().
    const literalPush: ForceGenerator = {
      id: 'literal-push',
      evaluate: (_ctx, out) => {
        out.push({ force: { x: 1000, y: 0, z: 0 }, point: { x: 0, y: 0, z: 0 } });
      },
    };
    sim.addForceGenerator(literalPush);

    const env = makeEnv();
    // One step: F = 1000 N on +X, m = 100 kg, dt = 1/120 → Δv = 1000/100 * dt.
    sim.step(env, 0, 1 / 120);

    const expectedVx = (1000 / 100) * (1 / 120);
    expect(sim.state.linearVelocity.x).toBeCloseTo(expectedVx, 6);
  });

  it('clears the force list between steps (no unbounded accumulation)', () => {
    const sim = new BoatSimulationImpl(makeSpec());
    sim.reset({ x: 0, y: 0, z: 0 }, 0);

    const constantPush: ForceGenerator = {
      id: 'constant-push',
      evaluate: (_ctx, out) => {
        out.push({ force: { x: 1000, y: 0, z: 0 }, point: { x: 0, y: 0, z: 0 } });
      },
    };
    sim.addForceGenerator(constantPush);

    const env = makeEnv();
    const dt = 1 / 120;

    // If the force list were NOT cleared, the per-step force would grow linearly
    // (1000, 2000, 3000, …) and acceleration would ramp. With the fix, each step
    // applies exactly 1000 N, so velocity increases by a CONSTANT increment.
    sim.step(env, 0, dt);
    const v1 = sim.state.linearVelocity.x;
    sim.step(env, dt, dt);
    const v2 = sim.state.linearVelocity.x;
    sim.step(env, 2 * dt, dt);
    const v3 = sim.state.linearVelocity.x;

    const inc1 = v2 - v1;
    const inc2 = v3 - v2;
    // Constant increments ⇒ equal steps (would be 2× and 3× if not cleared).
    expect(inc2).toBeCloseTo(inc1, 6);
    expect(inc1).toBeCloseTo((1000 / 100) * dt, 6);
  });
});
