/**
 * Tests for Rain.ts (F.2) — rain params, surface disturbance, lens droplets,
 * and TSL node/system builds.
 */

import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@/types';
import type * as THREE from 'three/webgpu';
import {
  DEFAULT_RAIN_BUDGET,
  terminalFallSpeed,
  rainParams,
  rainSurfaceDisturbance,
  LensDropletState,
  rainRippleNormalNode,
  lensDropletMaskNode,
  createRainSystem,
} from '@render/weather/Rain';
import { float, vec2 } from 'three/tsl';

const CALM: Vec3 = { x: 0, y: 0, z: 0 };

describe('terminalFallSpeed', () => {
  it('is 0 at 0 and within the physical 3–9 m/s band otherwise', () => {
    expect(terminalFallSpeed(0)).toBe(0);
    for (const r of [0.5, 1, 5, 20, 50]) {
      const v = terminalFallSpeed(r);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(9);
    }
  });

  it('is non-decreasing in rate', () => {
    let prev = -Infinity;
    for (let r = 0.1; r <= 50; r += 0.5) {
      const v = terminalFallSpeed(r);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
  });
});

describe('rainParams', () => {
  it('is exactly zero at 0 mm/h', () => {
    const p = rainParams(0, CALM);
    expect(p.dropCount).toBe(0);
    expect(p.streakLength).toBe(0);
    expect(p.fallSpeed).toBe(0);
    expect(p.alpha).toBe(0);
    expect(p.slantAngle).toBe(0);
  });

  it('drop count / length / alpha are monotone non-decreasing in precipitation', () => {
    let prevCount = -1;
    let prevLen = -1;
    let prevAlpha = -1;
    for (let r = 0.5; r <= 40; r += 0.5) {
      const p = rainParams(r, CALM);
      expect(p.dropCount).toBeGreaterThanOrEqual(prevCount);
      expect(p.streakLength).toBeGreaterThanOrEqual(prevLen - 1e-9);
      expect(p.alpha).toBeGreaterThanOrEqual(prevAlpha - 1e-9);
      prevCount = p.dropCount;
      prevLen = p.streakLength;
      prevAlpha = p.alpha;
    }
  });

  it('drop count is bounded by the budget', () => {
    const budget = 500;
    for (const r of [1, 10, 100, 1000]) {
      expect(rainParams(r, CALM, budget).dropCount).toBeLessThanOrEqual(budget);
    }
    expect(rainParams(5, CALM).dropCount).toBeLessThanOrEqual(DEFAULT_RAIN_BUDGET);
  });

  it('rain slants DOWNWIND: horizontal velocity equals the air-velocity direction', () => {
    const wind: Vec3 = { x: 4, y: 0, z: -3 }; // air moving east-ish & north
    const p = rainParams(10, wind);
    expect(p.horizontalVelocity.x).toBeCloseTo(4, 10);
    expect(p.horizontalVelocity.z).toBeCloseTo(-3, 10);
    // Slant angle from vertical = atan(|w| / fallSpeed).
    const expected = Math.atan2(Math.hypot(4, 3), p.fallSpeed);
    expect(p.slantAngle).toBeCloseTo(expected, 10);
  });

  it('no wind ⇒ no slant', () => {
    expect(rainParams(10, CALM).slantAngle).toBe(0);
  });
});

describe('rainSurfaceDisturbance', () => {
  it('is 0 at 0, monotone increasing and saturating below 1', () => {
    expect(rainSurfaceDisturbance(0)).toBe(0);
    let prev = -1;
    for (let r = 0; r <= 100; r += 2) {
      const v = rainSurfaceDisturbance(r);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      prev = v;
    }
    // Approaches 1 for a downpour.
    expect(rainSurfaceDisturbance(100)).toBeGreaterThan(0.99);
  });
});

describe('LensDropletState', () => {
  it('accumulates only when exposed AND raining', () => {
    const s = new LensDropletState();
    s.update(1, 10, false); // raining but sheltered
    expect(s.coverage).toBe(0);
    s.update(1, 0, true); // exposed but dry
    expect(s.coverage).toBe(0);
    s.update(1, 10, true); // exposed and raining
    expect(s.coverage).toBeGreaterThan(0);
  });

  it('decays toward 0 when dry', () => {
    const s = new LensDropletState();
    for (let i = 0; i < 10; i++) s.update(1, 10, true);
    const wet = s.coverage;
    expect(wet).toBeGreaterThan(0);
    for (let i = 0; i < 100; i++) s.update(1, 0, false);
    expect(s.coverage).toBeLessThan(wet);
    expect(s.coverage).toBeLessThan(0.05);
  });

  it('stays within [0,1] under heavy prolonged rain', () => {
    const s = new LensDropletState();
    for (let i = 0; i < 1000; i++) {
      s.update(0.5, 200, true);
      expect(s.coverage).toBeGreaterThanOrEqual(0);
      expect(s.coverage).toBeLessThanOrEqual(1);
    }
  });

  it('reset returns to dry', () => {
    const s = new LensDropletState();
    s.update(5, 10, true);
    s.reset();
    expect(s.coverage).toBe(0);
  });
});

describe('TSL hooks and rain system build in node', () => {
  it('rainRippleNormalNode builds without throwing', () => {
    const node = rainRippleNormalNode(vec2(1, 2), float(0.5));
    expect(node).toBeDefined();
  });

  it('lensDropletMaskNode builds without throwing', () => {
    const node = lensDropletMaskNode(vec2(0.5, 0.5), float(0.3));
    expect(node).toBeDefined();
  });

  it('createRainSystem builds, updates and disposes cleanly', () => {
    const sys = createRainSystem({ budget: 100 });
    expect(sys.object).toBeDefined();
    expect(sys.object.visible).toBe(false); // starts hidden
    sys.update(rainParams(10, { x: 2, y: 0, z: -1 }, 100));
    expect(sys.object.visible).toBe(true);
    sys.update(rainParams(0, CALM)); // rain stops → hidden
    expect(sys.object.visible).toBe(false);
    expect(() => sys.dispose()).not.toThrow();
  });

  it('streak material is transparent and has an opacityNode (alpha is wired)', () => {
    const sys = createRainSystem({ budget: 100 });
    const mesh = sys.object as THREE.Mesh;
    const material = mesh.material as THREE.PointsNodeMaterial;
    expect(material.transparent).toBe(true);
    expect(material.opacityNode).toBeDefined();
    // Pushing params updates the alpha uniform the opacityNode reads, so a
    // heavier rain yields a higher resolved alpha that the material can show.
    sys.update(rainParams(16, CALM, 100));
    expect(() => sys.dispose()).not.toThrow();
  });
});
