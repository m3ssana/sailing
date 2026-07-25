/**
 * Anodized aluminium material — matte metallic finish for spars and hardware.
 *
 * Art-direction.md §3.2:
 * - Roughness: 0.35–0.45
 * - Metalness: 0.8
 * - No scratches, no corrosion
 *
 * Detail params (all optional):
 * - grainScale: subtle directional grain frequency (default 60)
 * - grainStrength: roughness variation from grain (default 0.02, per §3.3 max ±0.05)
 */

import * as THREE from 'three/webgpu';
import { uniform, vec3, float, positionLocal } from 'three/tsl';
import type { MaterialParams } from '@/types';
import { hash3D } from './noise';
import { applyWetSurface } from './wetSurface';

export function buildAnodized(params: MaterialParams): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();

  const baseColor = uniform(new THREE.Color(params.baseColor.r, params.baseColor.g, params.baseColor.b));
  const roughness = uniform(params.roughness);
  const wetness = uniform(0.0);

  const detail = params.detail;
  const grainScale = detail?.['grainScale'] ?? 60;
  const grainStrength = Math.min(detail?.['grainStrength'] ?? 0.02, 0.05);

  // Subtle directional grain — anodized metal has a fine brushed appearance
  // along the extrusion/machining direction (Y axis for spars).
  // Use position-based hash with elongated scale on Y to produce streaks.
  const grainPos = vec3(
    positionLocal.dot(vec3(1, 0, 0)).mul(grainScale),
    positionLocal.dot(vec3(0, 1, 0)).mul(grainScale * 0.2),
    positionLocal.dot(vec3(0, 0, 1)).mul(grainScale),
  );
  const grainNoise = hash3D(grainPos).sub(0.5).mul(grainStrength);

  // Roughness varies slightly along grain direction
  const roughnessNode = roughness.add(grainNoise);

  // Apply wet-surface darkening
  const wet = applyWetSurface(baseColor, roughnessNode, wetness);

  material.colorNode = wet.color;
  material.roughnessNode = wet.roughness;
  material.metalnessNode = float(params.metalness);

  return material;
}
