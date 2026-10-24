/**
 * Camera controller (H.4) — the pure, engine-agnostic brain of the camera.
 *
 * `createCameraController(opts)` returns an object the session drives once per
 * render frame:
 *
 *   const cam = createCameraController({ assist: 'simulation' });
 *   // each frame:
 *   const pose = cam.update(frame, dt);     // CameraPose for the render rig
 *   if (input.cameraCycle) cam.cycle();     // advance helm→chase→…→broadcast
 *   if (input.pausePressed) cam.togglePhoto();
 *   session.paused = cam.paused;            // photo mode pauses the sim
 *
 * No three.js, no DOM. Everything is deterministic in (frame, dt, prior state).
 * All smoothing is frame-rate independent (exponential with dt), so the same
 * motion results at 30 Hz and 120 Hz within tolerance (asserted by tests).
 *
 * Per-instance scratch only — nothing module-scope is shared across instances,
 * so two controllers never alias each other's results.
 */

import type { Quat, Vec3 } from '@/types';
import { copy3, set3, sub3, vec3, length3 } from '@core/math/vec';
import { heelFromQuat, rotateVec3 } from '@core/math/quat';
import { damp } from '@core/math/interpolation';
import {
  applyViewRoll,
  createLookScratch,
  dampVec3,
  lookRotationZNeg,
} from './cameraMath';
import {
  CAMERA_FAR,
  CAMERA_NEAR,
  defaultCameraSettings,
  headMotionScale,
  type CameraSettings,
} from './settings';
import {
  computeHeadMotion,
  createPlacementScratch,
  placeChase,
  placeDrone,
  placeHelm,
  placeMast,
  type HeadMotion,
  type Placement,
  type PlacementScratch,
} from './modes';
import { BroadcastDirector, pickBroadcastSubject } from './broadcast';
import { PhotoCamera, type CaptureRequest, type PhotoFrame } from './photo';
import { CAMERA_MODE_CYCLE, type CameraFrame, type CameraMode, type CameraPose } from './types';

export interface CameraControllerOptions {
  /** Initial mode. Defaults to 'chase'. */
  mode?: CameraMode;
  /** Override any settings fields. */
  settings?: Partial<CameraSettings>;
  /** Aspect ratio (width/height) for broadcast in-frame scoring. Default 16/9. */
  aspect?: number;
}

export interface CameraController {
  readonly mode: CameraMode;
  /** True while photo mode is active — the session pauses the sim on this. */
  readonly paused: boolean;
  /** Mutable settings (horizon lock, reduced roll, per-mode FOV, …). */
  readonly settings: CameraSettings;
  /** The photo-mode sub-controller (lens/exposure/DoF/HUD + capture). */
  readonly photo: PhotoCamera;
  /** Advance one render frame; returns the pose to apply. Reused object. */
  update(frame: CameraFrame, dt: number): CameraPose;
  /** Advance to the next diegetic mode (helm→chase→mast→drone→broadcast→helm). */
  cycle(): void;
  /** Jump to a specific diegetic mode. */
  setMode(mode: CameraMode): void;
  /** Toggle photo mode on/off. Returns the new `paused` state. */
  togglePhoto(): boolean;
  /** Request a photo capture (only meaningful in photo mode). */
  capture(): CaptureRequest;
  /**
   * The reused photo-mode frame buffer. The session may write `move`/`boost`
   * into it before calling `update` to drive free-fly translation (the frozen
   * `InputState` carries only `lookDelta`, so movement is supplied this way).
   */
  getPhotoFrame(): PhotoFrame;
}

export function createCameraController(opts: CameraControllerOptions = {}): CameraController {
  return new CameraControllerImpl(opts);
}

class CameraControllerImpl implements CameraController {
  private _mode: CameraMode;
  private _paused = false;
  readonly settings: CameraSettings;
  readonly photo = new PhotoCamera();
  private readonly aspect: number;

  // Smoothed state (per instance).
  private readonly smoothedEye: Vec3 = vec3();
  private readonly smoothedTarget: Vec3 = vec3();
  private smoothedRoll = 0;
  private initialized = false;

  // Broadcast director (per instance).
  private readonly director = new BroadcastDirector();

  // Scratch (per instance, never shared).
  private readonly placement: Placement = { eye: vec3(), target: vec3() };
  private readonly placeScratch: PlacementScratch = createPlacementScratch();
  private readonly headMotion: HeadMotion = { translation: vec3(), extraPitch: 0 };
  private readonly lookScratch = createLookScratch();
  private readonly subjectScratch: Vec3 = vec3();
  private readonly fwdScratch: Vec3 = vec3();
  private readonly upScratch: Vec3 = vec3();
  private readonly rightScratch: Vec3 = vec3();
  private readonly quatScratch: Quat = { x: 0, y: 0, z: 0, w: 1 };
  private readonly rolledQuat: Quat = { x: 0, y: 0, z: 0, w: 1 };
  private readonly pose: CameraPose = {
    position: vec3(),
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    fov: 1,
    near: CAMERA_NEAR,
    far: CAMERA_FAR,
    roll: 0,
    exposure: 0,
  };

  // Photo-mode frame buffer (reused).
  private readonly photoFrame: PhotoFrame = {
    lookDelta: { x: 0, y: 0 },
    move: { forward: 0, right: 0, up: 0 },
    boost: false,
    dt: 0,
    aspect: 16 / 9,
  };

  constructor(opts: CameraControllerOptions) {
    this._mode = opts.mode ?? 'chase';
    this.aspect = opts.aspect ?? 16 / 9;
    this.settings = { ...defaultCameraSettings(), ...(opts.settings ?? {}) };
  }

  get mode(): CameraMode {
    return this._mode;
  }

  get paused(): boolean {
    return this._paused;
  }

  cycle(): void {
    const i = CAMERA_MODE_CYCLE.indexOf(this._mode);
    const next = CAMERA_MODE_CYCLE[(i + 1) % CAMERA_MODE_CYCLE.length];
    if (next !== undefined) this.setMode(next);
  }

  setMode(mode: CameraMode): void {
    if (mode === this._mode) return;
    this._mode = mode;
    this.initialized = false; // snap to the new placement rather than sweeping across the world.
    if (mode === 'broadcast') this.director.reset();
  }

  togglePhoto(): boolean {
    this._paused = !this._paused;
    if (this._paused) {
      // Seed the free camera from the current smoothed eye + look direction.
      const yaw = Math.atan2(
        this.smoothedTarget.x - this.smoothedEye.x,
        -(this.smoothedTarget.z - this.smoothedEye.z),
      );
      const flat = Math.hypot(
        this.smoothedTarget.x - this.smoothedEye.x,
        this.smoothedTarget.z - this.smoothedEye.z,
      );
      const pitch = Math.atan2(this.smoothedTarget.y - this.smoothedEye.y, flat);
      this.photo.enter(this.smoothedEye, yaw, pitch);
    }
    return this._paused;
  }

  capture(): CaptureRequest {
    return this.photo.capture();
  }

  update(frame: CameraFrame, dt: number): CameraPose {
    if (this._paused) {
      return this.updatePhoto(frame, dt);
    }
    return this.updateDiegetic(frame, dt);
  }

  private updatePhoto(frame: CameraFrame, dt: number): CameraPose {
    // lookDelta comes from the frozen InputState each frame; move/boost are
    // written into the photo frame by the session (see getPhotoFrame) since the
    // frozen InputState carries no free-fly translation axes. dt/aspect are set
    // here so the session never has to.
    this.photoFrame.lookDelta.x = frame.lookDelta.x;
    this.photoFrame.lookDelta.y = frame.lookDelta.y;
    this.photoFrame.dt = dt;
    this.photoFrame.aspect = this.aspect;
    const pose = this.photo.update(this.photoFrame);
    // Consume the look delta so a single delta is not re-applied if the session
    // forgets to clear it; move/boost persist until the session changes them.
    this.photoFrame.lookDelta.x = 0;
    this.photoFrame.lookDelta.y = 0;
    return pose;
  }

  /** Expose the photo frame so the session can drive free-fly movement. */
  getPhotoFrame(): PhotoFrame {
    return this.photoFrame;
  }

  private updateDiegetic(frame: CameraFrame, dt: number): CameraPose {
    const g = frame.geometry;

    // 1. Raw placement for the active mode.
    let rawRoll = 0;
    switch (this._mode) {
      case 'helm':
        placeHelm(frame.boatPosition, frame.boatOrientation, g.eyeOffset, this.placeScratch, this.placement);
        rawRoll = this.computeHorizonRoll(frame);
        this.applyHelmHeadMotion(frame);
        break;
      case 'chase':
        placeChase(frame.boatPosition, frame.boatOrientation, g.loa, g.mastHeight, this.placeScratch, this.placement);
        rawRoll = this.computeHorizonRoll(frame);
        break;
      case 'mast':
        placeMast(frame.boatPosition, frame.boatOrientation, g.mastHeight, this.placeScratch, this.placement);
        rawRoll = this.computeHorizonRoll(frame);
        break;
      case 'drone':
        placeDrone(frame.boatPosition, frame.boatVelocity, g.loa, frame.time, this.placement);
        rawRoll = this.computeHorizonRoll(frame) * 0.3; // drones barely roll.
        break;
      case 'broadcast':
        this.placeBroadcast(frame);
        rawRoll = 0; // broadcast always keeps a level horizon.
        break;
    }

    // 2. Smooth the eye/target/roll (frame-rate independent). Snap on first
    //    frame or immediately after a mode switch.
    if (!this.initialized) {
      copy3(this.smoothedEye, this.placement.eye);
      copy3(this.smoothedTarget, this.placement.target);
      this.smoothedRoll = rawRoll;
      this.initialized = true;
    } else {
      const sm = this.settings.smoothing;
      // Helm is rigidly attached to the head (no positional smoothing); follow
      // modes smooth so the arm trails.
      if (this._mode === 'helm') {
        copy3(this.smoothedEye, this.placement.eye);
        copy3(this.smoothedTarget, this.placement.target);
      } else {
        dampVec3(this.smoothedEye, this.placement.eye, sm.position, dt, this.smoothedEye);
        dampVec3(this.smoothedTarget, this.placement.target, sm.target, dt, this.smoothedTarget);
      }
      this.smoothedRoll = damp(this.smoothedRoll, rawRoll, sm.roll, dt);
    }

    // 3. Build the pose. Forward = target − eye.
    sub3(this.smoothedTarget, this.smoothedEye, this.fwdScratch);
    if (length3(this.fwdScratch) < 1e-6) {
      // Degenerate (eye == target): look north.
      set3(this.fwdScratch, 0, 0, -1);
    }
    lookRotationZNeg(this.fwdScratch, { x: 0, y: 1, z: 0 }, this.quatScratch, this.lookScratch);
    applyViewRoll(this.quatScratch, this.smoothedRoll, this.rolledQuat);

    copy3(this.pose.position, this.smoothedEye);
    this.pose.quaternion.x = this.rolledQuat.x;
    this.pose.quaternion.y = this.rolledQuat.y;
    this.pose.quaternion.z = this.rolledQuat.z;
    this.pose.quaternion.w = this.rolledQuat.w;
    this.pose.fov = this.settings.modeFov[this._mode];
    this.pose.near = CAMERA_NEAR;
    this.pose.far = CAMERA_FAR;
    this.pose.roll = this.smoothedRoll;
    this.pose.exposure = 0;
    delete this.pose.dof;
    return this.pose;
  }

  /** Target camera roll from horizon-lock: fraction of boat heel. */
  private computeHorizonRoll(frame: CameraFrame): number {
    // Prefer the explicit heel from the frame; fall back to extracting it from
    // the orientation if the caller left it at zero but the boat is heeled.
    const heel = frame.heel !== 0 ? frame.heel : heelFromQuat(frame.boatOrientation);
    return heel * this.settings.horizonLock;
  }

  /** Add helm head motion (heel sway + slam kick) to the placement, bounded. */
  private applyHelmHeadMotion(frame: CameraFrame): void {
    const scale = headMotionScale(this.settings);
    if (scale === 0) return;
    // World up / right from the boat orientation.
    rotateVec3(frame.boatOrientation, { x: 0, y: 1, z: 0 }, this.upScratch);
    rotateVec3(frame.boatOrientation, { x: 1, y: 0, z: 0 }, this.rightScratch);
    const caps = this.settings.headMotion;
    computeHeadMotion(
      frame.heel,
      frame.slam,
      this.upScratch,
      this.rightScratch,
      caps.maxTranslation,
      caps.maxPitch,
      scale,
      this.headMotion,
    );
    // Apply translation to both eye and target so the view direction is kept,
    // plus the extra pitch nudges the target down.
    this.placement.eye.x += this.headMotion.translation.x;
    this.placement.eye.y += this.headMotion.translation.y;
    this.placement.eye.z += this.headMotion.translation.z;
    this.placement.target.x += this.headMotion.translation.x;
    this.placement.target.y += this.headMotion.translation.y;
    this.placement.target.z += this.headMotion.translation.z;
    // Extra pitch: drop the target a little (look down on a slam).
    this.placement.target.y -= this.headMotion.extraPitch * 10;
  }

  /** Resolve the broadcast placement for this frame via the director. */
  private placeBroadcast(frame: CameraFrame): void {
    const subject = pickBroadcastSubject(
      frame.boatPosition,
      frame.marks,
      frame.otherBoats,
      this.subjectScratch,
    );
    const sol = this.director.solve({
      boatPosition: frame.boatPosition,
      boatHeading: frame.heading,
      subject,
      time: frame.time,
      loa: frame.geometry.loa,
      ...(frame.sunDirection ? { sunDirection: frame.sunDirection } : {}),
      ...(frame.isLand ? { isLand: frame.isLand } : {}),
      fov: this.settings.modeFov.broadcast,
      aspect: this.aspect,
    });
    copy3(this.placement.eye, sol.position);
    copy3(this.placement.target, sol.target);
  }
}
