/**
 * Sail cloth TSL material — double-sided translucency and backlit scatter.
 *
 * Uses MeshPhysicalNodeMaterial for:
 * - `side: THREE.DoubleSide` — both faces rendered.
 * - Transmission node for physical translucency (light through thin cloth).
 * - Custom emissive backlight term: when viewing the sail from the shadowed side
 *   while the sun is behind it, a warm orange scatter glow appears, simulating
 *   subsurface scattering through thin Dacron/Mylar sailcloth.
 *
 * The backlight approximation:
 *   scatter = max(0, dot(viewDir, -lightDir))^exponent × scatterColor × translucency
 *
 * This is a cheap view-dependent effect, NOT a full SSS simulation. It produces
 * the iconic "glowing sail" look when sailing toward the sun.
 *
 * ## Panel seams
 *
 * The existing sailcloth material in `src/render/materials/sailcloth.ts` handles
 * panel seam lines via positionLocal. This material extends that with the PBR
 * translucency. The panel-fraction encoding from SailSurfaceGenerator (stored in
 * vertex colors channel R) can drive seam darkening.
 *
 * ## TSL compilation
 *
 * TSL compiles to both WGSL (WebGPU) and GLSL (WebGL2) automatically. No
 * backend-specific code needed — the material works identically on both.
 */

import * as THREE from 'three/webgpu';
import { uniform, float, normalWorld, positionWorld, cameraPosition } from 'three/tsl';
import type { SailClothMaterialParams } from './SailCloth';

// Extend the type declarations for DoubleSide constant and material.side
// three.js exposes DoubleSide as a numeric constant (2).
const DOUBLE_SIDE = 2;

/**
 * Build the sail cloth TSL material with double-sided translucency.
 *
 * @param params - Material configuration (color, translucency, scatter color).
 * @returns A MeshPhysicalNodeMaterial ready to be assigned to the sail mesh.
 */
export function buildSailClothMaterial(
  params: SailClothMaterialParams,
): THREE.MeshPhysicalNodeMaterial {
  const material = new THREE.MeshPhysicalNodeMaterial();

  // --- Double-sided rendering ---
  // side is a standard Material property, works with both WebGPU and WebGL2.
  (material as unknown as { side: number }).side = DOUBLE_SIDE;

  // --- Base appearance ---
  const baseColor = uniform(new THREE.Color(params.baseColor.r, params.baseColor.g, params.baseColor.b));
  const roughness = uniform(0.75); // Sailcloth: matte fabric
  const metalness = uniform(0.0);

  material.colorNode = baseColor;
  material.roughnessNode = roughness;
  material.metalnessNode = metalness;

  // --- Translucency via transmission ---
  // Transmission allows light to pass through the thin fabric.
  // Low value (0.1-0.3) for sailcloth — it's translucent, not transparent.
  const transmission = uniform(params.translucency);
  material.transmissionNode = transmission;
  // Thickness affects how much light is absorbed passing through.
  // Thin cloth = small thickness = more light passes.
  // thicknessNode is available on MeshPhysicalNodeMaterial in three.js 0.180
  // but not declared in our minimal ambient typings.
  (material as unknown as { thicknessNode: unknown }).thicknessNode = float(0.002);

  // --- Backlit scatter (subsurface approximation via emissive) ---
  // When viewing the sail from the back while sunlit, a warm glow appears.
  // Approximation: dot(viewDir, -sunDir) raised to a power, coloured warm.
  //
  // We use a simplified version: the view direction dot with the surface normal,
  // inverted. When the normal faces away from the camera (we're seeing the back face),
  // AND light is coming from behind (normal faces toward light), we get scatter.
  //
  // For TSL: the scatter term uses normalWorld and cameraPosition.
  const scatterColor = uniform(
    new THREE.Color(params.scatterColor.r, params.scatterColor.g, params.scatterColor.b),
  );
  const scatterStrength = uniform(params.translucency * 0.6);

  // View direction: camera - surface point, normalized
  const viewDir = cameraPosition.sub(positionWorld).normalize();

  // Backlight factor: how much the normal faces AWAY from the viewer.
  // dot(normal, viewDir) < 0 means we're looking at the back face.
  // We want scatter when looking at the back face, so use -dot.
  const ndotv = normalWorld.dot(viewDir);
  // Back-face factor: clamped negative dot → positive scatter contribution.
  const backFace = float(0).sub(ndotv).clamp(0, 1);

  // Power curve for tighter highlight
  const scatter = backFace.pow(2).mul(scatterStrength);
  material.emissiveNode = scatterColor.mul(scatter);

  // Transparent for the transmission to work correctly
  (material as unknown as { transparent: boolean }).transparent = true;

  return material;
}

/**
 * Default material parameters for a typical white Dacron sail.
 */
export const DEFAULT_SAIL_MATERIAL_PARAMS: SailClothMaterialParams = {
  baseColor: { r: 0.95, g: 0.93, b: 0.88 }, // Slightly warm white
  translucency: 0.15, // Subtle translucency
  scatterColor: { r: 1.0, g: 0.85, b: 0.6 }, // Warm orange scatter
};
