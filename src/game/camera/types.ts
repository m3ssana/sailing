/**
 * Camera-model types local to the pure (no-three, no-DOM) camera layer — H.4.
 *
 * These are NOT part of the frozen `src/types/` surface. The camera model only
 * consumes frozen types (`Vec2`, `Vec3`, `Quat`, `Radians`, …) and produces a
 * plain-data `CameraPose` the render layer (`src/render/camera/CameraRig.ts`)
 * applies to a `THREE.PerspectiveCamera`.
 *
 * ## Conventions (non-negotiable — see .kiro/steering/sailing-conventions.md)
 *
 * - SI units, radians everywhere internally.
 * - World space is Y-up, right-handed, +X east, +Z **south**; bearing θ maps to
 *   the horizontal direction `(sin θ, 0, -cos θ)`.
 * - A camera looks down its own local **-Z** axis (the three.js convention), has
 *   local +Y up and local +X right. Every pose this layer emits is expressed so
 *   that applying the quaternion to `(0,0,-1)` yields the world-space view
 *   direction. The render layer applies the quaternion verbatim.
 * - `roll` on a pose is the signed camera roll about its view axis, positive
 *   when the camera rolls to starboard (matching `heelFromQuat`). The quaternion
 *   already includes the roll; `roll` is reported for diagnostics and tests.
 */

import type { Quat, Radians, Vec2, Vec3 } from '@/types';

/** The five diegetic camera modes (requirement 5.6). */
export type CameraMode = 'helm' | 'chase' | 'mast' | 'drone' | 'broadcast';

/** Ordered cycle used by the `cameraCycle` input (requirement 5.6, 7.16). */
export const CAMERA_MODE_CYCLE: readonly CameraMode[] = [
  'helm',
  'chase',
  'mast',
  'drone',
  'broadcast',
] as const;

/**
 * Everything one frame needs to place every camera. Plain data; the session
 * layer fills this from the interpolated player `BoatState`, the boat spec and
 * the environment each frame. All vectors are world-space SI metres unless
 * noted; `out`-style reuse is the caller's concern (this is read-only input).
 */
export interface CameraFrame {
  /** Player boat centre-of-mass position, world metres. */
  boatPosition: Vec3;
  /** Player boat orientation (same convention as `BoatState.orientation`). */
  boatOrientation: Quat;
  /** Player boat world linear velocity, m/s. Drives drone/broadcast lead + blur. */
  boatVelocity: Vec3;
  /** Heel angle, radians, positive to starboard (as `BoatState.heel`). */
  heel: Radians;
  /** Pitch angle, radians, positive bow-up (as `BoatState.pitch`). */
  pitch: Radians;
  /** Compass heading of the bow, radians clockwise from north (`BoatState.heading`). */
  heading: Radians;
  /**
   * Slam intensity 0..1 — how hard the hull just dropped into a wave this frame.
   * Drives the helm-cam head-slam kick. The session derives it (e.g. from the
   * boat's recent vertical acceleration); the camera only reads it.
   */
  slam: number;
  /** Boat geometry the camera needs, from the `BoatSpec`/`BoatDefinition`. */
  geometry: BoatCameraGeometry;
  /** Session time, seconds. Used for broadcast dwell timing + drone orbit phase. */
  time: number;
  /** Camera look delta this frame, radians (from `InputState.lookDelta`). */
  lookDelta: Vec2;
  /** Next mark position(s) to frame, world metres. Empty when none. */
  marks: readonly Vec3[];
  /** Other (non-player) boat positions, world metres. Empty when none. */
  otherBoats: readonly Vec3[];
  /**
   * Optional world-space direction FROM the scene TOWARDS the sun (unit-ish).
   * When present, broadcast framing penalises shots that point into the sun.
   */
  sunDirection?: Vec3;
  /**
   * Optional land test: returns true when the given world point is over land /
   * terrain (used by broadcast to avoid water-level shots occluded by shore).
   */
  isLand?: (x: number, z: number) => boolean;
}

/** Boat geometry the camera consumes. All hull-local metres. */
export interface BoatCameraGeometry {
  /** Mast height above the boat origin, metres (drives mast-cam + chase height). */
  mastHeight: number;
  /** Length overall, metres (scales chase distance + drone radius). */
  loa: number;
  /**
   * Helm eye offset in hull-local metres: where the sailor's head sits relative
   * to the boat origin (x starboard, y up, z forward is **-Z**, matching the
   * boat forward axis). Typically slightly aft and to windward of centre.
   */
  eyeOffset: Vec3;
}

/**
 * A fully-resolved camera placement for one frame. Plain data consumed by the
 * render layer. `quaternion` already encodes any roll; `roll` is the signed
 * roll reported for tests/diagnostics.
 */
export interface CameraPose {
  position: Vec3;
  quaternion: Quat;
  /** Vertical field of view, radians. */
  fov: Radians;
  near: number;
  far: number;
  /** Signed camera roll about the view axis, radians (diagnostic). */
  roll: Radians;
  /** Tone-mapping exposure in stops (0 = neutral). Photo mode varies this. */
  exposure: number;
  /** Depth-of-field request, only present in photo mode. */
  dof?: CameraDoF;
}

/** Depth-of-field parameters mapped to `PostChain`'s `DoFConfig`. */
export interface CameraDoF {
  /** Focus distance, metres. */
  focusDistance: number;
  /** Lens focal length, millimetres (also sets the FOV). */
  focalLength: number;
  /** Bokeh scale derived from aperture (larger = more blur). */
  bokehScale: number;
}
