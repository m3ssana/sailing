import { describe, expect, it } from 'vitest';
import { rotateVec3 } from '@core/math/quat';
import {
  apertureToBokeh,
  focalLengthToFov,
  PhotoCamera,
  PHOTO_DEFAULTS,
  SENSOR_HALF_HEIGHT_MM,
} from '@game/camera/photo';
import { defaultCameraSettings, headMotionScale, DEFAULT_MODE_FOV } from '@game/camera/settings';

describe('focalLengthToFov (24 mm sensor height)', () => {
  it('uses the thin-lens relation fov = 2·atan(12/f)', () => {
    expect(SENSOR_HALF_HEIGHT_MM).toBe(12);
    const f = 50;
    expect(focalLengthToFov(f)).toBeCloseTo(2 * Math.atan(12 / f), 12);
  });

  it('50 mm is a long-ish lens, 12 mm is ~90° wide', () => {
    const fov50 = focalLengthToFov(50);
    const fov12 = focalLengthToFov(12);
    expect((fov50 * 180) / Math.PI).toBeCloseTo(27.0, 0);
    expect((fov12 * 180) / Math.PI).toBeCloseTo(90.0, 0);
  });

  it('longer focal length → narrower FOV (monotonic)', () => {
    let prev = Infinity;
    for (const f of [12, 24, 35, 50, 85, 200]) {
      const fov = focalLengthToFov(f);
      expect(fov).toBeLessThan(prev);
      prev = fov;
    }
  });

  it('is finite for a zero / tiny focal length', () => {
    expect(Number.isFinite(focalLengthToFov(0))).toBe(true);
  });
});

describe('apertureToBokeh', () => {
  it('wider aperture (smaller f-number) → larger bokeh', () => {
    expect(apertureToBokeh(1.4)).toBeGreaterThan(apertureToBokeh(8));
  });
  it('is clamped to a sane range', () => {
    expect(apertureToBokeh(0.1)).toBeLessThanOrEqual(6);
    expect(apertureToBokeh(1000)).toBeGreaterThanOrEqual(0.1);
  });
});

describe('PhotoCamera', () => {
  it('fov tracks focal length', () => {
    const cam = new PhotoCamera();
    cam.enter({ x: 0, y: 2, z: 0 }, 0, 0);
    cam.focalLengthMm = 24;
    const pose = cam.update({
      lookDelta: { x: 0, y: 0 },
      move: { forward: 0, right: 0, up: 0 },
      boost: false,
      dt: 0.016,
      aspect: 16 / 9,
    });
    expect(pose.fov).toBeCloseTo(focalLengthToFov(24), 9);
  });

  it('exposure stops flow through to the pose', () => {
    const cam = new PhotoCamera();
    cam.enter({ x: 0, y: 2, z: 0 }, 0, 0);
    cam.exposure = 1.5;
    const pose = cam.update({
      lookDelta: { x: 0, y: 0 },
      move: { forward: 0, right: 0, up: 0 },
      boost: false,
      dt: 0.016,
      aspect: 16 / 9,
    });
    expect(pose.exposure).toBe(1.5);
  });

  it('DoF maps focus distance + aperture into the pose', () => {
    const cam = new PhotoCamera();
    cam.enter({ x: 0, y: 2, z: 0 }, 0, 0);
    cam.focusDistance = 12;
    cam.aperture = 2;
    const pose = cam.update({
      lookDelta: { x: 0, y: 0 },
      move: { forward: 0, right: 0, up: 0 },
      boost: false,
      dt: 0.016,
      aspect: 16 / 9,
    });
    expect(pose.dof).toBeDefined();
    expect(pose.dof?.focusDistance).toBe(12);
    expect(pose.dof?.bokehScale).toBeCloseTo(apertureToBokeh(2), 9);
  });

  it('look delta yaws the view; forward move translates along the view', () => {
    const cam = new PhotoCamera();
    cam.enter({ x: 0, y: 2, z: 0 }, 0, 0); // yaw 0 = looking north (-Z).
    // Yaw 90° to the right (east).
    const pose = cam.update({
      lookDelta: { x: Math.PI / 2, y: 0 },
      move: { forward: 1, right: 0, up: 0 },
      boost: false,
      dt: 1,
      aspect: 16 / 9,
    });
    // After yawing east and moving forward 1s at base speed (8 m/s), the camera
    // should have moved +X (east).
    expect(pose.position.x).toBeGreaterThan(5);
    // View direction (local -Z rotated) should point roughly +X.
    const f = rotateVec3(pose.quaternion, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 0 });
    expect(f.x).toBeGreaterThan(0.9);
  });

  it('pitch is clamped shy of vertical (no gimbal flip)', () => {
    const cam = new PhotoCamera();
    cam.enter({ x: 0, y: 2, z: 0 }, 0, 0);
    // Push a huge downward pitch.
    const pose = cam.update({
      lookDelta: { x: 0, y: 10 },
      move: { forward: 0, right: 0, up: 0 },
      boost: false,
      dt: 1,
      aspect: 16 / 9,
    });
    const f = rotateVec3(pose.quaternion, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 0 });
    // Looking almost straight down but not exactly (clamped at 89°).
    expect(f.y).toBeLessThan(-0.99);
    expect(f.y).toBeGreaterThan(-1.0000001);
  });

  it('capture returns a reproducible request with an incrementing id', () => {
    const cam = new PhotoCamera();
    cam.enter({ x: 1, y: 2, z: 3 }, 0, 0);
    cam.hideHud = true;
    cam.update({
      lookDelta: { x: 0, y: 0 },
      move: { forward: 0, right: 0, up: 0 },
      boost: false,
      dt: 0.016,
      aspect: 16 / 9,
    });
    const r1 = cam.capture();
    const r2 = cam.capture();
    expect(r1.id).toBe(1);
    expect(r2.id).toBe(2);
    expect(r1.hideHud).toBe(true);
    expect(r1.pose.position.x).toBeCloseTo(1, 6);
    // The captured pose is a clone: mutating the camera afterward must not change it.
    const snapshotX = r1.pose.position.x;
    cam.update({
      lookDelta: { x: 0, y: 0 },
      move: { forward: 1, right: 0, up: 0 },
      boost: false,
      dt: 1,
      aspect: 16 / 9,
    });
    expect(r1.pose.position.x).toBe(snapshotX);
  });

  it('PHOTO_DEFAULTS are sane', () => {
    expect(PHOTO_DEFAULTS.focalLengthMm).toBeGreaterThan(0);
    expect(PHOTO_DEFAULTS.aperture).toBeGreaterThan(0);
  });
});

describe('camera settings', () => {
  it('has a per-mode FOV for every mode', () => {
    for (const mode of ['helm', 'chase', 'mast', 'drone', 'broadcast'] as const) {
      expect(DEFAULT_MODE_FOV[mode]).toBeGreaterThan(0);
    }
  });

  it('defaults to a mostly-level horizon (lock 0.35, a UX choice) and normal head motion', () => {
    const s = defaultCameraSettings();
    // horizonLock is the fraction of boat roll the camera follows (0 = level horizon, 1 = rolls
    // fully with the boat; see settings.ts). The default was lowered 1 -> 0.35 after the first
    // real-browser run (cramped, tilting view); the 0..1 mapping itself is covered by the
    // controller tests, so this only pins the shipped default.
    expect(s.horizonLock).toBe(0.35);
    expect(s.reducedRoll).toBe(false);
    expect(headMotionScale(s)).toBe(1);
  });

  it('reduced-roll halves head motion; reduced-motion-zero zeroes it', () => {
    const s = defaultCameraSettings();
    s.reducedRoll = true;
    expect(headMotionScale(s)).toBe(0.5);
    s.reducedMotionZero = true;
    expect(headMotionScale(s)).toBe(0);
  });
});
