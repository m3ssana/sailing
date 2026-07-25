/**
 * Signature vessel generator — D.9.
 *
 * Generates distinctive ferry, container ship, and hovercraft silhouettes.
 * Ferry and container ship reuse StationLofter with appropriately boxy/large
 * HullParams. Hovercraft uses a simple extruded flat-bottomed shape.
 *
 * Design notes:
 * - Container ship: very boxy hull (chine bilge, high beam-to-length ratio ~1:6,
 *   nearly vertical sides). The approximation is a wall-sided hull with hard
 *   chines — visually correct at silhouette distances.
 * - Ferry: moderate beam-to-length (~1:5), slightly more rounded bow, flat stern
 *   (transom). Superstructure is not modelled here (silhouette-level only).
 * - Hovercraft: NOT a displacement hull. Approximated as a flat-bottomed platform
 *   with a thin extruded skirt band around the perimeter. This is the same
 *   art-direction spirit as D.6 — recognizable silhouette, not simulation.
 *
 * LOD: These use moderate resolution (lengthSegments=10, girthSegments=8)
 * since signature vessels are fewer in number and more visually prominent than
 * moored fleet boats, but still well below player-boat detail.
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
import { extrudePolygon } from '../common/extrude';
import { mergeMeshes } from '../common/meshUtils';
import { StationLofter } from '../hull/StationLofter';

// ─── Types ───────────────────────────────────────────────────────────────────

export type SignatureVesselKind = 'ferry' | 'containerShip' | 'hovercraft';

export interface SignatureVesselParams {
  kind: SignatureVesselKind;
  /** Overall length, metres. Drives geometry scale. */
  length: number;
}

// ─── LOD for signature vessels (moderate — more prominent than moored fleet) ─

const SIG_LENGTH_SEGMENTS = 10;
const SIG_GIRTH_SEGMENTS = 8;

// ─── Container ship stations ─────────────────────────────────────────────────

function makeContainerShipStations(_loa: number, beam: number, draft: number): StationCurve[] {
  const halfBeam = beam / 2;
  // Very boxy: nearly vertical sides, hard chine bilge
  const scale = (pts: Array<[number, number]>): Vec2[] =>
    pts.map(([xFrac, yFrac]) => ({
      x: xFrac * halfBeam,
      y: yFrac * (draft + draft * 0.3), // modest freeboard
    }));

  return [
    { position: 0.0, points: scale([[0, 0], [0.15, 0.2], [0.3, 0.5], [0.35, 1.0]]) },  // bulbous bow
    { position: 0.08, points: scale([[0, 0], [0.5, 0.15], [0.7, 0.5], [0.75, 1.0]]) },
    { position: 0.2, points: scale([[0, 0], [0.9, 0.08], [0.95, 0.5], [0.98, 1.0]]) },  // wall-sided
    { position: 0.4, points: scale([[0, 0], [0.95, 0.06], [0.98, 0.5], [1.0, 1.0]]) },  // max beam
    { position: 0.6, points: scale([[0, 0], [0.95, 0.06], [0.98, 0.5], [1.0, 1.0]]) },
    { position: 0.8, points: scale([[0, 0], [0.9, 0.08], [0.95, 0.5], [0.98, 1.0]]) },
    { position: 0.92, points: scale([[0, 0], [0.7, 0.1], [0.8, 0.5], [0.85, 1.0]]) },
    { position: 1.0, points: scale([[0, 0], [0.5, 0.15], [0.6, 0.5], [0.65, 1.0]]) },   // transom
  ];
}

// ─── Ferry stations ──────────────────────────────────────────────────────────

function makeFerryStations(_loa: number, beam: number, draft: number): StationCurve[] {
  const halfBeam = beam / 2;
  const scale = (pts: Array<[number, number]>): Vec2[] =>
    pts.map(([xFrac, yFrac]) => ({
      x: xFrac * halfBeam,
      y: yFrac * (draft + draft * 0.4),
    }));

  return [
    { position: 0.0, points: scale([[0, 0], [0.1, 0.3], [0.25, 0.6], [0.3, 1.0]]) },    // raked bow
    { position: 0.1, points: scale([[0, 0], [0.4, 0.2], [0.65, 0.6], [0.7, 1.0]]) },
    { position: 0.25, points: scale([[0, 0], [0.7, 0.12], [0.88, 0.5], [0.95, 1.0]]) },
    { position: 0.45, points: scale([[0, 0], [0.8, 0.1], [0.92, 0.5], [1.0, 1.0]]) },   // max beam
    { position: 0.65, points: scale([[0, 0], [0.8, 0.1], [0.92, 0.5], [1.0, 1.0]]) },
    { position: 0.85, points: scale([[0, 0], [0.7, 0.12], [0.85, 0.5], [0.9, 1.0]]) },
    { position: 1.0, points: scale([[0, 0], [0.55, 0.15], [0.7, 0.5], [0.75, 1.0]]) },  // transom
  ];
}

// ─── Hovercraft (extruded platform + skirt) ──────────────────────────────────

function makeHovercraft(length: number): GeneratedMesh {
  // Platform: an elongated hexagonal outline (boat-shaped plan view)
  const beam = length * 0.4; // hovercraft are wide relative to length
  const hw = beam / 2;
  const hl = length / 2;

  // Boat-shaped plan outline (XZ plane, Y is up)
  const outline: Vec2[] = [
    { x: -hw * 0.3, y: -hl },       // bow point
    { x: -hw * 0.7, y: -hl * 0.7 },
    { x: -hw, y: -hl * 0.3 },
    { x: -hw, y: hl * 0.6 },
    { x: -hw * 0.8, y: hl * 0.9 },
    { x: -hw * 0.4, y: hl },         // stern
    { x: hw * 0.4, y: hl },
    { x: hw * 0.8, y: hl * 0.9 },
    { x: hw, y: hl * 0.6 },
    { x: hw, y: -hl * 0.3 },
    { x: hw * 0.7, y: -hl * 0.7 },
    { x: hw * 0.3, y: -hl },         // bow other side
  ];

  // Main platform (deck) — modest height
  const deckHeight = length * 0.08;
  const deckMesh = extrudePolygon(outline, deckHeight);

  // Skirt: a thin band around the perimeter, sitting below the deck
  // Create a slightly larger outline for the skirt's outer edge
  const skirtHeight = length * 0.04;

  // Slightly larger outline for skirt outer
  const skirtOuter: Vec2[] = outline.map(p => {
    const dist = Math.sqrt(p.x * p.x + p.y * p.y);
    const scale = dist > 0 ? (dist + 0.05) / dist : 1;
    return { x: p.x * scale, y: p.y * scale };
  });

  const skirtMesh = extrudePolygon(skirtOuter, skirtHeight);

  // Offset skirt below deck (shift Y positions down)
  for (let i = 1; i < skirtMesh.positions.length; i += 3) {
    skirtMesh.positions[i] = (skirtMesh.positions[i] ?? 0) - skirtHeight;
  }

  return mergeMeshes([deckMesh, skirtMesh]);
}

// ─── Generator ───────────────────────────────────────────────────────────────

export const SignatureVesselGenerator: Generator<SignatureVesselParams, GeneratedModel> = {
  id: 'ambient-signature-vessel',

  generate(params: SignatureVesselParams, seed: Seed): GeneratedModel {
    const { kind, length } = params;

    let mesh: GeneratedMesh;

    switch (kind) {
      case 'containerShip': {
        // Container ships have beam ~1:6 of LOA, deep draft
        const beam = length / 6;
        const draft = length * 0.06;
        const hullParams: HullParams = {
          loa: length,
          beam,
          designDraft: draft,
          waterlineHeight: draft * 0.85,
          stations: makeContainerShipStations(length, beam, draft),
          bilge: 'chine', // Hard chines for boxy container ship
          hullCount: 1,
          sheerRise: 0.01,
          deckCamber: 0.005,
          lengthSegments: SIG_LENGTH_SEGMENTS,
          girthSegments: SIG_GIRTH_SEGMENTS,
        };
        const model = StationLofter.generate(hullParams, seed);
        const m = model.meshes[0];
        if (m === undefined) {
          throw new Error('StationLofter produced no mesh for container ship');
        }
        mesh = m;
        break;
      }

      case 'ferry': {
        // Ferries have beam ~1:5 of LOA
        const beam = length / 5;
        const draft = length * 0.04;
        const hullParams: HullParams = {
          loa: length,
          beam,
          designDraft: draft,
          waterlineHeight: draft * 0.85,
          stations: makeFerryStations(length, beam, draft),
          bilge: 'round',
          hullCount: 1,
          sheerRise: 0.015,
          deckCamber: 0.008,
          lengthSegments: SIG_LENGTH_SEGMENTS,
          girthSegments: SIG_GIRTH_SEGMENTS,
        };
        const model = StationLofter.generate(hullParams, seed);
        const m = model.meshes[0];
        if (m === undefined) {
          throw new Error('StationLofter produced no mesh for ferry');
        }
        mesh = m;
        break;
      }

      case 'hovercraft': {
        mesh = makeHovercraft(length);
        break;
      }
    }

    return {
      meshes: [mesh],
      groups: [{ name: `vessel-${kind}`, start: 0, count: mesh.indices.length, materialId: 'gelcoat' }],
      transferables: [],
    };
  },
};
