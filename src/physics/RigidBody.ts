/**
 * 6-DOF rigid body state and inertia tensor handling.
 *
 * The state here matches the frozen BoatState contract exactly. Inertia is
 * stored as a diagonal in hull-local axes and transformed to world via the
 * orientation quaternion for angular acceleration. This is correct because a
 * boat's yaw inertia is 3-5× its roll inertia — a scalar approximation would
 * make it respond identically to both, which kills the "feel" of a hull in
 * beam seas.
 */

import type { AppliedForce, BoatState, ControlState, Quat, Vec3 } from '@/types';
import {
  vec3,
  zero3,
  copy3,
  sub3,
  addScaled3,
  cross3,
  rotateVec3,
  isFinite3,
  headingFromQuat,
  heelFromQuat,
  pitchFromQuat,
  length3,
} from '@core/math';
import { copyQ, quat } from '@core/math';

// ─── Module-scope scratch vectors (ZERO allocation in hot paths) ─────────────

const _scratch0: Vec3 = vec3();
const _scratch1: Vec3 = vec3();

// ─── Control state factory ───────────────────────────────────────────────────

export function createControlState(): ControlState {
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
  };
}

// ─── BoatState factory ───────────────────────────────────────────────────────

export function createBoatState(): BoatState {
  return {
    position: vec3(),
    orientation: quat(),
    linearVelocity: vec3(),
    angularVelocity: vec3(),
    controls: createControlState(),
    heel: 0,
    pitch: 0,
    heading: 0,
    speed: 0,
    capsized: false,
    foiling: false,
    helmLoad: 0,
  };
}

/** Deep-copy a BoatState into an existing target, allocation-free. */
export function copyBoatState(target: BoatState, source: BoatState): void {
  copy3(target.position, source.position);
  copyQ(target.orientation, source.orientation);
  copy3(target.linearVelocity, source.linearVelocity);
  copy3(target.angularVelocity, source.angularVelocity);
  target.controls.rudder = source.controls.rudder;
  target.controls.mainsheet = source.controls.mainsheet;
  target.controls.jibsheet = source.controls.jibsheet;
  target.controls.spinnaker = source.controls.spinnaker;
  target.controls.vang = source.controls.vang;
  target.controls.traveller = source.controls.traveller;
  target.controls.board = source.controls.board;
  target.controls.crewFore = source.controls.crewFore;
  target.controls.crewLateral = source.controls.crewLateral;
  target.controls.hike = source.controls.hike;
  target.heel = source.heel;
  target.pitch = source.pitch;
  target.heading = source.heading;
  target.speed = source.speed;
  target.capsized = source.capsized;
  target.foiling = source.foiling;
  target.helmLoad = source.helmLoad;
}

/** Update the derived (cached) fields on BoatState from position + orientation + velocity. */
export function updateDerivedState(state: BoatState): void {
  state.heading = headingFromQuat(state.orientation);
  state.heel = heelFromQuat(state.orientation);
  state.pitch = pitchFromQuat(state.orientation);
  state.speed = length3(state.linearVelocity);
}

/** Check whether the state contains any NaN or Infinity. */
export function isStateFinite(state: BoatState): boolean {
  return (
    isFinite3(state.position) &&
    isFinite3(state.linearVelocity) &&
    isFinite3(state.angularVelocity) &&
    Number.isFinite(state.orientation.x) &&
    Number.isFinite(state.orientation.y) &&
    Number.isFinite(state.orientation.z) &&
    Number.isFinite(state.orientation.w)
  );
}

// ─── Inertia tensor world-frame transform ────────────────────────────────────

/**
 * Transform a diagonal local inertia tensor into world space and invert it.
 *
 * I_world = R * I_local * R^T, so I_world_inv = R * I_local_inv * R^T.
 * Since I_local is diagonal, I_local_inv is trivially the reciprocal of each component.
 * The result is a 3×3 symmetric matrix stored as 6 unique values [xx, xy, xz, yy, yz, zz].
 */
export interface InertiaWorldInv {
  xx: number;
  xy: number;
  xz: number;
  yy: number;
  yz: number;
  zz: number;
}

const _basisX: Vec3 = vec3();
const _basisY: Vec3 = vec3();
const _basisZ: Vec3 = vec3();

export function computeWorldInertiaInverse(
  localInertia: Vec3,
  orientation: Quat,
  out: InertiaWorldInv,
): InertiaWorldInv {
  // Get the rotation matrix columns by rotating unit vectors
  rotateVec3(orientation, { x: 1, y: 0, z: 0 }, _basisX);
  rotateVec3(orientation, { x: 0, y: 1, z: 0 }, _basisY);
  rotateVec3(orientation, { x: 0, y: 0, z: 1 }, _basisZ);

  // I_local_inv diagonal
  const ix = localInertia.x > 1e-10 ? 1 / localInertia.x : 0;
  const iy = localInertia.y > 1e-10 ? 1 / localInertia.y : 0;
  const iz = localInertia.z > 1e-10 ? 1 / localInertia.z : 0;

  // I_world_inv = R * diag(ix,iy,iz) * R^T
  // Element (i,j) = sum_k R[i][k] * Iinv[k] * R[j][k]
  out.xx = _basisX.x * _basisX.x * ix + _basisY.x * _basisY.x * iy + _basisZ.x * _basisZ.x * iz;
  out.xy = _basisX.x * _basisX.y * ix + _basisY.x * _basisY.y * iy + _basisZ.x * _basisZ.y * iz;
  out.xz = _basisX.x * _basisX.z * ix + _basisY.x * _basisY.z * iy + _basisZ.x * _basisZ.z * iz;
  out.yy = _basisX.y * _basisX.y * ix + _basisY.y * _basisY.y * iy + _basisZ.y * _basisZ.y * iz;
  out.yz = _basisX.y * _basisX.z * ix + _basisY.y * _basisY.z * iy + _basisZ.y * _basisZ.z * iz;
  out.zz = _basisX.z * _basisX.z * ix + _basisY.z * _basisY.z * iy + _basisZ.z * _basisZ.z * iz;

  return out;
}

/** Multiply a symmetric 3×3 matrix by a vector: result = M * v. */
export function mulInertiaVec(m: InertiaWorldInv, v: Vec3, out: Vec3): Vec3 {
  out.x = m.xx * v.x + m.xy * v.y + m.xz * v.z;
  out.y = m.xy * v.x + m.yy * v.y + m.yz * v.z;
  out.z = m.xz * v.x + m.yz * v.y + m.zz * v.z;
  return out;
}

// ─── Force accumulation ──────────────────────────────────────────────────────

/**
 * Sum applied forces into net force and net torque about a centre of mass.
 * Allocation-free — writes into the provided out-parameters.
 */
export function accumulateForces(
  forces: readonly AppliedForce[],
  forceCount: number,
  centreOfMass: Vec3,
  outForce: Vec3,
  outTorque: Vec3,
): void {
  zero3(outForce);
  zero3(outTorque);

  for (let i = 0; i < forceCount; i++) {
    const f = forces[i];
    if (f === undefined) continue;

    addScaled3(outForce, f.force, 1);

    // torque = (point - CoM) × force
    sub3(f.point, centreOfMass, _scratch0);
    cross3(_scratch0, f.force, _scratch1);
    addScaled3(outTorque, _scratch1, 1);
  }
}

// ─── Force pool ──────────────────────────────────────────────────────────────

const MAX_FORCES = 128;
const _forcePool: AppliedForce[] = [];
for (let i = 0; i < MAX_FORCES; i++) {
  _forcePool.push({ force: vec3(), point: vec3() });
}

let _forcePoolIndex = 0;

/** Reset the force pool for a new step. Call once at the start of each physics step. */
export function resetForcePool(): void {
  _forcePoolIndex = 0;
}

/** Get the next available AppliedForce from the pool. Returns undefined if exhausted. */
export function allocForce(): AppliedForce | undefined {
  if (_forcePoolIndex >= MAX_FORCES) return undefined;
  const f = _forcePool[_forcePoolIndex];
  _forcePoolIndex++;
  if (f === undefined) return undefined;
  zero3(f.force);
  zero3(f.point);
  return f;
}

/** Current number of forces allocated this step. */
export function getForceCount(): number {
  return _forcePoolIndex;
}

/** Direct access to the pool array for passing to accumulateForces. */
export function getForcePoolSlice(): readonly AppliedForce[] {
  return _forcePool;
}
