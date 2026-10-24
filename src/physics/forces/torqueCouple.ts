/**
 * Pure force-couple injection for a torque expressed in the BODY frame.
 *
 * The integrator sums `(point − CoM) × force` over applied forces to get the net
 * torque. A generator that wants to apply a pure torque `τ` (no net force) about
 * the boat's own axes must therefore emit a force COUPLE whose moment equals `τ`
 * and whose forces cancel. This helper does exactly that, in a way that is
 * rotation-invariant by construction: the body-frame torque is rotated into
 * world space via the orientation quaternion, then injected as two equal-and-
 * opposite forces about the centre of mass.
 *
 * ## Why body-frame (the rotation-invariance fix)
 *
 * RightingMoment and HydrodynamicDamping are roll/pitch/yaw couples about the
 * HULL's own axes (roll about the longitudinal −Z_body axis, pitch about the
 * transverse +X_body axis, yaw about +Y_body). Injecting them about fixed WORLD
 * axes — as the historical code did — is only correct when the hull points due
 * north/south; at any other compass heading the "roll" couple acts partly about
 * the wrong axis, so stability depends on the absolute heading. Rotating the
 * body-frame torque through the orientation removes that dependence entirely.
 *
 * ## Geometry (pure couple = exactly the requested torque, zero net force)
 *
 * For a world torque `τ`, pick any unit `â` ⟂ `τ`, a lever `d`, and forces
 * `±F` at `±d·â` with `F = (τ × â)/(2d)`. Then the net force is `F + (−F) = 0`
 * and the net moment is `2·(d·â) × F = â × (τ × â) = τ` (since `â·τ = 0`). We
 * choose `â` as whichever world axis is most perpendicular to `τ` for numerical
 * conditioning.
 */

import type { AppliedForce, Quat, Vec3 } from '@/types';
import { vec3, rotateVec3, cross3, length3, normalize3 } from '@core/math';

const _tauWorld: Vec3 = vec3();
const _aHat: Vec3 = vec3();
const _r: Vec3 = vec3();
const _f: Vec3 = vec3();
const _tauCrossA: Vec3 = vec3();

const _candidate: Vec3 = vec3();

/** Lever arm for the injected couple, metres. Cancels out of the net torque. */
const LEVER = 1;

/**
 * Inject a pure torque `torqueBody` (body frame) as a force couple about `com`
 * (world-space centre of mass), pushing two `AppliedForce`s into `out`.
 *
 * Allocation-light: uses module-scope scratch and pushes two plain force
 * literals (the simulation clears its force list each step). Not reentrant
 * across threads — fine for the single-threaded fixed step.
 */
export function pushBodyAxisTorque(
  torqueBody: Vec3,
  orientation: Quat,
  com: Vec3,
  out: AppliedForce[],
): void {
  // Body torque → world torque.
  rotateVec3(orientation, torqueBody, _tauWorld);
  const tauMag = length3(_tauWorld);
  if (tauMag < 1e-9) return;

  // Choose a world axis most perpendicular to τ for a well-conditioned lever.
  const ax = Math.abs(_tauWorld.x);
  const ay = Math.abs(_tauWorld.y);
  const az = Math.abs(_tauWorld.z);
  _candidate.x = 0;
  _candidate.y = 0;
  _candidate.z = 0;
  if (ax <= ay && ax <= az) _candidate.x = 1;
  else if (ay <= az) _candidate.y = 1;
  else _candidate.z = 1;

  // â = normalize(candidate − (candidate·τ̂)τ̂) — project candidate perpendicular to τ.
  const tHatX = _tauWorld.x / tauMag;
  const tHatY = _tauWorld.y / tauMag;
  const tHatZ = _tauWorld.z / tauMag;
  const dotCT = _candidate.x * tHatX + _candidate.y * tHatY + _candidate.z * tHatZ;
  _aHat.x = _candidate.x - dotCT * tHatX;
  _aHat.y = _candidate.y - dotCT * tHatY;
  _aHat.z = _candidate.z - dotCT * tHatZ;
  normalize3(_aHat, _aHat);

  // F = (τ × â) / (2·LEVER).
  cross3(_tauWorld, _aHat, _tauCrossA);
  const inv = 1 / (2 * LEVER);
  _f.x = _tauCrossA.x * inv;
  _f.y = _tauCrossA.y * inv;
  _f.z = _tauCrossA.z * inv;

  // r = LEVER·â.
  _r.x = _aHat.x * LEVER;
  _r.y = _aHat.y * LEVER;
  _r.z = _aHat.z * LEVER;

  // +F at com + r, −F at com − r → net force 0, net moment τ.
  out.push({
    force: { x: _f.x, y: _f.y, z: _f.z },
    point: { x: com.x + _r.x, y: com.y + _r.y, z: com.z + _r.z },
  });
  out.push({
    force: { x: -_f.x, y: -_f.y, z: -_f.z },
    point: { x: com.x - _r.x, y: com.y - _r.y, z: com.z - _r.z },
  });
}
