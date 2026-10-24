/**
 * StarFieldRig — rotation-correctness regression tests (Stream F.4 audit fix #1).
 *
 * The rig bakes each star at siderealTime = 0, then rotates the whole Points
 * object about the celestial-pole axis per frame. This MUST reproduce the pure
 * `equatorialToHorizon(ra, dec, siderealTime, lat)` exactly. A previous bug
 * rotated by +siderealTime (wrong sense), which these tests catch — the audit
 * measured lat=0.7 st=1.2 ra=0.3 dec=0.2 giving the pure (-0.768, 0.594, 0.241)
 * but the +sign rig (0.978, 0.181, -0.107).
 *
 * The existing NCP test ("does not move") is structurally blind to the sign: the
 * pole is on the rotation axis, so it is invariant for EITHER sign. We therefore
 * test off-pole stars whose world position actually depends on the sign.
 */

import { describe, it, expect } from 'vitest';
import type * as THREE from 'three/webgpu';
import { createStarField } from './StarFieldRig';
import { equatorialToHorizon, type CatalogStar } from './StarField';

const DEG = Math.PI / 180;
const HOUR = Math.PI / 12;
const RADIUS = 2000;

function star(ra: number, dec: number): CatalogStar {
  return {
    ra,
    dec,
    magnitude: 2,
    colorIndex: 0.5,
    color: { r: 1, g: 1, b: 1 },
    intensity: 0.5,
  };
}

/**
 * Apply the rig's ACTUAL object quaternion (after `update` at `st`) to the
 * star's baked (siderealTime = 0) local direction, returning a world unit vector
 * — exactly the transform the GPU applies (baked local position × object
 * quaternion). The bake is reproduced here via the same pure call the rig uses
 * (`equatorialToHorizon(ra, dec, 0, lat)`) so the test exercises the rig's real
 * per-frame quaternion, independent of how the rig stores its buffer.
 */
function rigWorldDir(
  rig: ReturnType<typeof createStarField>,
  ra: number,
  dec: number,
  lat: number,
): { x: number; y: number; z: number } {
  const baked = equatorialToHorizon(ra, dec, 0, lat);
  // Rotate the baked local vector by the rig's actual object quaternion, applied
  // with the standard formula v' = v + 2·qw·(qv×v) + 2·(qv×(qv×v)). (We avoid
  // THREE.Vector3.applyQuaternion to keep off the concurrently-edited shared
  // type-declaration file; the math is identical.)
  const q = rig.object.quaternion;
  return rotateByQuaternion(baked, q.x, q.y, q.z, q.w);
}

/** v' = q · v · q⁻¹ for a unit quaternion (qx, qy, qz, qw). */
function rotateByQuaternion(
  v: { x: number; y: number; z: number },
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): { x: number; y: number; z: number } {
  // t = 2 · (qv × v)
  const tx = 2 * (qy * v.z - qz * v.y);
  const ty = 2 * (qz * v.x - qx * v.z);
  const tz = 2 * (qx * v.y - qy * v.x);
  // v' = v + qw·t + (qv × t)
  return {
    x: v.x + qw * tx + (qy * tz - qz * ty),
    y: v.y + qw * ty + (qz * tx - qx * tz),
    z: v.z + qw * tz + (qx * ty - qy * tx),
  };
}

describe('StarFieldRig — object rotation reproduces equatorialToHorizon', () => {
  it('matches the pure function over many (lat, st, ra, dec) combinations', () => {
    const lats = [-1.3, -0.7, -0.1, 0, 0.3, 0.7, 1.2, 1.5]; // incl. negative + near-pole
    const sts = [0, 0.5, 1.2, 2.4, 3.9, 5.5];
    const ras = [0.3, 1.1, 2.7, 4.5];
    const decs = [-1.0, -0.2, 0.2, 0.9];

    for (const lat of lats) {
      // The rig's per-frame quaternion depends only on (siderealTime, latitude),
      // not on which stars are in the catalogue, so one placeholder star suffices.
      const rig = createStarField([star(0, 0)], { latitude: lat, radius: RADIUS });

      for (const st of sts) {
        rig.update(st, lat, 1);
        for (const ra of ras) {
          for (const dec of decs) {
            const expected = equatorialToHorizon(ra, dec, st, lat);
            const got = rigWorldDir(rig, ra, dec, lat);
            expect(got.x).toBeCloseTo(expected.x, 5);
            expect(got.y).toBeCloseTo(expected.y, 5);
            expect(got.z).toBeCloseTo(expected.z, 5);
          }
        }
      }
      rig.dispose();
    }
  });

  it('specifically reproduces the audited failing case (lat 0.7, st 1.2, ra 0.3, dec 0.2)', () => {
    const rig = createStarField([star(0.3, 0.2)], { latitude: 0.7, radius: RADIUS });
    rig.update(1.2, 0.7, 1);
    const got = rigWorldDir(rig, 0.3, 0.2, 0.7);
    const expected = equatorialToHorizon(0.3, 0.2, 1.2, 0.7);
    // The pure function gives ~(-0.768, 0.594, 0.241); the buggy +sign rig gave
    // ~(0.978, 0.181, -0.107).
    expect(expected.x).toBeCloseTo(-0.768, 2);
    expect(expected.y).toBeCloseTo(0.594, 2);
    expect(expected.z).toBeCloseTo(0.241, 2);
    expect(got.x).toBeCloseTo(expected.x, 5);
    expect(got.y).toBeCloseTo(expected.y, 5);
    expect(got.z).toBeCloseTo(expected.z, 5);
    rig.dispose();
  });
});

describe('StarFieldRig — diurnal motion is east-to-west', () => {
  it('a near-meridian mid-sky star at lat 41.49 moves west (world X decreasing) as st increases', () => {
    const lat = 41.49 * DEG;
    // A star culminating (transit) near the meridian at st0: put RA so that at
    // st0 the hour angle is slightly negative (just east of the meridian, rising
    // towards transit), then advance st so it crosses to the west.
    const ra = 2.0;
    const dec = 20 * DEG; // mid-sky for this latitude, well above horizon
    const rig = createStarField([star(ra, dec)], { latitude: lat, radius: RADIUS });

    // Sample world X just before and just after transit (H slightly < 0 → > 0).
    const stBefore = ra - 0.3 * HOUR;
    const stAfter = ra + 0.3 * HOUR;

    rig.update(stBefore, lat, 1);
    const before = rigWorldDir(rig, ra, dec, lat);
    rig.update(stAfter, lat, 1);
    const after = rigWorldDir(rig, ra, dec, lat);

    // East → west means world X decreases (east = +X, west = -X).
    expect(before.x).toBeGreaterThan(after.x);
    // Cross-check against the pure model at the same times.
    const pureBefore = equatorialToHorizon(ra, dec, stBefore, lat);
    const pureAfter = equatorialToHorizon(ra, dec, stAfter, lat);
    expect(pureBefore.x).toBeGreaterThan(pureAfter.x);
    expect(before.x).toBeCloseTo(pureBefore.x, 5);
    expect(after.x).toBeCloseTo(pureAfter.x, 5);
    rig.dispose();
  });
});


describe('StarFieldRig — baked positions actually reach the geometry buffer', () => {
  // Regression for the copy-then-mutate bug: `new Float32BufferAttribute(array)`
  // COPIES its source (three BufferAttribute.js: `super(new Float32Array(array))`),
  // so mutating the original staging array after construction never reaches the
  // GPU buffer. The fix writes into `attribute.array` directly. Before the fix,
  // every position in the geometry buffer was 0 (stars rendered at the origin).
  const catalog: CatalogStar[] = [
    star(0.3, 0.2),
    star(2.0, -0.4),
    star(4.5, 1.1),
    star(5.5, -0.9),
  ];

  function positionArray(rig: ReturnType<typeof createStarField>): Float32Array {
    const points = rig.object as unknown as THREE.Points;
    const attr = points.geometry.getAttribute('position');
    return attr.array as Float32Array;
  }

  it('the position attribute holds the model output (not all zeros) after createStarField', () => {
    const lat = 41.49 * DEG;
    const rig = createStarField(catalog, { latitude: lat, radius: RADIUS });
    const arr = positionArray(rig);

    // Not the all-zero (origin) buffer the bug produced.
    const anyNonZero = Array.from(arr).some((v) => v !== 0);
    expect(anyNonZero).toBe(true);

    for (let i = 0; i < catalog.length; i++) {
      const s = catalog[i];
      if (s === undefined) continue;
      const expected = equatorialToHorizon(s.ra, s.dec, 0, lat);
      // Buffer holds the unit direction scaled by the sky-shell radius.
      expect(arr[i * 3 + 0]).toBeCloseTo(expected.x * RADIUS, 3);
      expect(arr[i * 3 + 1]).toBeCloseTo(expected.y * RADIUS, 3);
      expect(arr[i * 3 + 2]).toBeCloseTo(expected.z * RADIUS, 3);
      // Unit-length (×radius) sanity: on the sky shell.
      const r = Math.hypot(arr[i * 3] ?? 0, arr[i * 3 + 1] ?? 0, arr[i * 3 + 2] ?? 0);
      expect(r).toBeCloseTo(RADIUS, 2);
    }
    rig.dispose();
  });

  it('rebake(latitude) re-writes the geometry buffer to the new latitude', () => {
    const latA = 10 * DEG;
    const latB = 60 * DEG;
    const rig = createStarField(catalog, { latitude: latA, radius: RADIUS });

    rig.rebake(latB);
    const arr = positionArray(rig);
    const s0 = catalog[0];
    expect(s0).toBeDefined();
    if (s0 !== undefined) {
      const expB = equatorialToHorizon(s0.ra, s0.dec, 0, latB);
      expect(arr[0]).toBeCloseTo(expB.x * RADIUS, 3);
      expect(arr[1]).toBeCloseTo(expB.y * RADIUS, 3);
      expect(arr[2]).toBeCloseTo(expB.z * RADIUS, 3);
      // And it genuinely differs from latitude A's baking (dec-offset star moves).
      const expA = equatorialToHorizon(s0.ra, s0.dec, 0, latA);
      expect(Math.abs(expA.y - expB.y)).toBeGreaterThan(1e-3);
    }
    rig.dispose();
  });

  it('a latitude change via update() rebakes the buffer', () => {
    const latA = 20 * DEG;
    const latB = 55 * DEG;
    const rig = createStarField(catalog, { latitude: latA, radius: RADIUS });
    // update() with a changed latitude must re-bake (not just rotate).
    rig.update(0, latB, 1);
    const arr = positionArray(rig);
    const s0 = catalog[0];
    if (s0 !== undefined) {
      const expB = equatorialToHorizon(s0.ra, s0.dec, 0, latB);
      expect(arr[0]).toBeCloseTo(expB.x * RADIUS, 3);
      expect(arr[1]).toBeCloseTo(expB.y * RADIUS, 3);
      expect(arr[2]).toBeCloseTo(expB.z * RADIUS, 3);
    }
    rig.dispose();
  });
});
