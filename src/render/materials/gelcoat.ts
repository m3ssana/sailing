/**
 * Gelcoat material — smooth marine hull finish with subtle orange-peel normal
 * perturbation and optional metallic flake sparkle.
 *
 * Art-direction.md §3.2:
 * - Roughness: 0.25–0.35
 * - Metalness: 0.0
 * - Orange-peel normal perturbation at 0.002 amplitude max
 * - Flake sparkle in metallic colours only
 *
 * Detail params (all optional with sensible defaults):
 * - orangePeelScale: spatial frequency of orange-peel (default 80)
 * - orangePeelAmplitude: normal perturbation amplitude (default 0.002)
 * - flakeDensity: sparkle density for metallic colours (default 0, 0 = no flake)
 * - flakeScale: spatial frequency of flake pattern (default 200)
 */

import * as THREE from 'three/webgpu';
import { uniform, vec3, float, positionLocal } from 'three/tsl';
import type { TSLNode } from 'three/tsl';
import type { MaterialParams } from '@/types';
import { hash3D } from './noise';
import { applyWetSurface } from './wetSurface';

export function buildGelcoat(params: MaterialParams): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();

  const baseColor = uniform(new THREE.Color(params.baseColor.r, params.baseColor.g, params.baseColor.b));
  const roughness = uniform(params.roughness);
  const wetness = uniform(0.0);

  const detail = params.detail;
  const orangePeelScale = detail?.['orangePeelScale'] ?? 80;
  const orangePeelAmplitude = detail?.['orangePeelAmplitude'] ?? 0.002;
  const flakeDensity = detail?.['flakeDensity'] ?? 0;
  const flakeScale = detail?.['flakeScale'] ?? 200;

  // Orange-peel micro-normal perturbation: subtle low-frequency noise
  // applied to the surface normal to simulate the slight undulation of
  // sprayed gelcoat. Per art-direction: max 0.002 amplitude.
  const clampedAmplitude = Math.min(orangePeelAmplitude, 0.002);
  const pos = positionLocal.mul(orangePeelScale);
  const orangePeelNoise = hash3D(pos).sub(0.5).mul(clampedAmplitude);
  const perturbedNormal = vec3(
    orangePeelNoise,
    orangePeelNoise.mul(0.7),
    float(1.0),
  ).normalize();

  // Flake sparkle: high-frequency hash creates rare bright spots
  let colorNode: TSLNode = baseColor;
  if (flakeDensity > 0) {
    const flakePos = positionLocal.mul(flakeScale);
    const flakeHash = hash3D(flakePos);
    // Only activate sparkle where hash exceeds threshold
    const threshold = 1.0 - Math.min(flakeDensity, 0.1);
    const sparkle = flakeHash.sub(threshold).clamp(0.0, 1.0).mul(10.0).clamp(0.0, 1.0);
    // Brighten base color by sparkle
    colorNode = baseColor.add(vec3(sparkle, sparkle, sparkle).mul(0.3));
  }

  // Apply wet-surface darkening
  const wet = applyWetSurface(colorNode, roughness, wetness);

  material.colorNode = wet.color;
  material.roughnessNode = wet.roughness;
  material.metalnessNode = float(params.metalness);
  material.normalNode = perturbedNormal;

  return material;
}
