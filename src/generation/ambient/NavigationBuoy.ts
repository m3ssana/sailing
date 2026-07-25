/**
 * Navigation buoy generator — D.9.
 *
 * Produces simple can/spar/pillar buoy shapes via revolve. Buoys are colour-coded
 * per IALA maritime navigation standards:
 * - Port (red, can shape): cylindrical with flat top
 * - Starboard (green, conical top): cylinder tapering to a point at the top
 * - Safe-water (red/white vertical stripes): spherical-ish body
 * - Cardinal (black/yellow bands): pillar with topmark suggestion
 *
 * Colour is encoded via `mesh.meta` fields (red, green, blue for the primary
 * band colour) since the generation layer doesn't use three.js materials.
 * The render layer should use these meta values to assign materials.
 *
 * Engine-agnostic — no three.js.
 */

import type { GeneratedMesh, GeneratedModel, Generator, Seed, Vec2 } from '@/types';
import { revolve } from '../common/extrude';

// ─── Types ───────────────────────────────────────────────────────────────────

export type BuoyKind = 'port' | 'starboard' | 'safe-water' | 'cardinal';

export interface NavigationBuoyParams {
  kind: BuoyKind;
  /** Overall height of the buoy above waterline, metres. Default 2.0. */
  height?: number;
  /** Body diameter, metres. Default 1.0. */
  diameter?: number;
}

// ─── Revolve segment count — cheap buoys, ~8–12 segments around ──────────────

const BUOY_RADIAL_SEGMENTS = 10;

// ─── Profile builders ────────────────────────────────────────────────────────

/**
 * Port buoy (IALA): cylindrical can shape with flat top.
 * Profile in XY plane: x = distance from axis, y = height.
 */
function portProfile(height: number, radius: number): Vec2[] {
  return [
    { x: 0, y: -0.1 },         // bottom centre (slight undercut)
    { x: radius * 0.6, y: -0.1 },
    { x: radius * 0.8, y: 0 },
    { x: radius, y: 0.1 },     // body start
    { x: radius, y: height * 0.85 }, // body end
    { x: radius * 0.95, y: height * 0.9 },
    { x: radius * 0.9, y: height },  // flat top edge
    { x: 0, y: height },       // top centre
  ];
}

/**
 * Starboard buoy (IALA): conical top (cone buoy).
 */
function starboardProfile(height: number, radius: number): Vec2[] {
  return [
    { x: 0, y: -0.1 },
    { x: radius * 0.6, y: -0.1 },
    { x: radius * 0.8, y: 0 },
    { x: radius, y: 0.1 },
    { x: radius, y: height * 0.6 },  // body end
    { x: radius * 0.6, y: height * 0.75 },
    { x: radius * 0.2, y: height * 0.9 },
    { x: 0, y: height },       // conical tip
  ];
}

/**
 * Safe-water buoy: spherical-ish body with topmark staff.
 */
function safeWaterProfile(height: number, radius: number): Vec2[] {
  return [
    { x: 0, y: -0.05 },
    { x: radius * 0.3, y: 0 },
    { x: radius * 0.7, y: height * 0.1 },
    { x: radius, y: height * 0.3 },    // max beam at lower third
    { x: radius * 0.95, y: height * 0.5 },
    { x: radius * 0.7, y: height * 0.65 },
    { x: radius * 0.3, y: height * 0.75 },
    { x: radius * 0.08, y: height * 0.8 }, // staff begins
    { x: radius * 0.06, y: height * 0.95 },
    { x: radius * 0.1, y: height },    // topmark ball suggestion
    { x: 0, y: height },
  ];
}

/**
 * Cardinal buoy: tall pillar shape with distinct banding zones.
 */
function cardinalProfile(height: number, radius: number): Vec2[] {
  return [
    { x: 0, y: -0.05 },
    { x: radius * 0.5, y: 0 },
    { x: radius * 0.7, y: height * 0.05 },
    { x: radius * 0.75, y: height * 0.1 },   // base taper
    { x: radius * 0.6, y: height * 0.15 },   // body
    { x: radius * 0.6, y: height * 0.7 },    // body end
    { x: radius * 0.5, y: height * 0.75 },   // topmark taper
    { x: radius * 0.08, y: height * 0.8 },   // staff
    { x: radius * 0.08, y: height * 0.95 },
    { x: radius * 0.15, y: height },         // double-cone topmark hint
    { x: 0, y: height },
  ];
}

// ─── Colour mapping ──────────────────────────────────────────────────────────

function getBuoyColor(kind: BuoyKind): { r: number; g: number; b: number } {
  switch (kind) {
    case 'port':
      return { r: 0.8, g: 0.1, b: 0.1 }; // red
    case 'starboard':
      return { r: 0.1, g: 0.7, b: 0.1 }; // green
    case 'safe-water':
      return { r: 0.8, g: 0.2, b: 0.2 }; // red (with white stripes, indicated in meta)
    case 'cardinal':
      return { r: 0.9, g: 0.8, b: 0.1 }; // yellow (black/yellow)
  }
}

// ─── Generator ───────────────────────────────────────────────────────────────

export const NavigationBuoyGenerator: Generator<NavigationBuoyParams, GeneratedModel> = {
  id: 'ambient-navigation-buoy',

  generate(params: NavigationBuoyParams, _seed: Seed): GeneratedModel {
    const height = params.height ?? 2.0;
    const radius = (params.diameter ?? 1.0) / 2;
    const { kind } = params;

    let profile: Vec2[];
    switch (kind) {
      case 'port':
        profile = portProfile(height, radius);
        break;
      case 'starboard':
        profile = starboardProfile(height, radius);
        break;
      case 'safe-water':
        profile = safeWaterProfile(height, radius);
        break;
      case 'cardinal':
        profile = cardinalProfile(height, radius);
        break;
    }

    const mesh = revolve(profile, BUOY_RADIAL_SEGMENTS);
    const color = getBuoyColor(kind);

    // Attach colour metadata for the render layer to assign materials
    const taggedMesh: GeneratedMesh = {
      ...mesh,
      meta: {
        ...mesh.meta,
        colorR: color.r,
        colorG: color.g,
        colorB: color.b,
        height,
        diameter: radius * 2,
      },
    };

    return {
      meshes: [taggedMesh],
      groups: [{ name: `buoy-${kind}`, start: 0, count: taggedMesh.indices.length, materialId: 'concrete' }],
      transferables: [],
    };
  },
};
