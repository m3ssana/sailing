/**
 * Moored fleet generator — D.9.
 *
 * Produces a small set of low-poly hull variants suitable for GPU instancing by
 * the render layer. Reuses D.2's StationLofter at reduced resolution:
 *
 * LOD parameters chosen:
 * - lengthSegments: 6 (vs. typical 24–32 for a player boat → ~1/4 to 1/5)
 * - girthSegments: 5 (vs. typical 16–20 for a player boat → ~1/4)
 *
 * This keeps triangle counts in the 200–400 range per variant, which is ample
 * for a distant moored yacht silhouette, and enables instancing hundreds of
 * moored boats at near-zero per-instance GPU cost.
 *
 * CONTRACT: The output is structured for instancing. The render layer (not yet
 * built) receives `variants: GeneratedMesh[]` — a small number (typically 3–5)
 * of distinct hull meshes. It should instance each variant across the mooring
 * positions, randomly assigning a variant per slot, so that the fleet appears
 * varied without requiring unique geometry per boat.
 *
 * Engine-agnostic — no three.js.
 */

import type {
  GeneratedMesh,
  GeneratedModel,
  Generator,
  HullParams,
  Seed,
  StationCurve,
  Vec2,
} from '@/types';
import { createRandom, hashCombine } from '@core/math';
import { StationLofter } from '../hull/StationLofter';

// ─── LOD parameters (1/4 of typical player-boat resolution) ─────────────────

/** Length segments for moored fleet hulls (player boat typically uses 24–32). */
const LOD_LENGTH_SEGMENTS = 6;
/** Girth segments for moored fleet hulls (player boat typically uses 16–20). */
const LOD_GIRTH_SEGMENTS = 5;

// ─── Params ──────────────────────────────────────────────────────────────────

export interface MooredFleetParams {
  /** Number of distinct hull variants to produce (for instancing variety). */
  variantCount: number;
  /** Base length overall, metres. Variants randomise ±15% around this. */
  baseLoa: number;
  /** Base beam, metres. Variants randomise ±10% around this. */
  baseBeam: number;
}

// ─── Default station curves for a generic moored yacht ───────────────────────

/**
 * Minimal station set for a plausible small-yacht hull silhouette.
 * 6 stations, ordered bow to stern, in half-breadth coordinates.
 * Each point: x = half-beam fraction (0..1 of beam/2), y = height from keel.
 */
function makeGenericYachtStations(_loa: number, beam: number, draft: number): StationCurve[] {
  const halfBeam = beam / 2;
  // Scale points by actual hull dimensions
  const scale = (pts: Array<[number, number]>): Vec2[] =>
    pts.map(([xFrac, yFrac]) => ({
      x: xFrac * halfBeam,
      y: yFrac * (draft + 0.3), // slight freeboard above waterline
    }));

  return [
    { position: 0.0, points: scale([[0, 0], [0.05, 0.3], [0.15, 0.6], [0.2, 1.0]]) }, // bow (narrow)
    { position: 0.15, points: scale([[0, 0], [0.3, 0.3], [0.55, 0.6], [0.6, 1.0]]) },
    { position: 0.35, points: scale([[0, 0], [0.6, 0.25], [0.85, 0.6], [0.95, 1.0]]) }, // max beam
    { position: 0.55, points: scale([[0, 0], [0.6, 0.25], [0.85, 0.6], [0.95, 1.0]]) },
    { position: 0.75, points: scale([[0, 0], [0.45, 0.3], [0.7, 0.6], [0.75, 1.0]]) },
    { position: 1.0, points: scale([[0, 0], [0.2, 0.35], [0.35, 0.65], [0.4, 1.0]]) }, // stern (narrower)
  ];
}

// ─── Generator ───────────────────────────────────────────────────────────────

export const MooredFleetGenerator: Generator<MooredFleetParams, GeneratedModel> = {
  id: 'ambient-moored-fleet',

  generate(params: MooredFleetParams, seed: Seed): GeneratedModel {
    const { variantCount, baseLoa, baseBeam } = params;
    const rng = createRandom(seed);

    const meshes: GeneratedMesh[] = [];

    for (let i = 0; i < variantCount; i++) {
      // Vary dimensions per variant using seeded randomness
      const variantSeed = hashCombine(seed, i);
      const variantRng = createRandom(variantSeed);

      const loa = baseLoa * variantRng.range(0.85, 1.15);
      const beam = baseBeam * variantRng.range(0.9, 1.1);
      const draft = loa * variantRng.range(0.08, 0.12); // draft ~8–12% of LOA

      const hullParams: HullParams = {
        loa,
        beam,
        designDraft: draft,
        waterlineHeight: draft * 0.85,
        stations: makeGenericYachtStations(loa, beam, draft),
        bilge: rng.chance(0.7) ? 'round' : 'chine',
        hullCount: 1,
        sheerRise: variantRng.range(0.02, 0.05),
        deckCamber: variantRng.range(0.01, 0.03),
        lengthSegments: LOD_LENGTH_SEGMENTS,
        girthSegments: LOD_GIRTH_SEGMENTS,
      };

      // Use StationLofter at low resolution
      const model = StationLofter.generate(hullParams, variantSeed);
      const mesh = model.meshes[0];
      if (mesh !== undefined) {
        meshes.push(mesh);
      }
    }

    return {
      meshes,
      groups: meshes.map((_, idx) => ({
        name: `moored-variant-${idx}`,
        start: 0,
        count: meshes[idx]?.indices.length ?? 0,
        materialId: 'gelcoat',
      })),
      transferables: [],
    };
  },
};
