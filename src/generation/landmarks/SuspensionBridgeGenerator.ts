/**
 * Suspension bridge landmark generator — D.6.
 *
 * Produces a recognizable suspension bridge silhouette: two towers, a parabolic
 * main cable, vertical suspender cables, and a flat deck. Designed for 2 km
 * identification per art-direction §2.1.
 *
 * Geometry: origin-centred in local space. The deck spans along the X axis,
 * towers rise along Y, and the bridge has depth along Z.
 *
 * Closed-solid assessment: the towers are closed (sweepTube with caps), the
 * deck is closed (extrudePolygon with caps). Cables are thin geometry and
 * functionally open surfaces.
 *
 * Engine-agnostic — no three.js.
 */

import type { GeneratedMesh, GeneratedModel, Generator, Seed, Vec3 } from '@/types';
import { sweepTube } from '../common/sweep';
import { extrudePolygon } from '../common/extrude';
import { chamferSize } from '../common/chamfer';
import { computeBounds, gatherTransferables, mergeMeshes } from '../common/meshUtils';

// ─── Params ──────────────────────────────────────────────────────────────────

/**
 * Parameters for the suspension bridge generator.
 *
 * All lengths in metres (SI).
 *
 * | Param | Default | Description |
 * |---|---|---|
 * | span | 400 | Total horizontal span (tip-to-tip) |
 * | towerHeight | 80 | Height of each tower from deck level |
 * | deckWidth | 20 | Transverse deck width |
 * | deckHeight | 3 | Vertical thickness of the deck section |
 * | numSuspenders | 20 | Number of vertical suspender cables per side |
 * | cableRadius | 0.4 | Radius of the main cables |
 * | suspenderRadius | 0.1 | Radius of suspender cables |
 * | towerBaseWidth | 8 | Base width of each tower |
 * | towerTopWidth | 5 | Top width of each tower |
 * | sag | 0.12 | Sag ratio (fraction of span for cable droop) |
 */
export interface SuspensionBridgeParams {
  span: number;
  towerHeight: number;
  deckWidth: number;
  deckHeight: number;
  numSuspenders: number;
  cableRadius: number;
  suspenderRadius: number;
  towerBaseWidth: number;
  towerTopWidth: number;
  sag: number;
}

const DEFAULTS: SuspensionBridgeParams = {
  span: 400,
  towerHeight: 80,
  deckWidth: 20,
  deckHeight: 3,
  numSuspenders: 20,
  cableRadius: 0.4,
  suspenderRadius: 0.1,
  towerBaseWidth: 8,
  towerTopWidth: 5,
  sag: 0.12,
};

function resolveParams(raw: Record<string, unknown>): SuspensionBridgeParams {
  return {
    span: typeof raw['span'] === 'number' ? raw['span'] : DEFAULTS.span,
    towerHeight: typeof raw['towerHeight'] === 'number' ? raw['towerHeight'] : DEFAULTS.towerHeight,
    deckWidth: typeof raw['deckWidth'] === 'number' ? raw['deckWidth'] : DEFAULTS.deckWidth,
    deckHeight: typeof raw['deckHeight'] === 'number' ? raw['deckHeight'] : DEFAULTS.deckHeight,
    numSuspenders: typeof raw['numSuspenders'] === 'number' ? raw['numSuspenders'] : DEFAULTS.numSuspenders,
    cableRadius: typeof raw['cableRadius'] === 'number' ? raw['cableRadius'] : DEFAULTS.cableRadius,
    suspenderRadius: typeof raw['suspenderRadius'] === 'number' ? raw['suspenderRadius'] : DEFAULTS.suspenderRadius,
    towerBaseWidth: typeof raw['towerBaseWidth'] === 'number' ? raw['towerBaseWidth'] : DEFAULTS.towerBaseWidth,
    towerTopWidth: typeof raw['towerTopWidth'] === 'number' ? raw['towerTopWidth'] : DEFAULTS.towerTopWidth,
    sag: typeof raw['sag'] === 'number' ? raw['sag'] : DEFAULTS.sag,
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TOWER_RADIAL_SEGMENTS = 8;
const TOWER_PATH_STATIONS = 12;
const CABLE_SEGMENTS = 40;
const CABLE_RADIAL_SEGMENTS = 6;
const SUSPENDER_RADIAL_SEGMENTS = 4;
const SUSPENDER_PATH_STATIONS = 4;

// ─── Geometry helpers ────────────────────────────────────────────────────────

/** Build a straight tapered tower along Y axis at given x/z position. */
function buildTower(
  baseX: number,
  baseZ: number,
  baseWidth: number,
  topWidth: number,
  height: number,
): GeneratedMesh {
  const path: Vec3[] = [];
  for (let i = 0; i < TOWER_PATH_STATIONS; i++) {
    const t = TOWER_PATH_STATIONS > 1 ? i / (TOWER_PATH_STATIONS - 1) : 0;
    path.push({ x: baseX, y: t * height, z: baseZ });
  }
  const baseR = baseWidth / 2;
  const topR = topWidth / 2;
  return sweepTube(
    path,
    (t: number) => baseR + (topR - baseR) * t,
    TOWER_RADIAL_SEGMENTS,
  );
}

/**
 * Parabolic cable approximation: y = 4*sag*x*(1-x) below the tower top,
 * where x is normalized [0,1] across the span.
 */
function buildMainCable(
  startX: number,
  endX: number,
  towerTop: number,
  sagDistance: number,
  z: number,
  radius: number,
): GeneratedMesh {
  const path: Vec3[] = [];
  for (let i = 0; i <= CABLE_SEGMENTS; i++) {
    const t = i / CABLE_SEGMENTS;
    const x = startX + (endX - startX) * t;
    // Parabola: highest at ends (tower tops), lowest at midspan
    const y = towerTop - 4 * sagDistance * t * (1 - t);
    path.push({ x, y, z });
  }
  return sweepTube(path, () => radius, CABLE_RADIAL_SEGMENTS);
}

/** Build a single vertical suspender cable from cable to deck. */
function buildSuspender(
  x: number,
  z: number,
  topY: number,
  bottomY: number,
  radius: number,
): GeneratedMesh {
  const path: Vec3[] = [];
  for (let i = 0; i < SUSPENDER_PATH_STATIONS; i++) {
    const t = SUSPENDER_PATH_STATIONS > 1 ? i / (SUSPENDER_PATH_STATIONS - 1) : 0;
    path.push({ x, y: bottomY + (topY - bottomY) * t, z });
  }
  return sweepTube(path, () => radius, SUSPENDER_RADIAL_SEGMENTS);
}

// ─── Generator ───────────────────────────────────────────────────────────────

export const SuspensionBridgeGenerator: Generator<
  Record<string, unknown>,
  GeneratedModel
> = {
  id: 'suspensionBridge',

  generate(raw: Record<string, unknown>, _seed: Seed): GeneratedModel {
    const params = resolveParams(raw);
    const {
      span,
      towerHeight,
      deckWidth,
      deckHeight,
      numSuspenders,
      cableRadius,
      suspenderRadius,
      towerBaseWidth,
      towerTopWidth,
      sag,
    } = params;

    const allMeshes: GeneratedMesh[] = [];

    const halfSpan = span / 2;
    const sagDistance = sag * span;
    const deckY = towerHeight * 0.3; // Deck at ~30% of tower height
    const towerTop = deckY + towerHeight;

    // ── Towers (two: at ±halfSpan * 0.4 — slightly inboard of span ends)
    const towerX = halfSpan * 0.8;
    allMeshes.push(buildTower(-towerX, 0, towerBaseWidth, towerTopWidth, towerTop));
    allMeshes.push(buildTower(towerX, 0, towerBaseWidth, towerTopWidth, towerTop));

    // ── Main cables (two: offset ±deckWidth/2 in Z)
    const cableZ = deckWidth / 2;
    allMeshes.push(buildMainCable(-halfSpan, halfSpan, towerTop, sagDistance, cableZ, cableRadius));
    allMeshes.push(buildMainCable(-halfSpan, halfSpan, towerTop, sagDistance, -cableZ, cableRadius));

    // ── Suspender cables
    if (numSuspenders > 0) {
      for (let i = 1; i <= numSuspenders; i++) {
        const t = i / (numSuspenders + 1);
        const x = -halfSpan + span * t;
        // Cable height at this x position (parabolic)
        const cableY = towerTop - 4 * sagDistance * t * (1 - t);

        // Both sides (±Z)
        allMeshes.push(buildSuspender(x, cableZ, cableY, deckY, suspenderRadius));
        allMeshes.push(buildSuspender(x, -cableZ, cableY, deckY, suspenderRadius));
      }
    }

    // ── Deck (extruded rectangle along X axis)
    const bevel = chamferSize(Math.max(span, deckWidth, deckHeight));
    const halfDeckW = deckWidth / 2;
    const halfSpanDeck = halfSpan;
    // XZ plane outline for extrudePolygon (which lifts along Y)
    // We build the deck as a long thin rectangle in XZ, extruded by deckHeight
    const deckOutline = [
      { x: -halfSpanDeck, y: -halfDeckW },
      { x: halfSpanDeck, y: -halfDeckW },
      { x: halfSpanDeck, y: halfDeckW },
      { x: -halfSpanDeck, y: halfDeckW },
    ];
    const deckMesh = extrudePolygon(deckOutline, deckHeight, { bevel, bevelSegments: 2 });
    // Translate deck up to deckY
    for (let i = 1; i < deckMesh.positions.length; i += 3) {
      deckMesh.positions[i] = (deckMesh.positions[i] ?? 0) + deckY;
    }
    allMeshes.push(deckMesh);

    // ── Merge
    const merged = mergeMeshes(allMeshes);
    const bounds = computeBounds(merged.positions);
    const finalMesh: GeneratedMesh = {
      ...merged,
      bounds,
      meta: {
        span,
        towerHeight,
        triangleCount: merged.indices.length / 3,
      },
    };

    const model: GeneratedModel = {
      meshes: [finalMesh],
      groups: [
        { name: 'bridge', start: 0, count: merged.indices.length, materialId: 'concrete' },
      ],
      transferables: [],
    };
    model.transferables = gatherTransferables(model);
    return model;
  },
};
