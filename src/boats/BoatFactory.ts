/**
 * BoatFactory — turns a pure-data {@link BoatDefinition} into everything the
 * physics engine needs to run it.
 *
 * Two entry points:
 *   - `buildBoatSpec(def)` : loft the hull, derive hydrostatics (displacement,
 *     buoyancy points, righting curve recomputed about the REAL centre of
 *     gravity), and translate the definition's sails/foils into physics
 *     `SailSpec`/`FoilSpec`. Results are cached by definition id so repeated
 *     calls (e.g. a test building the same boat many times) are cheap.
 *   - `createBoatSimulation(def, opts?)` : build the spec, construct a
 *     `BoatSimulationImpl`, and register the force generators in a sensible
 *     evaluation order (see the ordering note below).
 *
 * Engine-agnostic: no three.js (the import boundary — only `src/render` may).
 * The lofted hull mesh is a plain `GeneratedMesh` of typed arrays; the render
 * layer turns it into geometry, we only use it for hydrostatics here.
 *
 * Conventions (shared with StationLofter.ts and the frozen types):
 *   - Y up, X transverse (+starboard), Z longitudinal (+bow, −stern), SI units,
 *     radians internally.
 *   - CCW winding from outside → positive signed volume (checked via the hull's
 *     `meta`/hydrostatics; `computeHydrostatics` takes the magnitude but a
 *     negative raw volume would signal an inverted hull — see `buildBoatSpec`).
 */

import type {
  BoatDefinition,
  BoatSpec,
  FoilDefinition,
  FoilSpec,
  GeneratedMesh,
  Hydrostatics,
  SailDefinition,
  SailSpec,
  Vec3,
} from '@/types';
import { PHYSICS_CONSTANTS } from '@/types';
import type { EventBus } from '@core/events';
import { StationLofter } from '@generation/hull/StationLofter';
import { computeHydrostatics } from '@physics/hydrostatics/computeHydrostatics';
import { computeRightingCurve } from '@physics/hydrostatics/rightingCurve';
import { BoatSimulationImpl } from '@physics/BoatSimulation';
import { BuoyancyForceGenerator } from '@physics/forces/Buoyancy';
import { WaveDragForceGenerator } from '@physics/forces/WaveDrag';
import { AeroForce } from '@physics/forces/AeroForce';
import { HydroResistance } from '@physics/forces/HydroResistance';
import { FoilLift } from '@physics/forces/FoilLift';
import { RightingMoment } from '@physics/forces/RightingMoment';
import { AngularDampingForceGenerator, DINGHY_ANGULAR_DAMPING } from './AngularDamping';

/** The full result of building a boat for simulation. */
export interface BuiltBoatSpec {
  spec: BoatSpec;
  /** The lofted hull mesh (hull-local coords), for the render layer or tests. */
  hullMesh: GeneratedMesh;
}

/** Options for {@link createBoatSimulation}. */
export interface CreateBoatSimulationOptions {
  /** Instance id; defaults to the definition id. */
  id?: string;
  /** Event bus for slam/spray events emitted by WaveDrag. Optional. */
  eventBus?: EventBus;
  /** Override water density (e.g. freshwater venue). Defaults to seawater. */
  waterDensity?: number;
  /**
   * Include the WaveDrag generator (orbital drag + surfing + slam). Default true.
   *
   * WaveDrag keeps module-scope per-point slam state (`_wasAbove`/`_prevVy`) that
   * is shared across instances; in a long headless soak its slam impulse can also
   * pump the lightly-damped roll mode. Callers that need a deterministic, clean
   * long run (e.g. a soak-stability check) may set this false; buoyancy still
   * drives the heave/pitch response to waves.
   */
  includeWaveDrag?: boolean;
}

/** The runnable simulation bundle returned by {@link createBoatSimulation}. */
export interface BoatSimulationBundle {
  sim: BoatSimulationImpl;
  spec: BoatSpec;
  hullMesh: GeneratedMesh;
  /** The aero generator, exposed so callers can read per-sail aero state. */
  aero: AeroForce;
  /** The foil generator, exposed for helm-load / side-force readouts. */
  foils: FoilLift;
  /** The hull resistance generator. */
  resistance: HydroResistance;
  /** The righting-moment generator (tracks capsize/recovery). */
  righting: RightingMoment;
}

// ── Caches keyed by definition id ────────────────────────────────────────────
const _specCache = new Map<string, BuiltBoatSpec>();

/**
 * Estimate a diagonal inertia tensor (hull-local axes) for the boat.
 *
 * A boat's yaw and pitch inertias are several times its roll inertia — a scalar
 * would make it respond identically to all three, which kills the feel of a hull
 * in beam seas (see RigidBody.ts). A uniform solid box, however, badly
 * UNDER-estimates ROLL inertia for a rigged dinghy: it ignores (a) the tall rig
 * mass well above the roll axis, (b) crew mass sitting out near the gunwale/hiking
 * strap, and (c) the hydrodynamic ADDED MASS of the water the hull must rotate,
 * which for a shallow dinghy hull roughly doubles the effective roll inertia.
 * Underestimating roll inertia makes the boat flick past its capsize angle in a
 * puff before the crew can respond — unphysically twitchy.
 *
 * We therefore build each principal inertia from identifiable mass groups:
 *
 *   - Hull (bare) as a uniform box of length `loa`, beam `beam`, depth `d`.
 *   - Crew as a point mass at the hiking arm (lateral) and seated height.
 *   - Rig as a point mass at ~40% mast height on the centreline.
 *   - A roll ADDED-MASS term (×1.0 of the structural roll inertia), the standard
 *     order-of-magnitude for a beamy shallow hull (Larsson, "Principles of Yacht
 *     Design"; the added mass of a half-cylinder of water ≈ the hull's own).
 *
 * This is a documented engineering estimate, NOT a measured tensor — but it gives
 * the right magnitudes and the right ordering (yaw ≈ pitch ≫ roll).
 */
function estimateInertia(def: BoatDefinition, hullMass: number, depth: number): Vec3 {
  const loa = def.hull.loa;
  const beam = def.hull.beam;
  const l2 = loa * loa;
  const b2 = beam * beam;
  const d2 = depth * depth;

  // Hull as a uniform box.
  const hullRoll = (hullMass / 12) * (b2 + d2); // about X (longitudinal)
  const hullYaw = (hullMass / 12) * (l2 + b2); // about Y (vertical)
  const hullPitch = (hullMass / 12) * (l2 + d2); // about Z (transverse)

  // Crew point mass: seated/hiked at the gunwale, a little aft of centre.
  const crewMass = def.crewMass * def.crewCount;
  const crewArm = def.crewMovementRange.x * 0.6; // typical lateral station (seated-to-hiked avg)
  const crewHeight = 0.3; // CoG above the waterline when seated in.
  const crewFore = loa * 0.1; // slightly aft of amidships.
  const crewRoll = crewMass * (crewArm * crewArm + crewHeight * crewHeight);
  const crewYaw = crewMass * (crewArm * crewArm + crewFore * crewFore);
  const crewPitch = crewMass * (crewFore * crewFore + crewHeight * crewHeight);

  // Rig point mass (mast + boom + sail), light but high. ~12 kg at ~40% of the
  // rig height above the waterline.
  const rigMass = 12;
  const rigHeight = (def.sails[0]?.centreOfEffortHeight ?? 2) * 1.0;
  const rigRoll = rigMass * rigHeight * rigHeight;
  const rigPitch = rigMass * rigHeight * rigHeight;
  const rigYaw = rigMass * (def.hull.beam * 0.1) * (def.hull.beam * 0.1); // negligible.

  // Added mass of entrained water increases roll (and to a lesser extent pitch).
  const ADDED_MASS_ROLL = 1.0;
  const ADDED_MASS_PITCH = 0.3;

  const roll = (hullRoll + crewRoll + rigRoll) * (1 + ADDED_MASS_ROLL);
  const pitch = (hullPitch + crewPitch + rigPitch) * (1 + ADDED_MASS_PITCH);
  const yaw = hullYaw + crewYaw + rigYaw;

  return { x: roll, y: yaw, z: pitch };
}

/** Translate a content {@link SailDefinition} into a physics {@link SailSpec}. */
function toSailSpec(def: SailDefinition): SailSpec {
  const s = def.surface;
  return {
    id: def.id,
    kind: def.kind,
    area: def.area,
    luffLength: s.luffLength,
    footLength: s.footLength,
    leechLength: s.leechLength,
    luffRound: s.luffRound,
    broadseam: s.broadseam,
    maxCamber: def.maxCamber,
    centreOfEffortHeight: def.centreOfEffortHeight,
    aspectRatio: def.aspectRatio,
    maxSheetAngle: def.maxSheetAngle,
  };
}

/** Translate a content {@link FoilDefinition} into a physics {@link FoilSpec}. */
function toFoilSpec(def: FoilDefinition): FoilSpec {
  return {
    id: def.id,
    kind: def.kind,
    area: def.area,
    span: def.span,
    chord: def.chord,
    position: { x: def.position.x, y: def.position.y, z: def.position.z },
    thickness: def.thickness,
    retractable: def.retractable,
    steerable: def.steerable,
  };
}

/**
 * Build a {@link BoatSpec} (and the lofted hull mesh) from a definition.
 *
 * Steps:
 *   1. Loft the hull from `def.hull` via `StationLofter` → GeneratedMesh.
 *   2. `computeHydrostatics` at the design waterline → displacement, CoB,
 *      wetted surface, buoyancy points, waterline length/beam, and a first
 *      righting curve (computed about an assumed CoG).
 *   3. Recompute the righting curve about the REAL centre of gravity (crew + hull
 *      mass, with a CoG height estimate), since stability depends strongly on it.
 *   4. Assemble sails, foils, inertia, mass, and the rest of the spec.
 *
 * Cached by `def.id`.
 */
export function buildBoatSpec(def: BoatDefinition): BuiltBoatSpec {
  const cached = _specCache.get(def.id);
  if (cached !== undefined) return cached;

  // ── 1. Loft the hull. StationLofter is deterministic; seed is irrelevant. ──
  const model = StationLofter.generate(def.hull, 0);
  const hullMesh = model.meshes[0];
  if (hullMesh === undefined) {
    throw new Error(`BoatFactory: hull lofter produced no mesh for '${def.id}'`);
  }

  const totalMass = def.hullMass + def.ballastMass + def.crewMass * def.crewCount;

  // ── 2. Hydrostatics at the design waterline. ──
  const waterDensity = PHYSICS_CONSTANTS.WATER_DENSITY;
  const baseHydro = computeHydrostatics(hullMesh, def.hull.waterlineHeight, waterDensity);

  // ── 3. Centre of gravity and a righting curve recomputed about it. ──
  // Hull + crew sit above the canoe body. For an unballasted dinghy the CoG is
  // a little above the waterline (crew weight dominates and sits high). We place
  // it a modest height above the centre of buoyancy; crew lateral motion is
  // handled dynamically by RightingMoment, not baked into the curve.
  const cog: Vec3 = {
    x: 0,
    y: baseHydro.centreOfBuoyancy.y + estimateCogRise(def),
    z: baseHydro.centreOfBuoyancy.z,
  };

  const rightingCurve = computeRightingCurve(
    hullMesh,
    baseHydro.displacedVolume,
    cog.y,
    36,
    150,
  );

  const hydrostatics: Hydrostatics = {
    ...baseHydro,
    rightingCurve,
  };

  // ── 4. Assemble the spec. ──
  // Effective depth for the inertia box: canoe-body draft + a little topside.
  const depth = Math.max(def.hull.designDraft * 2, hydrostatics.waterlineBeam * 0.2, 0.3);
  const inertia = estimateInertia(def, def.hullMass, depth);

  const spec: BoatSpec = {
    id: def.id,
    name: def.name,
    mass: totalMass,
    inertia,
    centreOfMass: cog,
    hydrostatics,
    sails: def.sails.map(toSailSpec),
    foils: def.foils.map(toFoilSpec),
    residuaryCurve: def.residuaryCurve,
    ballastMass: def.ballastMass,
    crewMass: def.crewMass * def.crewCount,
    crewMovementRange: {
      x: def.crewMovementRange.x,
      y: def.crewMovementRange.y,
      z: def.crewMovementRange.z,
    },
    capsizeAngle: def.capsizeAngle,
    hullCount: def.hull.hullCount,
    ...(def.foiling !== undefined
      ? {
          foiling: {
            takeoffSpeed: def.foiling.takeoffSpeed,
            liftCurve: def.foiling.liftCurve,
            rideHeightRange: def.foiling.rideHeightRange,
            flyingDragFactor: def.foiling.flyingDragFactor,
          },
        }
      : {}),
  };

  const built: BuiltBoatSpec = { spec, hullMesh };
  _specCache.set(def.id, built);
  return built;
}

/**
 * Estimate how far the centre of gravity sits above the centre of buoyancy.
 *
 * For a ballasted keelboat the CoG is below the CoB (ballast pulls it down);
 * for an unballasted dinghy the CoG is ABOVE the CoB (crew + rig weight sits
 * high), which is exactly why a dinghy needs crew hiking to stay upright. We
 * take a crew- and rig-weighted height above the waterline, scaled down by the
 * fraction of mass that is low (hull) vs high (crew).
 */
function estimateCogRise(def: BoatDefinition): number {
  if (def.ballastMass > 0) {
    // Ballasted: CoG pulled well below the CoB by the keel.
    return -Math.max(def.hull.designDraft, 0.2);
  }
  // Unballasted dinghy: crew mass sits roughly at gunwale height; rig CoG higher
  // but light. Weighted CoG height above the waterline ~0.15–0.25 m for a Laser.
  const crewFraction =
    (def.crewMass * def.crewCount) / (def.hullMass + def.crewMass * def.crewCount);
  // Crew sits ~0.3 m above the waterline when seated in; blended with the low hull.
  return 0.3 * crewFraction;
}

/**
 * Build a runnable simulation for a boat definition.
 *
 * ## Force-generator evaluation order
 *
 * Order is mostly irrelevant — forces compose additively and the integrator
 * sums them — with ONE real coupling: `FoilLift` computes the total side force
 * each step and `HydroResistance` reads it (`resistance.totalSideForce`) to
 * derive induced drag. So FoilLift MUST be registered (and therefore evaluated)
 * before HydroResistance. We wire that coupling explicitly after construction.
 *
 * Registration order used:
 *   1. Buoyancy   (weight + distributed buoyancy; keeps the hull floating)
 *   2. FoilLift   (side force from board + rudder; sets totalSideForce)
 *   3. side-force bridge (copies FoilLift's side force into HydroResistance)
 *   4. HydroResistance (friction + residuary + induced drag; reads side force)
 *   5. WaveDrag   (orbital drag + surfing + slam)
 *   6. Aero       (sail drive/heel/yaw)
 *   7. RightingMoment (hull-form + crew righting; capsize/recovery)
 */
export function createBoatSimulation(
  def: BoatDefinition,
  opts: CreateBoatSimulationOptions = {},
): BoatSimulationBundle {
  const { spec, hullMesh } = buildBoatSpec(def);

  const sim = new BoatSimulationImpl(spec, opts.id ?? def.id);

  const buoyancy = new BuoyancyForceGenerator();
  const foils = new FoilLift();
  const resistance = new HydroResistance();
  const waveDrag = new WaveDragForceGenerator(opts.id ?? def.id, opts.eventBus);
  const aero = new AeroForce(spec);
  const righting = new RightingMoment();
  const damping = new AngularDampingForceGenerator(DINGHY_ANGULAR_DAMPING);

  sim.addForceGenerator(buoyancy);
  sim.addForceGenerator(foils);
  // Bridge runs AFTER FoilLift and BEFORE HydroResistance so induced drag uses
  // the current step's side force (zero latency).
  sim.addForceGenerator(createSideForceBridge(foils, resistance));
  sim.addForceGenerator(resistance);
  if (opts.includeWaveDrag !== false) {
    sim.addForceGenerator(waveDrag);
  }
  sim.addForceGenerator(aero);
  sim.addForceGenerator(righting);
  // Hydrodynamic angular damping (roll/pitch/yaw). Composable boat-level
  // generator — the frozen physics models the righting moment but not the
  // damping that lets a dinghy actually settle. See AngularDamping.ts.
  sim.addForceGenerator(damping);

  return { sim, spec, hullMesh, aero, foils, resistance, righting };
}

/**
 * A zero-force generator whose only job is to copy FoilLift's computed side
 * force into HydroResistance before HydroResistance runs. Registered AFTER
 * FoilLift and BEFORE HydroResistance so the induced-drag term uses the current
 * step's side force with no latency.
 */
function createSideForceBridge(foils: FoilLift, resistance: HydroResistance): {
  id: string;
  evaluate(): void;
} {
  return {
    id: 'side-force-bridge',
    evaluate(): void {
      resistance.totalSideForce = foils.totalSideForce;
    },
  };
}
