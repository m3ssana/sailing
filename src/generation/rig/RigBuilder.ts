/**
 * Rig builder — D.3.
 *
 * Takes a RigParams definition and produces a complete rig model: tapered mast,
 * boom, spreaders, standing rigging (shrouds, forestay, backstay), running
 * rigging (halyard), and optional bowsprit with rigging.
 *
 * Coordinate convention (hull-local, matching StationLofter.ts):
 * - Y-up (vertical), X-transverse (starboard positive), Z-longitudinal
 *   (bow positive, stern negative).
 * - Mast rake is aft: the mast top tilts toward -Z (stern direction).
 *
 * Winding: CCW viewed from outside → positive signed volume (for closed tubes).
 *
 * Engine-agnostic — no three.js.
 */

import type { GeneratedMesh, GeneratedModel, Generator, RigParams, Seed, Vec3 } from '@/types';
import { sweepTube, ribbon } from '../common/sweep';
import { computeBounds, gatherTransferables, mergeMeshes } from '../common/meshUtils';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Radial segments for main spars (mast, boom, bowsprit). Higher = smoother. */
const SPAR_RADIAL_SEGMENTS = 12;

/** Radial segments for spreaders (slightly less round, saves geometry). */
const SPREADER_RADIAL_SEGMENTS = 8;

/** Radial segments for standing rigging wires (very thin, few needed). */
const RIGGING_RADIAL_SEGMENTS = 6;

/** Number of path stations along each spar for smooth tapering. */
const SPAR_PATH_STATIONS = 16;

/** Number of path stations for rigging lines (simple straight lines). */
const RIGGING_PATH_STATIONS = 4;

/**
 * Spreader height heuristic:
 * Spreaders are distributed evenly in the upper portion of the mast, starting
 * at 40% of mast height and ending at 85% of mast height. This models typical
 * fractional rigging where the shroud attachment zone occupies the upper half
 * of the mast.
 *
 * For a single spreader pair: placed at 62.5% (midpoint of 40%–85%).
 * For multiple pairs: linearly spaced between 40% and 85%.
 */
const SPREADER_HEIGHT_FRACTION_START = 0.4;
const SPREADER_HEIGHT_FRACTION_END = 0.85;

/**
 * Spreader length as a fraction of beam at that height.
 * Typical modern racing rigs have spreaders extending about 10-15% of mast height.
 * We use 12% as a compromise.
 */
const SPREADER_LENGTH_FRACTION = 0.12;

/** Spreader taper (tip diameter as fraction of base diameter). */
const SPREADER_TAPER = 0.6;

/** Spreader base diameter as fraction of mast base diameter. */
const SPREADER_DIAMETER_FRACTION = 0.4;

/**
 * Chainplate positions — distance from mast step in ±X and -Z directions,
 * as fractions of mast height. These represent the deck attachment points
 * for shrouds.
 */
const CHAINPLATE_X_FRACTION = 0.15;
const CHAINPLATE_Z_AFT_FRACTION = 0.05;

/** Forestay attaches forward: fraction of mast height as a Z offset from step. */
const FORESTAY_DECK_Z_FRACTION = 0.8;

/** Backstay attaches aft: fraction of mast height as a Z offset from step. */
const BACKSTAY_DECK_Z_FRACTION = 0.6;

/** Bow position for bowsprit attachment, as fraction of mast height forward of step. */
const BOWSPRIT_DECK_Z_FRACTION = 0.3;

/** Sweep angle of spreaders: slight aft deflection in radians (~15°). */
const SPREADER_AFT_SWEEP = 0.26;

// ─── Geometry builders ───────────────────────────────────────────────────────

/**
 * Build a straight or slightly curved path between two points with N stations.
 */
function straightPath(start: Vec3, end: Vec3, stations: number): Vec3[] {
  const path: Vec3[] = [];
  for (let i = 0; i < stations; i++) {
    const t = stations > 1 ? i / (stations - 1) : 0;
    path.push({
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t,
      z: start.z + (end.z - start.z) * t,
    });
  }
  return path;
}

/**
 * Compute the mast tip position given step position, height, and rake.
 * Rake is aft (tilts toward -Z in hull-local space).
 */
function mastTipPosition(step: Vec3, height: number, rake: number): Vec3 {
  return {
    x: step.x,
    y: step.y + height * Math.cos(rake),
    z: step.z - height * Math.sin(rake),
  };
}

/**
 * Compute a point along the mast at a given height fraction.
 */
function mastPointAt(step: Vec3, height: number, rake: number, fraction: number): Vec3 {
  const h = height * fraction;
  return {
    x: step.x,
    y: step.y + h * Math.cos(rake),
    z: step.z - h * Math.sin(rake),
  };
}

// ─── Mast ────────────────────────────────────────────────────────────────────

function buildMast(params: RigParams): GeneratedMesh {
  const { stepPosition, mastHeight, mastBaseDiameter, mastTaper, mastRake } = params;
  const baseRadius = mastBaseDiameter / 2;
  const tipRadius = baseRadius * mastTaper;

  const start = stepPosition;
  const end = mastTipPosition(stepPosition, mastHeight, mastRake);
  const path = straightPath(start, end, SPAR_PATH_STATIONS);

  return sweepTube(
    path,
    (t: number) => baseRadius + (tipRadius - baseRadius) * t,
    SPAR_RADIAL_SEGMENTS,
  );
}

// ─── Boom ────────────────────────────────────────────────────────────────────

function buildBoom(params: RigParams): GeneratedMesh {
  const { stepPosition, boomLength, boomDiameter, boomHeight } = params;
  const radius = boomDiameter / 2;

  // Gooseneck is at the mast, at boomHeight above the deck (step Y + boomHeight)
  const gooseneck: Vec3 = {
    x: stepPosition.x,
    y: stepPosition.y + boomHeight,
    z: stepPosition.z,
  };

  // Boom extends aft (-Z direction in hull-local)
  const boomEnd: Vec3 = {
    x: gooseneck.x,
    y: gooseneck.y,
    z: gooseneck.z - boomLength,
  };

  const path = straightPath(gooseneck, boomEnd, SPAR_PATH_STATIONS);

  // Slight taper on the boom (90% at tip)
  return sweepTube(
    path,
    (t: number) => radius * (1 - 0.1 * t),
    SPAR_RADIAL_SEGMENTS,
  );
}

// ─── Spreaders ───────────────────────────────────────────────────────────────

/**
 * Compute the height fractions for each spreader pair.
 */
function spreaderHeightFractions(pairs: number): number[] {
  if (pairs <= 0) return [];
  if (pairs === 1) {
    return [(SPREADER_HEIGHT_FRACTION_START + SPREADER_HEIGHT_FRACTION_END) / 2];
  }
  const fractions: number[] = [];
  for (let i = 0; i < pairs; i++) {
    const t = i / (pairs - 1);
    fractions.push(
      SPREADER_HEIGHT_FRACTION_START +
        t * (SPREADER_HEIGHT_FRACTION_END - SPREADER_HEIGHT_FRACTION_START),
    );
  }
  return fractions;
}

function buildSpreaders(params: RigParams): GeneratedMesh[] {
  const { stepPosition, mastHeight, mastRake, mastBaseDiameter, spreaderPairs } = params;
  if (spreaderPairs <= 0) return [];

  const meshes: GeneratedMesh[] = [];
  const fractions = spreaderHeightFractions(spreaderPairs);
  const spreaderLength = mastHeight * SPREADER_LENGTH_FRACTION;
  const baseDiam = mastBaseDiameter * SPREADER_DIAMETER_FRACTION;

  for (const frac of fractions) {
    const mastPt = mastPointAt(stepPosition, mastHeight, mastRake, frac);

    // Each spreader pair: one port (-X), one starboard (+X)
    // Spreaders have a slight aft sweep (toward -Z)
    for (const sign of [-1, 1]) {
      const tipX = mastPt.x + sign * spreaderLength;
      const tipZ = mastPt.z - spreaderLength * Math.sin(SPREADER_AFT_SWEEP);

      const start: Vec3 = { x: mastPt.x, y: mastPt.y, z: mastPt.z };
      const end: Vec3 = { x: tipX, y: mastPt.y, z: tipZ };

      const path = straightPath(start, end, 8);
      const baseR = baseDiam / 2;
      const mesh = sweepTube(
        path,
        (t: number) => baseR * (1 - (1 - SPREADER_TAPER) * t),
        SPREADER_RADIAL_SEGMENTS,
      );
      meshes.push(mesh);
    }
  }

  return meshes;
}

// ─── Standing rigging ────────────────────────────────────────────────────────

/**
 * Build standing rigging: shrouds, forestay, backstay.
 * Only produced when spreaderPairs > 0 (stayed rig).
 *
 * Shroud routing:
 * - Cap shrouds run from mast-top to the chainplates (outermost, through all spreader tips).
 * - Intermediate shrouds run from each spreader level to chainplates.
 * For simplicity, we model one shroud per side per level running from that level
 * to the chainplates, plus a cap shroud from the top.
 */
function buildStandingRigging(params: RigParams): GeneratedMesh[] {
  const { stepPosition, mastHeight, mastRake, shroudDiameter, spreaderPairs } = params;
  if (spreaderPairs <= 0) return [];

  const meshes: GeneratedMesh[] = [];
  const fractions = spreaderHeightFractions(spreaderPairs);
  const spreaderLength = mastHeight * SPREADER_LENGTH_FRACTION;
  const wireRadius = shroudDiameter / 2;

  // Chainplate positions (deck level, offset from mast step)
  const chainplateX = mastHeight * CHAINPLATE_X_FRACTION;
  const chainplateZ = -mastHeight * CHAINPLATE_Z_AFT_FRACTION;
  const deckY = stepPosition.y;

  // ── Cap shrouds: mast-top to chainplates (port + starboard)
  const mastTop = mastTipPosition(stepPosition, mastHeight, mastRake);
  for (const sign of [-1, 1]) {
    const chainplate: Vec3 = {
      x: stepPosition.x + sign * chainplateX,
      y: deckY,
      z: stepPosition.z + chainplateZ,
    };
    const path = straightPath(mastTop, chainplate, RIGGING_PATH_STATIONS);
    meshes.push(sweepTube(path, () => wireRadius, RIGGING_RADIAL_SEGMENTS));
  }

  // ── Intermediate shrouds: from each spreader tip to chainplates
  for (const frac of fractions) {
    const mastPt = mastPointAt(stepPosition, mastHeight, mastRake, frac);
    for (const sign of [-1, 1]) {
      const spreaderTip: Vec3 = {
        x: mastPt.x + sign * spreaderLength,
        y: mastPt.y,
        z: mastPt.z - spreaderLength * Math.sin(SPREADER_AFT_SWEEP),
      };
      const chainplate: Vec3 = {
        x: stepPosition.x + sign * chainplateX,
        y: deckY,
        z: stepPosition.z + chainplateZ,
      };
      const path = straightPath(spreaderTip, chainplate, RIGGING_PATH_STATIONS);
      meshes.push(sweepTube(path, () => wireRadius, RIGGING_RADIAL_SEGMENTS));
    }
  }

  // ── Forestay: mast-top to bow deck
  const forestayDeck: Vec3 = {
    x: stepPosition.x,
    y: deckY,
    z: stepPosition.z + mastHeight * FORESTAY_DECK_Z_FRACTION,
  };
  const forestayPath = straightPath(mastTop, forestayDeck, RIGGING_PATH_STATIONS);
  meshes.push(sweepTube(forestayPath, () => wireRadius, RIGGING_RADIAL_SEGMENTS));

  // ── Backstay: mast-top to stern deck
  const backstayDeck: Vec3 = {
    x: stepPosition.x,
    y: deckY,
    z: stepPosition.z - mastHeight * BACKSTAY_DECK_Z_FRACTION,
  };
  const backstayPath = straightPath(mastTop, backstayDeck, RIGGING_PATH_STATIONS);
  meshes.push(sweepTube(backstayPath, () => wireRadius, RIGGING_RADIAL_SEGMENTS));

  return meshes;
}

// ─── Running rigging ─────────────────────────────────────────────────────────

/**
 * Build running rigging: main halyard/sheet from mast head to deck.
 * Uses ribbon for visual lightness.
 */
function buildRunningRigging(params: RigParams): GeneratedMesh[] {
  const { stepPosition, mastHeight, mastRake, shroudDiameter } = params;
  const meshes: GeneratedMesh[] = [];

  // Main halyard: mast head to a deck point near the cockpit (aft of mast)
  const mastTop = mastTipPosition(stepPosition, mastHeight, mastRake);
  const halyardDeck: Vec3 = {
    x: stepPosition.x,
    y: stepPosition.y,
    z: stepPosition.z - mastHeight * 0.3, // aft of mast, toward cockpit
  };

  // Use ribbon for the halyard line — thinner visual profile
  const halyardWidth = shroudDiameter * 1.5;
  const halyardPath = straightPath(mastTop, halyardDeck, RIGGING_PATH_STATIONS);
  meshes.push(ribbon(halyardPath, () => halyardWidth));

  return meshes;
}

// ─── Bowsprit ────────────────────────────────────────────────────────────────

function buildBowsprit(params: RigParams): GeneratedMesh[] {
  const { stepPosition, bowspritLength, mastHeight, shroudDiameter } = params;
  if (!params.bowsprit) return [];

  const meshes: GeneratedMesh[] = [];
  const length = bowspritLength ?? mastHeight * 0.15; // default 15% of mast height
  const diameter = params.boomDiameter * 0.7; // slightly thinner than the boom

  // Bowsprit projects forward (+Z in hull-local) from the bow region
  const bowspritBase: Vec3 = {
    x: stepPosition.x,
    y: stepPosition.y,
    z: stepPosition.z + mastHeight * BOWSPRIT_DECK_Z_FRACTION,
  };
  const bowspritTip: Vec3 = {
    x: bowspritBase.x,
    y: bowspritBase.y,
    z: bowspritBase.z + length,
  };

  const path = straightPath(bowspritBase, bowspritTip, 8);
  const baseR = diameter / 2;
  meshes.push(sweepTube(path, (t: number) => baseR * (1 - 0.15 * t), SPAR_RADIAL_SEGMENTS));

  // Bowsprit bobstay: rigging line from bowsprit tip down to the hull
  const bobstayDeck: Vec3 = {
    x: bowspritBase.x,
    y: bowspritBase.y - diameter * 2,
    z: bowspritBase.z,
  };
  const bobstayPath = straightPath(bowspritTip, bobstayDeck, RIGGING_PATH_STATIONS);
  meshes.push(ribbon(bobstayPath, () => shroudDiameter * 1.2));

  return meshes;
}

// ─── Generator ───────────────────────────────────────────────────────────────

/**
 * Rig builder generator.
 *
 * Implements Generator<RigParams, GeneratedModel>. Deterministic in (params, seed).
 * Seed is accepted for interface compliance but not used — all geometry is fully
 * determined by RigParams.
 */
export const RigBuilder: Generator<RigParams, GeneratedModel> = {
  id: 'rig-builder',

  generate(params: RigParams, _seed: Seed): GeneratedModel {
    const allMeshes: GeneratedMesh[] = [];

    // ── 1. Mast (always present)
    const mastMesh = buildMast(params);
    allMeshes.push(mastMesh);

    // ── 2. Boom (always present)
    const boomMesh = buildBoom(params);
    allMeshes.push(boomMesh);

    // ── 3. Spreaders
    const spreaderMeshes = buildSpreaders(params);
    for (const m of spreaderMeshes) {
      allMeshes.push(m);
    }

    // ── 4. Standing rigging (only for stayed rigs)
    const standingMeshes = buildStandingRigging(params);
    for (const m of standingMeshes) {
      allMeshes.push(m);
    }

    // ── 5. Running rigging
    const runningMeshes = buildRunningRigging(params);
    for (const m of runningMeshes) {
      allMeshes.push(m);
    }

    // ── 6. Bowsprit (if enabled)
    const bowspritMeshes = buildBowsprit(params);
    for (const m of bowspritMeshes) {
      allMeshes.push(m);
    }

    // ── Merge into single mesh ───────────────────────────────────────────────
    const merged = mergeMeshes(allMeshes);

    // Recompute bounds on merged
    const bounds = computeBounds(merged.positions);
    const finalMesh: GeneratedMesh = {
      ...merged,
      bounds,
      meta: {
        mastHeight: params.mastHeight,
        boomLength: params.boomLength,
        spreaderPairs: params.spreaderPairs,
        partCount: allMeshes.length,
        triangleCount: merged.indices.length / 3,
      },
    };

    const model: GeneratedModel = {
      meshes: [finalMesh],
      groups: [
        { name: 'rig', start: 0, count: merged.indices.length, materialId: 'carbon' },
      ],
      transferables: [],
    };

    model.transferables = gatherTransferables(model);
    return model;
  },
};
