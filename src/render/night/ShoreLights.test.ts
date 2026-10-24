import { describe, it, expect } from 'vitest';
import { generateShoreLights, type ShoreAnchor } from './ShoreLights';

const ANCHORS: ShoreAnchor[] = [
  { x: 0, y: 0, z: 0, radius: 30, height: 40 },
  { x: 200, y: 0, z: -100, radius: 20, height: 15 },
  { x: -150, y: 0, z: 80, radius: 50, height: 160 }, // tall → beacon
];

describe('generateShoreLights — determinism', () => {
  it('is deterministic for equal seed + anchors + density', () => {
    const a = generateShoreLights(42, ANCHORS, { density: 0.6 });
    const b = generateShoreLights(42, ANCHORS, { density: 0.6 });
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]?.x).toBe(b[i]?.x);
      expect(a[i]?.y).toBe(b[i]?.y);
      expect(a[i]?.z).toBe(b[i]?.z);
      expect(a[i]?.phase).toBe(b[i]?.phase);
    }
  });

  it('differs for a different seed', () => {
    const a = generateShoreLights(1, ANCHORS, { density: 0.6 });
    const b = generateShoreLights(2, ANCHORS, { density: 0.6 });
    // Same count (density-driven), but positions differ.
    let diffs = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i]?.x !== b[i]?.x) diffs++;
    expect(diffs).toBeGreaterThan(n * 0.5);
  });
});

describe('generateShoreLights — density scaling', () => {
  it('produces more lights at higher urban density', () => {
    const low = generateShoreLights(5, ANCHORS, { density: 0.2 });
    const high = generateShoreLights(5, ANCHORS, { density: 1.0 });
    expect(high.length).toBeGreaterThan(low.length);
  });

  it('zero density produces (almost) no window lights — only beacons remain', () => {
    const none = generateShoreLights(5, ANCHORS, { density: 0 });
    // No window lights; the tall anchor still gets its beacon.
    const windows = none.filter((l) => !l.isBeacon);
    const beacons = none.filter((l) => l.isBeacon);
    expect(windows.length).toBe(0);
    expect(beacons.length).toBe(1);
  });

  it('scales roughly linearly with density', () => {
    const d25 = generateShoreLights(9, ANCHORS, { density: 0.25 }).filter((l) => !l.isBeacon).length;
    const d100 = generateShoreLights(9, ANCHORS, { density: 1.0 }).filter((l) => !l.isBeacon).length;
    // 4x density → roughly 4x window lights (within rounding).
    expect(d100 / Math.max(1, d25)).toBeGreaterThan(3);
    expect(d100 / Math.max(1, d25)).toBeLessThan(5);
  });
});

describe('generateShoreLights — content', () => {
  it('window lights are warm (r >= g >= b)', () => {
    const lights = generateShoreLights(3, ANCHORS, { density: 1 }).filter((l) => !l.isBeacon);
    for (const l of lights) {
      expect(l.color.r).toBeGreaterThanOrEqual(l.color.g - 1e-9);
      expect(l.color.g).toBeGreaterThanOrEqual(l.color.b - 1e-9);
    }
  });

  it('tall anchors get a red aviation beacon at their top', () => {
    const lights = generateShoreLights(3, ANCHORS, { density: 1 });
    const beacons = lights.filter((l) => l.isBeacon);
    expect(beacons.length).toBe(1);
    const beacon = beacons[0];
    expect(beacon?.color.r).toBeGreaterThan(beacon?.color.g ?? 1);
    expect(beacon?.color.r).toBeGreaterThan(beacon?.color.b ?? 1);
    // At the top of the tall (160m) anchor.
    expect(beacon?.y).toBeCloseTo(160, 0);
  });

  it('lights scatter within the anchor footprint radius', () => {
    const single: ShoreAnchor[] = [{ x: 0, y: 0, z: 0, radius: 30, height: 20 }];
    const lights = generateShoreLights(11, single, { density: 1 }).filter((l) => !l.isBeacon);
    for (const l of lights) {
      const r = Math.sqrt(l.x * l.x + l.z * l.z);
      expect(r).toBeLessThanOrEqual(30 + 1e-6);
    }
  });

  it('respects a custom beacon threshold', () => {
    const anchors: ShoreAnchor[] = [{ x: 0, y: 0, z: 0, radius: 10, height: 50 }];
    const withLow = generateShoreLights(1, anchors, { density: 0.5, beaconHeightThreshold: 40 });
    const withHigh = generateShoreLights(1, anchors, { density: 0.5, beaconHeightThreshold: 100 });
    expect(withLow.some((l) => l.isBeacon)).toBe(true);
    expect(withHigh.some((l) => l.isBeacon)).toBe(false);
  });
});

describe('generateShoreLights — NaN poisoning guards (audit fix #3)', () => {
  it('emits no NaN positions and skips anchors with non-finite geometry', () => {
    const bad: ShoreAnchor[] = [
      { x: NaN, y: 0, z: 0, radius: 20, height: 40 },
      { x: 0, y: 0, z: 0, radius: NaN, height: 40 },
      { x: 0, y: 0, z: 0, radius: 20, height: Infinity },
      { x: 0, y: 0, z: 0, radius: 20, height: 40 }, // the one good anchor
    ];
    const lights = generateShoreLights(7, bad, { density: 1 });
    expect(lights.length).toBeGreaterThan(0);
    for (const l of lights) {
      expect(Number.isFinite(l.x)).toBe(true);
      expect(Number.isFinite(l.y)).toBe(true);
      expect(Number.isFinite(l.z)).toBe(true);
    }
  });

  it('all-bad anchors yield zero lights rather than NaN points', () => {
    const bad: ShoreAnchor[] = [
      { x: NaN, y: NaN, z: NaN, radius: NaN, height: NaN },
      { x: 0, y: Infinity, z: 0 },
    ];
    const lights = generateShoreLights(3, bad, { density: 1 });
    expect(lights.length).toBe(0);
  });
});
