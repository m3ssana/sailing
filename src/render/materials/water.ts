/**
 * Water material — PLACEHOLDER for the MaterialParams contract.
 *
 * Art-direction.md §3.2:
 * - Roughness: 0.0–0.05
 * - Metalness: 0.0
 * - GGX specular from wind-roughened normals — effectively variable
 *
 * TODO: Stream E.4 (Ocean Rendering) owns the full water shading feature set:
 * - Depth-dependent absorption and scattering
 * - Fresnel with proper IOR
 * - Screen-space reflections
 * - Refraction with depth
 * - Crest sub-surface scattering
 * - Sun/moon glitter
 * - Per-venue colour and turbidity
 *
 * This module provides ONLY a basic MaterialParams.kind='water' resolver that
 * sets base color, roughness, and metalness as TSL nodes. It does NOT implement
 * any of E.4's features. The full ocean material will replace this entirely.
 *
 * Detail params: none used in placeholder (E.4 will define its own).
 */

import * as THREE from 'three/webgpu';
import { uniform, float } from 'three/tsl';
import type { MaterialParams } from '@/types';

export function buildWater(params: MaterialParams): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();

  const baseColor = uniform(new THREE.Color(params.baseColor.r, params.baseColor.g, params.baseColor.b));
  const roughness = uniform(params.roughness);

  // Basic placeholder: just the flat PBR values from MaterialParams.
  // No wet-surface modifier — water IS the wet surface.
  material.colorNode = baseColor;
  material.roughnessNode = roughness;
  material.metalnessNode = float(params.metalness);

  return material;
}
