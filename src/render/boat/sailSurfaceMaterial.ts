/**
 * Sail surface material for the rendered boat (I.1 BoatView).
 *
 * The first browser run showed the main as a flat, uniform, translucent GREY
 * triangle: the generic `buildSailcloth` material is single-sided, so the chase
 * camera (astern of a boat sailing away) saw the unlit BACK face, and it carried
 * no seam detail. This builder produces the sailcloth the art direction calls
 * for (§3.2):
 *
 *  - **Two-sided** (`side = DoubleSide`) so the sail reads as cloth from either
 *    side — a sail is lit on both faces, and the camera routinely sees the back.
 *  - **Cream/white cloth** base colour with a touch of warmth.
 *  - **Panel seam lines** as subtle albedo darkening, driven by the panel
 *    fraction the generator bakes into the vertex-colour R channel (so the seams
 *    follow the real panel layout, not an arbitrary world grid).
 *  - A mild **backlit translucency glow** (emissive) so the sail glows softly
 *    when the sun is behind it — the iconic sunlit-sail look.
 *  - Matte roughness (0.7) and zero metalness.
 *
 * The camber + twist the player sees come from the sail GEOMETRY: the
 * `SailSurfaceGenerator` bakes luff round (camber) and designed twist into the
 * rest mesh. A full pressure-driven PBD deformation (`src/render/cloth/`) is a
 * richer future wiring; this material makes the baked-in shape read correctly
 * and is a labelled step up from the flat grey placeholder.
 *
 * Conventions: linear RGB; TSL `mix(a,b,t)` free function (never the `.mix`
 * method — the Stream F trap); imports three from `three/webgpu` + `three/tsl`.
 */

import * as THREE from 'three/webgpu';
import {
  float,
  vec3,
  mix,
  uniform,
  attribute,
  normalWorld,
  positionWorld,
  cameraPosition,
} from 'three/tsl';
import type { TSLNode } from 'three/tsl';
import type { RGB } from '@/types';

/** three.js DoubleSide constant (not in the minimal ambient typings). */
const DOUBLE_SIDE = 2;

export interface SailSurfaceMaterialParams {
  /** Base cloth colour (linear). Default warm cream. */
  baseColor?: RGB;
  /** Number of panels across the girth (for seam spacing). Default 5. */
  panelCount?: number;
}

/**
 * Build the two-sided cream sail material. The seam lines use the vertex-colour
 * R channel (panel fraction, 0..1 sawtooth across the girth) written by
 * `SailSurfaceGenerator`, darkening the albedo near each panel boundary.
 */
export function buildSailSurfaceMaterial(
  params: SailSurfaceMaterialParams = {},
): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();
  (material as unknown as { side: number }).side = DOUBLE_SIDE;

  const base = params.baseColor ?? { r: 0.92, g: 0.9, b: 0.84 };
  const uBase = uniform(new THREE.Color(base.r, base.g, base.b));

  // Panel fraction (0..1 across each panel) from the generator's vertex colour
  // R channel. A seam sits where the fraction wraps (near 0 and near 1); darken
  // a narrow band there.
  const panelFrac = attribute('color', 'vec3').x;
  const seamDist = panelFrac.sub(0.5).abs(); // 0 at panel centre, 0.5 at seam
  // Narrow dark line near the seam (seamDist → 0.5). saturate(1 - (0.5-d)*k).
  const seam = float(0.5).sub(seamDist).mul(26).clamp(0, 1).mul(0.14);
  const colorNode: TSLNode = uBase.mul(float(1.0).sub(seam));

  material.colorNode = colorNode;
  material.roughnessNode = float(0.72);
  material.metalnessNode = float(0.0);

  // Backlit glow: when the camera looks toward the sun through the sail (back
  // face toward viewer) a soft warm scatter appears. Approximated from the
  // view/normal geometry (no sun uniform needed — cheap and view-stable).
  const scatterColor = vec3(0.9, 0.82, 0.68);
  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const backFace = float(0).sub(normalWorld.dot(viewDir)).clamp(0, 1);
  const glow = backFace.pow(2).mul(0.12);
  material.emissiveNode = mix(vec3(0, 0, 0), scatterColor, glow);

  return material;
}
