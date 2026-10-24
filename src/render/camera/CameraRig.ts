/**
 * CameraRig (H.4) — the thin three.js driver for the pure camera model.
 *
 * Wraps a `THREE.PerspectiveCamera` and applies a `CameraPose` produced by
 * `src/game/camera`. This is the ONLY camera code that imports three.js; the
 * model stays engine-agnostic and headlessly testable.
 *
 * ## Conventions
 *
 * The pose's quaternion is expressed in the three.js camera convention (looks
 * down local -Z, +Y up, +X right), so it is applied verbatim to the camera.
 * `pose.position` is world metres; `pose.fov` is the VERTICAL field of view in
 * radians (three expects degrees, so we convert); `pose.near`/`pose.far` set the
 * clip planes.
 *
 * ## Clip planes
 *
 * The model sets `far = 20000` m, which clears both the 8000 m sky dome
 * (`src/render/sky/SkyDome.ts`) and the 12000 m cloud dome
 * (`src/render/weather/CloudRenderer.ts`), and `near = 0.1` m for a
 * cockpit-close helm view. The rig honours whatever the pose carries.
 *
 * Headless-testable: `new THREE.PerspectiveCamera()` constructs fine under
 * vitest's `node` environment (no WebGL context needed), matching how the
 * existing `src/render/post` tests build cameras.
 */

import * as THREE from 'three/webgpu';
import type { CameraPose } from '@game/camera';

const RAD_TO_DEG = 180 / Math.PI;

export interface CameraRigOptions {
  /** Initial aspect ratio (width / height). Default 16/9. */
  aspect?: number;
}

export class CameraRig {
  /** The three.js camera. Pass this to the renderer / post chain. */
  readonly camera: THREE.PerspectiveCamera;

  constructor(opts: CameraRigOptions = {}) {
    const aspect = opts.aspect ?? 16 / 9;
    // Fov/near/far are placeholders overwritten on the first applyPose.
    this.camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 20000);
  }

  /**
   * Apply a pose to the camera. Position and quaternion are set directly; fov
   * (converted radians→degrees) and the clip planes update the projection.
   *
   * The quaternion is authoritative — we set it directly rather than using
   * `lookAt`, so the pose's roll (horizon-lock) is preserved. three's
   * `matrixAutoUpdate` (on by default) recomputes the world matrix from
   * position/quaternion before the next render.
   *
   * Only calls `updateProjectionMatrix` when a projection parameter actually
   * changed, to avoid needless matrix recomputes on static frames.
   */
  applyPose(pose: CameraPose): void {
    this.camera.position.set(pose.position.x, pose.position.y, pose.position.z);
    this.camera.quaternion.set(
      pose.quaternion.x,
      pose.quaternion.y,
      pose.quaternion.z,
      pose.quaternion.w,
    );

    const fovDeg = pose.fov * RAD_TO_DEG;
    let projectionDirty = false;
    if (this.camera.fov !== fovDeg) {
      this.camera.fov = fovDeg;
      projectionDirty = true;
    }
    if (this.camera.near !== pose.near) {
      this.camera.near = pose.near;
      projectionDirty = true;
    }
    if (this.camera.far !== pose.far) {
      this.camera.far = pose.far;
      projectionDirty = true;
    }
    if (projectionDirty) {
      this.camera.updateProjectionMatrix();
    }
  }

  /** Update the aspect ratio on a viewport resize. */
  resize(aspect: number): void {
    if (this.camera.aspect !== aspect) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
  }
}
