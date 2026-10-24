/**
 * HUD view-model types — the pure, engine-agnostic data surface the render loop
 * builds each frame and the React UI renders.
 *
 * These are LOCAL (non-frozen) types. They never edit `src/types/`. The frozen
 * surface (`BoatState`, `ControlState`, `WeatherSnapshot`, `CoachingHint`,
 * `SailAeroState`, …) is consumed as INPUT; this module's output is a flat,
 * allocation-reuse-friendly struct of numbers and enums.
 *
 * Unit discipline (non-negotiable, see src/types/units.ts):
 * - Everything crossing IN is SI and radians.
 * - The view model carries BOTH the SI source value AND the display value in the
 *   player's chosen units (knots / nautical miles), so the `formatHud` layer only
 *   formats — it never converts. Conversions use the exact `UNITS` constants
 *   derived from 1852/3600.
 *
 * Direction conventions (inherited from the data source, deliberate):
 * - wind bearing = the compass bearing the wind blows FROM.
 * - current direction = the bearing the current flows TOWARDS.
 */

import type { Radians } from '@/types/units';
import type { WeatherSource } from '@/types/weather';

/** Display unit system for speed/distance. Knots+NM is the sailing default. */
export type UnitSystem = 'metricSI' | 'knotsNm';

/**
 * HUD information-density preset (requirement 11.x / 2.9). Which widgets are
 * shown is DATA, defined once in {@link PRESET_WIDGETS} and tested exhaustively.
 */
export type HudPreset = 'full' | 'moderate' | 'minimal' | 'none';

/** The widgets the HUD can show. A preset is a subset of these. */
export type HudWidget =
  | 'wind'
  | 'speed'
  | 'trim'
  | 'heelHelm'
  | 'compass'
  | 'conditions'
  | 'coaching';

/** Point of sail classification, derived from the true wind angle magnitude. */
export type PointOfSail =
  | 'head-to-wind'
  | 'close-hauled'
  | 'close-reach'
  | 'beam-reach'
  | 'broad-reach'
  | 'running';

/** A 2D point in venue-local metres (x east, y south). Matches frozen `Vec2`. */
export interface HudVec2 {
  x: number;
  y: number;
}

/**
 * Per-sail trim state surfaced on the trim gauge. Mirrors the parts of the
 * frozen `SailAeroState` the HUD actually shows, so the view model never leaks a
 * physics object reference into the UI.
 */
export interface HudSailTrim {
  sailId: string;
  /** 0 = fully separated / luffing, 1 = fully attached flow. */
  attachment: number;
  /** True when the sail is luffing (flow detached, flogging). */
  luffing: boolean;
}

/** Inputs to {@link buildHudViewModel}. All SI / radians. */
export interface HudInput {
  /** Rigid-body state of the player's boat (frozen contract). */
  boat: BoatStateLike;
  /** Current control positions (frozen contract). */
  controls: ControlStateLike;
  /**
   * True wind the boat sees, as speed (m/s) and the bearing it comes FROM
   * (radians, compass-from). Usually from the weather sample at the boat.
   */
  trueWind: { speed: number; fromBearing: Radians };
  /**
   * Apparent wind at the rig, as speed (m/s) and ANGLE relative to the bow
   * (radians, signed: positive = wind from starboard bow, negative = port bow).
   * The render loop computes this from true wind + boat velocity; the view model
   * also recomputes an apparent-wind-angle from first principles so it can be
   * tested, but accepts the physics value when supplied.
   */
  apparentWind: { speed: number; angle: Radians };
  /** Course over ground (radians, compass bearing of the velocity vector). */
  courseOverGround: Radians;
  /** Speed over ground, m/s. */
  speedOverGround: number;
  /** Weather provenance — drives the data-source label. */
  weatherSource: WeatherSource;
  /** Horizontal visibility, metres (for the conditions panel). */
  visibility: number;
  /** Current speed (m/s) and the bearing it flows TOWARDS (radians). */
  current: { speed: number; towardsBearing: Radians };
  /**
   * Polar target-speed lookup: given (true wind speed m/s, true wind ANGLE off
   * the bow in radians, 0..π), returns the model's target boat speed in m/s.
   * This is `PolarDiagram.targetSpeed` passed by reference — the HUD layer does
   * not own the polar.
   */
  targetSpeed: (twsMps: number, twaRad: number) => number;
  /** Next mark to round, venue-local metres, or null when none. */
  nextMark: { id: string; position: HudVec2 } | null;
  /** Per-sail aero state, if the physics exposes it this frame. */
  sails?: readonly HudSailTrim[];
  /** The most prominent coaching hint to show, or null. */
  coaching?: HudCoachingLike | null;
  /** Information-density preset. */
  preset: HudPreset;
  /** Display unit system. */
  units: UnitSystem;
  /** When true, the UI should render opaque backdrops for contrast (req 12.1). */
  opaqueBackdrop: boolean;
}

/** Minimal shape of the frozen `BoatState` the view model reads. */
export interface BoatStateLike {
  heading: Radians;
  heel: Radians;
  pitch: Radians;
  speed: number;
  helmLoad: number;
  capsized: boolean;
  position: { x: number; y: number; z: number };
}

/** Minimal shape of the frozen `ControlState` the view model reads. */
export interface ControlStateLike {
  mainsheet: number;
  jibsheet: number;
  traveller: number;
  board: number;
  rudder: number;
  vang: number;
}

/** Minimal shape of the frozen `CoachingHint` the view model reads. */
export interface HudCoachingLike {
  id: string;
  message: string;
  severity: number;
}

/** A speed value carried in both SI and display units. */
export interface SpeedReadout {
  /** Source value, m/s. */
  mps: number;
  /** Display value in the chosen unit (knots or m/s). */
  display: number;
}

/** A distance value carried in both SI and display units. */
export interface DistanceReadout {
  /** Source value, metres. */
  metres: number;
  /**
   * Display value in the chosen unit (nautical miles or metres). When the
   * knots/NM system is active AND the distance is under
   * {@link SHORT_DISTANCE_METRES}, `unit` is `'m'` and `display` is metres, so
   * close-range mark distances read as "250 m" not "0.13 nm".
   */
  display: number;
  /** Which unit `display` is expressed in. */
  unit: 'nm' | 'm' | 'km';
}

/** Wind indicator sub-model. */
export interface WindViewModel {
  /** Apparent wind angle off the bow, radians, signed (+starboard, −port). */
  apparentAngle: Radians;
  apparentSpeed: SpeedReadout;
  /** True wind angle off the bow, radians, signed (+starboard, −port). */
  trueAngle: Radians;
  trueSpeed: SpeedReadout;
  /** Bearing the true wind comes FROM, radians compass. */
  trueFromBearing: Radians;
  /** Point of sail, from |TWA|. */
  pointOfSail: PointOfSail;
  /** On which tack: 'port' = wind over port side, 'starboard' = over starboard. */
  tack: 'port' | 'starboard';
  /**
   * Layline bearings to the next windward target: the two close-hauled headings
   * (compass radians) that lay a windward mark, i.e. `windFrom ± tackAngle`.
   */
  laylines: { port: Radians; starboard: Radians };
  /** The optimal upwind tacking angle off the true wind, radians. */
  tackAngle: Radians;
}

/** Speed + VMG sub-model. */
export interface SpeedViewModel {
  sog: SpeedReadout;
  /** VMG toward the wind (positive = making ground upwind). */
  vmgUpwind: SpeedReadout;
  /** VMG away from the wind (positive = making ground downwind). */
  vmgDownwind: SpeedReadout;
  /** Fraction of polar target speed achieved, 0..~1.2. */
  targetFraction: number;
  /** Target boat speed from the polar, for display. */
  target: SpeedReadout;
}

/** Trim gauge sub-model. */
export interface TrimViewModel {
  /** 0..1 */
  mainsheet: number;
  /** 0..1 */
  jibsheet: number;
  /** −1..1 */
  traveller: number;
  /** 0..1 */
  board: number;
  /** −1..1 */
  rudder: number;
  /** 0..1 */
  vang: number;
  /** Per-sail attachment / luff indicators, empty when physics exposes none. */
  sails: readonly HudSailTrim[];
}

/** Heel + helm-load sub-model. */
export interface HeelHelmViewModel {
  /** Heel angle, radians, positive to starboard. */
  heel: Radians;
  /** Pitch angle, radians, positive bow-up. */
  pitch: Radians;
  /** Normalized helm load, 0..1. */
  helmLoad: number;
  capsized: boolean;
}

/** Compass sub-model. */
export interface CompassViewModel {
  /** Boat heading, radians compass. */
  heading: Radians;
  /** Course over ground, radians compass. */
  cog: Radians;
  /** Bearing to the next mark, radians compass, or null. */
  bearingToMark: Radians | null;
  /** Distance to the next mark, or null. */
  distanceToMark: DistanceReadout | null;
  /** Next mark id, or null. */
  markId: string | null;
}

/** Conditions panel sub-model. */
export interface ConditionsViewModel {
  source: WeatherSource;
  /** True when the source is sandbox/simulated — UI must mark 'SIMULATED'. */
  simulated: boolean;
  trueWindSpeed: SpeedReadout;
  /** Bearing the wind comes FROM, radians compass. */
  trueWindFrom: Radians;
  currentSpeed: SpeedReadout;
  /** Bearing the current flows TOWARDS, radians compass. */
  currentTowards: Radians;
  visibility: DistanceReadout;
}

/** Coaching banner sub-model. */
export interface CoachingViewModel {
  id: string;
  message: string;
  severity: number;
}

/** The complete HUD view model. Rebuilt (or re-filled) each UI tick. */
export interface HudViewModel {
  preset: HudPreset;
  units: UnitSystem;
  opaqueBackdrop: boolean;
  /** Which widgets this preset shows. Derived from {@link PRESET_WIDGETS}. */
  visible: Record<HudWidget, boolean>;
  wind: WindViewModel;
  speed: SpeedViewModel;
  trim: TrimViewModel;
  heelHelm: HeelHelmViewModel;
  compass: CompassViewModel;
  conditions: ConditionsViewModel;
  /** Null when there is no active coaching hint. */
  coaching: CoachingViewModel | null;
}
