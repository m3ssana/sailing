/**
 * Shell vault landmark generator — D.6.
 *
 * Produces a distinctive curved shell/vault roof silhouette (inspired by the
 * Sydney Opera House). Uses revolve of an ellipse-arc profile to create
 * sail-like shells. Multiple shells at varying sizes create the recognizable
 * cluster.
 *
 * Geometry: origin-centred in local space. Shells rise along +Y.
 *
 * Closed-solid assessment: individual shells are open surfaces (half-revolves)
 * with a flat base. The combined model is NOT watertight — shells are open at
 * the back and base is a separate cap. This is appropriate for a silhouette
 * landmark that will never need volume computation.
 *
 * Engine-agnostic — no three.js.
 */

import type { GeneratedMesh, GeneratedModel, Generator, Seed, Vec2 } from '@/types';
import { revolve } from '../common/extrude';
import { computeBounds, gatherTransferables, mergeMeshes } from '../common/meshUtils';

// ─── Params ──────────────────────────────────────────────────────────────────

/**
 * Parameters for the shell vault generator.
 *
 * | Param | Default | Description |
 * |---|---|---|
 * | baseWidth | 60 | Width of the platform base |
 * | baseDepth | 40 | Depth of the platform base |
 * | maxShellHeight | 45 | Height of the tallest shell |
 * | numShells | 4 | Number of shell segments |
 * | shellArc | 0.6 | Arc fraction of full circle for each shell (0-1) |
 * | shellThinness | 0.15 | Thickness of shell wall as fraction of height |
 * | segments | 16 | Revolve segments per shell |
 */
export interface ShellVaultParams {
  baseWidth: number;
  baseDepth: number;
  maxShellHeight: number;
  numShells: number;
  shellArc: number;
  shellThinness: number;
  segments: number;
}

const DEFAULTS: ShellVaultParams = {
  baseWidth: 60,
  baseDepth: 40,
  maxShellHeight: 45,
  numShells: 4,
  shellArc: 0.6,
  shellThinness: 0.15,
  segments: 16,
};

function resolveParams(raw: Record<string, unknown>): ShellVaultParams {
  return {
    baseWidth: typeof raw['baseWidth'] === 'number' ? raw['baseWidth'] : DEFAULTS.baseWidth,
    baseDepth: typeof raw['baseDepth'] === 'number' ? raw['baseDepth'] : DEFAULTS.baseDepth,
    maxShellHeight: typeof raw['maxShellHeight'] === 'number' ? raw['maxShellHeight'] : DEFAULTS.maxShellHeight,
    numShells: typeof raw['numShells'] === 'number' ? raw['numShells'] : DEFAULTS.numShells,
    shellArc: typeof raw['shellArc'] === 'number' ? raw['shellArc'] : DEFAULTS.shellArc,
    shellThinness: typeof raw['shellThinness'] === 'number' ? raw['shellThinness'] : DEFAULTS.shellThinness,
    segments: typeof raw['segments'] === 'number' ? raw['segments'] : DEFAULTS.segments,
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const PROFILE_POINTS = 12;

// ─── Geometry helpers ────────────────────────────────────────────────────────

/**
 * Generate an elliptical arc profile for one shell.
 * Profile is in the XY plane: x = distance from axis, y = height.
 * The arc traces from the base to the peak, creating a pointed sail shape.
 */
function shellProfile(height: number, width: number, thinness: number): Vec2[] {
  const points: Vec2[] = [];
  const thickness = height * thinness;

  // Outer surface: elliptical arc from base to tip
  for (let i = 0; i < PROFILE_POINTS; i++) {
    const t = i / (PROFILE_POINTS - 1);
    // Use a power curve for a more pointed peak
    const angle = t * Math.PI * 0.5;
    const x = width * (1 - Math.sin(angle));
    const y = height * Math.pow(Math.sin(angle), 0.7);
    points.push({ x, y });
  }

  // Inner surface (slightly smaller, going back down) to give shell thickness
  for (let i = PROFILE_POINTS - 2; i >= 1; i--) {
    const t = i / (PROFILE_POINTS - 1);
    const angle = t * Math.PI * 0.5;
    const x = Math.max(0, width * (1 - Math.sin(angle)) - thickness);
    const y = height * Math.pow(Math.sin(angle), 0.7);
    points.push({ x, y });
  }

  return points;
}

/**
 * Translate a mesh by offset. Modifies positions in-place.
 */
function translateMesh(mesh: GeneratedMesh, dx: number, dy: number, dz: number): void {
  for (let i = 0; i < mesh.positions.length; i += 3) {
    mesh.positions[i] = (mesh.positions[i] ?? 0) + dx;
    mesh.positions[i + 1] = (mesh.positions[i + 1] ?? 0) + dy;
    mesh.positions[i + 2] = (mesh.positions[i + 2] ?? 0) + dz;
  }
}

// ─── Generator ───────────────────────────────────────────────────────────────

export const ShellVaultGenerator: Generator<
  Record<string, unknown>,
  GeneratedModel
> = {
  id: 'shellVault',

  generate(raw: Record<string, unknown>, _seed: Seed): GeneratedModel {
    const params = resolveParams(raw);
    const {
      baseWidth,
      maxShellHeight,
      numShells,
      shellArc,
      shellThinness,
      segments,
    } = params;

    const allMeshes: GeneratedMesh[] = [];

    // Generate multiple shells at decreasing sizes, offset along X
    const shellSpacing = baseWidth / (numShells + 1);

    for (let i = 0; i < numShells; i++) {
      // Each shell is progressively smaller
      const sizeFactor = 1 - (i / numShells) * 0.5;
      const shellHeight = maxShellHeight * sizeFactor;
      const shellWidth = shellHeight * 0.4; // Width is ~40% of height for a pointed shell

      const arc = shellArc * Math.PI * 2;
      const profile = shellProfile(shellHeight, shellWidth, shellThinness);
      const shellMesh = revolve(profile, segments, arc);

      // Position shells in a staggered row
      const xOffset = -baseWidth / 2 + shellSpacing * (i + 1);
      translateMesh(shellMesh, xOffset, 0, 0);

      allMeshes.push(shellMesh);
    }

    // ── Merge
    const merged = mergeMeshes(allMeshes);
    const bounds = computeBounds(merged.positions);
    const finalMesh: GeneratedMesh = {
      ...merged,
      bounds,
      meta: {
        maxShellHeight,
        numShells,
        triangleCount: merged.indices.length / 3,
      },
    };

    const model: GeneratedModel = {
      meshes: [finalMesh],
      groups: [
        { name: 'shells', start: 0, count: merged.indices.length, materialId: 'concrete' },
      ],
      transferables: [],
    };
    model.transferables = gatherTransferables(model);
    return model;
  },
};
