import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@/types';
import { rotateVec3 } from '@core/math/quat';
import { bearingToDirection } from '@core/math/vec';
import {
  applyViewRoll,
  dampVec3,
  lookRotationZNeg,
} from '@game/camera/cameraMath';

const CAMERA_FORWARD_LOCAL: Vec3 = { x: 0, y: 0, z: -1 };
const CAMERA_UP_LOCAL: Vec3 = { x: 0, y: 1, z: 0 };
const CAMERA_RIGHT_LOCAL: Vec3 = { x: 1, y: 0, z: 0 };

/** Apply a quaternion to a local axis and return the world vector. */
function worldAxis(q: { x: number; y: number; z: number; w: number }, local: Vec3): Vec3 {
  return rotateVec3(q, local, { x: 0, y: 0, z: 0 });
}

describe('lookRotationZNeg — the -Z forward convention', () => {
  it('maps local -Z to the requested world forward direction', () => {
    // Look due east (+X).
    const q = lookRotationZNeg({ x: 1, y: 0, z: 0 });
    const f = worldAxis(q, CAMERA_FORWARD_LOCAL);
    expect(f.x).toBeCloseTo(1, 6);
    expect(f.y).toBeCloseTo(0, 6);
    expect(f.z).toBeCloseTo(0, 6);
  });

  it('keeps world up for a horizontal look (no unintended roll)', () => {
    const q = lookRotationZNeg({ x: 0, y: 0, z: -1 }); // look north.
    const up = worldAxis(q, CAMERA_UP_LOCAL);
    expect(up.x).toBeCloseTo(0, 6);
    expect(up.y).toBeCloseTo(1, 6);
    expect(up.z).toBeCloseTo(0, 6);
  });

  it('produces a right-handed basis: local +X points to screen-right', () => {
    // Looking north (-Z), right should be east (+X) in a right-handed frame
    // where up is +Y: right = forward × up for -Z forward → +X.
    const q = lookRotationZNeg({ x: 0, y: 0, z: -1 });
    const right = worldAxis(q, CAMERA_RIGHT_LOCAL);
    expect(right.x).toBeCloseTo(1, 6);
    expect(right.y).toBeCloseTo(0, 6);
    expect(right.z).toBeCloseTo(0, 6);
  });

  it('a camera at the stern looking forward along the heading has the bow ahead in view', () => {
    // Boat heading 40° (bearing). Bow direction is bearingToDirection(40°).
    const heading = (40 * Math.PI) / 180;
    const bow = bearingToDirection(heading);
    // Camera sits at the stern, looks toward the bow.
    const q = lookRotationZNeg(bow);
    const viewDir = worldAxis(q, CAMERA_FORWARD_LOCAL);
    // The view direction must coincide with the bow direction (bow ahead).
    expect(viewDir.x).toBeCloseTo(bow.x, 6);
    expect(viewDir.y).toBeCloseTo(bow.y, 6);
    expect(viewDir.z).toBeCloseTo(bow.z, 6);
    // And the dot with the bow direction is +1 (not -1, which would be the bow
    // behind the camera — the classic flipped-forward bug).
    const dot = viewDir.x * bow.x + viewDir.y * bow.y + viewDir.z * bow.z;
    expect(dot).toBeCloseTo(1, 6);
  });

  it('produces a unit quaternion', () => {
    const q = lookRotationZNeg({ x: 0.3, y: -0.5, z: 0.8 });
    const n = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    expect(n).toBeCloseTo(1, 6);
  });

  it('is robust to a degenerate (zero) forward', () => {
    const q = lookRotationZNeg({ x: 0, y: 0, z: 0 });
    expect(Number.isFinite(q.x)).toBe(true);
    expect(Number.isFinite(q.w)).toBe(true);
  });

  it('handles a straight-down look without NaN (forward parallel to up)', () => {
    const q = lookRotationZNeg({ x: 0, y: -1, z: 0 });
    const f = worldAxis(q, CAMERA_FORWARD_LOCAL);
    expect(f.y).toBeCloseTo(-1, 5);
    expect(Number.isFinite(q.w)).toBe(true);
  });
});

describe('applyViewRoll', () => {
  it('rolls about the view axis so a level camera tilts by the roll angle', () => {
    const q = lookRotationZNeg({ x: 0, y: 0, z: -1 }); // look north, level.
    const roll = (30 * Math.PI) / 180;
    const rolled = applyViewRoll(q, roll);
    // The forward axis is unchanged by a roll about itself.
    const f = worldAxis(rolled, CAMERA_FORWARD_LOCAL);
    expect(f.z).toBeCloseTo(-1, 5);
    // The up axis tilts: rolling about the view axis (-Z) by +roll rotates the
    // local up vector into world as (sin roll, cos roll, 0). This sign is the
    // layer's convention and the controller feeds it `heel` directly, so at
    // horizon-lock 1 the camera roll equals the heel (see controller tests).
    const up = worldAxis(rolled, CAMERA_UP_LOCAL);
    expect(up.x).toBeCloseTo(Math.sin(roll), 5);
    expect(up.y).toBeCloseTo(Math.cos(roll), 5);
  });

  it('zero roll is identity', () => {
    const q = lookRotationZNeg({ x: 1, y: 0, z: 0 });
    const r = applyViewRoll(q, 0);
    expect(r.x).toBeCloseTo(q.x, 9);
    expect(r.y).toBeCloseTo(q.y, 9);
    expect(r.z).toBeCloseTo(q.z, 9);
    expect(r.w).toBeCloseTo(q.w, 9);
  });
});

describe('dampVec3 — frame-rate independence', () => {
  it('two half-steps equal one full step within tolerance', () => {
    const current: Vec3 = { x: 0, y: 0, z: 0 };
    const target: Vec3 = { x: 10, y: -4, z: 7 };
    const lambda = 3;

    // One full step of dt=0.1.
    const full = dampVec3(current, target, lambda, 0.1, { x: 0, y: 0, z: 0 });

    // Two half-steps of dt=0.05 each.
    let half: Vec3 = { x: 0, y: 0, z: 0 };
    half = dampVec3(current, target, lambda, 0.05, half);
    half = dampVec3(half, target, lambda, 0.05, half);

    expect(half.x).toBeCloseTo(full.x, 9);
    expect(half.y).toBeCloseTo(full.y, 9);
    expect(half.z).toBeCloseTo(full.z, 9);
  });

  it('converges toward the target', () => {
    let v: Vec3 = { x: 0, y: 0, z: 0 };
    const target: Vec3 = { x: 5, y: 5, z: 5 };
    for (let i = 0; i < 100; i++) v = dampVec3(v, target, 5, 1 / 60, v);
    expect(v.x).toBeCloseTo(5, 2);
  });
});
