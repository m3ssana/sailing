/**
 * StarFieldRig — the thin three/TSL layer for the star field (Stream F.4).
 *
 * Consumes the pure `StarField` model. Renders stars as additive points with
 * size-by-magnitude and a gentle per-star twinkle.
 *
 * ## Single-object rotation (requirement: NOT per-star)
 *
 * Each star's LOCAL position is baked once via
 * `equatorialToHorizon(ra, dec, siderealTime = 0, latitude)`. Sidereal time
 * enters that transform ONLY through the hour angle `H = siderealTime - ra`,
 * i.e. as a pure rotation about the celestial-pole axis. So the entire diurnal
 * motion is reproduced by rotating the WHOLE Points object about the pole axis
 * by `-siderealTime` (see `applyPoleRotation` for the sign derivation) — one
 * object quaternion per frame, never a per-star update.
 *
 * The celestial pole axis in world space is `(0, sin lat, -cos lat)` (it points
 * due north at an elevation equal to the observer's latitude). Baking at
 * `siderealTime = 0` for the current latitude means the baked positions already
 * carry the latitude tilt; only the sidereal spin is applied per frame.
 *
 * If latitude changes (venue change), call `rebake(latitude)` to re-bake.
 */

import * as THREE from 'three/webgpu';
import { Fn, vec3, uniform, attribute, time, oscSine } from 'three/tsl';
import type { TSLNode } from 'three/tsl';
import {
  equatorialToHorizon,
  magnitudeToPointSize,
  type CatalogStar,
} from './StarField';

export interface StarFieldRigOptions {
  /** Distance to place stars at (sky shell radius). Default 2000. */
  radius?: number;
  /** Observer latitude, radians (+N). Default 0. */
  latitude?: number;
}

export interface StarFieldRig {
  readonly object: THREE.Object3D;
  /**
   * Update visibility and diurnal rotation.
   * @param siderealTime Local apparent sidereal time, radians.
   * @param latitude Observer latitude, radians.
   * @param visibility Overall star visibility 0..1 (from `starVisibility`).
   */
  update(siderealTime: number, latitude: number, visibility: number): void;
  /** Re-bake local positions for a new latitude. */
  rebake(latitude: number): void;
  dispose(): void;
}

/**
 * Build a star-field Points cloud from a catalogue.
 */
export function createStarField(
  catalog: readonly CatalogStar[],
  opts: StarFieldRigOptions = {},
): StarFieldRig {
  const radius = opts.radius ?? 2000;
  let latitude = opts.latitude ?? 0;
  const n = catalog.length;

  const colors = new Float32Array(n * 3);
  // perStar.x = point size, .y = twinkle phase, .z = base intensity
  const perStar = new Float32Array(n * 3);

  // IMPORTANT: `new THREE.Float32BufferAttribute(array, …)` COPIES its source
  // array (`super(new Float32Array(array), …)` in three's BufferAttribute.js),
  // so the attribute owns a *separate* buffer. `bake()` must therefore write
  // into `posAttr.array` — the attribute's own buffer that the GPU uploads —
  // NOT into a staging array that was only used to size the attribute. The old
  // code mutated a discarded source array, so every star stayed at the origin.
  const posAttr = new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3);
  const posArray = posAttr.array as Float32Array;

  function bake(lat: number): void {
    const v = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < n; i++) {
      const s = catalog[i];
      if (s === undefined) continue;
      // Bake at siderealTime = 0; the per-frame pole rotation supplies motion.
      equatorialToHorizon(s.ra, s.dec, 0, lat, v);
      posArray[i * 3] = v.x * radius;
      posArray[i * 3 + 1] = v.y * radius;
      posArray[i * 3 + 2] = v.z * radius;
    }
    posAttr.needsUpdate = true;
  }

  for (let i = 0; i < n; i++) {
    const s = catalog[i];
    if (s === undefined) continue;
    colors[i * 3] = s.color.r;
    colors[i * 3 + 1] = s.color.g;
    colors[i * 3 + 2] = s.color.b;
    perStar[i * 3] = magnitudeToPointSize(s.magnitude);
    perStar[i * 3 + 1] = (s.ra + s.dec) % (Math.PI * 2); // deterministic twinkle phase
    // Normalise intensity into a renderable 0..1 (relative to the brightest).
    perStar[i * 3 + 2] = Math.min(1, s.intensity);
  }

  bake(latitude);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('starColor', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('starData', new THREE.Float32BufferAttribute(perStar, 3));

  const uVisibility = uniform(0);

  const material = new THREE.PointsNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.AdditiveBlending;
  material.sizeAttenuation = false;

  const starColor = attribute('starColor', 'vec3');
  const starData = attribute('starData', 'vec3');

  const colorNode: TSLNode = Fn(() => {
    const phase = starData.y;
    const baseIntensity = starData.z;
    // Gentle twinkle, out of sync per star.
    const twinkle = oscSine(time.mul(1.5).add(phase)).mul(0.15).add(0.85);
    const emit = baseIntensity.mul(twinkle).mul(uVisibility);
    return vec3(starColor).mul(emit);
  })();

  material.colorNode = colorNode;
  material.opacityNode = Fn(() => uVisibility.clamp(0, 1))();
  material.sizeNode = Fn(() => starData.x)();

  const points = new THREE.Points(geometry, material);

  /**
   * Set the object quaternion to the diurnal rotation about the celestial-pole
   * axis for the given sidereal time.
   *
   * ## Sign derivation (from first principles, NOT a blind flip)
   *
   * The pure `equatorialToHorizon` drives motion through the hour angle
   * `H = siderealTime - ra`, so `H` INCREASES with sidereal time. In that
   * transform the eastward world component is `worldX = -cosDec·sin(H)`: as `H`
   * grows from just-before transit (`H` slightly < 0, `worldX` > 0, star in the
   * east) through transit (`H = 0`) to just-after (`H` > 0, `worldX` < 0, star in
   * the west), the star sweeps east → west. That is the real diurnal direction.
   *
   * The baked positions were computed at `siderealTime = 0` (i.e. `H = -ra`), so
   * we need the rigid rotation `R(st)` about the pole axis with
   * `R(st)·baked == equatorialToHorizon(ra, dec, st, lat)`. The pole axis
   * `(0, sin lat, -cos lat)` points toward the celestial pole (north in the
   * northern hemisphere). By the right-hand rule a POSITIVE quaternion angle
   * about that axis spins stars counter-clockwise as seen looking along the axis
   * toward the pole — i.e. west → east, the WRONG way. The diurnal spin is the
   * opposite sense, so the correct object rotation is by `-siderealTime` about
   * the pole axis. (An independent audit confirmed `-siderealTime` reproduces the
   * pure function to <1e-4 over many cases, while `+siderealTime` does not.)
   */
  function applyPoleRotation(siderealTime: number, lat: number): void {
    // Pole axis in world: (0, sin lat, -cos lat).
    const ax = 0;
    const ay = Math.sin(lat);
    const az = -Math.cos(lat);
    // Diurnal spin is -siderealTime about the pole axis (see derivation above).
    const half = -siderealTime * 0.5;
    const s = Math.sin(half);
    points.quaternion.set(ax * s, ay * s, az * s, Math.cos(half));
  }

  return {
    object: points,
    update(siderealTime: number, lat: number, visibility: number): void {
      if (lat !== latitude) {
        latitude = lat;
        bake(latitude);
      }
      applyPoleRotation(siderealTime, latitude);
      uVisibility.value = Math.max(0, Math.min(1, visibility));
    },
    rebake(lat: number): void {
      latitude = lat;
      bake(latitude);
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}


