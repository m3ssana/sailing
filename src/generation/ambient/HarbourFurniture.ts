/**
 * Harbour furniture generator — D.9 (standalone).
 *
 * D.6's harbourFurniture landmark generator does not yet exist (landmarks/
 * directory is empty at time of writing). This provides minimal pier/bollard
 * geometry for ambient world population.
 *
 * NOTE FOR FUTURE DEDUPLICATION: When D.6's harbourFurniture landmark generator
 * is built, this module's helpers (makeBollard, makePierSection) should be
 * extracted into a shared utility or this module should re-export from D.6.
 * The landmark generator handles placed/oriented instances; this one supplies
 * geometry that the ambient population system scatters procedurally.
 *
 * Engine-agnostic — no three.js.
 */

import type { GeneratedMesh, GeneratedModel, Generator, Seed, Vec2 } from '@/types';
import { extrudePolygon, revolve } from '../common/extrude';
import { mergeMeshes } from '../common/meshUtils';

// ─── Types ───────────────────────────────────────────────────────────────────

export type FurnitureKind = 'bollard' | 'pier-section' | 'cleat' | 'fender';

export interface HarbourFurnitureParams {
  kind: FurnitureKind;
  /** Scale multiplier (1.0 = standard size). */
  scale?: number;
}

// ─── Bollard: a short thick post for mooring lines ───────────────────────────

function makeBollard(scale: number): GeneratedMesh {
  // Revolve a mushroom-like profile: narrow base, wider cap
  const height = 0.8 * scale;
  const baseRadius = 0.12 * scale;
  const capRadius = 0.2 * scale;

  const profile: Vec2[] = [
    { x: 0, y: 0 },
    { x: baseRadius, y: 0 },
    { x: baseRadius, y: height * 0.6 },
    { x: baseRadius * 0.8, y: height * 0.65 },
    { x: capRadius, y: height * 0.7 },
    { x: capRadius, y: height * 0.85 },
    { x: capRadius * 0.9, y: height * 0.95 },
    { x: capRadius * 0.5, y: height },
    { x: 0, y: height },
  ];

  return revolve(profile, 8);
}

// ─── Pier section: a simple rectangular extrusion (a pier pile/deck segment) ─

function makePierSection(scale: number): GeneratedMesh {
  // A short rectangular pier deck section
  const width = 3.0 * scale;
  const depth = 2.0 * scale;
  const height = 0.4 * scale;
  const hw = width / 2;
  const hd = depth / 2;

  const outline: Vec2[] = [
    { x: -hw, y: -hd },
    { x: hw, y: -hd },
    { x: hw, y: hd },
    { x: -hw, y: hd },
  ];

  return extrudePolygon(outline, height);
}

// ─── Cleat: a small T-shaped mooring fitting ─────────────────────────────────

function makeCleat(scale: number): GeneratedMesh {
  // A T-shaped profile extruded along the base axis
  const h = 0.15 * scale;
  const baseW = 0.08 * scale;
  const armW = 0.2 * scale;
  const armH = 0.04 * scale;
  const hbw = baseW / 2;
  const haw = armW / 2;

  const outline: Vec2[] = [
    { x: -hbw, y: -hbw },
    { x: hbw, y: -hbw },
    { x: hbw, y: hbw },
    { x: -hbw, y: hbw },
  ];

  const baseMesh = extrudePolygon(outline, h - armH);

  // Arms (cross-piece) as a wider box on top
  const armOutline: Vec2[] = [
    { x: -haw, y: -armH / 2 },
    { x: haw, y: -armH / 2 },
    { x: haw, y: armH / 2 },
    { x: -haw, y: armH / 2 },
  ];
  const armMesh = extrudePolygon(armOutline, armH);

  // Offset arm mesh upward by translating positions
  for (let i = 1; i < armMesh.positions.length; i += 3) {
    armMesh.positions[i] = (armMesh.positions[i] ?? 0) + (h - armH);
  }

  return mergeMeshes([baseMesh, armMesh]);
}

// ─── Fender: a cylindrical bumper ────────────────────────────────────────────

function makeFender(scale: number): GeneratedMesh {
  // A torus-like cushion shape (approximated as a fat cylinder with rounded ends)
  const height = 0.6 * scale;
  const radius = 0.15 * scale;

  const profile: Vec2[] = [
    { x: 0, y: 0 },
    { x: radius * 0.7, y: 0.02 * scale },
    { x: radius, y: height * 0.15 },
    { x: radius, y: height * 0.85 },
    { x: radius * 0.7, y: height * 0.98 },
    { x: 0, y: height },
  ];

  return revolve(profile, 8);
}

// ─── Generator ───────────────────────────────────────────────────────────────

export const HarbourFurnitureGenerator: Generator<HarbourFurnitureParams, GeneratedModel> = {
  id: 'ambient-harbour-furniture',

  generate(params: HarbourFurnitureParams, _seed: Seed): GeneratedModel {
    const scale = params.scale ?? 1.0;
    let mesh: GeneratedMesh;

    switch (params.kind) {
      case 'bollard':
        mesh = makeBollard(scale);
        break;
      case 'pier-section':
        mesh = makePierSection(scale);
        break;
      case 'cleat':
        mesh = makeCleat(scale);
        break;
      case 'fender':
        mesh = makeFender(scale);
        break;
    }

    return {
      meshes: [mesh],
      groups: [{ name: `furniture-${params.kind}`, start: 0, count: mesh.indices.length, materialId: 'concrete' }],
      transferables: [],
    };
  },
};
