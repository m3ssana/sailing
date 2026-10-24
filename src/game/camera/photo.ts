/**
 * Photo mode (H.4) — pure model.
 *
 * Pauses the sim (the session reads `paused`), flies a free camera driven by the
 * look delta and move axes, and exposes cinematic controls: exposure (stops),
 * focal length (mm), depth of field (focus distance + aperture) and a hidden-HUD
 * flag. It produces the same `CameraPose` shape the diegetic modes do, plus a
 * `capture()` that returns a request object; the actual canvas snapshot is the
 * DOM layer's job (`src/render/camera/PhotoCapture.ts`).
 *
 * No three.js, no DOM.
 *
 * ## Focal length → vertical FOV
 *
 * For a sensor 24 mm tall (full-frame height), the vertical field of view is
 *   fov = 2 · atan( (24/2) / f ) = 2 · atan( 12 / f ).
 * So 50 mm → ~27°, 24 mm → ~53°, 12 mm → ~90°. This is the standard thin-lens
 * relation; `SENSOR_HALF_HEIGHT_MM = 12`.
 *
 * ## Camera axes
 *
 * Same -Z forward convention as the rest of the camera layer. `lookDelta.x`
 * yaws (about world +Y), `lookDelta.y` pitches (about the camera's local right
 * axis); pitch is clamped just shy of ±90° to avoid gimbal flip. Move axes are
 * in camera-local space: forward/back along view, right/left strafe, up/down
 * along world +Y.
 */

import type { Quat, Vec3 } from '@/types';
import { clamp } from '@core/math/interpolation';
import {
  addScaled3,
  copy3,
  normalize3,
  set3,
  vec3,
} from '@core/math/vec';
import { CAMERA_FAR, CAMERA_NEAR } from './settings';
import { createLookScratch, lookRotationZNeg } from './cameraMath';
import type { CameraDoF, CameraPose } from './types';

/** Half the full-frame sensor height, mm. */
export const SENSOR_HALF_HEIGHT_MM = 12;

/** Convert a lens focal length (mm) to a vertical FOV (radians). */
export function focalLengthToFov(focalLengthMm: number): number {
  const f = Math.max(1e-3, focalLengthMm);
  return 2 * Math.atan(SENSOR_HALF_HEIGHT_MM / f);
}

/** Photo-mode movement speeds. */
const MOVE_SPEED = 8; // m/s base fly speed.
const BOOST = 4; // boost multiplier.
const PITCH_LIMIT = (89 * Math.PI) / 180;

/** Default photo-mode lens/exposure. */
export const PHOTO_DEFAULTS = {
  focalLengthMm: 35,
  exposure: 0,
  focusDistance: 15,
  /** Aperture f-number; lower = shallower depth of field = bigger bokeh. */
  aperture: 4,
  hideHud: false,
} as const;

/** Per-frame inputs to the photo-mode camera. */
export interface PhotoFrame {
  /** Look delta this frame, radians (yaw in x, pitch in y). */
  lookDelta: { x: number; y: number };
  /** Movement axes, each -1..1: forward(+)/back(-), right(+)/left(-), up(+)/down(-). */
  move: { forward: number; right: number; up: number };
  /** True while the boost modifier is held. */
  boost: boolean;
  /** Frame delta, seconds. */
  dt: number;
  aspect: number;
}

/** A capture request handed to the DOM layer. Plain data. */
export interface CaptureRequest {
  /** Monotonic request id so the DOM layer can de-duplicate. */
  id: number;
  /** Whether the HUD should be hidden in the captured frame. */
  hideHud: boolean;
  /** The pose at capture time (so a capture is reproducible). */
  pose: CameraPose;
}

/**
 * Map an aperture f-number to a `CameraDoF.bokehScale`. Wider aperture (smaller
 * f-number) → larger bokeh. Normalised so f/4 ≈ 1.0, clamped to a sane range.
 */
export function apertureToBokeh(aperture: number): number {
  const a = Math.max(0.7, aperture);
  return clamp(4 / a, 0.1, 6);
}

/**
 * Free-fly photo camera. One instance per controller; holds its own pose and
 * scratch, mutated in place each frame (allocation-free steady state).
 */
export class PhotoCamera {
  private readonly position: Vec3 = vec3();
  private yaw = 0;
  private pitch = 0;

  focalLengthMm: number = PHOTO_DEFAULTS.focalLengthMm;
  exposure: number = PHOTO_DEFAULTS.exposure;
  focusDistance: number = PHOTO_DEFAULTS.focusDistance;
  aperture: number = PHOTO_DEFAULTS.aperture;
  hideHud: boolean = PHOTO_DEFAULTS.hideHud;

  private captureCounter = 0;

  // Scratch — per instance, never shared.
  private readonly scratchForward: Vec3 = vec3();
  private readonly scratchRight: Vec3 = vec3();
  private readonly scratchQuat: Quat = { x: 0, y: 0, z: 0, w: 1 };
  private readonly lookScratch = createLookScratch();
  private readonly pose: CameraPose = {
    position: vec3(),
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    fov: focalLengthToFov(PHOTO_DEFAULTS.focalLengthMm),
    near: CAMERA_NEAR,
    far: CAMERA_FAR,
    roll: 0,
    exposure: 0,
  };

  /**
   * Seed the free camera from the diegetic camera's last pose + heading so entry
   * into photo mode does not jump. `heading` is the look yaw (radians, bearing).
   */
  enter(position: Vec3, yaw: number, pitch: number): void {
    copy3(this.position, position);
    this.yaw = yaw;
    this.pitch = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /** Advance the free camera and return its pose (reused object). */
  update(frame: PhotoFrame): CameraPose {
    this.yaw += frame.lookDelta.x;
    this.pitch = clamp(this.pitch - frame.lookDelta.y, -PITCH_LIMIT, PITCH_LIMIT);

    // Forward from yaw/pitch (yaw is a compass bearing: (sin,-,-cos)).
    const cp = Math.cos(this.pitch);
    set3(
      this.scratchForward,
      Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * cp,
    );
    normalize3(this.scratchForward, this.scratchForward);

    // Right = forward × worldUp, on the ground plane.
    set3(this.scratchRight, this.scratchForward.z, 0, -this.scratchForward.x);
    normalize3(this.scratchRight, this.scratchRight);

    const speed = MOVE_SPEED * (frame.boost ? BOOST : 1) * frame.dt;
    addScaled3(this.position, this.scratchForward, frame.move.forward * speed);
    addScaled3(this.position, this.scratchRight, frame.move.right * speed);
    this.position.y += frame.move.up * speed;

    const q = lookRotationZNeg(
      this.scratchForward,
      { x: 0, y: 1, z: 0 },
      this.scratchQuat,
      this.lookScratch,
    );

    copy3(this.pose.position, this.position);
    this.pose.quaternion.x = q.x;
    this.pose.quaternion.y = q.y;
    this.pose.quaternion.z = q.z;
    this.pose.quaternion.w = q.w;
    this.pose.fov = focalLengthToFov(this.focalLengthMm);
    this.pose.roll = 0;
    this.pose.exposure = this.exposure;
    this.pose.dof = this.buildDoF();
    return this.pose;
  }

  /** Current DoF parameters (focus distance + aperture → PostChain DoF). */
  buildDoF(out: CameraDoF = { focusDistance: 0, focalLength: 0, bokehScale: 0 }): CameraDoF {
    out.focusDistance = this.focusDistance;
    out.focalLength = this.focalLengthMm;
    out.bokehScale = apertureToBokeh(this.aperture);
    return out;
  }

  /**
   * Request a capture of the current frame. Returns a plain request; the DOM
   * layer performs the actual `canvas.toBlob`. A fresh pose snapshot is cloned
   * so the request is reproducible even if the camera keeps moving.
   */
  capture(): CaptureRequest {
    this.captureCounter += 1;
    const pose: CameraPose = {
      position: vec3(this.pose.position.x, this.pose.position.y, this.pose.position.z),
      quaternion: { ...this.pose.quaternion },
      fov: this.pose.fov,
      near: this.pose.near,
      far: this.pose.far,
      roll: this.pose.roll,
      exposure: this.pose.exposure,
    };
    if (this.pose.dof) {
      pose.dof = { ...this.pose.dof };
    }
    return {
      id: this.captureCounter,
      hideHud: this.hideHud,
      pose,
    };
  }
}
