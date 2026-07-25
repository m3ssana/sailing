/**
 * Game-layer contracts — race state, rules, replay, input and progression.
 *
 * FROZEN CONTRACT — see docs/interfaces.md.
 */

import type { Metres, MetresPerSecond, Radians, Seed, SessionTime, Vec2 } from './units';
import type { AssistLevel, ControlState } from './physics';
import type { WeatherSnapshot } from './weather';

/** Which mode the session is running. */
export type GameMode =
  | 'freeSail'
  | 'fleetRace'
  | 'timeTrial'
  | 'dailyChallenge'
  | 'coastalPassage'
  | 'sailingSchool';

/** Phase of a race. */
export type RacePhase = 'prestart' | 'starting' | 'racing' | 'finished' | 'abandoned';

/** Per-boat race progress. */
export interface BoatRaceState {
  boatId: string;
  /** Index into the course sequence of the next mark to round. */
  nextMarkIndex: number;
  /** Completed laps. */
  lap: number;
  /** Current position in the fleet, 1-based. */
  fleetPosition: number;
  /** Elapsed race time, seconds. Undefined before the start. */
  elapsed?: number;
  /** Finish time, seconds. Undefined until finished. */
  finishTime?: number;
  /** Outstanding penalty turns owed. */
  penaltiesOwed: number;
  /** True when the boat started early and must return. */
  ocs: boolean;
  /** Distance to the next mark, metres. */
  distanceToNextMark: Metres;
}

/** Overall race state. */
export interface RaceState {
  phase: RacePhase;
  courseId: string;
  /** Seconds until the start. Negative once racing. */
  startCountdown: number;
  /** Per-boat progress, keyed by boat id. */
  boats: Record<string, BoatRaceState>;
  /** Start line endpoints in venue-local metres. */
  startLine: [Vec2, Vec2];
  /**
   * Start-line bias in radians: positive means the starboard end is favoured.
   * Derived from the line's angle against the current wind.
   */
  lineBias: Radians;
  /** Course axis, aligned to the wind when the course is wind-aligned. */
  courseAxis: Radians;
}

/** A racing rule that can be infringed. */
export type RuleId =
  | 'portStarboard'
  | 'windwardLeeward'
  | 'markRoom'
  | 'ocs'
  | 'contact'
  | 'properCourse';

/** A detected infringement. */
export interface Infringement {
  ruleId: RuleId;
  /** Boat that infringed. */
  boatId: string;
  /** Boat with right of way, when applicable. */
  againstBoatId?: string;
  time: SessionTime;
  /** Player-facing explanation, e.g. "Port tack — you must keep clear". */
  message: string;
  /** Penalty turns required. */
  penaltyTurns: number;
}

/**
 * A recorded run. Inputs plus 1 Hz state checkpoints, because float results are
 * not bit-identical across machines (requirement 6.5a, design.md §12.2).
 */
export interface Replay {
  /** Schema version, for forward migration. */
  version: number;
  venueId: string;
  boatId: string;
  courseId: string;
  seed: Seed;
  /** Embedded so the replay never depends on refetching (requirement 6.5b). */
  snapshot: WeatherSnapshot;
  assistLevel: AssistLevel;
  /** Session time at which recording began. */
  startTime: SessionTime;
  /** Duration, seconds. */
  duration: number;
  /**
   * Control samples quantized to int8 at INPUT_SAMPLE_HZ, interleaved in the
   * field order given by REPLAY_CONTROL_ORDER.
   */
  inputs: Int8Array;
  /**
   * Full state at CHECKPOINT_HZ: position (3), orientation (4), linear
   * velocity (3), angular velocity (3) = 13 floats per checkpoint.
   */
  checkpoints: Float32Array;
  result: {
    elapsed: number;
    /** Split time at each mark, seconds. */
    markSplits: number[];
    finished: boolean;
  };
}

/** Replay encoding constants. Changing any of these requires a version bump. */
export const REPLAY_FORMAT = {
  VERSION: 1,
  /** Control sample rate, Hz. */
  INPUT_SAMPLE_HZ: 30,
  /** State checkpoint rate, Hz. */
  CHECKPOINT_HZ: 1,
  /** Floats per checkpoint: position, orientation, linear vel, angular vel. */
  CHECKPOINT_STRIDE: 13,
  /** Field order for the interleaved input stream. */
  CONTROL_ORDER: [
    'rudder',
    'mainsheet',
    'jibsheet',
    'spinnaker',
    'vang',
    'traveller',
    'board',
    'crewFore',
    'crewLateral',
    'hike',
  ] as const satisfies readonly (keyof ControlState)[],
} as const;

/** Raw input state, before assist processing. */
export interface InputState {
  /** Desired control positions, -1..1 or 0..1 per control. */
  controls: ControlState;
  /** Crew commands issued this frame (requirement 5.4a). */
  crewCommands: CrewCommand[];
  /** Camera look delta this frame, radians. */
  lookDelta: Vec2;
  /** Requested camera mode change, if any. */
  cameraCycle: number;
  /** True when the pause key was pressed this frame. */
  pausePressed: boolean;
}

/** A command issued to AI crew. */
export type CrewCommand =
  | 'hikeHarder'
  | 'easeOut'
  | 'hoistSpinnaker'
  | 'douseSpinnaker'
  | 'moveForward'
  | 'moveAft'
  | 'prepareTack'
  | 'prepareGybe';

/** A coaching hint surfaced to the player (requirement 6.10). */
export interface CoachingHint {
  id: string;
  /** Actionable text, e.g. "you're pinching — bear away 5°". */
  message: string;
  /** How serious the inefficiency is, 0..1. Drives prominence. */
  severity: number;
  /** Seconds the condition has persisted. */
  duration: number;
}

/** Persistent player progression (requirement 6.8). */
export interface Logbook {
  version: number;
  /** Total distance sailed, metres. The primary unlock currency. */
  totalDistance: Metres;
  /** Total time on the water, seconds. */
  totalTime: number;
  /** Completed challenge ids. */
  challengesCompleted: string[];
  unlockedBoats: string[];
  unlockedVenues: string[];
  /** Per-venue statistics, keyed by venue id. */
  venueStats: Record<string, VenueStats>;
  /** Per-boat statistics, keyed by boat id. */
  boatStats: Record<string, BoatStats>;
}

/** Statistics accumulated at one venue. */
export interface VenueStats {
  visits: number;
  distance: Metres;
  time: number;
  /** Best time trial result, seconds. */
  bestTimeTrial?: number;
  racesWon: number;
  racesSailed: number;
}

/** Statistics accumulated on one boat. */
export interface BoatStats {
  distance: Metres;
  time: number;
  topSpeed: MetresPerSecond;
  bestUpwindVmg: MetresPerSecond;
  /** Fraction of target speed retained through tacks, 0..1. */
  tackEfficiency: number;
  capsizes: number;
}
