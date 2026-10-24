/**
 * ShoreLightsRig — the thin three/TSL layer for shore lighting (Stream F.4).
 *
 * Consumes the pure `ShoreLights` generator. Renders warm window/street lights
 * (and red aviation beacons) as additive points that flicker gently and fade
 * with `nightFactor` — dark by day. With the nav lights, these are the only
 * emissive items the art direction allows.
 */

import * as THREE from 'three/webgpu';
import { Fn, vec3, float, uniform, attribute, time, oscSine, mix } from 'three/tsl';
import type { TSLNode } from 'three/tsl';
import type { ShoreLight } from './ShoreLights';

export interface ShoreLightsRigOptions {
  /** Base point size (pixels). Default 3. */
  pointSize?: number;
}

export interface ShoreLightsRig {
  readonly object: THREE.Object3D;
  /** Update night fade (0 day .. 1 night). */
  update(nightFactor: number): void;
  dispose(): void;
}

/**
 * Build a Points cloud from pre-generated shore lights. The geometry is static
 * (world positions); only the night-factor uniform changes per frame.
 */
export function createShoreLights(
  lights: readonly ShoreLight[],
  opts: ShoreLightsRigOptions = {},
): ShoreLightsRig {
  const pointSize = opts.pointSize ?? 3;
  const n = lights.length;

  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  // perLight.x = base intensity, .y = flicker phase, .z = beacon flag (0/1)
  const perLight = new Float32Array(n * 3);

  for (let i = 0; i < n; i++) {
    const l = lights[i];
    if (l === undefined) continue;
    positions[i * 3] = l.x;
    positions[i * 3 + 1] = l.y;
    positions[i * 3 + 2] = l.z;
    colors[i * 3] = l.color.r;
    colors[i * 3 + 1] = l.color.g;
    colors[i * 3 + 2] = l.color.b;
    perLight[i * 3] = l.intensity;
    perLight[i * 3 + 1] = l.phase;
    perLight[i * 3 + 2] = l.isBeacon ? 1 : 0;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('shoreColor', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('shoreData', new THREE.Float32BufferAttribute(perLight, 3));

  const uNightFactor = uniform(0);

  const material = new THREE.PointsNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.AdditiveBlending;
  material.sizeAttenuation = true;

  const shoreColor = attribute('shoreColor', 'vec3');
  const shoreData = attribute('shoreData', 'vec3');

  const colorNode: TSLNode = Fn(() => {
    const baseIntensity = shoreData.x;
    const phase = shoreData.y;
    const beacon = shoreData.z;
    // Window flicker: subtle for windows, a slow pulse for beacons.
    const windowFlicker = oscSine(time.mul(2.5).add(phase)).mul(0.06).add(0.94);
    const beaconPulse = oscSine(time.mul(1.2).add(phase)).mul(0.5).add(0.5);
    // Beacons pulse strongly; windows flicker faintly.
    const flicker = mix(windowFlicker, beaconPulse, beacon);
    const emit = baseIntensity.mul(flicker).mul(uNightFactor);
    return vec3(shoreColor).mul(emit);
  })();

  material.colorNode = colorNode;
  material.opacityNode = Fn(() => uNightFactor.clamp(0, 1))();
  material.sizeNode = float(pointSize);

  const points = new THREE.Points(geometry, material);

  return {
    object: points,
    update(nightFactor: number): void {
      uNightFactor.value = Math.max(0, Math.min(1, nightFactor));
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
