/**
 * Sailcloth material — matte, translucent fabric with panel seam lines.
 *
 * Art-direction.md §3.2:
 * - Roughness: 0.70–0.85
 * - Metalness: 0.0
 * - Panel seam lines as subtle darkening, not geometry
 * - Visible warp/weft only on close inspection (< 3m)
 *
 * Detail params (all optional):
 * - panelWidth: width of cloth panels for seam spacing (default 0.5 metres)
 * - seamDarkening: albedo reduction at seams (default 0.05)
 * - seamSharpness: edge sharpness of seam lines (default 30)
 * - weftScale: warp/weft fabric texture frequency (default 200)
 * - weftStrength: warp/weft roughness variation (default 0.02)
 */

import * as THREE from 'three/webgpu';
import { uniform, vec3, float, positionLocal } from 'three/tsl';
import type { MaterialParams } from '@/types';
import { hash3D } from './noise';
import { applyWetSurface } from './wetSurface';

export function buildSailcloth(params: MaterialParams): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();

  const baseColor = uniform(new THREE.Color(params.baseColor.r, params.baseColor.g, params.baseColor.b));
  const roughness = uniform(params.roughness);
  const wetness = uniform(0.0);

  const detail = params.detail;
  const panelWidth = detail?.['panelWidth'] ?? 0.5;
  const seamDarkening = detail?.['seamDarkening'] ?? 0.05;
  const seamSharpness = detail?.['seamSharpness'] ?? 30;
  const weftScale = detail?.['weftScale'] ?? 200;
  const weftStrength = Math.min(detail?.['weftStrength'] ?? 0.02, 0.05);

  // Panel seam lines: subtle darkening at regular intervals along the sail.
  // Seams run roughly perpendicular to the luff, so we use the Y component
  // of local position as the seam direction.
  const seamCoord = positionLocal.dot(vec3(0, 1, 0)).div(panelWidth);
  // Distance to nearest seam centre (fract gives [0,1] within each panel)
  const seamDist = seamCoord.fract().sub(0.5).abs();
  // Sharpen into a narrow dark line near seam boundaries.
  // seamDist ranges from 0 (at seam) to 0.5 (mid-panel).
  // Linear falloff: saturate(1 - seamDist * seamSharpness) gives a line at edges.
  const seamLine = float(1.0).sub(seamDist.mul(seamSharpness).clamp(0, 1)).mul(seamDarkening);

  // Warp/weft texture: very subtle roughness variation at high frequency
  const weftPos = positionLocal.mul(weftScale);
  const weftNoise = hash3D(weftPos).sub(0.5).mul(weftStrength);

  // Apply seam darkening to color
  const colorNode = baseColor.mul(float(1.0).sub(seamLine));

  // Roughness with weft variation
  const roughnessNode = roughness.add(weftNoise);

  // Apply wet-surface darkening
  const wet = applyWetSurface(colorNode, roughnessNode, wetness);

  material.colorNode = wet.color;
  material.roughnessNode = wet.roughness;
  material.metalnessNode = float(params.metalness);

  return material;
}
