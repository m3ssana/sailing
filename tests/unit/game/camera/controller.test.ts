import { describe, expect, it } from 'vitest';
import type { Quat, Vec3 } from '@/types';
import { fromYawPitchRoll, rotateVec3 } from '@core/math/quat';
import { createCameraController } from '@game/camera/controller';
import type { CameraFrame } from '@game/camera/types';
import { CAMERA_FAR } from '@game/camera/settings';

const GEOM = { mastHeight: 6, loa: 4.2, eyeOffset: { x: 0.2, y: 1.0, z: -0.5 } as Vec3 };

function frame(over: Partial<CameraFrame> = {}): CameraFrame {
  return {
    boatPosition: { x: 0, y: 0, z: 0 },
    boatOrientation: { x: 0, y: 0, z: 0, w: 1 },
    boatVelocity: { x: 0, y: 0, z: 0 },
    heel: 0,
    pitch: 0,
    heading: 0,
    slam: 0,
    geometry: GEOM,
    time: 0,
    lookDelta: { x: 0, y: 0 },
    marks: [],
    otherBoats: [],
    ...over,
  };
}

/** Measure camera roll from a pose quaternion: the tilt of the local up axis. */
function measureRoll(q: Quat): number {
  const up = rotateVec3(q, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 });
  // Roll about the view axis shows as up.x = sin(roll) when looking level.
  return Math.atan2(up.x, up.y);
}

/** Orientation for a given heel (roll) at zero yaw/pitch. */
function heeledOrientation(heel: number): Quat {
  return fromYawPitchRoll(0, 0, heel, { x: 0, y: 0, z: 0, w: 1 });
}

describe('mode cycling', () => {
  it('cycles helm → chase → mast → drone → broadcast → helm', () => {
    const cam = createCameraController({ mode: 'helm' });
    const seen = [cam.mode];
    for (let i = 0; i < 5; i++) {
      cam.cycle();
      seen.push(cam.mode);
    }
    expect(seen).toEqual(['helm', 'chase', 'mast', 'drone', 'broadcast', 'helm']);
  });

  it('setMode jumps directly', () => {
    const cam = createCameraController();
    cam.setMode('drone');
    expect(cam.mode).toBe('drone');
  });
});

describe('pose basics', () => {
  it('far plane clears the 8000 m sky dome + 12000 m cloud dome', () => {
    const cam = createCameraController({ mode: 'chase' });
    const pose = cam.update(frame(), 1 / 60);
    expect(pose.far).toBe(CAMERA_FAR);
    expect(pose.far).toBeGreaterThanOrEqual(12000);
  });

  it('every mode produces a finite, unit-quaternion pose', () => {
    for (const mode of ['helm', 'chase', 'mast', 'drone', 'broadcast'] as const) {
      const cam = createCameraController({ mode });
      const pose = cam.update(frame({ marks: [{ x: 100, y: 0, z: 0 }] }), 1 / 60);
      const n = Math.hypot(
        pose.quaternion.x,
        pose.quaternion.y,
        pose.quaternion.z,
        pose.quaternion.w,
      );
      expect(n).toBeCloseTo(1, 5);
      expect(Number.isFinite(pose.position.x)).toBe(true);
      expect(pose.fov).toBeGreaterThan(0);
    }
  });

  it('helm eye is at the sailor position and looks forward (bow ahead)', () => {
    const cam = createCameraController({ mode: 'helm' });
    const heading = (30 * Math.PI) / 180;
    const ori = fromYawPitchRoll(heading, 0, 0, { x: 0, y: 0, z: 0, w: 1 });
    const pose = cam.update(frame({ heading, boatOrientation: ori }), 1 / 60);
    // The boat's true forward is the orientation applied to local -Z (the bow).
    // The camera view direction must coincide with it (bow ahead, not behind).
    const bow = rotateVec3(ori, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 0 });
    const view = rotateVec3(pose.quaternion, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 0 });
    const dot = view.x * bow.x + view.y * bow.y + view.z * bow.z;
    expect(dot).toBeGreaterThan(0.99);
  });

  it('chase sits behind and above the boat', () => {
    const cam = createCameraController({ mode: 'chase' });
    const pose = cam.update(frame({ heading: 0 }), 1 / 60);
    // Heading 0 = bow toward -Z, so behind is +Z and the eye is above water.
    expect(pose.position.z).toBeGreaterThan(0);
    expect(pose.position.y).toBeGreaterThan(0);
  });
});

describe('horizon lock', () => {
  it('lock = 0 keeps the horizon level even at 30° heel', () => {
    const cam = createCameraController({ mode: 'chase', settings: { horizonLock: 0 } });
    const heel = (30 * Math.PI) / 180;
    const ori = heeledOrientation(heel);
    // Snap (first frame) then let it settle.
    let pose = cam.update(frame({ heel, boatOrientation: ori }), 1 / 60);
    for (let i = 0; i < 120; i++) pose = cam.update(frame({ heel, boatOrientation: ori }), 1 / 60);
    expect(Math.abs(pose.roll)).toBeLessThan(1e-6);
    expect(Math.abs(measureRoll(pose.quaternion))).toBeLessThan(1e-3);
  });

  it('lock = 1 rolls fully with the boat (camera roll == heel)', () => {
    const cam = createCameraController({ mode: 'chase', settings: { horizonLock: 1 } });
    const heel = (30 * Math.PI) / 180;
    const ori = heeledOrientation(heel);
    let pose = cam.update(frame({ heel, boatOrientation: ori }), 1 / 60);
    for (let i = 0; i < 300; i++) pose = cam.update(frame({ heel, boatOrientation: ori }), 1 / 60);
    expect(pose.roll).toBeCloseTo(heel, 4);
  });

  it('RMS camera roll over a rolling sequence decreases monotonically as lock decreases', () => {
    const locks = [1, 0.75, 0.5, 0.25, 0];
    const rms: number[] = [];
    for (const lock of locks) {
      const cam = createCameraController({ mode: 'chase', settings: { horizonLock: lock } });
      let sumSq = 0;
      let n = 0;
      for (let i = 0; i < 600; i++) {
        const t = i / 60;
        // Synthetic rolling sea: ±25° heel oscillation.
        const heel = (25 * Math.PI) / 180 * Math.sin(t * 1.2);
        const ori = heeledOrientation(heel);
        const pose = cam.update(frame({ time: t, heel, boatOrientation: ori }), 1 / 60);
        if (i > 120) {
          // skip the initial settle
          sumSq += pose.roll * pose.roll;
          n++;
        }
      }
      rms.push(Math.sqrt(sumSq / n));
    }
    // Monotonic non-increasing as lock drops 1 → 0.
    for (let i = 1; i < rms.length; i++) {
      const prev = rms[i - 1] ?? 0;
      const cur = rms[i] ?? 0;
      expect(cur).toBeLessThan(prev);
    }
    // lock 0 is essentially level.
    expect(rms[rms.length - 1]).toBeLessThan(1e-3);
  });
});

describe('spring smoothing is frame-rate independent', () => {
  it('chase converges to the same place at 30 Hz and 120 Hz', () => {
    const settle = (hz: number): Vec3 => {
      const cam = createCameraController({ mode: 'chase' });
      const dt = 1 / hz;
      // Start the boat offset, then jump it to a fixed pose and let the arm settle.
      cam.update(frame({ boatPosition: { x: 0, y: 0, z: 0 } }), dt); // snap
      let pose = cam.update(frame({ boatPosition: { x: 50, y: 0, z: 30 } }), dt);
      const seconds = 3;
      const steps = Math.round(seconds * hz);
      for (let i = 0; i < steps; i++) {
        pose = cam.update(frame({ boatPosition: { x: 50, y: 0, z: 30 } }), dt);
      }
      return { ...pose.position };
    };
    const a = settle(30);
    const b = settle(120);
    expect(a.x).toBeCloseTo(b.x, 2);
    expect(a.y).toBeCloseTo(b.y, 2);
    expect(a.z).toBeCloseTo(b.z, 2);
  });
});

describe('helm head motion', () => {
  it('heel + slam produce a bounded head-motion offset', () => {
    const heel = (25 * Math.PI) / 180;
    const ori = heeledOrientation(heel);
    // Isolate HEAD MOTION by holding the boat pose fixed and varying only slam
    // (eye-offset rotation is identical in both, so it cancels in the delta).
    const noSlam = createCameraController({ mode: 'helm' });
    const withSlam = createCameraController({ mode: 'helm' });
    const p0 = noSlam.update(frame({ heel, slam: 0, boatOrientation: ori }), 1 / 60);
    const p1 = withSlam.update(frame({ heel, slam: 1, boatOrientation: ori }), 1 / 60);
    const mag = Math.hypot(
      p1.position.x - p0.position.x,
      p1.position.y - p0.position.y,
      p1.position.z - p0.position.z,
    );
    // Non-zero (slam kicks the head) but bounded by the configured caps
    // (maxTranslation 0.12 m); well under 0.2 m.
    expect(mag).toBeGreaterThan(0);
    expect(mag).toBeLessThan(0.2);
  });

  it('reduced-motion-zero removes head motion entirely', () => {
    const heel = (25 * Math.PI) / 180;
    const ori = heeledOrientation(heel);
    const cam = createCameraController({
      mode: 'helm',
      settings: { reducedRoll: true, reducedMotionZero: true },
    });
    const noSlam = cam.update(frame({ heel, slam: 0, boatOrientation: ori }), 1 / 60);
    const cam2 = createCameraController({
      mode: 'helm',
      settings: { reducedRoll: true, reducedMotionZero: true },
    });
    const bigSlam = cam2.update(frame({ heel, slam: 1, boatOrientation: ori }), 1 / 60);
    // With motion zeroed, slam does not move the eye.
    expect(noSlam.position.x).toBeCloseTo(bigSlam.position.x, 9);
    expect(noSlam.position.y).toBeCloseTo(bigSlam.position.y, 9);
  });
});

describe('photo mode pause', () => {
  it('toggles the paused flag the session reads', () => {
    const cam = createCameraController({ mode: 'chase' });
    expect(cam.paused).toBe(false);
    // Settle the diegetic camera first so photo entry has a seed.
    cam.update(frame(), 1 / 60);
    expect(cam.togglePhoto()).toBe(true);
    expect(cam.paused).toBe(true);
    expect(cam.togglePhoto()).toBe(false);
    expect(cam.paused).toBe(false);
  });

  it('in photo mode, the controller drives the free-fly camera + DoF', () => {
    const cam = createCameraController({ mode: 'chase' });
    cam.update(frame(), 1 / 60);
    cam.togglePhoto();
    cam.photo.focalLengthMm = 24;
    cam.photo.aperture = 2;
    const pose = cam.update(frame({ lookDelta: { x: 0, y: 0 } }), 1 / 60);
    expect(pose.dof).toBeDefined();
    expect(pose.fov).toBeGreaterThan(0);
  });

  it('two controllers do not alias each other (per-instance scratch)', () => {
    const a = createCameraController({ mode: 'drone' });
    const b = createCameraController({ mode: 'drone' });
    const pa = a.update(frame({ boatPosition: { x: 100, y: 0, z: 0 }, time: 5 }), 1 / 60);
    const pb = b.update(frame({ boatPosition: { x: -100, y: 0, z: 0 }, time: 5 }), 1 / 60);
    expect(pa.position.x).not.toBeCloseTo(pb.position.x, 0);
  });
});
