/**
 * Physics contracts — rigid body state, force generators, and derived hydrostatics.
 *
 * FROZEN CONTRACT — see docs/interfaces.md.
 *
 * Everything here is pure and deterministic in `(state, inputs, environment, dt)`.
 * No three.js, no DOM, no randomness that is not seeded. This is what makes the
 * physics headlessly testable and golden-run regression possible (requirement 11.3).
 */

import type {
  CurvePoint,
  Metres,
  MetresPerSecond,
  Quat,
  Radians,
  SessionTime,
  Vec3,
} from './units';
import type { Environment } from './environment';

/** Continuous control inputs, all normalized. */
export interface ControlState {
  /** Rudder angle, -1 (hard to port) .. 1 (hard to starboard). */
  rudder: number;
  /** Mainsheet, 0 (fully eased) .. 1 (fully trimmed). */
  mainsheet: number;
  /** Headsail sheet, 0 (fully eased) .. 1 (fully trimmed). */
  jibsheet: number;
  /** Spinnaker, 0 (doused) .. 1 (fully set and trimmed). */
  spinnaker: number;
  /** Vang / kicker tension, 0..1. Controls leech tension and twist. */
  vang: number;
  /** Traveller position, -1 (port) .. 1 (starboard). */
  traveller: number;
  /** Board or daggerboard depth, 0 (fully raised) .. 1 (fully down). */
  board: number;
  /** Crew fore-aft position, -1 (aft) .. 1 (forward). */
  crewFore: number;
  /** Crew athwartships position, -1 (port) .. 1 (starboard). */
  crewLateral: number;
  /** Hiking effort, 0 (sitting in) .. 1 (fully extended). */
  hike: number;
}

/** Complete rigid-body state of one boat. */
export interface BoatState {
  /** Centre-of-mass position in world space. */
  position: Vec3;
  /** Orientation. Identity means bow towards -Z (north) and mast up. */
  orientation: Quat;
  /** Linear velocity in world space, m/s. */
  linearVelocity: Vec3;
  /** Angular velocity in world space, rad/s. */
  angularVelocity: Vec3;
  /** Current control positions, after actuator rate limits. */
  controls: ControlState;
  /** Heel angle, positive to starboard. Derived from orientation, cached. */
  heel: Radians;
  /** Pitch angle, positive bow-up. Derived, cached. */
  pitch: Radians;
  /** Compass heading of the bow, clockwise from true north. Derived, cached. */
  heading: Radians;
  /** Speed through the water. */
  speed: MetresPerSecond;
  /** True when the hull is inverted or knocked down past its capsize angle. */
  capsized: boolean;
  /** True when a foiling boat is flying. */
  foiling: boolean;
  /**
   * Normalized rudder load, 0..1, exported for haptics and steering resistance
   * (requirement 5.7). Emerges from the rudder moment plus sail-plan imbalance.
   */
  helmLoad: number;
}

/** A force with its application point, in world space. */
export interface AppliedForce {
  /** Force vector, newtons. */
  force: Vec3;
  /** Application point in world space. Offset from the centre of mass yields moment. */
  point: Vec3;
}

/** Context handed to every force generator on each step. */
export interface ForceContext {
  state: BoatState;
  boat: BoatSpec;
  environment: Environment;
  time: SessionTime;
  /** Fixed timestep, seconds. */
  dt: number;
  /** Apparent wind at the sail plan's centre of effort. Precomputed once per step. */
  apparentWind: Vec3;
  /** Water density for this venue. */
  waterDensity: number;
  /** Air density from live pressure and temperature. */
  airDensity: number;
}

/**
 * One physical effect. Independent and composable: a new appendage is a new
 * generator, never an edit to the integrator (design.md §7.1).
 */
export interface ForceGenerator {
  /** Stable identifier, used by the profiler and by tests. */
  readonly id: string;
  /**
   * Compute forces for this step and push them into `out`.
   * MUST NOT allocate — push into the provided array and reuse pooled vectors.
   */
  evaluate(ctx: ForceContext, out: AppliedForce[]): void;
}

/** Hydrostatic properties computed from generated hull geometry (design.md §7.2). */
export interface Hydrostatics {
  /** Submerged volume at design waterline, m³. */
  displacedVolume: number;
  /** Mass implied by the displaced volume, kg. */
  displacement: number;
  /** Wetted surface area at design trim, m². */
  wettedSurface: number;
  /** Waterplane area, m². */
  waterplaneArea: number;
  /** Centre of buoyancy in hull-local coordinates. */
  centreOfBuoyancy: Vec3;
  /** Longitudinal centre of flotation, metres from the hull origin. */
  centreOfFlotation: number;
  /** Points at which buoyancy is sampled, hull-local, volume-weighted. */
  buoyancyPoints: BuoyancyPoint[];
  /** Righting moment against heel angle, computed by sweeping the hull. */
  rightingCurve: CurvePoint[];
  /** Length on the design waterline, metres. Sets the hull-speed limit. */
  waterlineLength: Metres;
  /** Maximum beam on the waterline, metres. */
  waterlineBeam: Metres;
}

/** One buoyancy sampling point on the hull. */
export interface BuoyancyPoint {
  /** Position in hull-local coordinates. */
  position: Vec3;
  /** Share of total volume this point represents, m³. */
  volume: number;
  /** Cross-sectional area at this station, m². Used for slam force. */
  sectionArea: number;
}

/** A sail in the rig. */
export interface SailSpec {
  id: string;
  kind: 'main' | 'jib' | 'genoa' | 'spinnaker' | 'code0';
  /** Sail area, m². */
  area: number;
  /** Luff length, metres. */
  luffLength: Metres;
  /** Foot length, metres. */
  footLength: Metres;
  /** Leech length, metres. */
  leechLength: Metres;
  /** Luff round as a fraction of luff length — drives generated camber. */
  luffRound: number;
  /** Broadseam as a fraction of foot length. */
  broadseam: number;
  /** Maximum camber as a fraction of chord. */
  maxCamber: number;
  /** Height of the centre of effort above the waterline, metres. */
  centreOfEffortHeight: Metres;
  /** Effective aspect ratio, for induced drag. */
  aspectRatio: number;
  /** Maximum sheeting angle from centreline, radians. */
  maxSheetAngle: Radians;
}

/** A lifting surface below the waterline. */
export interface FoilSpec {
  id: string;
  kind: 'keel' | 'daggerboard' | 'centreboard' | 'rudder' | 'liftingFoil';
  /** Planform area, m². */
  area: number;
  /** Span (depth for a keel), metres. */
  span: Metres;
  /** Mean chord, metres. */
  chord: Metres;
  /** Position in hull-local coordinates. */
  position: Vec3;
  /** Section thickness ratio. */
  thickness: number;
  /** True when the player can raise or lower it. */
  retractable: boolean;
  /** True for a steerable surface. */
  steerable: boolean;
}

/** Everything the physics engine needs about a boat, derived at load. */
export interface BoatSpec {
  id: string;
  name: string;
  /** Total mass including crew, kg. */
  mass: number;
  /** Diagonal inertia tensor in hull-local axes, kg·m². */
  inertia: Vec3;
  /** Centre of mass in hull-local coordinates. */
  centreOfMass: Vec3;
  hydrostatics: Hydrostatics;
  sails: SailSpec[];
  foils: FoilSpec[];
  /** Residuary resistance coefficient against Froude number. */
  residuaryCurve: CurvePoint[];
  /** Ballast mass, kg. Zero for dinghies. */
  ballastMass: number;
  /** Crew mass, kg. */
  crewMass: number;
  /** How far crew mass can move, hull-local metres. */
  crewMovementRange: Vec3;
  /** Heel angle beyond which the boat capsizes. */
  capsizeAngle: Radians;
  /** Number of hulls. 2 for a catamaran. */
  hullCount: 1 | 2;
  /** Present only on foiling boats. */
  foiling?: FoilingSpec;
}

/** Foiling parameters (requirement 4.11). */
export interface FoilingSpec {
  /** Speed at which the boat can begin to fly. */
  takeoffSpeed: MetresPerSecond;
  /** Foil lift coefficient against angle of attack. */
  liftCurve: CurvePoint[];
  /** Minimum and maximum ride height, metres. */
  rideHeightRange: [Metres, Metres];
  /** Drag multiplier once flying. Well below 1. */
  flyingDragFactor: number;
}

/** A polar diagram, computed from the physics model rather than authored. */
export interface PolarDiagram {
  /** True wind speeds sampled, m/s. */
  windSpeeds: number[];
  /** True wind angles sampled, radians, 0..π. */
  windAngles: number[];
  /** Boat speed indexed as `[windSpeedIndex][windAngleIndex]`, m/s. */
  boatSpeeds: number[][];
  /** Best upwind VMG angle per wind speed. */
  optimalUpwindAngle: number[];
  /** Best downwind VMG angle per wind speed. */
  optimalDownwindAngle: number[];
  /** Target speed for a given true wind speed and angle. */
  targetSpeed(windSpeed: number, windAngle: number): MetresPerSecond;
}

/** How much the game helps the player (requirement 5.5). Affects assists only. */
export type AssistLevel = 'arcade' | 'assisted' | 'simulation';

/** Physics level-of-detail tier (requirement 8.13, design.md §7.6). */
export type PhysicsLOD = 0 | 1 | 2 | 3;

/** Drives one boat's simulation. */
export interface BoatSimulation {
  readonly id: string;
  readonly spec: BoatSpec;
  readonly state: BoatState;
  /** Current LOD tier. */
  lod: PhysicsLOD;
  /** Advance by exactly one fixed timestep. */
  step(environment: Environment, time: SessionTime, dt: number): void;
  /** Set desired control positions. Actuator rate limits are applied internally. */
  setControls(target: Partial<ControlState>): void;
  /** Reset to a given position and heading, clearing velocities. */
  reset(position: Vec3, heading: Radians): void;
}
