/**
 * Camera settings — per-mode defaults and tunables (H.4).
 *
 * Pure data + a merge helper. No three.js, no DOM. All angles radians, all
 * distances SI metres.
 */

import type { CameraMode } from './types';

/** Degrees → radians (local; the frozen `UNITS.DEG_TO_RAD` is display-layer). */
const D2R = Math.PI / 180;

/**
 * Clip-plane distances shared by all diegetic modes.
 *
 * `far` must cover the furthest thing the camera can see. The sky dome radius is
 * 8000 m (`src/render/sky/SkyDome.ts`) and the cloud dome is 12000 m
 * (`src/render/weather/CloudRenderer.ts`), both camera-following, so 20000 m
 * clears them with margin. `near` is small enough for a cockpit-close helm view
 * (the sailor's hands are tens of centimetres away) without crushing depth
 * precision at distance.
 */
export const CAMERA_NEAR = 0.1;
export const CAMERA_FAR = 20000;

/** Per-mode default vertical FOV, radians (requirement 5.6: per-mode FOV). */
export const DEFAULT_MODE_FOV: Readonly<Record<CameraMode, number>> = {
  helm: 68 * D2R, // Wide — immersive cockpit view.
  chase: 55 * D2R, // Moderate — shows the boat and some water.
  mast: 60 * D2R, // Looking down the deck.
  drone: 50 * D2R, // Slightly long — cinematic follow.
  broadcast: 38 * D2R, // Long — TV-style framing of boat + mark.
} as const;

/** Head-motion caps (helm mode). Bounded so motion never becomes nauseating. */
export interface HeadMotionCaps {
  /** Max translation offset from heel/slam, metres. */
  maxTranslation: number;
  /** Max extra pitch from a slam, radians. */
  maxPitch: number;
  /** Max extra roll contribution from heel coupling, radians. */
  maxRoll: number;
}

export const DEFAULT_HEAD_MOTION_CAPS: HeadMotionCaps = {
  maxTranslation: 0.12, // 12 cm — a real sailor's head sway.
  maxPitch: 5 * D2R,
  maxRoll: 4 * D2R,
};

/** Smoothing rates (exponential `lambda`, 1/s). Higher = snappier. */
export interface SmoothingRates {
  /** Chase/drone position follow rate. */
  position: number;
  /** Roll (horizon-lock) follow rate. */
  roll: number;
  /** Look-target follow rate. */
  target: number;
}

export const DEFAULT_SMOOTHING: SmoothingRates = {
  position: 3.5,
  roll: 6,
  target: 5,
};

/**
 * The full mutable camera settings a controller carries. All optional pieces in
 * {@link CameraControllerOptions} resolve into this.
 */
export interface CameraSettings {
  /** Per-mode FOV, radians. */
  modeFov: Record<CameraMode, number>;
  /**
   * Horizon-lock fraction 0..1: how much the camera roll follows the boat heel.
   * 1 = rolls fully with the boat; 0 = level horizon. Applies to all follow
   * modes (helm/chase/mast/drone); broadcast always keeps a level horizon.
   */
  horizonLock: number;
  /**
   * Reduced-roll / reduced-motion option. When true, head-motion offsets are
   * halved (or zeroed, see `reducedMotionZero`) for comfort (requirement 12.3).
   */
  reducedRoll: boolean;
  /** When true (with `reducedRoll`), head motion is zeroed entirely, not halved. */
  reducedMotionZero: boolean;
  headMotion: HeadMotionCaps;
  smoothing: SmoothingRates;
}

export function defaultCameraSettings(): CameraSettings {
  return {
    modeFov: { ...DEFAULT_MODE_FOV },
    horizonLock: 1,
    reducedRoll: false,
    reducedMotionZero: false,
    headMotion: { ...DEFAULT_HEAD_MOTION_CAPS },
    smoothing: { ...DEFAULT_SMOOTHING },
  };
}

/**
 * Effective head-motion scale given the reduced-roll settings:
 * 1 normally, 0.5 when reducedRoll, 0 when reducedRoll + reducedMotionZero.
 */
export function headMotionScale(settings: CameraSettings): number {
  if (!settings.reducedRoll) return 1;
  return settings.reducedMotionZero ? 0 : 0.5;
}
