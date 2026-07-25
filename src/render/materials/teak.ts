/**
 * Teak material — wood decking with banded grain noise.
 *
 * Art-direction.md §3.2:
 * - Roughness: 0.55–0.70
 * - Metalness: 0.0
 * - Banded noise along the grain, max 3 visible bands per plank
 * - No knots
 *
 * Detail params (all optional):
 * - plankWidth: width of individual planks in metres (default 0.05)
 * - grainScale: grain band frequency along plank length (default 8)
 * - grainContrast: colour variation from grain (default 0.025, per §3.3 max ±3%)
 * - caulkDarkening: darkening at plank gaps (default 0.15)
 * - caulkWidth: relative width of caulk line (default 0.05)
 */

import * as THREE from 'three/webgpu';
import { uniform, vec3, float, positionLocal } from 'three/tsl';
import type { MaterialParams } from '@/types';
import { hash3D } from './noise';
import { applyWetSurface } from './wetSurface';

export function buildTeak(params: MaterialParams): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();

  const baseColor = uniform(new THREE.Color(params.baseColor.r, params.baseColor.g, params.baseColor.b));
  const roughness = uniform(params.roughness);
  const wetness = uniform(0.0);

  const detail = params.detail;
  const plankWidth = detail?.['plankWidth'] ?? 0.05;
  const grainScale = detail?.['grainScale'] ?? 8;
  const grainContrast = Math.min(detail?.['grainContrast'] ?? 0.025, 0.03);
  const caulkDarkening = detail?.['caulkDarkening'] ?? 0.15;
  const caulkWidth = detail?.['caulkWidth'] ?? 0.05;

  // Plank structure: repeat pattern across the X axis (athwartships)
  const plankCoord = positionLocal.dot(vec3(1, 0, 0)).div(plankWidth);
  const plankFract = plankCoord.fract();

  // Caulk lines at plank boundaries
  const caulkDist = plankFract.sub(0.5).abs();
  const halfCaulk = (1.0 - caulkWidth) * 0.5;
  // Dark caulk where caulkDist > halfCaulk (near edges)
  const caulkMask = caulkDist.sub(halfCaulk).clamp(0.0, 1.0).mul(1.0 / (caulkWidth * 0.5 + 0.001));

  // Grain bands: low-frequency sinusoidal variation along plank length (Z axis)
  // Limited to ~3 bands visible per plank by using low grainScale
  const grainCoord = positionLocal.dot(vec3(0, 0, 1)).mul(grainScale);

  // Add slight per-plank hash offset so bands don't align across planks
  const plankSeed = vec3(plankCoord.floor(), float(0.0), float(0.0));
  const plankOffset = hash3D(plankSeed);
  const grainWithOffset = grainCoord.add(plankOffset.mul(6.28)).sin().mul(0.5).add(0.5);

  // Combine: grain modulates color within ±grainContrast
  const grainMod = grainWithOffset.sub(0.5).mul(grainContrast);
  const woodColor = baseColor.add(vec3(grainMod, grainMod, grainMod));

  // Apply caulk darkening
  const colorNode = woodColor.mul(float(1.0).sub(caulkMask.mul(caulkDarkening)));

  // Apply wet-surface darkening
  const wet = applyWetSurface(colorNode, roughness, wetness);

  material.colorNode = wet.color;
  material.roughnessNode = wet.roughness;
  material.metalnessNode = float(params.metalness);

  return material;
}
