/**
 * Pure camera models (H.4) — barrel.
 *
 * No three.js, no DOM. The render layer (`src/render/camera/`) consumes the
 * `CameraPose` these produce. The session drives `createCameraController`.
 */

export { createCameraController } from './controller';
export type { CameraController, CameraControllerOptions } from './controller';
export {
  CAMERA_MODE_CYCLE,
  type BoatCameraGeometry,
  type CameraDoF,
  type CameraFrame,
  type CameraMode,
  type CameraPose,
} from './types';
export {
  CAMERA_FAR,
  CAMERA_NEAR,
  DEFAULT_MODE_FOV,
  defaultCameraSettings,
  headMotionScale,
  type CameraSettings,
  type HeadMotionCaps,
  type SmoothingRates,
} from './settings';
export {
  apertureToBokeh,
  focalLengthToFov,
  PhotoCamera,
  PHOTO_DEFAULTS,
  SENSOR_HALF_HEIGHT_MM,
  type CaptureRequest,
  type PhotoFrame,
} from './photo';
export {
  BroadcastDirector,
  BROADCAST_HYSTERESIS_MARGIN,
  BROADCAST_MIN_DWELL,
  generateBroadcastCandidates,
  pickBroadcastSubject,
  scoreBroadcastCandidate,
  type BroadcastCandidate,
  type BroadcastInputs,
  type BroadcastSolution,
} from './broadcast';
export {
  applyViewRoll,
  dampVec3,
  lookRotationZNeg,
} from './cameraMath';
