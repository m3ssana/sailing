/**
 * Render-side camera layer (H.4) — barrel.
 *
 * The three.js driver for the pure camera model. Only this layer imports three.
 */

export { CameraRig, type CameraRigOptions } from './CameraRig';
export {
  capturePhoto,
  type BlobCapableCanvas,
  type CapturePhotoOptions,
} from './PhotoCapture';
