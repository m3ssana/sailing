/**
 * Diegetic camera modes (H.4): helm, chase, mast, drone.
 *
 * Pure models. Each produces a world-space eye position and a look target; the
 * controller turns those into a `CameraPose` (applying FOV, horizon-lock roll,
 * and head motion). Smoothing lives in the controller so these functions stay
 * stateless and trivially testable.
 *
 * Conventions: Y-up, +X east, +Z south; the boat's local forward is -Z (bow)
 * in hull-local space, rotated into world by the boat orientation. Camera looks
 * down local -Z.
 */

import type { Quat, Vec3 } from '@/types';
import { addScaled3, set3, vec3 } from '@core/math/vec';
import { rotateVec3 } from '@core/math/quat';

/** Local hull axes, hull-local space. Forward is -Z (bow), up +Y, right +X. */
const LOCAL_FORWARD: Vec3 = { x: 0, y: 0, z: -1 };
const LOCAL_UP: Vec3 = { x: 0, y: 1, z: 0 };

/** A camera placement before smoothing/roll: eye + look target. */
export interface Placement {
  eye: Vec3;
  target: Vec3;
}

/** Scratch for placement math, one set per controller instance. */
export interface PlacementScratch {
  fwd: Vec3;
  up: Vec3;
  right: Vec3;
  tmp: Vec3;
}

export function createPlacementScratch(): PlacementScratch {
  return { fwd: vec3(), up: vec3(), right: vec3(), tmp: vec3() };
}

/** World forward (bow direction) from the boat orientation. */
function worldForward(orientation: Quat, out: Vec3): Vec3 {
  return rotateVec3(orientation, LOCAL_FORWARD, out);
}

/** World up (mast direction) from the boat orientation. */
function worldUp(orientation: Quat, out: Vec3): Vec3 {
  return rotateVec3(orientation, LOCAL_UP, out);
}

/**
 * Helm: eye at the sailor's head (hull-local `eyeOffset` rotated into world),
 * looking forward along the bow. Head motion (heel/slam) is added by the
 * controller. The returned target is a point ahead along the bow direction.
 */
export function placeHelm(
  boatPosition: Vec3,
  orientation: Quat,
  eyeOffset: Vec3,
  s: PlacementScratch,
  out: Placement,
): Placement {
  // Eye = boatPosition + R·eyeOffset.
  rotateVec3(orientation, eyeOffset, s.tmp);
  set3(out.eye, boatPosition.x + s.tmp.x, boatPosition.y + s.tmp.y, boatPosition.z + s.tmp.z);
  // Look forward along the bow.
  worldForward(orientation, s.fwd);
  set3(out.target, out.eye.x + s.fwd.x * 20, out.eye.y + s.fwd.y * 20, out.eye.z + s.fwd.z * 20);
  return out;
}

/**
 * Chase (spring-arm): behind and above the boat, looking at it. The arm trails
 * the boat's horizontal heading (derived from the orientation, projected onto
 * the ground plane and renormalised, so heel/pitch do not swing the arm). The
 * controller smooths the eye so it trails. Distance/height scale with LOA.
 *
 * Using the orientation's projected forward — rather than `bearingToDirection`
 * of the derived heading — keeps chase consistent with helm/mast, which read
 * the orientation directly. (The project's `fromYawPitchRoll` yaw sign and
 * `bearingToDirection` do not agree on the x sign; the orientation quaternion is
 * the single source of truth.)
 */
export function placeChase(
  boatPosition: Vec3,
  orientation: Quat,
  loa: number,
  mastHeight: number,
  s: PlacementScratch,
  out: Placement,
): Placement {
  // Horizontal forward = boat forward projected onto the ground plane.
  worldForward(orientation, s.fwd);
  let hx = s.fwd.x;
  let hz = s.fwd.z;
  const hl = Math.hypot(hx, hz);
  if (hl < 1e-6) {
    hx = 0;
    hz = -1; // boat pointing straight up/down: fall back to north.
  } else {
    hx /= hl;
    hz /= hl;
  }
  const dist = Math.max(6, loa * 2.2);
  const height = Math.max(2.5, mastHeight * 0.6);
  // Eye behind the boat (opposite the bow) and up.
  set3(out.eye, boatPosition.x - hx * dist, boatPosition.y + height, boatPosition.z - hz * dist);
  // Aim slightly above the hull so the boat sits in the lower third.
  set3(out.target, boatPosition.x, boatPosition.y + loa * 0.1, boatPosition.z);
  return out;
}

/**
 * Mast-cam: at the masthead looking down and forward over the deck.
 */
export function placeMast(
  boatPosition: Vec3,
  orientation: Quat,
  mastHeight: number,
  s: PlacementScratch,
  out: Placement,
): Placement {
  worldUp(orientation, s.up);
  worldForward(orientation, s.fwd);
  // Eye at (near) the masthead.
  set3(
    out.eye,
    boatPosition.x + s.up.x * mastHeight,
    boatPosition.y + s.up.y * mastHeight,
    boatPosition.z + s.up.z * mastHeight,
  );
  // Look forward-and-down over the bow: forward minus some up.
  set3(out.target, out.eye.x, out.eye.y, out.eye.z);
  addScaled3(out.target, s.fwd, mastHeight * 1.5);
  addScaled3(out.target, s.up, -mastHeight);
  return out;
}

/**
 * Drone: an orbit/offset follow. Orbits the boat slowly at a cinematic radius
 * and leads the boat's velocity a little so it feels like a tracking shot.
 */
export function placeDrone(
  boatPosition: Vec3,
  boatVelocity: Vec3,
  loa: number,
  time: number,
  out: Placement,
): Placement {
  const radius = Math.max(10, loa * 3);
  const height = Math.max(5, loa * 1.2);
  const phase = (time / 25) * Math.PI * 2; // one orbit per ~25 s.
  // Lead the boat by a fraction of a second of its velocity.
  const lead = 0.8;
  set3(
    out.eye,
    boatPosition.x + Math.sin(phase) * radius + boatVelocity.x * lead,
    boatPosition.y + height,
    boatPosition.z + Math.cos(phase) * radius + boatVelocity.z * lead,
  );
  set3(
    out.target,
    boatPosition.x + boatVelocity.x * lead,
    boatPosition.y,
    boatPosition.z + boatVelocity.z * lead,
  );
  return out;
}

/**
 * Head motion offset for the helm cam: heel pushes the head to leeward a little
 * and a slam kicks it down + pitches it, all bounded by caps. Returns the eye
 * translation offset (world) and the extra pitch to add. Pure.
 */
export interface HeadMotion {
  translation: Vec3;
  extraPitch: number;
}

export function computeHeadMotion(
  heel: number,
  slam: number,
  worldUpVec: Vec3,
  worldRightVec: Vec3,
  maxTranslation: number,
  maxPitch: number,
  scale: number,
  out: HeadMotion,
): HeadMotion {
  // Heel sway: proportional to heel, capped. Positive heel (starboard) sways the
  // head to leeward (−right side drops), so translate along −right a touch.
  const heelSway = Math.max(-1, Math.min(1, heel / (Math.PI / 6))) * maxTranslation * 0.5 * scale;
  // Slam drop: down along world up, scaled by slam (0..1).
  const slamDrop = Math.min(1, Math.max(0, slam)) * maxTranslation * scale;
  set3(out.translation, 0, 0, 0);
  addScaled3(out.translation, worldRightVec, -heelSway);
  addScaled3(out.translation, worldUpVec, -slamDrop);
  out.extraPitch = Math.min(1, Math.max(0, slam)) * maxPitch * scale;
  return out;
}
