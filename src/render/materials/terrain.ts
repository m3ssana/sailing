/**
 * Terrain material — colour by slope and altitude.
 *
 * Art-direction.md §3.2:
 * - Rock/earth: roughness 0.75–0.90, metalness 0.0
 * - Sand/beach: roughness 0.85–0.95
 * - No displacement mapping
 * - Colour by altitude and slope
 *
 * The baseColor from MaterialParams is used as the primary land colour.
 * The detail params allow optional slope-based blending.
 *
 * Detail params (all optional):
 * - slopeThreshold: normal.y below which rock colour is used (default 0.7)
 * - slopeBlend: blend range for slope transition (default 0.1)
 * - rockRoughness: roughness of steep rock faces (default 0.85)
 * - altitudeScale: scale factor for altitude-based colour shift (default 0.001)
 */

import * as THREE from 'three/webgpu';
import { uniform, vec3, float, positionLocal, normalLocal } from 'three/tsl';
import type { MaterialParams } from '@/types';
import { hash3D } from './noise';
import { applyWetSurface } from './wetSurface';

export function buildTerrain(params: MaterialParams): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();

  const baseColor = uniform(new THREE.Color(params.baseColor.r, params.baseColor.g, params.baseColor.b));
  const roughness = uniform(params.roughness);
  const wetness = uniform(0.0);

  const detail = params.detail;
  const slopeThreshold = detail?.['slopeThreshold'] ?? 0.7;
  const slopeBlend = detail?.['slopeBlend'] ?? 0.1;
  const rockRoughness = detail?.['rockRoughness'] ?? 0.85;
  const altitudeScale = detail?.['altitudeScale'] ?? 0.001;

  // Slope detection: normalLocal.y gives the cosine of the surface angle
  // with the vertical. Flat ground → 1.0, vertical cliff → 0.0.
  const slopeY = normalLocal.dot(vec3(0, 1, 0));

  // Slope factor: 0 = flat ground (use base colour), 1 = steep rock
  const slopeFactor = float(1.0).sub(
    slopeY.sub(slopeThreshold).div(slopeBlend).clamp(0.0, 1.0),
  );

  // Rock colour: darker/greyer version of base colour
  const rockColor = baseColor.mul(0.6);

  // Altitude-based lightening: higher terrain gets slightly lighter
  const altitude = positionLocal.dot(vec3(0, 1, 0)).mul(altitudeScale).clamp(0.0, 0.1);
  const altitudeShift = vec3(altitude, altitude, altitude);

  // Blend base colour with rock based on slope
  const terrainColor = baseColor.add(altitudeShift).mix(rockColor, slopeFactor);

  // Add very subtle noise to break uniformity (within §3.3 limits)
  const noisePos = positionLocal.mul(5.0);
  const terrainNoise = hash3D(noisePos).sub(0.5).mul(0.02);
  const colorNode = terrainColor.add(vec3(terrainNoise, terrainNoise, terrainNoise));

  // Roughness: blend between base and rock roughness based on slope
  const roughnessNode = roughness.mix(float(rockRoughness), slopeFactor);

  // Apply wet-surface darkening
  const wet = applyWetSurface(colorNode, roughnessNode, wetness);

  material.colorNode = wet.color;
  material.roughnessNode = wet.roughness;
  material.metalnessNode = float(params.metalness);

  return material;
}
