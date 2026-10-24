/**
 * First-principles tests for the pure HUD navigation maths.
 *
 * These assert the sailing definitions directly (not against the implementation),
 * e.g. a boat on 045° with wind from 000° sailing at 5 kt makes 5·cos45° upwind
 * VMG. Angles are radians internally; the test literals name their degrees.
 */

import { describe, it, expect } from 'vitest';
import {
  apparentWindAngle,
  bearingTo,
  computeVmg,
  distanceTo,
  laylineBearings,
  optimalUpwindTwa,
  pointOfSail,
  targetSpeedFraction,
  windAngleOffBow,
} from '@game/hud/navMath';
import { UNITS } from '@/types/units';

const DEG = Math.PI / 180;
const KN = UNITS.KNOTS_TO_MS;

describe('windAngleOffBow', () => {
  it('is zero when the wind is from dead ahead', () => {
    expect(windAngleOffBow(90 * DEG, 90 * DEG)).toBeCloseTo(0, 12);
  });

  it('is positive (starboard) when the wind is from the starboard bow', () => {
    // Heading 000, wind from 045 → wind over the starboard bow.
    expect(windAngleOffBow(0, 45 * DEG)).toBeCloseTo(45 * DEG, 12);
  });

  it('is negative (port) when the wind is from the port bow', () => {
    // Heading 000, wind from 315 → wind over the port bow.
    expect(windAngleOffBow(0, 315 * DEG)).toBeCloseTo(-45 * DEG, 12);
  });

  it('is ±π when the wind is from dead astern', () => {
    expect(Math.abs(windAngleOffBow(0, 180 * DEG))).toBeCloseTo(Math.PI, 12);
  });
});

describe('computeVmg', () => {
  it('boat heading 045 with wind from 000 at 5 kt gives upwind VMG = 5·cos45', () => {
    const sog = 5 * KN;
    const vmg = computeVmg(sog, 45 * DEG, 0);
    expect(vmg.upwind).toBeCloseTo(sog * Math.cos(45 * DEG), 12);
    // Downwind is the negation.
    expect(vmg.downwind).toBeCloseTo(-vmg.upwind, 12);
  });

  it('is symmetric across tacks (045 and 315 give equal upwind VMG)', () => {
    const sog = 5 * KN;
    const stbd = computeVmg(sog, 45 * DEG, 0).upwind;
    const port = computeVmg(sog, 315 * DEG, 0).upwind;
    expect(port).toBeCloseTo(stbd, 12);
  });

  it('sailing dead downwind gives negative upwind VMG = full downwind', () => {
    const sog = 6 * KN;
    // Wind from 000, sailing towards 180 (running dead downwind).
    const vmg = computeVmg(sog, 180 * DEG, 0);
    expect(vmg.upwind).toBeCloseTo(-sog, 12);
    expect(vmg.downwind).toBeCloseTo(sog, 12);
  });

  it('beam reaching gives zero VMG along the wind axis', () => {
    const sog = 6 * KN;
    // Wind from 000, sailing towards 090 (beam reach).
    const vmg = computeVmg(sog, 90 * DEG, 0);
    expect(vmg.upwind).toBeCloseTo(0, 12);
  });
});

describe('apparentWindAngle', () => {
  it('head-to-wind: apparent speed = true + boat, angle 0', () => {
    const r = apparentWindAngle(10, 0, 4);
    expect(r.speed).toBeCloseTo(14, 12);
    expect(r.angle).toBeCloseTo(0, 12);
  });

  it('dead downwind: apparent speed = true − boat, angle ±π', () => {
    const r = apparentWindAngle(10, Math.PI, 4);
    expect(r.speed).toBeCloseTo(6, 12);
    expect(Math.abs(r.angle)).toBeCloseTo(Math.PI, 12);
  });

  it('boat motion draws the apparent wind FORWARD of the true wind', () => {
    // True wind on the starboard beam (90°), boat moving forward.
    const twa = 90 * DEG;
    const r = apparentWindAngle(8, twa, 5);
    // Apparent angle magnitude is smaller than the true angle (drawn forward).
    expect(Math.abs(r.angle)).toBeLessThan(twa);
    // Still on the same (starboard) side.
    expect(r.angle).toBeGreaterThan(0);
  });

  it('is symmetric: port and starboard mirror to equal magnitudes', () => {
    const s = apparentWindAngle(8, 70 * DEG, 5);
    const p = apparentWindAngle(8, -70 * DEG, 5);
    expect(p.speed).toBeCloseTo(s.speed, 12);
    expect(p.angle).toBeCloseTo(-s.angle, 12);
  });
});

describe('targetSpeedFraction', () => {
  const polar = (_tws: number, _twa: number) => 5; // flat 5 m/s target

  it('is SOG / target', () => {
    expect(targetSpeedFraction(4, 10, 45 * DEG, polar)).toBeCloseTo(0.8, 12);
  });

  it('is 0 when the target is non-positive', () => {
    expect(targetSpeedFraction(4, 10, 5 * DEG, () => 0)).toBe(0);
  });

  it('can exceed 1 (surfing) — not clamped', () => {
    expect(targetSpeedFraction(6, 10, 90 * DEG, polar)).toBeCloseTo(1.2, 12);
  });

  it('uses the absolute wind angle (symmetric polar)', () => {
    let seen = NaN;
    targetSpeedFraction(4, 10, -45 * DEG, (_tws, twa) => {
      seen = twa;
      return 5;
    });
    expect(seen).toBeCloseTo(45 * DEG, 12);
  });
});

describe('laylineBearings', () => {
  it('are symmetric about the wind by the tack angle', () => {
    const wind = 0;
    const tack = 42 * DEG;
    const lay = laylineBearings(wind, tack);
    // starboard tack heads to the right of the wind, port to the left.
    expect(lay.starboard).toBeCloseTo(42 * DEG, 12);
    // 360 − 42 = 318°.
    expect(lay.port).toBeCloseTo(318 * DEG, 12);
  });

  it('wraps across north correctly', () => {
    const lay = laylineBearings(10 * DEG, 42 * DEG);
    expect(lay.starboard).toBeCloseTo(52 * DEG, 12);
    // 10 − 42 = −32 → 328°.
    expect(lay.port).toBeCloseTo(328 * DEG, 12);
  });
});

describe('optimalUpwindTwa', () => {
  it('finds the angle that maximises V·cos(TWA)', () => {
    // A synthetic polar peaking in upwind VMG near 40°.
    const target = (_tws: number, twa: number): number => {
      // Boat speed rises with angle; VMG = v·cos(twa) peaks around 40°.
      const deg = (twa * 180) / Math.PI;
      return 2 + deg * 0.08;
    };
    const twa = optimalUpwindTwa(12, target);
    const deg = (twa * 180) / Math.PI;
    expect(deg).toBeGreaterThan(30);
    expect(deg).toBeLessThan(55);
  });
});

describe('pointOfSail', () => {
  it('classifies the band boundaries', () => {
    expect(pointOfSail(5 * DEG)).toBe('head-to-wind');
    expect(pointOfSail(40 * DEG)).toBe('close-hauled');
    expect(pointOfSail(70 * DEG)).toBe('close-reach');
    expect(pointOfSail(90 * DEG)).toBe('beam-reach');
    expect(pointOfSail(130 * DEG)).toBe('broad-reach');
    expect(pointOfSail(175 * DEG)).toBe('running');
  });

  it('is sign-independent (port and starboard classify the same)', () => {
    expect(pointOfSail(-90 * DEG)).toBe('beam-reach');
  });
});

describe('bearingTo / distanceTo (venue-local x east, y south)', () => {
  it('a mark due east is bearing 090', () => {
    expect(bearingTo({ x: 0, y: 0 }, { x: 100, y: 0 })).toBeCloseTo(90 * DEG, 12);
  });

  it('a mark due south (−y is north, so +y is south) is bearing 180', () => {
    expect(bearingTo({ x: 0, y: 0 }, { x: 0, y: 100 })).toBeCloseTo(180 * DEG, 12);
  });

  it('a mark due north is bearing 000', () => {
    expect(bearingTo({ x: 0, y: 0 }, { x: 0, y: -100 })).toBeCloseTo(0, 12);
  });

  it('distance is Euclidean', () => {
    expect(distanceTo({ x: 0, y: 0 }, { x: 300, y: 400 })).toBeCloseTo(500, 12);
  });
});
