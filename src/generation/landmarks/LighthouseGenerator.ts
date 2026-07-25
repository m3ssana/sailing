/**
 * Lighthouse landmark generator — D.6.
 *
 * Produces a tapered cylindrical tower with a distinct gallery/lantern room
 * bulge near the top and a dome cap. Classic lighthouse silhouette recognizable
 * at 2+ km per art-direction §2.1.
 *
 * Geometry: origin-centred, base at Y=0, lantern dome at top. The tower is a
 * revolved tapered profile, the gallery is a wider band, and the dome is a
 * hemisphere revolve.
 *
 * Closed-solid: YES — the full lighthouse is a closed solid (revolve produces
 * a watertight surface when the profile forms a closed loop from axis to axis).
 * computeVolume should return positive for correct winding.
 *
 * Engine-agnostic — no three.js.
 */

import type { GeneratedMesh, GeneratedModel, Generator, Seed, Vec2, Vec3 } from '@/types';
import { sweepTube } from '../common/sweep';
import { computeBounds, gatherTransferables } from '../common/meshUtils';

// ─── Params ──────────────────────────────────────────────────────────────────

/**
 * Parameters for the lighthouse generator.
 *
 * | Param | Default | Description |
 * |---|---|---|
 * | height | 25 | Total height from base to dome top (metres) |
 * | baseRadius | 3.5 | Radius at the base |
 * | topRadius | 2.0 | Radius at the top (below gallery) |
 * | galleryRadius | 3.0 | Gallery overhang radius |
 * | galleryHeight | 2.5 | Height of the gallery/lantern section |
 * | domeRadius | 1.8 | Radius of the dome cap |
 * | domeHeight | 1.5 | Height of the dome above gallery |
 * | segments | 16 | Radial segments for revolve |
 */
export interface LighthouseParams {
  height: number;
  baseRadius: number;
  topRadius: number;
  galleryRadius: number;
  galleryHeight: number;
  domeRadius: number;
  domeHeight: number;
  segments: number;
}

const DEFAULTS: LighthouseParams = {
  height: 25,
  baseRadius: 3.5,
  topRadius: 2.0,
  galleryRadius: 3.0,
  galleryHeight: 2.5,
  domeRadius: 1.8,
  domeHeight: 1.5,
  segments: 16,
};

function resolveParams(raw: Record<string, unknown>): LighthouseParams {
  return {
    height: typeof raw['height'] === 'number' ? raw['height'] : DEFAULTS.height,
    baseRadius: typeof raw['baseRadius'] === 'number' ? raw['baseRadius'] : DEFAULTS.baseRadius,
    topRadius: typeof raw['topRadius'] === 'number' ? raw['topRadius'] : DEFAULTS.topRadius,
    galleryRadius: typeof raw['galleryRadius'] === 'number' ? raw['galleryRadius'] : DEFAULTS.galleryRadius,
    galleryHeight: typeof raw['galleryHeight'] === 'number' ? raw['galleryHeight'] : DEFAULTS.galleryHeight,
    domeRadius: typeof raw['domeRadius'] === 'number' ? raw['domeRadius'] : DEFAULTS.domeRadius,
    domeHeight: typeof raw['domeHeight'] === 'number' ? raw['domeHeight'] : DEFAULTS.domeHeight,
    segments: typeof raw['segments'] === 'number' ? raw['segments'] : DEFAULTS.segments,
  };
}

// ─── Generator ───────────────────────────────────────────────────────────────

/**
 * Build the full lighthouse profile as a single revolve.
 *
 * The profile traces from the base edge up the tapered tower, out to the
 * gallery overhang, up through the lantern, in to the dome, and over the dome
 * to a small tip. We avoid x=0 points in the main revolve (which would create
 * degenerate triangles) and instead use sweepTube with small radii at top/bottom
 * to close the solid properly.
 *
 * Strategy: Use sweepTube along the Y axis with a varying radius function that
 * traces the lighthouse profile. This naturally produces a watertight closed
 * tube with caps.
 */
function buildLighthouseProfile(params: LighthouseParams): Vec2[] {
  const {
    height,
    baseRadius,
    topRadius,
    galleryRadius,
    galleryHeight,
    domeRadius,
    domeHeight,
  } = params;

  const towerHeight = height - galleryHeight - domeHeight;
  const profile: Vec2[] = [];

  // Profile traces the outer silhouette from bottom to top.
  // x = radius at that height, y = height

  // Base edge
  profile.push({ x: baseRadius, y: 0 });

  // Tapered tower: several points for smooth taper
  const towerStations = 8;
  for (let i = 1; i <= towerStations; i++) {
    const t = i / towerStations;
    const radius = baseRadius + (topRadius - baseRadius) * t;
    const y = t * towerHeight;
    profile.push({ x: radius, y });
  }

  // Gallery overhang — step out
  const galleryBase = towerHeight;
  profile.push({ x: galleryRadius, y: galleryBase });

  // Gallery top
  const galleryTop = galleryBase + galleryHeight;
  profile.push({ x: galleryRadius, y: galleryTop });

  // Narrow in above gallery to dome base
  profile.push({ x: domeRadius, y: galleryTop });

  // Dome: hemisphere arc from dome base to top
  const domeStations = 6;
  for (let i = 1; i <= domeStations; i++) {
    const t = i / domeStations;
    const angle = t * Math.PI * 0.5;
    const x = domeRadius * Math.cos(angle);
    const y = galleryTop + domeHeight * Math.sin(angle);
    profile.push({ x: Math.max(x, 0.001), y }); // Avoid exactly 0 to prevent degenerate tris
  }

  return profile;
}

/**
 * Build a lighthouse as a sweepTube along a vertical path, with radius
 * varying according to the lighthouse profile. This avoids the revolve
 * axis-degenerate-triangle problem and produces a proper watertight solid
 * (sweepTube includes end caps).
 */
function buildLighthouseMesh(params: LighthouseParams): GeneratedMesh {
  const { segments } = params;
  const profile = buildLighthouseProfile(params);

  // Convert profile to a vertical path + radius function.
  // Profile is (radius, y) pairs — extract into path points and a radius lookup.
  const path: Vec3[] = profile.map(p => ({ x: 0, y: p.y, z: 0 }));

  // Use sweepTube with the profile radii
  const totalLen = profile.length;
  return sweepTube(
    path,
    (t: number) => {
      const idx = Math.min(Math.floor(t * (totalLen - 1)), totalLen - 2);
      const frac = t * (totalLen - 1) - idx;
      const r0 = profile[idx]?.x ?? 1;
      const r1 = profile[idx + 1]?.x ?? r0;
      return r0 + (r1 - r0) * frac;
    },
    segments,
  );
}

export const LighthouseGenerator: Generator<
  Record<string, unknown>,
  GeneratedModel
> = {
  id: 'lighthouse',

  generate(raw: Record<string, unknown>, _seed: Seed): GeneratedModel {
    const params = resolveParams(raw);

    const mesh = buildLighthouseMesh(params);

    const bounds = computeBounds(mesh.positions);
    const finalMesh: GeneratedMesh = {
      ...mesh,
      bounds,
      meta: {
        height: params.height,
        baseRadius: params.baseRadius,
        triangleCount: mesh.indices.length / 3,
      },
    };

    const model: GeneratedModel = {
      meshes: [finalMesh],
      groups: [
        { name: 'lighthouse', start: 0, count: mesh.indices.length, materialId: 'concrete' },
      ],
      transferables: [],
    };
    model.transferables = gatherTransferables(model);
    return model;
  },
};
