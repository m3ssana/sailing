/**
 * Tests for the already-written math module. These validate the critical
 * behaviours that downstream physics and weather code depend on.
 */

import { describe, it, expect } from 'vitest';
import {
  circularLerp,
  angleDelta,
  catmullRomAngle,
  sampleCurve,
  createRandom,
  bearingToDirection,
  directionToBearing,
  windVector,
  integrateOrientation,
  quat,
  normalizeQ,
} from '@core/math';

const DEG = Math.PI / 180;

describe('circularLerp', () => {
  it('crosses north correctly: 350° → 10° at t=0.5 gives 0°', () => {
    const result = circularLerp(350 * DEG, 10 * DEG, 0.5);
    // Should be 0° (or equivalently 360°), NOT 180°
    const degrees = (result / DEG + 360) % 360;
    expect(degrees).toBeCloseTo(0, 4);
  });

  it('does not take the long way around for nearby angles crossing 0', () => {
    // 355° → 5° should go through 0°, not through 180°
    const mid = circularLerp(355 * DEG, 5 * DEG, 0.5);
    const midDeg = (mid / DEG + 360) % 360;
    expect(midDeg).toBeCloseTo(0, 4);
  });

  it('returns the start at t=0 and end at t=1', () => {
    const start = 45 * DEG;
    const end = 90 * DEG;
    expect(circularLerp(start, end, 0)).toBeCloseTo(start, 10);
    expect(circularLerp(start, end, 1)).toBeCloseTo(end, 10);
  });
});

describe('angleDelta', () => {
  it('positive when b is clockwise of a', () => {
    // From 10° to 20°: clockwise by 10°
    expect(angleDelta(10 * DEG, 20 * DEG)).toBeCloseTo(10 * DEG, 10);
  });

  it('negative when b is counter-clockwise of a', () => {
    // From 20° to 10°: counter-clockwise by 10°
    expect(angleDelta(20 * DEG, 10 * DEG)).toBeCloseTo(-10 * DEG, 10);
  });

  it('crosses north with correct sign: 350° to 10° is +20°', () => {
    expect(angleDelta(350 * DEG, 10 * DEG)).toBeCloseTo(20 * DEG, 10);
  });

  it('crosses north with correct sign: 10° to 350° is -20°', () => {
    expect(angleDelta(10 * DEG, 350 * DEG)).toBeCloseTo(-20 * DEG, 10);
  });

  it('opposite directions give ±π', () => {
    const delta = angleDelta(0, Math.PI);
    expect(Math.abs(delta)).toBeCloseTo(Math.PI, 10);
  });
});

describe('catmullRomAngle', () => {
  it('crosses north smoothly', () => {
    // Control points straddling north: 340°, 350°, 10°, 20°
    const p0 = 340 * DEG;
    const p1 = 350 * DEG;
    const p2 = 10 * DEG;
    const p3 = 20 * DEG;

    const mid = catmullRomAngle(p0, p1, p2, p3, 0.5);
    const midDeg = (mid / DEG + 360) % 360;
    // Should be near 0° (between 350° and 10°)
    expect(midDeg).toBeCloseTo(0, 0); // within 1°
  });

  it('returns p1 at t=0', () => {
    const result = catmullRomAngle(40 * DEG, 50 * DEG, 60 * DEG, 70 * DEG, 0);
    expect(result).toBeCloseTo(50 * DEG, 6);
  });

  it('returns p2 at t=1', () => {
    const result = catmullRomAngle(40 * DEG, 50 * DEG, 60 * DEG, 70 * DEG, 1);
    expect(result).toBeCloseTo(60 * DEG, 6);
  });
});

describe('createRandom (seeded)', () => {
  it('produces identical sequences from the same seed', () => {
    const a = createRandom(12345);
    const b = createRandom(12345);
    for (let i = 0; i < 100; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it('produces different sequences from different seeds', () => {
    const a = createRandom(1);
    const b = createRandom(2);
    let sameCount = 0;
    for (let i = 0; i < 50; i++) {
      if (a.next() === b.next()) sameCount++;
    }
    // Statistically impossible for them to be identical
    expect(sameCount).toBeLessThan(5);
  });

  it('values are in [0, 1)', () => {
    const rng = createRandom(42);
    for (let i = 0; i < 1000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('fork produces independent streams', () => {
    const rng = createRandom(100);
    const fork1 = rng.fork('wind');
    const fork2 = rng.fork('wave');
    // Forked streams should differ from each other
    let same = 0;
    for (let i = 0; i < 50; i++) {
      if (fork1.next() === fork2.next()) same++;
    }
    expect(same).toBeLessThan(5);
  });
});

describe('integrateOrientation', () => {
  it('maintains unit norm over 100k steps with no NaN', () => {
    let q = quat(0, 0, 0, 1);
    // Persistent angular velocity: spinning at ~1 rad/s about all axes
    const omega = { x: 0.7, y: 1.2, z: -0.9 };
    const dt = 1 / 120; // 120 Hz

    for (let i = 0; i < 100_000; i++) {
      q = integrateOrientation(q, omega, dt, q);
    }

    // Should never go NaN
    expect(Number.isFinite(q.x)).toBe(true);
    expect(Number.isFinite(q.y)).toBe(true);
    expect(Number.isFinite(q.z)).toBe(true);
    expect(Number.isFinite(q.w)).toBe(true);

    // Norm should remain 1
    const norm = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    expect(norm).toBeCloseTo(1, 6);
  });

  it('does not change orientation with zero angular velocity', () => {
    const initial = normalizeQ(quat(0.1, 0.2, 0.3, 0.9));
    const result = integrateOrientation(initial, { x: 0, y: 0, z: 0 }, 0.1);
    expect(result.x).toBeCloseTo(initial.x, 10);
    expect(result.y).toBeCloseTo(initial.y, 10);
    expect(result.z).toBeCloseTo(initial.z, 10);
    expect(result.w).toBeCloseTo(initial.w, 10);
  });
});

describe('bearingToDirection / directionToBearing round-trip', () => {
  it('round-trips through representative bearings', () => {
    const bearings = [0, 45, 90, 135, 180, 225, 270, 315, 359];
    for (const deg of bearings) {
      const rad = deg * DEG;
      const dir = bearingToDirection(rad);
      const recovered = directionToBearing(dir);
      // Compare as degrees for clearer error messages
      const recoveredDeg = (recovered / DEG + 360) % 360;
      expect(recoveredDeg).toBeCloseTo(deg, 4);
    }
  });

  it('north (0°) maps to (0, 0, -1)', () => {
    const dir = bearingToDirection(0);
    expect(dir.x).toBeCloseTo(0, 10);
    expect(dir.y).toBe(0);
    expect(dir.z).toBeCloseTo(-1, 10);
  });

  it('east (90°) maps to (1, 0, 0)', () => {
    const dir = bearingToDirection(90 * DEG);
    expect(dir.x).toBeCloseTo(1, 10);
    expect(dir.y).toBe(0);
    expect(dir.z).toBeCloseTo(0, 10);
  });
});

describe('windVector', () => {
  it('points OPPOSITE the meteorological from-direction', () => {
    // Wind from the north (0°) should produce a vector pointing south.
    // In world space south is +Z direction (from convention: +Z is south).
    const v = windVector(0, 10);
    // Air moves towards south: (0, 0, +10)
    expect(v.x).toBeCloseTo(0, 10);
    expect(v.y).toBe(0);
    expect(v.z).toBeCloseTo(10, 10);
  });

  it('wind from west (270°) blows towards east (+x)', () => {
    const v = windVector(270 * DEG, 5);
    // sin(270°) = -1, cos(270°) = 0
    // windVector: x = -sin(dir)*speed = -(-1)*5 = 5, z = cos(dir)*speed = 0
    expect(v.x).toBeCloseTo(5, 6);
    expect(v.z).toBeCloseTo(0, 6);
  });

  it('magnitude equals the speed parameter', () => {
    const v = windVector(45 * DEG, 12);
    const mag = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    expect(mag).toBeCloseTo(12, 6);
  });
});

describe('sampleCurve', () => {
  const curve = [
    { x: 0, y: 0 },
    { x: 1, y: 10 },
    { x: 2, y: 20 },
    { x: 3, y: 15 },
  ];

  it('clamps at the low end', () => {
    expect(sampleCurve(curve, -1)).toBe(0);
    expect(sampleCurve(curve, -100)).toBe(0);
  });

  it('clamps at the high end', () => {
    expect(sampleCurve(curve, 4)).toBe(15);
    expect(sampleCurve(curve, 100)).toBe(15);
  });

  it('returns exact values at control points', () => {
    expect(sampleCurve(curve, 0)).toBe(0);
    expect(sampleCurve(curve, 1)).toBe(10);
    expect(sampleCurve(curve, 2)).toBe(20);
    expect(sampleCurve(curve, 3)).toBe(15);
  });

  it('interpolates linearly between points', () => {
    expect(sampleCurve(curve, 0.5)).toBeCloseTo(5, 10);
    expect(sampleCurve(curve, 2.5)).toBeCloseTo(17.5, 10);
  });

  it('returns 0 for an empty curve', () => {
    expect(sampleCurve([], 5)).toBe(0);
  });

  it('returns the single value for a one-point curve', () => {
    expect(sampleCurve([{ x: 5, y: 42 }], 0)).toBe(42);
    expect(sampleCurve([{ x: 5, y: 42 }], 10)).toBe(42);
  });
});
