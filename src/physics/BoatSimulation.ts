/**
 * BoatSimulation — orchestrates force generators, integration, and state
 * management for one boat.
 *
 * Implements the frozen BoatSimulation interface from src/types/physics.ts.
 *
 * Per-step sequence:
 *   1. Apply actuator rate limits to controls
 *   2. Reset force pool
 *   3. Evaluate all force generators
 *   4. Sum forces → net force, net torque
 *   5. Integrate linear (symplectic Euler) and angular (RK4)
 *   6. Update derived state (heel, pitch, heading, speed)
 *   7. NaN guard: restore previous state if diverged
 *
 * The capsized flag is set when heel exceeds the boat's capsize angle. This is
 * emergent from the physics — the righting moment curve goes negative past that
 * angle, so the boat FALLS over rather than being told to.
 */

import type {
  AppliedForce,
  BoatSimulation as IBoatSimulation,
  BoatSpec,
  BoatState,
  ControlState,
  Environment,
  ForceContext,
  ForceGenerator,
  PhysicsLOD,
  Radians,
  SessionTime,
  Vec3,
} from '@/types';
import { PHYSICS_CONSTANTS } from '@/types';
import { vec3, zero3, copy3, addScaled3, rotateVec3 } from '@core/math';
import { fromAxisAngle, normalizeQ } from '@core/math';
import { clamp } from '@core/math';
import {
  createBoatState,
  copyBoatState,
  updateDerivedState,
  isStateFinite,
  accumulateForces,
  resetForcePool,
  getForceCount,
  getForcePoolSlice,
} from './RigidBody';
import { integrateLinear, integrateAngularRK4 } from './Integrator';

// ─── Actuator rate limits (radians or normalised units per second) ────────────
// A physical sheet can be eased at about 1 unit/s; the rudder is faster.
const ACTUATOR_RATES: Record<keyof ControlState, number> = {
  rudder: 3.0,
  mainsheet: 1.2,
  jibsheet: 1.2,
  spinnaker: 0.5,
  vang: 0.8,
  traveller: 1.5,
  board: 0.4,
  crewFore: 0.8,
  crewLateral: 1.0,
  hike: 1.5,
};

// ─── Scratch vectors for per-step work ───────────────────────────────────────

const _netForce: Vec3 = vec3();
const _netTorque: Vec3 = vec3();
const _apparentWind: Vec3 = vec3();
const _worldCoM: Vec3 = vec3();

// ─── Implementation ──────────────────────────────────────────────────────────

export class BoatSimulationImpl implements IBoatSimulation {
  readonly id: string;
  readonly spec: BoatSpec;
  readonly state: BoatState;
  lod: PhysicsLOD = 0;

  private readonly _generators: ForceGenerator[] = [];
  private readonly _prevState: BoatState;
  private readonly _targetControls: ControlState;
  private readonly _forces: AppliedForce[] = [];

  constructor(spec: BoatSpec, id?: string) {
    this.id = id ?? spec.id;
    this.spec = spec;
    this.state = createBoatState();
    this._prevState = createBoatState();
    this._targetControls = {
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
  }

  /** Register a force generator. Order does not matter — they compose additively. */
  addForceGenerator(gen: ForceGenerator): void {
    this._generators.push(gen);
  }

  /** Remove a force generator by id. */
  removeForceGenerator(id: string): void {
    const idx = this._generators.findIndex((g) => g.id === id);
    if (idx !== -1) this._generators.splice(idx, 1);
  }

  step(environment: Environment, time: SessionTime, dt: number): void {
    // ── 0. Snapshot previous state for NaN recovery
    copyBoatState(this._prevState, this.state);

    // ── 1. Apply actuator rate limits
    this._applyActuatorRateLimits(dt);

    // ── 2. Reset force pool
    resetForcePool();

    // ── 3. Compute apparent wind at the rig's centre of effort
    this._computeApparentWind(environment, time);

    // ── 4. Build force context
    const ctx: ForceContext = {
      state: this.state,
      boat: this.spec,
      environment,
      time,
      dt,
      apparentWind: _apparentWind,
      waterDensity: environment.waterDensity,
      airDensity: PHYSICS_CONSTANTS.AIR_DENSITY_REFERENCE,
    };

    // ── 5. Evaluate all force generators
    for (let i = 0; i < this._generators.length; i++) {
      const gen = this._generators[i];
      if (gen === undefined) continue;
      gen.evaluate(ctx, this._forces);
    }

    // ── 6. Accumulate forces and torques
    // The centre of mass in world space
    rotateVec3(this.state.orientation, this.spec.centreOfMass, _worldCoM);
    addScaled3(_worldCoM, this.state.position, 1);

    accumulateForces(
      getForcePoolSlice(),
      getForceCount(),
      _worldCoM,
      _netForce,
      _netTorque,
    );

    // ── 7. Integrate
    integrateLinear(this.state, _netForce, this.spec.mass, dt);
    integrateAngularRK4(this.state, _netTorque, this.spec.inertia, dt);

    // ── 8. Update derived state
    updateDerivedState(this.state);

    // ── 9. Capsize detection (emergent from the righting curve)
    if (Math.abs(this.state.heel) > this.spec.capsizeAngle) {
      this.state.capsized = true;
    }

    // ── 10. NaN guard
    if (!isStateFinite(this.state)) {
       
      console.error(`[BoatSimulation:${this.id}] NaN detected — restoring previous state`);
      copyBoatState(this.state, this._prevState);
    }
  }

  setControls(target: Partial<ControlState>): void {
    const keys = Object.keys(target) as Array<keyof ControlState>;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key === undefined) continue;
      const val = target[key];
      if (val !== undefined) {
        this._targetControls[key] = val;
      }
    }
  }

  reset(position: Vec3, heading: Radians): void {
    copy3(this.state.position, position);
    zero3(this.state.linearVelocity);
    zero3(this.state.angularVelocity);

    // Build orientation from heading (rotation about +Y)
    fromAxisAngle({ x: 0, y: 1, z: 0 }, heading, this.state.orientation);
    normalizeQ(this.state.orientation, this.state.orientation);

    this.state.capsized = false;
    this.state.foiling = false;
    this.state.helmLoad = 0;
    updateDerivedState(this.state);
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  private _applyActuatorRateLimits(dt: number): void {
    const controls = this.state.controls;
    const target = this._targetControls;

    const keys = Object.keys(ACTUATOR_RATES) as Array<keyof ControlState>;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key === undefined) continue;
      const rate = ACTUATOR_RATES[key];
      const maxChange = rate * dt;
      const diff = target[key] - controls[key];
      controls[key] += clamp(diff, -maxChange, maxChange);
    }
  }

  private _computeApparentWind(environment: Environment, time: SessionTime): void {
    // Sample wind at the estimated centre of effort height
    // Use first sail's centre of effort height, or 5m as default
    let coeHeight = 5;
    if (this.spec.sails.length > 0) {
      const firstSail = this.spec.sails[0];
      if (firstSail !== undefined) {
        coeHeight = firstSail.centreOfEffortHeight;
      }
    }

    const pos = this.state.position;
    const wind = environment.wind.sample(pos.x, pos.z, coeHeight, time);

    // Apparent wind = true wind velocity - boat velocity
    _apparentWind.x = wind.velocity.x - this.state.linearVelocity.x;
    _apparentWind.y = wind.velocity.y - this.state.linearVelocity.y;
    _apparentWind.z = wind.velocity.z - this.state.linearVelocity.z;
  }
}
