/**
 * Concrete material — flat grey seawalls and docks.
 *
 * Art-direction.md §3.2:
 * - Roughness: 0.80–0.90
 * - Metalness: 0.0
 * - Flat grey, no cracks, no staining
 *
 * Detail params (all optional):
 * - surfaceScale: frequency of subtle surface variation (default 10)
 * - surfaceStrength: roughness noise amplitude (default 0.03, per §3.3 max ±0.05)
 */

import * as THREE from 'three/webgpu';
import { uniform, vec3, float, positionLocal } from 'three/tsl';
import type { MaterialParams } from '@/types';
import { hash3D } from './noise';
import { applyWetSurface } from './wetSurface';

export function buildConcrete(params: MaterialParams): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();

  const baseColor = uniform(new THREE.Color(params.baseColor.r, params.baseColor.g, params.baseColor.b));
  const roughness = uniform(params.roughness);
  const wetness = uniform(0.0);

  const detail = params.detail;
  const surfaceScale = detail?.['surfaceScale'] ?? 10;
  const surfaceStrength = Math.min(detail?.['surfaceStrength'] ?? 0.03, 0.05);

  // Subtle large-scale roughness variation simulating aggregate and pore
  // distribution in cast concrete — per §3.3, no noise-as-albedo.
  const noisePos = positionLocal.mul(surfaceScale);
  const surfaceNoise = hash3D(noisePos).sub(0.5).mul(surfaceStrength);

  const roughnessNode = roughness.add(surfaceNoise);

  // Very subtle colour variation (within ±3% lightness per §3.3)
  const colorNoise = hash3D(noisePos.mul(0.3)).sub(0.5).mul(0.02);
  const colorNode = baseColor.add(vec3(colorNoise, colorNoise, colorNoise));

  // Apply wet-surface darkening
  const wet = applyWetSurface(colorNode, roughnessNode, wetness);

  material.colorNode = wet.color;
  material.roughnessNode = wet.roughness;
  material.metalnessNode = float(params.metalness);

  return material;
}
