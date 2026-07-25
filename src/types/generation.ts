/**
 * Generation contracts — procedural geometry and its derived metadata.
 *
 * FROZEN CONTRACT — see docs/interfaces.md.
 *
 * Generators emit plain typed arrays, never three.js objects, so they run in
 * workers, transfer without copying, and unit-test with no GPU
 * (requirements 9.8, 9.9). The render layer turns these buffers into geometry.
 */

import type { Metres, RGB, Seed, Vec2, Vec3 } from './units';

/**
 * A generated mesh as transferable buffers.
 *
 * All buffers are owned by the receiver after transfer. Indices are always
 * present — generators must not emit non-indexed geometry, since indexed data
 * is smaller and lets the hydrostatics code walk faces cheaply.
 */
export interface GeneratedMesh {
  /** Vertex positions, 3 floats per vertex. */
  positions: Float32Array;
  /** Vertex normals, 3 floats per vertex. */
  normals: Float32Array;
  /** Texture coordinates, 2 floats per vertex. */
  uvs: Float32Array;
  /** Triangle indices, 3 per face, counter-clockwise when viewed from outside. */
  indices: Uint32Array;
  /** Optional per-vertex colour, 3 floats per vertex. */
  colors?: Float32Array;
  /** Optional tangents for anisotropic materials, 4 floats per vertex. */
  tangents?: Float32Array;
  /** Axis-aligned bounds in the mesh's local space. */
  bounds: {
    min: Vec3;
    max: Vec3;
  };
  /**
   * Derived scalar metadata. Generators put computed geometric properties here —
   * volume, area, centroid components — so consumers never re-derive them.
   */
  meta: Readonly<Record<string, number>>;
}

/** Named groups of triangles within a mesh, so one mesh can carry several materials. */
export interface MeshGroup {
  name: string;
  /** Index offset into `indices`. */
  start: number;
  /** Number of indices in this group. */
  count: number;
  materialId: string;
}

/** A mesh plus its material groups. */
export interface GeneratedModel {
  meshes: GeneratedMesh[];
  groups: MeshGroup[];
  /** All buffers, gathered for `postMessage` transfer. */
  transferables: ArrayBufferLike[];
}

/**
 * A procedural generator. Pure and deterministic in `(params, seed)` — the same
 * inputs must always produce byte-identical output, which is what makes results
 * cacheable and testable.
 */
export interface Generator<TParams, TResult = GeneratedModel> {
  readonly id: string;
  generate(params: TParams, seed: Seed): TResult;
}

/** A closed curve describing one transverse hull section. */
export interface StationCurve {
  /**
   * Longitudinal position as a fraction of overall length, 0 (bow) .. 1 (stern).
   */
  position: number;
  /**
   * Half-breadth control points in the section plane: `y` is height above the
   * baseline, `x` is half-beam. Only the starboard half is given; the lofter
   * mirrors it. Ordered from keel upward.
   */
  points: Vec2[];
}

/** Parameters for the hull lofter — the single source for geometry AND physics. */
export interface HullParams {
  /** Length overall. */
  loa: Metres;
  /** Maximum beam. */
  beam: Metres;
  /** Canoe-body draft at the design waterline. */
  designDraft: Metres;
  /** Height of the design waterline above the baseline. */
  waterlineHeight: Metres;
  /** Transverse sections, ordered bow to stern. At least 6. */
  stations: StationCurve[];
  /** Bilge treatment. Chine produces hard edges, round produces smooth turns. */
  bilge: 'chine' | 'round';
  /** 1 for a monohull, 2 for a catamaran. */
  hullCount: 1 | 2;
  /** Centre-to-centre hull separation, metres. Only used when hullCount is 2. */
  hullSeparation?: Metres;
  /** Sheerline rise at bow and stern as a fraction of beam. */
  sheerRise: number;
  /** Deck camber as a fraction of beam. */
  deckCamber: number;
  /** Longitudinal subdivisions in the generated mesh. */
  lengthSegments: number;
  /** Points per station after resampling. */
  girthSegments: number;
}

/** Parameters for the rig builder. */
export interface RigParams {
  mastHeight: Metres;
  /** Mast diameter at the base. */
  mastBaseDiameter: Metres;
  /** Taper ratio: tip diameter as a fraction of base diameter. */
  mastTaper: number;
  /** Mast rake aft, radians. */
  mastRake: number;
  boomLength: Metres;
  boomDiameter: Metres;
  /** Boom height above the deck at the gooseneck. */
  boomHeight: Metres;
  /** Number of spreader pairs. Zero for an unstayed rig. */
  spreaderPairs: number;
  /** Standing rigging wire diameter. */
  shroudDiameter: Metres;
  /** True when the rig carries a bowsprit. */
  bowsprit: boolean;
  bowspritLength?: Metres;
  /** Mast step position in hull-local coordinates. */
  stepPosition: Vec3;
}

/** Parameters for the sail surface generator. Produces the cloth grid directly. */
export interface SailSurfaceParams {
  luffLength: Metres;
  footLength: Metres;
  leechLength: Metres;
  /** Luff round as a fraction of luff length. Creates camber when hoisted. */
  luffRound: number;
  /** Broadseam as a fraction of foot length. */
  broadseam: number;
  /** Twist from foot to head, radians. */
  twist: number;
  /** Grid resolution along the luff. */
  luffSegments: number;
  /** Grid resolution along the foot. */
  footSegments: number;
  /** Number of visible cloth panels. */
  panelCount: number;
}

/** A polyline in venue-local metres, used for coastlines and depth contours. */
export interface Polyline {
  points: Vec2[];
  /** True when the polyline closes on itself, e.g. an island. */
  closed: boolean;
  /** Depth in metres for contour lines; absent for coastlines. */
  depth?: number;
}

/** Parameters for the terrain builder. */
export interface TerrainParams {
  /** Venue extent in local metres. */
  bounds: { min: Vec2; max: Vec2 };
  /** Coastline polylines separating land from water. */
  coastlines: Polyline[];
  /** Bathymetric contours. */
  depthContours: Polyline[];
  /** Inland relief character. */
  relief: 'flat' | 'hilly' | 'mountainous';
  /** Maximum inland elevation. */
  maxElevation: Metres;
  /** Deepest water in the venue. */
  maxDepth: Metres;
  /** Heightfield resolution per axis. */
  resolution: number;
  seed: Seed;
}

/** Terrain output: render mesh plus the fields physics and shading need. */
export interface GeneratedTerrain {
  mesh: GeneratedMesh;
  /** Signed elevation grid, metres. Positive above water, negative below. */
  heightfield: Float32Array;
  /** Heightfield resolution per axis. */
  resolution: number;
  bounds: { min: Vec2; max: Vec2 };
  /** Land mask, 1 = land, 0 = water. Bilinear-sampled for shoreline effects. */
  landMask: Uint8Array;
  /** Signed distance to the nearest coastline, metres. Negative offshore. */
  shoreDistance: Float32Array;
  transferables: ArrayBufferLike[];
}

/** A landmark generator invocation in a venue definition. */
export interface LandmarkSpec {
  /** Which generator to invoke. */
  generator:
    | 'suspensionBridge'
    | 'shellVault'
    | 'ridgePlateau'
    | 'skyline'
    | 'lighthouse'
    | 'harbourFurniture'
    | 'breakwater';
  /** Generator-specific parameters, validated by the generator itself. */
  params: Record<string, number | string | boolean | number[]>;
  /** Placement in venue-local metres. */
  position: Vec3;
  /** Rotation about the vertical axis, radians. */
  rotation: number;
  /** Uniform scale. */
  scale: number;
}

/** Parameters for a procedural material, resolved into a TSL node graph. */
export interface MaterialParams {
  /** Which procedural material family to use. */
  kind:
    | 'gelcoat'
    | 'carbon'
    | 'anodized'
    | 'sailcloth'
    | 'teak'
    | 'terrain'
    | 'concrete'
    | 'water';
  baseColor: RGB;
  /** Perceptual roughness, 0..1. */
  roughness: number;
  /** Metalness, 0..1. */
  metalness: number;
  /** Family-specific tuning: flake density, weave scale, panel width, and so on. */
  detail?: Record<string, number>;
}

/** Progress reporting during the generation phase (requirement 8.7). */
export interface GenerationProgress {
  /** Which generator is running. */
  stage: string;
  /** Completed fraction, 0..1. */
  progress: number;
  /** Human-readable status for the loading screen. */
  message: string;
}
