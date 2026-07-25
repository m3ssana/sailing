/**
 * Carbon fibre material — weave pattern from a rotated-checker basis at very
 * low amplitude.
 *
 * Art-direction.md §3.2:
 * - Roughness: 0.20–0.30
 * - Metalness: 0.0
 * - Weave pattern: rotated checker at very low amplitude
 * - Viewed > 5m, reads as smooth dark surface
 *
 * Detail params (all optional):
 * - weaveScale: spatial frequency of weave (default 40)
 * - weaveAngle: rotation angle of weave in radians (default 0.785 = 45°)
 * - weaveContrast: lightness variation of weave (default 0.03, per §3.3 max ±3%)
 */

import * as THREE from 'three/webgpu';
import { uniform, vec3, vec2, float, positionLocal } from 'three/tsl';
import type { MaterialParams } from '@/types';
import { applyWetSurface } from './wetSurface';

export function buildCarbon(params: MaterialParams): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();

  const baseColor = uniform(new THREE.Color(params.baseColor.r, params.baseColor.g, params.baseColor.b));
  const roughness = uniform(params.roughness);
  const wetness = uniform(0.0);

  const detail = params.detail;
  const weaveScale = detail?.['weaveScale'] ?? 40;
  const weaveAngle = detail?.['weaveAngle'] ?? 0.785;
  const weaveContrast = Math.min(detail?.['weaveContrast'] ?? 0.03, 0.03);

  // Create rotated-checker weave pattern.
  // Rotate the UV coordinates by weaveAngle, then create alternating bands.
  const cosA = Math.cos(weaveAngle);
  const sinA = Math.sin(weaveAngle);

  // Project local position onto rotated 2D plane for the weave
  const posXZ = vec2(positionLocal.dot(vec3(1, 0, 0)), positionLocal.dot(vec3(0, 0, 1)));
  const rotated = vec2(
    posXZ.dot(vec2(cosA, -sinA)),
    posXZ.dot(vec2(sinA, cosA)),
  );

  // Checker pattern: alternating ±weaveContrast bands
  const scaled = rotated.mul(weaveScale);
  const checkerX = scaled.dot(vec2(1.0, 0.0)).floor();
  const checkerY = scaled.dot(vec2(0.0, 1.0)).floor();
  // XOR of even/odd produces checker
  const checker = checkerX.add(checkerY).mul(0.5).fract().sub(0.25).sign();
  // Map to subtle ±weaveContrast range
  const weaveModulation = checker.mul(weaveContrast);

  // Apply weave modulation to base color
  const colorNode = baseColor.add(vec3(weaveModulation, weaveModulation, weaveModulation));

  // Apply wet-surface darkening
  const wet = applyWetSurface(colorNode, roughness, wetness);

  material.colorNode = wet.color;
  material.roughnessNode = wet.roughness;
  material.metalnessNode = float(params.metalness);

  return material;
}
