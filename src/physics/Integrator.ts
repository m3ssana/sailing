/**
 * Physics integrator: semi-implicit (symplectic) Euler for linear motion,
 * RK4 for angular motion.
 *
 * Why the split: linear drag on a hull is well-behaved at 120 Hz with
 * symplectic Euler. Angular dynamics near capsize are not — the restoring
 * moment changes sign across the step, making explicit Euler oscillate and
 * diverge. RK4 samples the torque four times across the substep, handling
 * the sign transition cleanly. The cost is ~4× the world-inertia transform
 * for the angular part only, but that's a handful of multiplies, not a
 * concern at 12 boats.
 *
 * The linear part uses the exponential-map orientation integrator from
 * @core/math, which keeps the quaternion unit-length exactly rather than
 * accumulating drift that requires periodic renormalization.
 */

import type { BoatState, Vec3, Quat } from '@/types';
import {
  vec3,
  copy3,
  addScaled3,
} from '@core/math';
import {
  integrateOrientation,
  normalizeQ,
  quat,
} from '@core/math';
import {
  type InertiaWorldInv,
  computeWorldInertiaInverse,
  mulInertiaVec,
} from './RigidBody';

// ─── Scratch objects for RK4 (zero allocation) ──────────────────────────────

const _k1: Vec3 = vec3();
const _k2: Vec3 = vec3();
const _k3: Vec3 = vec3();
const _k4: Vec3 = vec3();
const _tempOmega: Vec3 = vec3();
const _tempQ: Quat = quat();
const _iWorldInv: InertiaWorldInv = { xx: 0, xy: 0, xz: 0, yy: 0, yz: 0, zz: 0 };
const _midIWorldInv: InertiaWorldInv = { xx: 0, xy: 0, xz: 0, yy: 0, yz: 0, zz: 0 };

/**
 * Integrate linear motion using semi-implicit (symplectic) Euler.
 *
 * Update velocity first (v += a*dt), then position (p += v*dt).
 * This is symplectic — it conserves energy exactly in the limit — which
 * prevents the steady drift that classical Euler gives on damped oscillators
 * (a box bobbing on water would slowly sink or rise).
 */
export function integrateLinear(
  state: BoatState,
  netForce: Vec3,
  mass: number,
  dt: number,
): void {
  const invMass = mass > 1e-10 ? 1 / mass : 0;

  // v += F/m * dt (symplectic: update velocity first)
  addScaled3(state.linearVelocity, netForce, invMass * dt);

  // p += v * dt (uses the NEW velocity)
  addScaled3(state.position, state.linearVelocity, dt);
}

/**
 * Integrate angular motion using RK4.
 *
 * The torque is assumed constant across the step (it was evaluated at the
 * beginning), but the inertia tensor orientation changes as the body rotates,
 * so we recompute I_world_inv at the midpoint orientations. This captures
 * the coupling between roll angle and the effective inertia seen by the torque,
 * which is what makes near-capsize dynamics stable.
 */
export function integrateAngularRK4(
  state: BoatState,
  netTorque: Vec3,
  localInertia: Vec3,
  dt: number,
): void {
  // ── k1: angular acceleration at current state
  computeWorldInertiaInverse(localInertia, state.orientation, _iWorldInv);
  mulInertiaVec(_iWorldInv, netTorque, _k1);

  // ── k2: at midpoint (t + dt/2) using k1
  copy3(_tempOmega, state.angularVelocity);
  addScaled3(_tempOmega, _k1, dt * 0.5);
  integrateOrientation(state.orientation, state.angularVelocity, dt * 0.5, _tempQ);
  normalizeQ(_tempQ, _tempQ);
  computeWorldInertiaInverse(localInertia, _tempQ, _midIWorldInv);
  mulInertiaVec(_midIWorldInv, netTorque, _k2);

  // ── k3: at midpoint (t + dt/2) using k2
  copy3(_tempOmega, state.angularVelocity);
  addScaled3(_tempOmega, _k2, dt * 0.5);
  integrateOrientation(state.orientation, _tempOmega, dt * 0.5, _tempQ);
  normalizeQ(_tempQ, _tempQ);
  computeWorldInertiaInverse(localInertia, _tempQ, _midIWorldInv);
  mulInertiaVec(_midIWorldInv, netTorque, _k3);

  // ── k4: at endpoint (t + dt) using k3
  copy3(_tempOmega, state.angularVelocity);
  addScaled3(_tempOmega, _k3, dt);
  integrateOrientation(state.orientation, _tempOmega, dt, _tempQ);
  normalizeQ(_tempQ, _tempQ);
  computeWorldInertiaInverse(localInertia, _tempQ, _midIWorldInv);
  mulInertiaVec(_midIWorldInv, netTorque, _k4);

  // ── Combine: ω += (k1 + 2*k2 + 2*k3 + k4) * dt/6
  addScaled3(state.angularVelocity, _k1, dt / 6);
  addScaled3(state.angularVelocity, _k2, dt / 3);
  addScaled3(state.angularVelocity, _k3, dt / 3);
  addScaled3(state.angularVelocity, _k4, dt / 6);

  // ── Integrate orientation using the updated angular velocity
  integrateOrientation(state.orientation, state.angularVelocity, dt, state.orientation);
  normalizeQ(state.orientation, state.orientation);
}
