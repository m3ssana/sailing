/**
 * Procedural noise primitives for TSL materials.
 *
 * All noise is built from TSL math operations (sin, fract, dot) so the same
 * code compiles to both WGSL (WebGPU) and GLSL (WebGL2) without raw shader
 * files. Per art-direction.md §3.3: maximum 4 noise octaves.
 */

import { Fn, float, vec2, vec3 } from 'three/tsl';
import type { TSLNode, TSLFn } from 'three/tsl';

/**
 * 2D hash — pseudo-random float from a vec2 input.
 * Classic sin-dot hash, good enough for procedural variation within
 * the constrained roughness/color limits of art-direction.md §3.3.
 */
export const hash2D: TSLFn = Fn((args) => {
  const p = args[0] as TSLNode;
  return p.dot(vec2(12.9898, 78.233)).sin().mul(43758.5453).fract();
});

/**
 * 3D hash — pseudo-random float from a vec3 input.
 */
export const hash3D: TSLFn = Fn((args) => {
  const p = args[0] as TSLNode;
  return p.dot(vec3(12.9898, 78.233, 45.543)).sin().mul(43758.5453).fract();
});

/**
 * Value noise 2D — smooth interpolated noise from a 2D coordinate.
 * Uses bilinear interpolation of hashed grid corners.
 */
export const valueNoise2D: TSLFn = Fn((args) => {
  const p = args[0] as TSLNode;
  const i = p.floor();
  const f = p.fract();

  // Smoothstep-like interpolation: 3f^2 - 2f^3
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));

  // Hash four corners
  const a = hash2D(i);
  const b = hash2D(i.add(vec2(1.0, 0.0)));
  const c = hash2D(i.add(vec2(0.0, 1.0)));
  const d = hash2D(i.add(vec2(1.0, 1.0)));

  // Bilinear interpolation using mix chains
  const ux = u.dot(vec2(1.0, 0.0));
  const uy = u.dot(vec2(0.0, 1.0));
  const ab = a.mix(b, ux);
  const cd = c.mix(d, ux);
  return ab.mix(cd, uy);
});

/**
 * Simple FBM (fractal Brownian motion) over valueNoise2D.
 * Limited to 4 octaves max per art-direction.md §3.3.
 *
 * @param p - 2D coordinate node
 * @param octaves - number of octaves (1–4 as a JS number, not TSL node)
 * @param lacunarity - frequency multiplier per octave (default 2.0)
 * @param gain - amplitude decay per octave (default 0.5)
 */
export function fbm2D(
  p: TSLNode,
  octaves: number,
  lacunarity = 2.0,
  gain = 0.5,
): TSLNode {
  const clampedOctaves = Math.min(Math.max(octaves, 1), 4);
  let value: TSLNode = float(0.0);
  let amplitude = 1.0;
  let frequency = 1.0;

  for (let i = 0; i < clampedOctaves; i++) {
    value = value.add(valueNoise2D(p.mul(frequency)).mul(amplitude));
    frequency *= lacunarity;
    amplitude *= gain;
  }

  return value;
}
