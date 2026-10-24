import { describe, expect, it } from 'vitest';
import { createCameraController } from '@game/camera';
import type { CameraFrame, CameraPose } from '@game/camera';
import { CameraRig } from './CameraRig';

function pose(over: Partial<CameraPose> = {}): CameraPose {
  return {
    position: { x: 1, y: 2, z: 3 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 },
    fov: (55 * Math.PI) / 180,
    near: 0.1,
    far: 20000,
    roll: 0,
    exposure: 0,
    ...over,
  };
}

describe('CameraRig', () => {
  it('constructs a PerspectiveCamera headlessly (vitest node, no WebGL)', () => {
    const rig = new CameraRig();
    expect(rig.camera).toBeDefined();
    expect(rig.camera.aspect).toBeCloseTo(16 / 9, 6);
  });

  it('applies position and quaternion from a pose', () => {
    const rig = new CameraRig();
    rig.applyPose(pose({ position: { x: 5, y: 6, z: 7 }, quaternion: { x: 0.1, y: 0.2, z: 0.3, w: 0.927 } }));
    expect(rig.camera.position.x).toBe(5);
    expect(rig.camera.position.y).toBe(6);
    expect(rig.camera.position.z).toBe(7);
    expect(rig.camera.quaternion.x).toBeCloseTo(0.1, 6);
    expect(rig.camera.quaternion.w).toBeCloseTo(0.927, 6);
  });

  it('converts the pose FOV (radians) to three.js degrees', () => {
    const rig = new CameraRig();
    rig.applyPose(pose({ fov: (60 * Math.PI) / 180 }));
    expect(rig.camera.fov).toBeCloseTo(60, 4);
  });

  it('sets clip planes so far covers the sky + cloud domes', () => {
    const rig = new CameraRig();
    rig.applyPose(pose({ near: 0.1, far: 20000 }));
    expect(rig.camera.near).toBe(0.1);
    expect(rig.camera.far).toBe(20000);
    expect(rig.camera.far).toBeGreaterThanOrEqual(12000);
  });

  it('resize updates the aspect ratio', () => {
    const rig = new CameraRig();
    rig.resize(21 / 9);
    expect(rig.camera.aspect).toBeCloseTo(21 / 9, 6);
  });

  it('drives from the pure controller end-to-end', () => {
    const cam = createCameraController({ mode: 'chase' });
    const rig = new CameraRig();
    const frame: CameraFrame = {
      boatPosition: { x: 10, y: 0, z: -5 },
      boatOrientation: { x: 0, y: 0, z: 0, w: 1 },
      boatVelocity: { x: 0, y: 0, z: 0 },
      heel: 0,
      pitch: 0,
      heading: 0,
      slam: 0,
      geometry: { mastHeight: 6, loa: 4.2, eyeOffset: { x: 0, y: 1, z: -0.5 } },
      time: 0,
      lookDelta: { x: 0, y: 0 },
      marks: [],
      otherBoats: [],
    };
    const p = cam.update(frame, 1 / 60);
    rig.applyPose(p);
    expect(Number.isFinite(rig.camera.position.x)).toBe(true);
    expect(rig.camera.fov).toBeGreaterThan(0);
  });
});
