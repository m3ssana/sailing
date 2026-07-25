/**
 * The frozen type surface.
 *
 * Every workstream implements against these contracts and nothing else. They are
 * frozen as of Phase 0.2 — if a contract appears wrong, escalate rather than
 * changing it locally, because a unilateral change breaks other workstreams
 * silently (requirement 11.6).
 *
 * See docs/interfaces.md for the rationale and invariants behind each type.
 */

export type {
  Vec2,
  Vec3,
  Quat,
  RGB,
  CurvePoint,
  SessionTime,
  EpochMs,
  Seed,
  Radians,
  Degrees,
  Metres,
  MetresPerSecond,
} from './units';
export { UNITS, PHYSICS_CONSTANTS } from './units';

export type {
  WeatherSource,
  WindConditions,
  WaveTrain,
  SeaConditions,
  CurrentConditions,
  SkyConditions,
  AirConditions,
  WeatherKeyframe,
  WeatherSnapshot,
  WeatherService,
  MonthlyClimate,
} from './weather';

export type {
  WindSample,
  WindField,
  WaveSpectrumParams,
  WaveComponent,
  WaveField,
  CurrentField,
  SkyState,
  Environment,
} from './environment';

export type {
  ControlState,
  BoatState,
  AppliedForce,
  ForceContext,
  ForceGenerator,
  Hydrostatics,
  BuoyancyPoint,
  SailSpec,
  FoilSpec,
  BoatSpec,
  FoilingSpec,
  PolarDiagram,
  AssistLevel,
  PhysicsLOD,
  BoatSimulation,
} from './physics';

export type {
  GeneratedMesh,
  MeshGroup,
  GeneratedModel,
  Generator,
  StationCurve,
  HullParams,
  RigParams,
  SailSurfaceParams,
  Polyline,
  TerrainParams,
  GeneratedTerrain,
  LandmarkSpec,
  MaterialParams,
  GenerationProgress,
} from './generation';

export type {
  Difficulty,
  WaterAppearance,
  WindProfile,
  TideProfile,
  MarkDefinition,
  CourseDefinition,
  ColorGradeParams,
  AmbienceParams,
  TrafficSpec,
  VenueDefinition,
  BoatClass,
  SailDefinition,
  FoilDefinition,
  BoatDefinition,
} from './content';

export type {
  RenderBackend,
  GPUCapabilities,
  QualityPreset,
  QualityKnobs,
  FrameTimings,
  PerformanceStats,
  FrameCap,
} from './render';

export type {
  GameMode,
  RacePhase,
  BoatRaceState,
  RaceState,
  RuleId,
  Infringement,
  Replay,
  InputState,
  CrewCommand,
  CoachingHint,
  Logbook,
  VenueStats,
  BoatStats,
} from './game';
export { REPLAY_FORMAT } from './game';
