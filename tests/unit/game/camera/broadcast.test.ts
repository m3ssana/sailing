import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@/types';
import {
  BroadcastDirector,
  BROADCAST_MIN_DWELL,
  generateBroadcastCandidates,
  pickBroadcastSubject,
  scoreBroadcastCandidate,
  type BroadcastInputs,
} from '@game/camera/broadcast';

function baseInputs(over: Partial<BroadcastInputs> = {}): BroadcastInputs {
  return {
    boatPosition: { x: 0, y: 0, z: 0 },
    boatHeading: 0,
    subject: { x: 100, y: 0, z: 0 },
    time: 0,
    loa: 4,
    fov: (38 * Math.PI) / 180,
    aspect: 16 / 9,
    ...over,
  };
}

describe('pickBroadcastSubject', () => {
  it('prefers the nearest mark', () => {
    const marks: Vec3[] = [
      { x: 50, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
    ];
    const s = pickBroadcastSubject({ x: 0, y: 0, z: 0 }, marks, []);
    expect(s?.x).toBe(10);
  });

  it('falls back to nearest other boat when no marks', () => {
    const boats: Vec3[] = [{ x: 0, y: 0, z: 20 }];
    const s = pickBroadcastSubject({ x: 0, y: 0, z: 0 }, [], boats);
    expect(s?.z).toBe(20);
  });

  it('returns null when nothing to frame', () => {
    expect(pickBroadcastSubject({ x: 0, y: 0, z: 0 }, [], [])).toBeNull();
  });
});

describe('broadcast candidate scoring', () => {
  it('generates a deterministic candidate set from the same inputs', () => {
    const a = generateBroadcastCandidates(baseInputs());
    const b = generateBroadcastCandidates(baseInputs());
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]?.position.x).toBeCloseTo(b[i]?.position.x ?? NaN, 12);
      expect(a[i]?.position.z).toBeCloseTo(b[i]?.position.z ?? NaN, 12);
    }
  });

  it('scores a well-framed candidate above one that loses the boat', () => {
    // No distant subject: just frame the boat nicely.
    const inputs = baseInputs({ subject: null });
    const good = {
      id: 0,
      position: { x: 0, y: 12, z: -40 },
      target: { x: 0, y: 0, z: 0 },
    };
    // A candidate looking away from the boat (boat falls outside the cone).
    const bad = {
      id: 1,
      position: { x: 0, y: 12, z: -40 },
      target: { x: 0, y: 0, z: -1000 },
    };
    expect(scoreBroadcastCandidate(good, inputs)).toBeGreaterThan(
      scoreBroadcastCandidate(bad, inputs),
    );
  });

  it('penalises pointing straight at the sun', () => {
    const sun: Vec3 = { x: 0, y: 0.2, z: -1 };
    const inputs = baseInputs({ sunDirection: sun, subject: null });
    const camPos: Vec3 = { x: 0, y: 10, z: 60 };
    // Into the sun: target far north so forward ≈ sun direction.
    const intoSun = { id: 0, position: camPos, target: { x: 0, y: 12, z: -500 } };
    // Away from the sun: look south.
    const awaySun = { id: 1, position: { x: 0, y: 10, z: -60 }, target: { x: 0, y: 0, z: 0 } };
    expect(scoreBroadcastCandidate(awaySun, inputs)).toBeGreaterThan(
      scoreBroadcastCandidate(intoSun, inputs),
    );
  });

  it('penalises a camera standing over land when isLand is given', () => {
    const inputs = baseInputs({
      subject: null,
      isLand: (x) => x < -10, // west of -10 is land.
    });
    const overWater = { id: 0, position: { x: 30, y: 12, z: 0 }, target: { x: 0, y: 0, z: 0 } };
    const overLand = { id: 1, position: { x: -30, y: 12, z: 0 }, target: { x: 0, y: 0, z: 0 } };
    expect(scoreBroadcastCandidate(overWater, inputs)).toBeGreaterThan(
      scoreBroadcastCandidate(overLand, inputs),
    );
  });
});

describe('BroadcastDirector — hysteresis & no flicker', () => {
  it('is deterministic: same frame sequence → same picks', () => {
    const d1 = new BroadcastDirector();
    const d2 = new BroadcastDirector();
    const ids1: number[] = [];
    const ids2: number[] = [];
    for (let t = 0; t < 30; t += 0.5) {
      ids1.push(d1.solve(baseInputs({ time: t })).candidateId);
      ids2.push(d2.solve(baseInputs({ time: t })).candidateId);
    }
    expect(ids1).toEqual(ids2);
  });

  it('holds a shot for at least the minimum dwell (no flicker)', () => {
    const d = new BroadcastDirector();
    // Jitter the boat slightly each frame so scores wobble near a boundary.
    let picks = 0;
    let lastId = -1;
    let lastCutTime = 0;
    const cutTimes: number[] = [];
    for (let i = 0; i < 400; i++) {
      const t = i * 0.05; // 20 Hz for 20 s.
      const jitter = Math.sin(i * 0.7) * 0.5;
      const sol = d.solve(
        baseInputs({
          time: t,
          boatPosition: { x: jitter, y: 0, z: jitter },
          subject: { x: 100 + jitter, y: 0, z: 0 },
        }),
      );
      if (sol.candidateId !== lastId) {
        if (lastId !== -1) {
          cutTimes.push(t - lastCutTime);
        }
        lastCutTime = t;
        lastId = sol.candidateId;
        picks++;
      }
    }
    // Every cut after the first must respect the dwell gate.
    for (const gap of cutTimes) {
      expect(gap).toBeGreaterThanOrEqual(BROADCAST_MIN_DWELL - 1e-9);
    }
    // And the sequence must not thrash (far fewer cuts than frames).
    expect(picks).toBeLessThan(10);
  });

  it('takes a shot immediately on the first frame', () => {
    const d = new BroadcastDirector();
    const sol = d.solve(baseInputs());
    expect(sol.candidateId).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(sol.position.x)).toBe(true);
  });

  it('always keeps the player boat in frame (boat never lost)', () => {
    const d = new BroadcastDirector();
    for (let t = 0; t < 60; t += 1) {
      const inputs = baseInputs({ time: t });
      const sol = d.solve(inputs);
      // Forward from eye to target, then boat must be within the cone.
      const fx = sol.target.x - sol.position.x;
      const fy = sol.target.y - sol.position.y;
      const fz = sol.target.z - sol.position.z;
      const fl = Math.hypot(fx, fy, fz);
      const bx = inputs.boatPosition.x - sol.position.x;
      const by = inputs.boatPosition.y - sol.position.y;
      const bz = inputs.boatPosition.z - sol.position.z;
      const bl = Math.hypot(bx, by, bz);
      const cos = (fx * bx + fy * by + fz * bz) / (fl * bl);
      const halfCone = Math.max(inputs.fov * 0.5, inputs.fov * 0.5 * inputs.aspect);
      expect(cos).toBeGreaterThan(Math.cos(halfCone));
    }
  });
});
