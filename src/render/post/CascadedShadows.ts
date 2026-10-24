/**
 * CascadedShadows — PURE model for cascaded shadow maps (Stream F.3).
 *
 * NO three.js. This is the headlessly-testable "model" the thin `ShadowRig.ts`
 * layer mirrors. It owns three independent pieces of maths:
 *
 *  1. `computeCascadeSplits` — the Practical Split Scheme (PSSM), Zhang et al.
 *     2006, blending a logarithmic and a uniform split by `lambda`.
 *  2. `fitCascade` — a camera-rotation-INVARIANT bounding-sphere fit of a
 *     frustum slice, with light-space texel snapping so the ortho box only ever
 *     moves in whole-texel steps (kills shimmering).
 *  3. `shadowProjectToPlane` — where a world point's shadow lands on a
 *     horizontal plane, used to reason about the mast shadow sweeping the deck.
 *
 * ## Conventions (see .kiro/steering/sailing-conventions.md)
 *
 * - World space Y-up, right-handed, +X east, +Z south. A compass bearing θ
 *   (clockwise from north) maps to the horizontal direction `(sin θ, 0, -cos θ)`.
 * - SI units, radians.
 * - `sunDirection` points FROM the scene TOWARDS the sun (same sense as
 *   `SkyState.sunDirection` and `LightingState`). Light travels along
 *   `-sunDirection`.
 *
 * ## References
 *
 * - Zhang, Sun, Xu, Lun (2006), "Parallel-Split Shadow Maps for Large-scale
 *   Virtual Environments" — the C_i = λ·C_log + (1-λ)·C_uni split scheme.
 * - The bounding-sphere + texel-snap stabilisation is the standard CSM
 *   shimmer-removal technique (e.g. Valient 2007; three.js CSM uses the same
 *   idea). A sphere's radius is independent of camera orientation, so the
 *   cascade's ortho extent does not breathe as the player looks around.
 */

import type { Vec3 } from '@/types';

// ─── Small pure Vec3 helpers (no three.js) ─────────────────────────────────────

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}
function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
function length(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}
function normalize(a: Vec3): Vec3 {
  const l = length(a);
  if (l < 1e-12) return { x: 0, y: 0, z: 0 };
  return scale(a, 1 / l);
}

// ─── 1. Cascade splits (PSSM) ──────────────────────────────────────────────────

/**
 * Practical Split Scheme (Zhang 2006).
 *
 * Returns `count + 1` split distances along the view axis, from `near` (first)
 * to `far` (last), strictly increasing. Each interior split blends:
 *
 *   C_log(i) = near · (far/near)^(i/N)           (logarithmic — detail near)
 *   C_uni(i) = near + (i/N)·(far − near)         (uniform — even spacing)
 *   C_i      = λ·C_log(i) + (1−λ)·C_uni(i)
 *
 * λ = 1 → fully logarithmic, λ = 0 → fully uniform. Default 0.75 favours the
 * logarithmic term, which is what you want for a ground-level sailing camera.
 *
 * @param near   Camera near distance (> 0).
 * @param far    Camera far distance (> near).
 * @param count  Number of cascades (≥ 1).
 * @param lambda Blend 0..1 (default 0.75).
 */
export function computeCascadeSplits(
  near: number,
  far: number,
  count: number,
  lambda = 0.75,
): number[] {
  if (!(near > 0) || !(far > near)) {
    throw new RangeError('computeCascadeSplits requires 0 < near < far');
  }
  const n = Math.max(1, Math.floor(count));
  const lam = Math.min(1, Math.max(0, lambda));
  const ratio = far / near;
  const splits: number[] = [near];
  for (let i = 1; i < n; i++) {
    const f = i / n;
    const cLog = near * Math.pow(ratio, f);
    const cUni = near + f * (far - near);
    splits.push(lam * cLog + (1 - lam) * cUni);
  }
  splits.push(far);
  return splits;
}

// ─── 2. Frustum-slice bounding-sphere fit + texel snap ─────────────────────────

/** Camera parameters describing a single view-frustum slice to fit. */
export interface CameraSliceParams {
  /** Camera position in world space. */
  position: Vec3;
  /** Forward unit vector (viewing direction). */
  forward: Vec3;
  /** Right unit vector. */
  right: Vec3;
  /** Up unit vector. */
  up: Vec3;
  /** Vertical field of view, radians. */
  fovY: number;
  /** Aspect ratio (width / height). */
  aspect: number;
  /** Near distance of this slice along `forward`. */
  sliceNear: number;
  /** Far distance of this slice along `forward`. */
  sliceFar: number;
}

/** The fitted cascade: an orthographic light-space box ready for a shadow cam. */
export interface CascadeFit {
  /** World-space centre of the frustum-slice bounding sphere (texel-snapped). */
  center: Vec3;
  /** Bounding-sphere radius — the ortho half-extent. Rotation-invariant. */
  radius: number;
  /** Light position: `center` pulled back along `sunDirection` by `radius`. */
  lightPosition: Vec3;
  /** Light-view basis (orthonormal), expressed in world space. */
  lightForward: Vec3; // towards the scene == -sunDirection
  lightRight: Vec3;
  lightUp: Vec3;
  /**
   * The discrete world-up the light basis was built from. `ShadowRig` sets this
   * as `light.up` so three's shadow-camera lookAt reproduces this exact basis
   * (see `lightBasis` docs). Either `(0,1,0)` or, for a near-vertical sun,
   * `(0,0,1)`.
   */
  lightWorldUp: Vec3;
  /** Orthographic half-extents in light space (== radius on both axes). */
  orthoHalfWidth: number;
  orthoHalfHeight: number;
  /** Near/far planes of the ortho projection along the light forward axis. */
  orthoNear: number;
  orthoFar: number;
  /** World size of one shadow-map texel at this cascade. */
  texelSize: number;
}

/**
 * Build an orthonormal light basis from a sun direction (FROM→sun), together
 * with the discrete world-up vector the basis was built from.
 *
 * ## Why this must EXACTLY match three's shadow-camera construction
 *
 * three builds a `DirectionalLight`'s shadow-camera view (LightShadow.
 * updateMatrices → Object3D.lookAt → Matrix4.lookAt) as, with `eye =
 * light world position`, `target = light.target world position`, `up =
 * light.up`:
 *
 *   _z = normalize(eye − target)              // points light → scene reversed
 *   _x = normalize(cross(up, _z))             // shadow-camera RIGHT axis
 *   _y = cross(_z, _x)                         // shadow-camera UP axis
 *
 * In our rig `eye = center + sunDirection·(radius+pad)` and `target = center`,
 * so `eye − target ∝ +sunDirection`, i.e. `_z = normalize(sunDirection) =
 * −forward` here. Therefore three's lateral axes are:
 *
 *   _x = normalize(cross(light.up,  sunDir))
 *   _y = cross(sunDir, _x)
 *
 * The texel snap below quantises the cascade centre along `right` and `up`. For
 * the snap grid to coincide with the REAL shadow-map axes (otherwise the grid
 * shifts relative to the texels and shimmer returns), the model's `right`/`up`
 * must span the SAME lines as three's `_x`/`_y`. With `worldUp == light.up`:
 *
 *   model.right = normalize(cross(worldUp, forward))
 *               = normalize(cross(worldUp, −sunDir)) = −_x   (same line; sign is
 *                 irrelevant to a symmetric round-to-grid snap)
 *   model.up    = cross(forward, right) = cross(−sunDir, −_x) = cross(sunDir,_x)
 *               = _y                                           (exactly equal)
 *
 * So the ONLY requirement is that the rig sets `light.up` to the SAME discrete
 * `worldUp` this function chose. We therefore return it so `ShadowRig` can set
 * it on both the sun light and its target-less lookAt consistently, including
 * the near-vertical-sun case where `(0,1,0)` would be parallel to `_z` (and
 * three's `Matrix4.lookAt` would silently nudge `_z` by 1e-4, desynchronising
 * the two bases). Switching BOTH sides to `(0,0,1)` there keeps them identical
 * and non-degenerate.
 */
export function lightBasis(sunDirection: Vec3): {
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  /** The discrete world-up the basis was built from — set this as `light.up`. */
  worldUp: Vec3;
} {
  // Light travels towards the scene: forward = -sunDirection.
  const forward = normalize(scale(sunDirection, -1));
  // Pick a world-up that isn't parallel to forward (== not parallel to sunDir).
  // The 0.99 threshold is on |forward.y| == |sunDir.y|; this is the same test
  // ShadowRig must reproduce when it sets light.up.
  const worldUp: Vec3 =
    Math.abs(forward.y) > 0.99 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
  const right = normalize(cross(worldUp, forward));
  const up = normalize(cross(forward, right));
  return { forward, right, up, worldUp };
}

/**
 * The discrete world-up vector `lightBasis`/`fitCascade` choose for a given sun
 * direction. `ShadowRig` sets this exact vector as `light.up` so three's
 * shadow-camera basis coincides with the model's snap axes. Kept as a tiny
 * standalone export so the rig does not need a full `fitCascade` just to learn
 * the up vector (and so a test can assert the two agree).
 */
export function shadowLightUp(sunDirection: Vec3): Vec3 {
  const fy = -normalize(sunDirection).y; // forward.y
  return Math.abs(fy) > 0.99 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
}

/** The eight world-space corners of a view-frustum slice. */
export function frustumSliceCorners(cam: CameraSliceParams): Vec3[] {
  const tanY = Math.tan(cam.fovY / 2);
  const tanX = tanY * cam.aspect;
  const corners: Vec3[] = [];
  for (const d of [cam.sliceNear, cam.sliceFar]) {
    const hy = tanY * d;
    const hx = tanX * d;
    const centre = add(cam.position, scale(cam.forward, d));
    for (const sy of [-1, 1]) {
      for (const sx of [-1, 1]) {
        corners.push(
          add(add(centre, scale(cam.right, sx * hx)), scale(cam.up, sy * hy)),
        );
      }
    }
  }
  return corners;
}

/**
 * Bounding sphere of a set of points, computed as the circumscribing sphere of
 * the min/max AABB-diagonal — a stable, cheap choice whose radius does not vary
 * with the camera's yaw/pitch for a symmetric frustum slice (the slice's
 * geometry is congruent under rotation, so the enclosing sphere is identical).
 */
export function boundingSphere(points: Vec3[]): { center: Vec3; radius: number } {
  if (points.length === 0) return { center: { x: 0, y: 0, z: 0 }, radius: 0 };
  // Centroid is the sphere centre for a frustum slice (symmetric about its axis).
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
    cz += p.z;
  }
  const inv = 1 / points.length;
  const center: Vec3 = { x: cx * inv, y: cy * inv, z: cz * inv };
  let r2 = 0;
  for (const p of points) {
    const d = sub(p, center);
    const d2 = dot(d, d);
    if (d2 > r2) r2 = d2;
  }
  return { center, radius: Math.sqrt(r2) };
}

/**
 * Fit a single cascade to a frustum slice, returning a stabilised orthographic
 * light-space box.
 *
 * Stability (no shimmer) comes from two steps:
 *  1. A bounding SPHERE of the slice corners. A sphere's radius is invariant to
 *     camera rotation, so the ortho extent never breathes as the player looks
 *     around — only the centre translates.
 *  2. Snapping the sphere centre, expressed in light space, to whole-texel
 *     multiples. The ortho box then only ever jumps by entire texels, so a
 *     given world texel keeps mapping to the same shadow-map texel frame to
 *     frame.
 *
 * @param cam            Frustum-slice camera parameters.
 * @param sunDirection   Unit direction FROM the scene TOWARDS the sun.
 * @param shadowMapSize  Shadow map resolution in texels (e.g. 2048).
 * @param depthPadding   Extra depth added in front of/behind the sphere so
 *                       off-screen casters still shadow into the slice
 *                       (default = radius).
 */
export function fitCascade(
  cam: CameraSliceParams,
  sunDirection: Vec3,
  shadowMapSize: number,
  depthPadding?: number,
): CascadeFit {
  const corners = frustumSliceCorners(cam);
  const { center: rawCenter, radius } = boundingSphere(corners);
  const basis = lightBasis(sunDirection);

  // World size of a texel: the ortho spans 2·radius across `shadowMapSize` texels.
  const texelSize = (2 * radius) / Math.max(1, shadowMapSize);

  // Express the centre in light space, snap each axis to whole texels, map back.
  const lx = dot(rawCenter, basis.right);
  const ly = dot(rawCenter, basis.up);
  const lz = dot(rawCenter, basis.forward);
  const snap = (v: number): number =>
    texelSize > 0 ? Math.round(v / texelSize) * texelSize : v;
  const sx = snap(lx);
  const sy = snap(ly);
  // Depth (forward) axis is not texel-quantised; only the box's lateral frame
  // must be stable to kill shimmer.
  const center: Vec3 = add(
    add(scale(basis.right, sx), scale(basis.up, sy)),
    scale(basis.forward, lz),
  );

  const pad = depthPadding ?? radius;
  const lightPosition = add(center, scale(sunDirection, radius + pad));

  return {
    center,
    radius,
    lightPosition,
    lightForward: basis.forward,
    lightRight: basis.right,
    lightUp: basis.up,
    lightWorldUp: basis.worldUp,
    orthoHalfWidth: radius,
    orthoHalfHeight: radius,
    orthoNear: 0,
    orthoFar: 2 * radius + 2 * pad,
    texelSize,
  };
}

/**
 * Light-space coordinates of a world point relative to a fitted cascade centre.
 * Useful for tests asserting the snapped centre lands on a texel grid.
 */
export function toLightSpace(point: Vec3, fit: CascadeFit): Vec3 {
  return {
    x: dot(point, fit.lightRight),
    y: dot(point, fit.lightUp),
    z: dot(point, fit.lightForward),
  };
}

// ─── 3. Shadow projection onto a horizontal plane ──────────────────────────────

/**
 * Project a world point's shadow onto the horizontal plane `y = planeY`, given
 * the sun direction (FROM→sun). Returns the ground point where the shadow of
 * `point` falls.
 *
 * The shadow ray travels along `-sunDirection` (towards the ground) from
 * `point` until it crosses `planeY`. Requires the sun to be above the horizon
 * (`sunDirection.y > 0`); otherwise there is no finite shadow on the plane and
 * `null` is returned.
 *
 * For a vertical mast of height `h` above the plane with the tip at height `h`,
 * the resulting shadow length along the ground is `h / tan(elevation)` and its
 * horizontal direction is `(-sunDir.x, -sunDir.z)` normalised — i.e. directly
 * away from the sun's azimuth. The tests derive this from first principles.
 */
export function shadowProjectToPlane(
  point: Vec3,
  sunDirection: Vec3,
  planeY: number,
): Vec3 | null {
  const dir = normalize(sunDirection);
  if (!(dir.y > 1e-9)) return null; // sun at or below horizon: no finite shadow
  // Travel along -dir: p + t·(-dir), solve (point.y - t·dir.y) = planeY.
  const t = (point.y - planeY) / dir.y;
  return {
    x: point.x - t * dir.x,
    y: planeY,
    z: point.z - t * dir.z,
  };
}

/** Convert a compass bearing (radians, clockwise from north) to a horizontal
 *  direction vector `(sin θ, 0, -cos θ)` per the project's world convention. */
export function bearingToDirection(bearing: number): Vec3 {
  return { x: Math.sin(bearing), y: 0, z: -Math.cos(bearing) };
}
