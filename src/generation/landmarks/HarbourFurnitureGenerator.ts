/**
 * Harbour furniture landmark generator — D.6.
 *
 * Produces small functional dockside structures: a pier/jetty with pilings,
 * and bollards. These items define harbour-side character at medium viewing
 * distance (200 m – 1 km).
 *
 * What is built:
 * - A flat rectangular pier deck on cylindrical pilings
 * - A row of bollards along the pier edge
 *
 * Geometry: origin-centred in local space. The pier deck is near Y=0 (raised
 * slightly), pilings extend downward.
 *
 * Closed-solid: Mixed — pilings are closed tubes (sweepTube with caps),
 * the deck is a closed extrusion, bollards are closed revolve solids.
 * The merged mesh is not watertight as a whole (separate objects), but
 * individual components are.
 *
 * Engine-agnostic — no three.js.
 */

import type { GeneratedMesh, GeneratedModel, Generator, Seed, Vec2, Vec3 } from '@/types';
import { sweepTube } from '../common/sweep';
import { extrudePolygon, revolve } from '../common/extrude';
import { chamferSize } from '../common/chamfer';
import { computeBounds, gatherTransferables, mergeMeshes } from '../common/meshUtils';

// ─── Params ──────────────────────────────────────────────────────────────────

/**
 * Parameters for the harbour furniture generator.
 *
 * | Param | Default | Description |
 * |---|---|---|
 * | pierLength | 30 | Length of the pier along X (metres) |
 * | pierWidth | 6 | Width of the pier along Z |
 * | pierHeight | 1.5 | Deck thickness |
 * | deckElevation | 2.0 | Height of deck above water (Y) |
 * | pilingRadius | 0.2 | Radius of each piling post |
 * | pilingDepth | 4 | How far pilings extend below deck |
 * | pilingSpacing | 5 | Spacing between pilings along the pier |
 * | numBollards | 4 | Number of bollards |
 * | bollardHeight | 0.6 | Height of each bollard |
 * | bollardRadius | 0.15 | Radius of each bollard |
 */
export interface HarbourFurnitureParams {
  pierLength: number;
  pierWidth: number;
  pierHeight: number;
  deckElevation: number;
  pilingRadius: number;
  pilingDepth: number;
  pilingSpacing: number;
  numBollards: number;
  bollardHeight: number;
  bollardRadius: number;
}

const DEFAULTS: HarbourFurnitureParams = {
  pierLength: 30,
  pierWidth: 6,
  pierHeight: 1.5,
  deckElevation: 2.0,
  pilingRadius: 0.2,
  pilingDepth: 4,
  pilingSpacing: 5,
  numBollards: 4,
  bollardHeight: 0.6,
  bollardRadius: 0.15,
};

function resolveParams(raw: Record<string, unknown>): HarbourFurnitureParams {
  return {
    pierLength: typeof raw['pierLength'] === 'number' ? raw['pierLength'] : DEFAULTS.pierLength,
    pierWidth: typeof raw['pierWidth'] === 'number' ? raw['pierWidth'] : DEFAULTS.pierWidth,
    pierHeight: typeof raw['pierHeight'] === 'number' ? raw['pierHeight'] : DEFAULTS.pierHeight,
    deckElevation: typeof raw['deckElevation'] === 'number' ? raw['deckElevation'] : DEFAULTS.deckElevation,
    pilingRadius: typeof raw['pilingRadius'] === 'number' ? raw['pilingRadius'] : DEFAULTS.pilingRadius,
    pilingDepth: typeof raw['pilingDepth'] === 'number' ? raw['pilingDepth'] : DEFAULTS.pilingDepth,
    pilingSpacing: typeof raw['pilingSpacing'] === 'number' ? raw['pilingSpacing'] : DEFAULTS.pilingSpacing,
    numBollards: typeof raw['numBollards'] === 'number' ? raw['numBollards'] : DEFAULTS.numBollards,
    bollardHeight: typeof raw['bollardHeight'] === 'number' ? raw['bollardHeight'] : DEFAULTS.bollardHeight,
    bollardRadius: typeof raw['bollardRadius'] === 'number' ? raw['bollardRadius'] : DEFAULTS.bollardRadius,
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const PILING_RADIAL_SEGMENTS = 8;
const PILING_PATH_STATIONS = 6;
const BOLLARD_SEGMENTS = 10;

// ─── Geometry helpers ────────────────────────────────────────────────────────

/** Translate a mesh in-place. */
function translateMesh(mesh: GeneratedMesh, dx: number, dy: number, dz: number): void {
  for (let i = 0; i < mesh.positions.length; i += 3) {
    mesh.positions[i] = (mesh.positions[i] ?? 0) + dx;
    mesh.positions[i + 1] = (mesh.positions[i + 1] ?? 0) + dy;
    mesh.positions[i + 2] = (mesh.positions[i + 2] ?? 0) + dz;
  }
}

/**
 * Build a bollard profile for revolve: a squat mushroom shape.
 * Profile: shaft rising to a wider cap.
 */
function bollardProfile(height: number, radius: number): Vec2[] {
  const shaftRadius = radius * 0.6;
  const capOverhang = radius;
  const capHeight = height * 0.25;
  const shaftHeight = height - capHeight;

  return [
    // Bottom centre (closes bottom)
    { x: 0, y: 0 },
    // Shaft base
    { x: shaftRadius, y: 0 },
    // Shaft top
    { x: shaftRadius, y: shaftHeight },
    // Cap underside
    { x: capOverhang, y: shaftHeight },
    // Cap top
    { x: capOverhang, y: height },
    // Cap top inset (rounded top)
    { x: capOverhang * 0.7, y: height },
    // Top centre (closes top)
    { x: 0, y: height },
  ];
}

// ─── Generator ───────────────────────────────────────────────────────────────

export const HarbourFurnitureGenerator: Generator<
  Record<string, unknown>,
  GeneratedModel
> = {
  id: 'harbourFurniture',

  generate(raw: Record<string, unknown>, _seed: Seed): GeneratedModel {
    const params = resolveParams(raw);
    const {
      pierLength,
      pierWidth,
      pierHeight,
      deckElevation,
      pilingRadius,
      pilingDepth,
      pilingSpacing,
      numBollards,
      bollardHeight,
      bollardRadius,
    } = params;

    const allMeshes: GeneratedMesh[] = [];

    // ── Pier deck (extruded rectangle)
    const halfLength = pierLength / 2;
    const halfWidth = pierWidth / 2;
    const bevel = chamferSize(pierLength);
    const deckOutline: Vec2[] = [
      { x: -halfLength, y: -halfWidth },
      { x: halfLength, y: -halfWidth },
      { x: halfLength, y: halfWidth },
      { x: -halfLength, y: halfWidth },
    ];
    const deckMesh = extrudePolygon(deckOutline, pierHeight, { bevel, bevelSegments: 1 });
    translateMesh(deckMesh, 0, deckElevation, 0);
    allMeshes.push(deckMesh);

    // ── Pilings (vertical cylinders below deck)
    const numPilingsAlongLength = Math.max(2, Math.floor(pierLength / pilingSpacing) + 1);
    const pilingRows = 2; // two rows: one each side of pier centre

    for (let i = 0; i < numPilingsAlongLength; i++) {
      const t = numPilingsAlongLength > 1 ? i / (numPilingsAlongLength - 1) : 0.5;
      const x = -halfLength + pierLength * t;

      for (let row = 0; row < pilingRows; row++) {
        const z = row === 0 ? -halfWidth * 0.7 : halfWidth * 0.7;
        const topY = deckElevation;
        const bottomY = deckElevation - pilingDepth;

        const path: Vec3[] = [];
        for (let s = 0; s < PILING_PATH_STATIONS; s++) {
          const st = PILING_PATH_STATIONS > 1 ? s / (PILING_PATH_STATIONS - 1) : 0;
          path.push({ x, y: bottomY + (topY - bottomY) * st, z });
        }
        allMeshes.push(sweepTube(path, () => pilingRadius, PILING_RADIAL_SEGMENTS));
      }
    }

    // ── Bollards (along one edge of pier)
    if (numBollards > 0) {
      const profile = bollardProfile(bollardHeight, bollardRadius);

      for (let i = 0; i < numBollards; i++) {
        const t = numBollards > 1 ? i / (numBollards - 1) : 0.5;
        const x = -halfLength * 0.8 + pierLength * 0.8 * t;
        const z = halfWidth * 0.8; // Near one edge

        const bollard = revolve(profile, BOLLARD_SEGMENTS);
        translateMesh(bollard, x, deckElevation + pierHeight, z);
        allMeshes.push(bollard);
      }
    }

    // ── Merge
    const merged = mergeMeshes(allMeshes);
    const bounds = computeBounds(merged.positions);
    const finalMesh: GeneratedMesh = {
      ...merged,
      bounds,
      meta: {
        pierLength,
        pierWidth,
        numBollards,
        triangleCount: merged.indices.length / 3,
      },
    };

    const model: GeneratedModel = {
      meshes: [finalMesh],
      groups: [
        { name: 'harbour', start: 0, count: merged.indices.length, materialId: 'concrete' },
      ],
      transferables: [],
    };
    model.transferables = gatherTransferables(model);
    return model;
  },
};
