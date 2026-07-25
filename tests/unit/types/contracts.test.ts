/**
 * Contract test for the frozen type surface (Phase 0.2).
 *
 * This file imports every shared type and constructs a stub of each. Its purpose
 * is not runtime behaviour — it is a compile-time proof that the contracts are
 * complete and mutually consistent, so any workstream can start from
 * `@types` alone.
 *
 * If this file stops compiling, a contract changed and every workstream that
 * depends on it must be notified.
 */

import { describe, expect, it } from 'vitest';
import {
  PHYSICS_CONSTANTS,
  REPLAY_FORMAT,
  UNITS,
  type AirConditions,
  type AppliedForce,
  type AssistLevel,
  type BoatClass,
  type BoatRaceState,
  type BoatSpec,
  type BoatState,
  type BoatStats,
  type BuoyancyPoint,
  type CoachingHint,
  type ColorGradeParams,
  type ControlState,
  type CourseDefinition,
  type CrewCommand,
  type CurrentConditions,
  type Difficulty,
  type FoilSpec,
  type FoilingSpec,
  type FrameCap,
  type FrameTimings,
  type GPUCapabilities,
  type GameMode,
  type GeneratedMesh,
  type GenerationProgress,
  type Hydrostatics,
  type Infringement,
  type InputState,
  type LandmarkSpec,
  type Logbook,
  type MarkDefinition,
  type MaterialParams,
  type MonthlyClimate,
  type PerformanceStats,
  type PhysicsLOD,
  type Polyline,
  type Quat,
  type QualityKnobs,
  type QualityPreset,
  type RGB,
  type RacePhase,
  type RaceState,
  type RenderBackend,
  type Replay,
  type RuleId,
  type SailSpec,
  type SeaConditions,
  type SkyConditions,
  type SkyState,
  type StationCurve,
  type TideProfile,
  type TrafficSpec,
  type Vec2,
  type Vec3,
  type WaterAppearance,
  type WaveComponent,
  type WaveSpectrumParams,
  type WaveTrain,
  type WeatherKeyframe,
  type WeatherSnapshot,
  type WeatherSource,
  type WindConditions,
  type WindProfile,
  type WindSample,
} from '@/types';

// --- primitives -------------------------------------------------------------

const vec2: Vec2 = { x: 0, y: 0 };
const vec3: Vec3 = { x: 0, y: 0, z: 0 };
const quat: Quat = { x: 0, y: 0, z: 0, w: 1 };
const rgb: RGB = { r: 0.5, g: 0.5, b: 0.5 };

// --- weather ----------------------------------------------------------------

const wind: WindConditions = {
  trueSpeed: 8,
  trueDirection: Math.PI,
  gustCeiling: 12,
  stability: 0.4,
};

const waveTrain: WaveTrain = { height: 0.8, period: 6, direction: Math.PI };

const sea: SeaConditions = {
  significantHeight: 1,
  dominantPeriod: 7,
  dominantDirection: Math.PI,
  swell: waveTrain,
  windWave: waveTrain,
  surfaceTemp: 18,
  tideHeight: 0.2,
};

const current: CurrentConditions = { speed: 0.5, direction: 0 };

const sky: SkyConditions = {
  cloudLow: 0.3,
  cloudMid: 0.1,
  cloudHigh: 0,
  visibility: 20000,
  precipitation: 0,
  wmoCode: 1,
  solarRadiation: 600,
  isDay: true,
};

const air: AirConditions = { temperature: 20, pressure: 101325, density: 1.204 };

const keyframe: WeatherKeyframe = { offset: 0, wind, sea, current, sky, air };

const snapshot: WeatherSnapshot = {
  fetchedAt: 0,
  source: 'live' satisfies WeatherSource,
  venueId: 'newport',
  localTime: { iso: '2026-07-24T12:00', utcOffsetSeconds: -14400 },
  wind,
  sea,
  current,
  sky,
  air,
  timeline: [keyframe],
  attribution: ['Weather data by Open-Meteo.com'],
};

const climate: MonthlyClimate = {
  month: 7,
  meanWindSpeed: 6,
  prevailingDirection: Math.PI,
  gustFactor: 1.3,
  meanWaveHeight: 0.6,
  meanWavePeriod: 5,
  meanAirTemp: 22,
  meanSeaTemp: 19,
  meanCloudCover: 0.4,
};

// --- environment ------------------------------------------------------------

const windSample: WindSample = { velocity: vec3, speed: 8, direction: Math.PI, gustFactor: 1 };

const spectrumParams: WaveSpectrumParams = {
  windSpeed: 8,
  windDirection: Math.PI,
  fetch: 50000,
  significantHeight: 1,
  swellHeight: 0.5,
  swellPeriod: 9,
  swellDirection: Math.PI,
  peakEnhancement: 3.3,
  directionalSpread: 4,
  depth: 30,
  currentVelocity: vec2,
  seed: 1,
};

const waveComponent: WaveComponent = {
  amplitude: 0.3,
  wavenumber: 0.1,
  direction: { x: 1, y: 0 },
  frequency: 1,
  phase: 0,
  steepness: 0.2,
};

const skyState: SkyState = {
  sunDirection: vec3,
  sunElevation: 0.5,
  sunAzimuth: 2,
  moonDirection: vec3,
  moonElevation: -0.2,
  moonPhase: 0.5,
  siderealTime: 1,
  cloudLow: 0.3,
  cloudMid: 0,
  cloudHigh: 0,
  isNight: false,
};

// --- physics ----------------------------------------------------------------

const controls: ControlState = {
  rudder: 0,
  mainsheet: 0.6,
  jibsheet: 0.6,
  spinnaker: 0,
  vang: 0.4,
  traveller: 0,
  board: 1,
  crewFore: 0,
  crewLateral: 0,
  hike: 0,
};

const boatState: BoatState = {
  position: vec3,
  orientation: quat,
  linearVelocity: vec3,
  angularVelocity: vec3,
  controls,
  heel: 0,
  pitch: 0,
  heading: 0,
  speed: 0,
  capsized: false,
  foiling: false,
  helmLoad: 0,
};

const appliedForce: AppliedForce = { force: vec3, point: vec3 };

const buoyancyPoint: BuoyancyPoint = { position: vec3, volume: 0.1, sectionArea: 0.2 };

const hydrostatics: Hydrostatics = {
  displacedVolume: 0.1,
  displacement: 102.5,
  wettedSurface: 4,
  waterplaneArea: 3,
  centreOfBuoyancy: vec3,
  centreOfFlotation: 0,
  buoyancyPoints: [buoyancyPoint],
  rightingCurve: [{ x: 0, y: 0 }],
  waterlineLength: 4,
  waterlineBeam: 1.4,
};

const sailSpec: SailSpec = {
  id: 'main',
  kind: 'main',
  area: 7,
  luffLength: 5,
  footLength: 2.5,
  leechLength: 5.2,
  luffRound: 0.02,
  broadseam: 0.01,
  maxCamber: 0.12,
  centreOfEffortHeight: 2.4,
  aspectRatio: 3.5,
  maxSheetAngle: 1.2,
};

const foilSpec: FoilSpec = {
  id: 'board',
  kind: 'centreboard',
  area: 0.5,
  span: 0.9,
  chord: 0.35,
  position: vec3,
  thickness: 0.1,
  retractable: true,
  steerable: false,
};

const foilingSpec: FoilingSpec = {
  takeoffSpeed: 6,
  liftCurve: [{ x: 0, y: 0 }],
  rideHeightRange: [0.2, 1.2],
  flyingDragFactor: 0.35,
};

const boatSpec: BoatSpec = {
  id: 'dinghy',
  name: 'Single-hander',
  mass: 150,
  inertia: { x: 100, y: 80, z: 200 },
  centreOfMass: vec3,
  hydrostatics,
  sails: [sailSpec],
  foils: [foilSpec],
  residuaryCurve: [{ x: 0, y: 0 }],
  ballastMass: 0,
  crewMass: 75,
  crewMovementRange: { x: 0.8, y: 0.4, z: 1 },
  capsizeAngle: 1.4,
  hullCount: 1,
  foiling: foilingSpec,
};

// --- generation -------------------------------------------------------------

const generatedMesh: GeneratedMesh = {
  positions: new Float32Array(9),
  normals: new Float32Array(9),
  uvs: new Float32Array(6),
  indices: new Uint32Array([0, 1, 2]),
  bounds: { min: vec3, max: vec3 },
  meta: { volume: 0 },
};

const stationCurve: StationCurve = { position: 0.5, points: [vec2] };

const polyline: Polyline = { points: [vec2], closed: false };

const landmark: LandmarkSpec = {
  generator: 'lighthouse',
  params: { height: 20 },
  position: vec3,
  rotation: 0,
  scale: 1,
};

const material: MaterialParams = {
  kind: 'gelcoat',
  baseColor: rgb,
  roughness: 0.2,
  metalness: 0,
};

const progress: GenerationProgress = { stage: 'hull', progress: 0.5, message: 'Lofting hull…' };

// --- content ----------------------------------------------------------------

const water: WaterAppearance = {
  colorShallow: rgb,
  colorDeep: rgb,
  turbidity: 0.3,
  extinctionDepth: 12,
};

const windProfile: WindProfile = {
  shearExponent: 0.12,
  oscillationScale: 1,
  gustScale: 1,
  fetch: 40000,
};

const tide: TideProfile = {
  amplitude: 1.2,
  phaseOffsetHours: 0,
  currentStrength: 1,
  currentAxis: { x: 1, y: 0 },
};

const mark: MarkDefinition = {
  id: 'w1',
  position: vec2,
  kind: 'windward',
  rounding: 'port',
  radius: 5,
};

const course: CourseDefinition = {
  id: 'wl1',
  name: 'Windward/Leeward',
  kind: 'windwardLeeward',
  marks: [mark],
  sequence: ['w1'],
  laps: 2,
  windAligned: true,
  legLength: 1500,
};

const grade: ColorGradeParams = {
  exposure: 0,
  contrast: 1,
  saturation: 1,
  shadowTint: rgb,
  highlightTint: rgb,
  palette: [rgb],
};

const traffic: TrafficSpec = {
  kind: 'ferry',
  route: [vec2],
  speed: 6,
  intervalSeconds: 600,
  length: 40,
};

// --- render -----------------------------------------------------------------

const caps: GPUCapabilities = {
  backend: 'webgpu' satisfies RenderBackend,
  compute: true,
  storageTextures: true,
  timestampQueries: false,
  maxTextureSize: 8192,
  float32Filterable: true,
  adapterInfo: 'test',
};

const knobs: QualityKnobs = {
  renderScale: 1,
  oceanCascades: 3,
  oceanResolution: 256,
  oceanGridRings: 8,
  reflectionScale: 0.5,
  reflectionCadence: 2,
  shadowCascades: 4,
  cloudMarchSteps: 48,
  sprayBudget: 20000,
  ambientBudget: 64,
  taa: true,
  motionBlur: true,
  depthOfField: false,
  bloom: true,
};

const timings: FrameTimings = {
  frame: 16.6,
  simulation: 3,
  sceneUpdate: 1,
  render: 5,
  gpu: -1,
  steps: 2,
  drawCalls: 400,
  triangles: 120000,
};

const perf: PerformanceStats = {
  medianFrameTime: 16.6,
  p95FrameTime: 18,
  targetFrameTime: 16.6,
  framesOverBudget: 0,
  framesUnderBudget: 100,
  thermalThrottleSuspected: false,
};

// --- game -------------------------------------------------------------------

const boatRaceState: BoatRaceState = {
  boatId: 'player',
  nextMarkIndex: 0,
  lap: 0,
  fleetPosition: 1,
  penaltiesOwed: 0,
  ocs: false,
  distanceToNextMark: 500,
};

const raceState: RaceState = {
  phase: 'prestart' satisfies RacePhase,
  courseId: 'wl1',
  startCountdown: 300,
  boats: { player: boatRaceState },
  startLine: [vec2, vec2],
  lineBias: 0.05,
  courseAxis: Math.PI,
};

const infringement: Infringement = {
  ruleId: 'portStarboard' satisfies RuleId,
  boatId: 'player',
  time: 12,
  message: 'Port tack — you must keep clear',
  penaltyTurns: 1,
};

const replay: Replay = {
  version: REPLAY_FORMAT.VERSION,
  venueId: 'newport',
  boatId: 'dinghy',
  courseId: 'wl1',
  seed: 42,
  snapshot,
  assistLevel: 'assisted' satisfies AssistLevel,
  startTime: 0,
  duration: 60,
  inputs: new Int8Array(REPLAY_FORMAT.CONTROL_ORDER.length * REPLAY_FORMAT.INPUT_SAMPLE_HZ),
  checkpoints: new Float32Array(REPLAY_FORMAT.CHECKPOINT_STRIDE),
  result: { elapsed: 60, markSplits: [30], finished: true },
};

const inputState: InputState = {
  controls,
  crewCommands: ['hikeHarder' satisfies CrewCommand],
  lookDelta: vec2,
  cameraCycle: 0,
  pausePressed: false,
};

const hint: CoachingHint = {
  id: 'pinching',
  message: "You're pinching — bear away 5°",
  severity: 0.5,
  duration: 3,
};

const boatStats: BoatStats = {
  distance: 1000,
  time: 600,
  topSpeed: 7,
  bestUpwindVmg: 3.2,
  tackEfficiency: 0.85,
  capsizes: 0,
};

const logbook: Logbook = {
  version: 1,
  totalDistance: 1000,
  totalTime: 600,
  challengesCompleted: [],
  unlockedBoats: ['dinghy'],
  unlockedVenues: ['newport'],
  venueStats: {
    newport: { visits: 1, distance: 1000, time: 600, racesWon: 0, racesSailed: 1 },
  },
  boatStats: { dinghy: boatStats },
};

// --- assertions -------------------------------------------------------------

describe('frozen type surface', () => {
  it('constructs a stub of every shared contract', () => {
    // Values are referenced so the compiler cannot elide the type checks above.
    const constructed = [
      vec2, vec3, quat, rgb,
      wind, waveTrain, sea, current, sky, air, keyframe, snapshot, climate,
      windSample, spectrumParams, waveComponent, skyState,
      controls, boatState, appliedForce, buoyancyPoint, hydrostatics,
      sailSpec, foilSpec, foilingSpec, boatSpec,
      generatedMesh, stationCurve, polyline, landmark, material, progress,
      water, windProfile, tide, mark, course, grade, traffic,
      caps, knobs, timings, perf,
      boatRaceState, raceState, infringement, replay, inputState, hint, boatStats, logbook,
    ];
    expect(constructed.every((value) => value !== undefined)).toBe(true);
    expect(constructed).toHaveLength(51);
  });

  it('exposes unit conversions that round-trip', () => {
    const knots = 12;
    const ms = knots * UNITS.KNOTS_TO_MS;
    expect(ms * UNITS.MS_TO_KNOTS).toBeCloseTo(knots, 6);
    expect(UNITS.NM_TO_M * UNITS.M_TO_NM).toBeCloseTo(1, 12);
    expect(UNITS.DEG_TO_RAD * UNITS.RAD_TO_DEG).toBeCloseTo(1, 12);
  });

  it('states physical constants at documented values', () => {
    expect(PHYSICS_CONSTANTS.GRAVITY).toBeCloseTo(9.80665, 5);
    expect(PHYSICS_CONSTANTS.WATER_DENSITY).toBe(1025);
    // Fresh water must be less dense than salt, or lake venues float wrong.
    expect(PHYSICS_CONSTANTS.FRESHWATER_DENSITY).toBeLessThan(
      PHYSICS_CONSTANTS.WATER_DENSITY,
    );
  });

  it('defines a replay format whose control order matches ControlState', () => {
    const keys = Object.keys(controls).sort();
    const order = [...REPLAY_FORMAT.CONTROL_ORDER].sort();
    // If these drift apart, replays silently decode into the wrong controls.
    expect(order).toEqual(keys);
    expect(REPLAY_FORMAT.CHECKPOINT_STRIDE).toBe(13);
  });

  it('keeps quality knobs and LOD tiers within their declared domains', () => {
    const preset: QualityPreset = 'ultra';
    const cap: FrameCap = 60;
    const lod: PhysicsLOD = 0;
    const mode: GameMode = 'freeSail';
    const cls: BoatClass = 'dinghy';
    const difficulty: Difficulty = 3;
    expect([preset, cap, lod, mode, cls, difficulty]).toHaveLength(6);
    expect(knobs.renderScale).toBeGreaterThan(0);
    expect(knobs.renderScale).toBeLessThanOrEqual(1);
  });
});
