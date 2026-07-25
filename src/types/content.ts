/**
 * Content contracts — venue and boat definitions.
 *
 * FROZEN CONTRACT — see docs/interfaces.md.
 *
 * These are pure JSON. Note what is absent: no mesh paths, no texture paths, no
 * audio paths. `HullParams.stations` is the single source for both the rendered
 * hull and its hydrostatics, so the two cannot disagree (design.md §7.2).
 */

import type { CurvePoint, Metres, MetresPerSecond, RGB, Radians, Vec2, Vec3 } from './units';
import type { MonthlyClimate } from './weather';
import type { HullParams, LandmarkSpec, MaterialParams, RigParams, SailSurfaceParams } from './generation';

/** Difficulty rating shown in the venue browser. */
export type Difficulty = 1 | 2 | 3 | 4 | 5;

/** Water optical properties, which differ markedly between venues. */
export interface WaterAppearance {
  /** Colour in shallow water. */
  colorShallow: RGB;
  /** Colour in deep water. */
  colorDeep: RGB;
  /** Turbidity, 0 (gin clear) .. 1 (opaque). Drives absorption depth. */
  turbidity: number;
  /** Depth at which light is fully absorbed, metres. */
  extinctionDepth: Metres;
}

/** Per-venue wind character beyond what the forecast provides. */
export interface WindProfile {
  /** Power-law shear exponent. ~0.11 offshore, up to 0.20 in built-up harbours. */
  shearExponent: number;
  /** Multiplier on oscillation amplitude for this venue. */
  oscillationScale: number;
  /** Multiplier on gust intensity. */
  gustScale: number;
  /** Fetch length for wind-wave generation, metres. Small for enclosed venues. */
  fetch: Metres;
}

/** Tidal and current behaviour. */
export interface TideProfile {
  /** Tidal range amplitude, metres. */
  amplitude: Metres;
  /** Phase offset from the API's tide series, hours. */
  phaseOffsetHours: number;
  /** Peak current speed on a spring tide. */
  currentStrength: MetresPerSecond;
  /** Principal current axis as a unit vector. */
  currentAxis: Vec2;
}

/** A racing mark. */
export interface MarkDefinition {
  id: string;
  /** Position in venue-local metres. */
  position: Vec2;
  kind: 'windward' | 'leeward' | 'gate' | 'start' | 'finish' | 'offset';
  /** Which side the boat must leave the mark. */
  rounding: 'port' | 'starboard';
  /** Mark radius for rounding validation, metres. */
  radius: Metres;
}

/** A racecourse. */
export interface CourseDefinition {
  id: string;
  name: string;
  kind: 'windwardLeeward' | 'triangle' | 'coastal' | 'pointToPoint' | 'reaching';
  marks: MarkDefinition[];
  /** Mark ids in the order they must be rounded. */
  sequence: string[];
  /** Number of laps. */
  laps: number;
  /** Whether the course auto-orients its axis to the current wind direction. */
  windAligned: boolean;
  /** Nominal beat length, metres. */
  legLength: Metres;
}

/** Procedural colour grade parameters, replacing an image LUT. */
export interface ColorGradeParams {
  /** Exposure adjustment in stops. */
  exposure: number;
  /** Contrast around mid grey. */
  contrast: number;
  /** Global saturation. */
  saturation: number;
  /** Colour lift in shadows. */
  shadowTint: RGB;
  /** Colour gain in highlights. */
  highlightTint: RGB;
  /** The venue's curated palette, 5–7 colours (design.md §8.7). */
  palette: RGB[];
}

/** Procedural ambience synthesis parameters, replacing audio files. */
export interface AmbienceParams {
  /** Surf intensity, 0..1. */
  surf: number;
  /** Gull call density, calls per minute. */
  gullDensity: number;
  /** City and traffic noise bed level, 0..1. */
  urban: number;
  /** Harbour activity level — halyards, machinery, distant voices. */
  harbour: number;
  /** Rigging-whistle resonance frequency, Hz. */
  riggingResonance: number;
}

/** Ambient vessel traffic (requirements 1.8, 1.9). */
export interface TrafficSpec {
  kind: 'ferry' | 'containerShip' | 'hovercraft' | 'fishingBoat' | 'tug' | 'yacht';
  /** Waypoints in venue-local metres. */
  route: Vec2[];
  /** Service speed. */
  speed: MetresPerSecond;
  /** Interval between departures, seconds. */
  intervalSeconds: number;
  /** Overall length, metres. Drives both geometry scale and wind-shadow size. */
  length: Metres;
}

/** A complete venue. Adding one is this JSON plus coastline data — no code. */
export interface VenueDefinition {
  id: string;
  name: string;
  region: string;
  /** Real-world coordinates, used for weather requests and solar position. */
  coordinates: {
    latitude: number;
    longitude: number;
  };
  /** IANA timezone identifier. */
  timezone: string;
  difficulty: Difficulty;
  /** One-line description shown in the browser. */
  blurb: string;
  /** Sailable extent in venue-local metres, origin at the venue centre. */
  bounds: { min: Vec2; max: Vec2 };
  /** Path to the coastline polyline JSON, relative to src/venues/coastlines/. */
  coastlineFile: string;
  /** Attribution required by the coastline data source. */
  coastlineAttribution: string;
  /** Inland relief character. */
  relief: 'flat' | 'hilly' | 'mountainous';
  maxElevation: Metres;
  maxDepth: Metres;
  /** True for fresh water, which changes density and buoyancy. */
  freshwater: boolean;
  landmarks: LandmarkSpec[];
  traffic: TrafficSpec[];
  water: WaterAppearance;
  windProfile: WindProfile;
  tide: TideProfile;
  courses: CourseDefinition[];
  /** Twelve entries, January first. The offline fallback (requirement 2.6). */
  climatology: MonthlyClimate[];
  grade: ColorGradeParams;
  ambience: AmbienceParams;
  /** Default spawn position and heading for free sailing. */
  spawn: { position: Vec2; heading: Radians };
}

/** Boat class, which determines handling character. */
export type BoatClass = 'dinghy' | 'skiff' | 'keelboat' | 'foilingCat' | 'offshore';

/** A sail as defined in content, combining generation and physics parameters. */
export interface SailDefinition {
  id: string;
  kind: 'main' | 'jib' | 'genoa' | 'spinnaker' | 'code0';
  area: number;
  surface: SailSurfaceParams;
  /** Height of the centre of effort above the waterline. */
  centreOfEffortHeight: Metres;
  aspectRatio: number;
  maxSheetAngle: Radians;
  maxCamber: number;
  /** Attachment points in hull-local coordinates. */
  tack: Vec3;
  clew: Vec3;
  head: Vec3;
}

/** A foil as defined in content. */
export interface FoilDefinition {
  id: string;
  kind: 'keel' | 'daggerboard' | 'centreboard' | 'rudder' | 'liftingFoil';
  area: number;
  span: Metres;
  chord: Metres;
  position: Vec3;
  thickness: number;
  retractable: boolean;
  steerable: boolean;
}

/** A complete boat. Adding one is this JSON — no code, no models. */
export interface BoatDefinition {
  id: string;
  name: string;
  class: BoatClass;
  /** One-line description shown when selecting. */
  blurb: string;
  /** Crew count including the player. */
  crewCount: number;
  /** Hull geometry AND hydrostatics both derive from this. */
  hull: HullParams;
  rig: RigParams;
  sails: SailDefinition[];
  foils: FoilDefinition[];
  /** Bare hull mass excluding crew, kg. */
  hullMass: number;
  ballastMass: number;
  /** Mass per crew member, kg. */
  crewMass: number;
  crewMovementRange: Vec3;
  capsizeAngle: Radians;
  /** Residuary resistance against Froude number. */
  residuaryCurve: CurvePoint[];
  foiling?: {
    takeoffSpeed: MetresPerSecond;
    liftCurve: CurvePoint[];
    rideHeightRange: [Metres, Metres];
    flyingDragFactor: number;
  };
  materials: {
    hull: MaterialParams;
    deck: MaterialParams;
    spars: MaterialParams;
    sail: MaterialParams;
  };
  /** Default customization, overridable by the player. */
  appearance: {
    hullColor: RGB;
    deckColor: RGB;
    sailNumber: string;
  };
  /** Nautical miles required to unlock. Zero for starting boats. */
  unlockMiles: number;
}
