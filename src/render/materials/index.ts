/**
 * Procedural TSL material library — the top-level dispatcher.
 *
 * Consumes the frozen `MaterialParams` contract from `src/types/generation.ts`
 * and produces a three.js `MeshStandardNodeMaterial` with TSL node graphs for
 * color, roughness, metalness, and (where applicable) normals.
 *
 * ## Scoping decision
 *
 * Despite tasks.md listing D.8 under Stream D (Generation), the actual TSL node
 * construction code lives here under `src/render/materials/` because:
 * - TSL (`three/tsl`) is a three.js API.
 * - The ESLint-enforced import boundary prohibits `src/generation/` from
 *   importing three.js.
 * - Only `src/render/` may import three.js.
 *
 * The `MaterialParams` plain-data contract remains the interface between
 * generation (engine-agnostic) and rendering (three.js-dependent).
 *
 * ## Design
 *
 * - Each material kind has its own builder module.
 * - Base color, roughness, and metalness are TSL uniforms, so they can be
 *   updated at runtime (e.g. for BoatDefinition.appearance customisation).
 * - All materials support wet-surface darkening via a shared helper.
 * - Materials render identically on WebGPU and WebGL2 because TSL compiles
 *   to both WGSL and GLSL.
 */

import type * as THREE from 'three/webgpu';
import type { MaterialParams } from '@/types';
import { buildGelcoat } from './gelcoat';
import { buildCarbon } from './carbon';
import { buildAnodized } from './anodized';
import { buildSailcloth } from './sailcloth';
import { buildTeak } from './teak';
import { buildTerrain } from './terrain';
import { buildConcrete } from './concrete';
import { buildWater } from './water';

/**
 * Build a procedural TSL node material from a MaterialParams descriptor.
 *
 * @param params - The material parameters (kind, baseColor, roughness, metalness, detail).
 * @returns A MeshStandardNodeMaterial with TSL node graphs wired for the given kind.
 * @throws If params.kind is unrecognised (exhaustive switch).
 */
export function buildProceduralMaterial(params: MaterialParams): THREE.MeshStandardNodeMaterial {
  switch (params.kind) {
    case 'gelcoat':
      return buildGelcoat(params);
    case 'carbon':
      return buildCarbon(params);
    case 'anodized':
      return buildAnodized(params);
    case 'sailcloth':
      return buildSailcloth(params);
    case 'teak':
      return buildTeak(params);
    case 'terrain':
      return buildTerrain(params);
    case 'concrete':
      return buildConcrete(params);
    case 'water':
      return buildWater(params);
    default: {
      // Exhaustive check: TypeScript will error if a kind is missing from the switch.
      const _exhaustive: never = params.kind;
      throw new Error(`Unknown material kind: ${String(_exhaustive)}`);
    }
  }
}

export { buildGelcoat } from './gelcoat';
export { buildCarbon } from './carbon';
export { buildAnodized } from './anodized';
export { buildSailcloth } from './sailcloth';
export { buildTeak } from './teak';
export { buildTerrain } from './terrain';
export { buildConcrete } from './concrete';
export { buildWater } from './water';
export { applyWetSurface, applyWetColor, applyWetRoughness } from './wetSurface';
