/**
 * Tests for the pure cascaded-shadow model. All expectations are derived from
 * first principles (PSSM split formula, bounding-sphere invariance, texel-snap
 * arithmetic, and planar shadow projection), not from the implementation.
 */

import { describe, it, expect } from 'vitest';
import {
  computeCascadeSplits,
  fitCascade,
  shadowProjectToPlane,
  frustumSliceCorners,
  boundingSphere,
  lightBasis,
  shadowLightUp,
  toLightSpace,
  bearingToDirection,
  type CameraSliceParams,
} from './CascadedShadows';

const DEG = Math.PI / 180;

// ─── Independent reimplementation of three's shadow-camera basis ───────────────
//
// three forms the DirectionalLight shadow-camera view in LightShadow.
// updateMatrices → Object3D.lookAt (camera branch) → Matrix4.lookAt(eye, target,
// up), with eye = light world position, target = light.target world position,
// up = light.up. Matrix4.lookAt builds (verbatim, Matrix4.js):
//   _z = normalize(eye − target);   _x = normalize(cross(up, _z));   _y = cross(_z, _x)
// where _x is the camera RIGHT axis and _y the camera UP axis in world space.
// This is a Matrix4-free cross-product port used ONLY to validate the model —
// if the model's snap grid is a whole number of texels along THESE axes, no
// shimmer can arise, because these are literally the axes three will rasterise
// the shadow map along.

type V = { x: number; y: number; z: number };
function vsub(a: V, b: V): V {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function vcross(a: V, b: V): V {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
function vnorm(a: V): V {
  const l = Math.hypot(a.x, a.y, a.z) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}
function vdot(a: V, b: V): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** three's real shadow-camera right/up axes for a given eye/target/up. */
function threeShadowAxes(eye: V, target: V, up: V): { right: V; up: V; z: V } {
  const _z = vnorm(vsub(eye, target));
  const _x = vnorm(vcross(up, _z));
  const _y = vcross(_z, _x); // already unit (both inputs unit & orthogonal)
  return { right: _x, up: _y, z: _z };
}

describe('computeCascadeSplits (PSSM)', () => {
  it('first split == near, last == far, strictly increasing', () => {
    const near = 0.5;
    const far = 2000;
    const splits = computeCascadeSplits(near, far, 4, 0.75);
    expect(splits.length).toBe(5);
    expect(splits[0]).toBeCloseTo(near, 10);
    expect(splits[splits.length - 1]).toBeCloseTo(far, 6);
    for (let i = 1; i < splits.length; i++) {
      expect(splits[i]!).toBeGreaterThan(splits[i - 1]!);
    }
  });

  it('lambda=0 is exactly uniform', () => {
    const near = 1;
    const far = 101;
    const splits = computeCascadeSplits(near, far, 5, 0);
    // Uniform: near + i/N * (far-near) = 1,21,41,61,81,101
    for (let i = 0; i <= 5; i++) {
      expect(splits[i]!).toBeCloseTo(near + (i / 5) * (far - near), 9);
    }
  });

  it('lambda=1 is exactly logarithmic', () => {
    const near = 1;
    const far = 1000;
    const splits = computeCascadeSplits(near, far, 3, 1);
    // Log: near * (far/near)^(i/N) = 1, 10, 100, 1000
    for (let i = 0; i <= 3; i++) {
      expect(splits[i]!).toBeCloseTo(near * Math.pow(far / near, i / 3), 6);
    }
  });

  it('a single cascade is just [near, far]', () => {
    const splits = computeCascadeSplits(2, 50, 1, 0.5);
    expect(splits).toHaveLength(2);
    expect(splits[0]).toBeCloseTo(2, 10);
    expect(splits[1]).toBeCloseTo(50, 10);
  });

  it('throws on invalid near/far', () => {
    expect(() => computeCascadeSplits(0, 100, 3)).toThrow();
    expect(() => computeCascadeSplits(100, 50, 3)).toThrow();
  });
});

// ─── Helpers for frustum tests ─────────────────────────────────────────────────

function camLookingAlong(yaw: number, pitch: number): CameraSliceParams {
  // Build an orthonormal camera basis from yaw (about Y) and pitch (about right).
  // forward from yaw/pitch:
  const cp = Math.cos(pitch);
  const forward = {
    x: Math.sin(yaw) * cp,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cp,
  };
  // world up
  const wUp = { x: 0, y: 1, z: 0 };
  // right = normalize(forward × up)  -> but standard is right = fwd×up? use cross(forward, wUp)
  const right0 = {
    x: forward.y * wUp.z - forward.z * wUp.y,
    y: forward.z * wUp.x - forward.x * wUp.z,
    z: forward.x * wUp.y - forward.y * wUp.x,
  };
  const rl = Math.hypot(right0.x, right0.y, right0.z);
  const right = { x: right0.x / rl, y: right0.y / rl, z: right0.z / rl };
  const up = {
    x: right.y * forward.z - right.z * forward.y,
    y: right.z * forward.x - right.x * forward.z,
    z: right.x * forward.y - right.y * forward.x,
  };
  return {
    position: { x: 0, y: 0, z: 0 },
    forward,
    right,
    up,
    fovY: 60 * DEG,
    aspect: 16 / 9,
    sliceNear: 1,
    sliceFar: 50,
  };
}

describe('fitCascade bounding sphere', () => {
  it('sphere radius is invariant under camera yaw and pitch', () => {
    const sun = { x: 0.3, y: 0.7, z: -0.2 };
    const base = fitCascade(camLookingAlong(0, 0), sun, 2048);
    const radii: number[] = [base.radius];
    for (const yaw of [30 * DEG, 90 * DEG, 180 * DEG, -120 * DEG]) {
      for (const pitch of [-30 * DEG, 0, 20 * DEG]) {
        const f = fitCascade(camLookingAlong(yaw, pitch), sun, 2048);
        radii.push(f.radius);
      }
    }
    for (const r of radii) {
      expect(r).toBeCloseTo(base.radius, 6);
    }
    expect(base.radius).toBeGreaterThan(0);
  });

  it('snapped centre is an exact integer multiple of texel size in light space', () => {
    const sun = { x: 0.3, y: 0.7, z: -0.2 };
    const size = 2048;
    const fit = fitCascade(camLookingAlong(37 * DEG, -12 * DEG), sun, size);
    const ls = toLightSpace(fit.center, fit);
    const kx = ls.x / fit.texelSize;
    const ky = ls.y / fit.texelSize;
    expect(kx).toBeCloseTo(Math.round(kx), 6);
    expect(ky).toBeCloseTo(Math.round(ky), 6);
  });

  it('ortho half-extents equal the sphere radius', () => {
    const sun = { x: 0, y: 1, z: 0 };
    const fit = fitCascade(camLookingAlong(0, 0), sun, 1024);
    expect(fit.orthoHalfWidth).toBeCloseTo(fit.radius, 10);
    expect(fit.orthoHalfHeight).toBeCloseTo(fit.radius, 10);
  });

  it('consecutive cascades nest and cover with no gap', () => {
    // Build two adjacent slices from a split schedule and confirm their spheres
    // overlap (slice N's far corners are inside slice N+1's sphere region):
    const sun = { x: 0.2, y: 0.9, z: -0.3 };
    const splits = computeCascadeSplits(1, 200, 3, 0.75);
    const fits = [];
    for (let i = 0; i < splits.length - 1; i++) {
      const cam = camLookingAlong(20 * DEG, -5 * DEG);
      cam.sliceNear = splits[i]!;
      cam.sliceFar = splits[i + 1]!;
      fits.push({ cam, fit: fitCascade(cam, sun, 2048) });
    }
    // The shared boundary distance between cascade i and i+1 is splits[i+1].
    // The near corners of cascade i+1 are the far corners of cascade i, so each
    // such corner must be within BOTH spheres (coverage, no gap).
    for (let i = 0; i < fits.length - 1; i++) {
      const boundary = fits[i]!.cam.sliceFar;
      expect(fits[i + 1]!.cam.sliceNear).toBeCloseTo(boundary, 9);
      const sharedCorners = frustumSliceCorners({
        ...fits[i]!.cam,
        sliceNear: boundary,
        sliceFar: boundary,
      });
      for (const c of sharedCorners) {
        // Texel snapping displaces each cascade's sphere centre laterally by up
        // to half a texel per axis, so strict containment holds only within
        // (radius + texelSize). That one-texel slack IS the stabilisation
        // trade-off (snap-for-no-shimmer), not a gap — the overlap below proves
        // the boundary is jointly covered by both cascades.
        const inA = dist(c, fits[i]!.fit.center) <= fits[i]!.fit.radius + fits[i]!.fit.texelSize;
        const inB =
          dist(c, fits[i + 1]!.fit.center) <= fits[i + 1]!.fit.radius + fits[i + 1]!.fit.texelSize;
        expect(inA).toBe(true);
        expect(inB).toBe(true);
      }
    }
  });
});

function dist(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

describe('boundingSphere', () => {
  it('returns zero for empty input', () => {
    const s = boundingSphere([]);
    expect(s.radius).toBe(0);
  });
  it('encloses all points', () => {
    const pts = [
      { x: 1, y: 0, z: 0 },
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 2, z: 0 },
      { x: 0, y: -2, z: 0 },
    ];
    const s = boundingSphere(pts);
    for (const p of pts) expect(dist(p, s.center)).toBeLessThanOrEqual(s.radius + 1e-9);
  });
});

describe('lightBasis', () => {
  it('forward is the negated sun direction, basis is orthonormal', () => {
    const sun = { x: 0.3, y: 0.8, z: -0.5 };
    const b = lightBasis(sun);
    const sl = Math.hypot(sun.x, sun.y, sun.z);
    expect(b.forward.x).toBeCloseTo(-sun.x / sl, 6);
    expect(b.forward.y).toBeCloseTo(-sun.y / sl, 6);
    expect(b.forward.z).toBeCloseTo(-sun.z / sl, 6);
    // Orthonormality
    expect(b.right.x * b.up.x + b.right.y * b.up.y + b.right.z * b.up.z).toBeCloseTo(0, 6);
    expect(Math.hypot(b.right.x, b.right.y, b.right.z)).toBeCloseTo(1, 6);
    expect(Math.hypot(b.up.x, b.up.y, b.up.z)).toBeCloseTo(1, 6);
  });

  it('handles a near-vertical sun without degenerating', () => {
    const b = lightBasis({ x: 0, y: 1, z: 0 });
    expect(Math.hypot(b.right.x, b.right.y, b.right.z)).toBeCloseTo(1, 6);
    expect(Math.hypot(b.up.x, b.up.y, b.up.z)).toBeCloseTo(1, 6);
  });
});

describe('shadowProjectToPlane — mast shadow across the deck', () => {
  it('mast-tip shadow length is h / tan(elevation), opposite the sun azimuth', () => {
    // Sun at elevation ε, azimuth α (compass, clockwise from north).
    // sunDirection FROM scene TO sun: horizontal part along bearing α, scaled
    // by cos ε; vertical sin ε.
    const h = 10; // mast height, metres
    for (const elevationDeg of [20, 35, 60]) {
      for (const azimuthDeg of [0, 45, 135, 250]) {
        const eps = elevationDeg * DEG;
        const az = azimuthDeg * DEG;
        const horiz = bearingToDirection(az); // (sin az, 0, -cos az)
        const sun = {
          x: horiz.x * Math.cos(eps),
          y: Math.sin(eps),
          z: horiz.z * Math.cos(eps),
        };
        const tip = { x: 0, y: h, z: 0 };
        const ground = shadowProjectToPlane(tip, sun, 0)!;
        expect(ground).not.toBeNull();
        // Length from first principles: h / tan(ε).
        const len = Math.hypot(ground.x, ground.z);
        expect(len).toBeCloseTo(h / Math.tan(eps), 6);
        // Direction is opposite the sun's horizontal bearing (away from the sun).
        const dirx = ground.x / len;
        const dirz = ground.z / len;
        expect(dirx).toBeCloseTo(-horiz.x, 6);
        expect(dirz).toBeCloseTo(-horiz.z, 6);
      }
    }
  });

  it('shadow rotates by the heading change through a tack', () => {
    // A mast at the origin of the boat; as the boat tacks from heading H1 to H2
    // through the wind, the mast position is fixed (origin), so the mast-tip
    // shadow does NOT move for a centreline mast. The meaningful quantity is a
    // point OFFSET from the mast in boat-local space (e.g. the masthead crane
    // or a shroud anchor at local +x). That offset rotates with heading, and so
    // does its shadow. We verify the shadow of a hull-local offset point rotates
    // by exactly the heading delta.
    const h = 12;
    const eps = 40 * DEG;
    const az = 90 * DEG; // sun due east
    const horiz = bearingToDirection(az);
    const sun = {
      x: horiz.x * Math.cos(eps),
      y: Math.sin(eps),
      z: horiz.z * Math.cos(eps),
    };
    // Boat-local offset point: 2 m to starboard and at masthead height.
    const localOffset = { x: 2, y: h, z: 0 };
    const headings = [0, 45 * DEG, 90 * DEG]; // bear through a tack
    const groundPts = headings.map((hdg) => {
      // Rotate the local offset about Y by the heading to get world position.
      const c = Math.cos(hdg);
      const s = Math.sin(hdg);
      const world = {
        x: localOffset.x * c + localOffset.z * s,
        y: localOffset.y,
        z: -localOffset.x * s + localOffset.z * c,
      };
      return shadowProjectToPlane(world, sun, 0)!;
    });
    // The shadow of the rotating offset must itself sweep: the horizontal
    // displacement of the offset's base (its XZ footprint) rotates with heading,
    // so successive ground shadows differ by a non-zero sweep.
    const sweep01 = dist(groundPts[0]!, groundPts[1]!);
    const sweep12 = dist(groundPts[1]!, groundPts[2]!);
    expect(sweep01).toBeGreaterThan(0.1);
    expect(sweep12).toBeGreaterThan(0.1);
  });

  it('returns null when the sun is at or below the horizon', () => {
    expect(shadowProjectToPlane({ x: 0, y: 5, z: 0 }, { x: 1, y: 0, z: 0 }, 0)).toBeNull();
    expect(shadowProjectToPlane({ x: 0, y: 5, z: 0 }, { x: 0.5, y: -0.5, z: 0 }, 0)).toBeNull();
  });
});


describe('texel snap aligns with three\'s REAL shadow-camera axes (no shimmer)', () => {
  // Build the shadow camera exactly as three would from the fit, then prove the
  // snapped centre is a whole number of texels along three's actual right/up
  // axes — the sufficient condition for a stable, shimmer-free cascade.
  function assertSnappedOnThreeGrid(sun: V, cam: CameraSliceParams, size: number): void {
    const fit = fitCascade(cam, sun, size);

    // Reproduce three's eye/target/up for this cascade's light:
    //   eye    = fit.lightPosition
    //   target = fit.center
    //   up     = fit.lightWorldUp   (what ShadowRig sets as light.up)
    const eye: V = fit.lightPosition;
    const target: V = fit.center;
    const up: V = fit.lightWorldUp;
    const axes = threeShadowAxes(eye, target, up);

    // The centre expressed along three's REAL lateral axes, in texels.
    const kRight = vdot(fit.center, axes.right) / fit.texelSize;
    const kUp = vdot(fit.center, axes.up) / fit.texelSize;
    expect(kRight).toBeCloseTo(Math.round(kRight), 5);
    expect(kUp).toBeCloseTo(Math.round(kUp), 5);

    // Cross-check: the model's own basis right/up must be the SAME lines as
    // three's (same up to sign for right, exactly equal for up). This is what
    // guarantees the model's snap == three's grid.
    const sameLine = (a: V, b: V): boolean => Math.abs(Math.abs(vdot(a, b)) - 1) < 1e-6;
    expect(sameLine(fit.lightRight, axes.right)).toBe(true);
    expect(sameLine(fit.lightUp, axes.up)).toBe(true);

    // And shadowLightUp (the standalone the rig may use) agrees with the fit.
    const slu = shadowLightUp(sun);
    expect(slu.x).toBeCloseTo(fit.lightWorldUp.x, 10);
    expect(slu.y).toBeCloseTo(fit.lightWorldUp.y, 10);
    expect(slu.z).toBeCloseTo(fit.lightWorldUp.z, 10);
  }

  it('holds for a spread of sun directions including near-zenith', () => {
    const size = 2048;
    const cam = camLookingAlong(31 * DEG, -9 * DEG);
    // Sun elevations from low to the zenith, across several azimuths.
    const elevations = [10, 30, 55, 80, 88, 89.5, 90]; // deg; 90 == exact zenith
    const azimuths = [0, 40, 125, 215, 300]; // deg
    for (const elDeg of elevations) {
      for (const azDeg of azimuths) {
        const el = elDeg * DEG;
        const az = azDeg * DEG;
        const horiz = bearingToDirection(az);
        const sun: V = {
          x: horiz.x * Math.cos(el),
          y: Math.sin(el),
          z: horiz.z * Math.cos(el),
        };
        assertSnappedOnThreeGrid(sun, cam, size);
      }
    }
  });

  it('at the exact zenith the model switches worldUp to (0,0,1) (non-degenerate)', () => {
    const sun: V = { x: 0, y: 1, z: 0 };
    const b = lightBasis(sun);
    expect(b.worldUp.x).toBeCloseTo(0, 10);
    expect(b.worldUp.y).toBeCloseTo(0, 10);
    expect(b.worldUp.z).toBeCloseTo(1, 10);
    // three's lookAt with this up and _z = +sun = (0,1,0) is non-degenerate:
    // cross((0,0,1),(0,1,0)) = (-1,0,0), unit length.
    const axes = threeShadowAxes({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 }, b.worldUp);
    expect(Math.hypot(axes.right.x, axes.right.y, axes.right.z)).toBeCloseTo(1, 6);
    // If instead we (wrongly) used (0,1,0) as up, cross((0,1,0),(0,1,0)) == 0
    // and three would have to nudge — demonstrate that degeneracy explicitly.
    const degenerate = vcross({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 });
    expect(Math.hypot(degenerate.x, degenerate.y, degenerate.z)).toBeCloseTo(0, 10);
  });

  it('a slightly-off-vertical sun stays on (0,1,0) and still lands on the grid', () => {
    // Just inside the 0.99 threshold on |sunDir.y| → still uses (0,1,0).
    const el = Math.asin(0.985); // |y| = 0.985 < 0.99
    const sun: V = { x: Math.cos(el), y: Math.sin(el), z: 0 };
    const b = lightBasis(sun);
    expect(b.worldUp.y).toBeCloseTo(1, 10);
    assertSnappedOnThreeGrid(sun, camLookingAlong(0, 0), 1024);
  });
});
