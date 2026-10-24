/**
 * Broadcast auto-framing (H.4).
 *
 * A pure, deterministic model that picks a camera placement which frames the
 * player boat together with the next mark (or nearby boats) attractively, like a
 * TV helicopter / chase-boat shot. It scores a fixed candidate set and keeps the
 * current shot until a clearly better one appears AND a minimum dwell time has
 * elapsed — the hysteresis that stops the camera flickering between near-equal
 * candidates.
 *
 * No three.js, no DOM. Determinism: the candidate set is generated from the
 * frame inputs only (boat/subject positions, time), so the same frame always
 * yields the same ranking. The orbit phase is derived from `time` so a held
 * scene drifts slowly rather than snapping.
 *
 * ## Scoring
 *
 * Each candidate is scored on:
 *  - subject-in-frame: boat and the framing subject both within the view cone;
 *  - distance: camera-to-boat distance inside a pleasant band;
 *  - horizon: the shot keeps a level horizon (always true here — broadcast never
 *    rolls — so this term rewards a modest downward tilt, not a steep top-down);
 *  - sun: penalise pointing within a small angle of the sun (when `sunDirection`
 *    is given), so the lens does not stare into the sun;
 *  - occlusion: penalise a camera placed over land / below the terrain line
 *    (when an `isLand` test is given), which would put a hill between lens and
 *    boat.
 *
 * The score is a weighted sum in [0,1]-ish; only relative order matters.
 */

import type { Vec3 } from '@/types';
import { dot3, length3, normalize3, set3, sub3, vec3 } from '@core/math/vec';

/** A broadcast camera candidate: where to stand and what to look at. */
export interface BroadcastCandidate {
  position: Vec3;
  target: Vec3;
  /** Stable id so hysteresis can tell whether the pick changed. */
  id: number;
}

/** Inputs to one broadcast solve. */
export interface BroadcastInputs {
  boatPosition: Vec3;
  boatHeading: number;
  /** The secondary subject to include (next mark or nearest boat), or null. */
  subject: Vec3 | null;
  time: number;
  loa: number;
  sunDirection?: Vec3;
  isLand?: (x: number, z: number) => boolean;
  /** Vertical FOV of the broadcast camera, radians (for the in-frame test). */
  fov: number;
  /** View aspect ratio (width/height) for the horizontal cone. */
  aspect: number;
}

/** Pleasant camera-to-boat distance band, in multiples of LOA. */
const DIST_MIN_LOA = 4;
const DIST_IDEAL_LOA = 8;
const DIST_MAX_LOA = 20;

/** Camera height band above the water, metres. */
const HEIGHT_MIN = 3;
const HEIGHT_MAX = 40;

/** Minimum seconds a shot must hold before it can be replaced. */
export const BROADCAST_MIN_DWELL = 4;
/**
 * The challenger must beat the incumbent's score by this margin to cut early —
 * on top of the dwell gate this is what makes the sequence flicker-free.
 */
export const BROADCAST_HYSTERESIS_MARGIN = 0.12;

/** Angle within which pointing at the sun is maximally penalised, radians. */
const SUN_AVOID_ANGLE = 20 * (Math.PI / 180);

/** Number of azimuth candidates generated around the boat. */
const AZIMUTHS = 8;
/** Height candidates per azimuth. */
const HEIGHTS: readonly number[] = [0.4, 0.75];

/**
 * Generate the deterministic candidate set. Candidates ring the boat at a fixed
 * ideal distance, biased so that the subject (if any) tends to sit across the
 * frame from the camera. A slow orbit phase from `time` keeps a held shot alive.
 */
export function generateBroadcastCandidates(
  inputs: BroadcastInputs,
  out: BroadcastCandidate[] = [],
): BroadcastCandidate[] {
  out.length = 0;
  const loa = Math.max(1, inputs.loa);
  // Base distance scales with LOA; when a subject is far away, back off enough
  // that both the boat and the subject fit inside the (narrow) broadcast cone.
  let dist = DIST_IDEAL_LOA * loa;
  if (inputs.subject) {
    const sep = Math.hypot(
      inputs.subject.x - inputs.boatPosition.x,
      inputs.subject.z - inputs.boatPosition.z,
    );
    const halfCone = Math.max(inputs.fov * 0.5, inputs.fov * 0.5 * Math.max(1, inputs.aspect));
    // Distance so a lateral span of `sep` subtends the cone, with margin.
    const fitDist = (sep * 0.6) / Math.max(0.05, Math.tan(halfCone));
    dist = Math.min(DIST_MAX_LOA * loa, Math.max(dist, fitDist));
  }
  // Orbit phase: one slow revolution per 120 s, deterministic in time.
  const phase = (inputs.time / 120) * Math.PI * 2;

  // Prefer azimuths that put the subject roughly opposite the camera: aim the
  // ring so candidate 0 looks from the side the subject is NOT on.
  let bias = inputs.boatHeading;
  if (inputs.subject) {
    const dx = inputs.subject.x - inputs.boatPosition.x;
    const dz = inputs.subject.z - inputs.boatPosition.z;
    // Bearing from boat to subject; stand opposite it (+π).
    bias = Math.atan2(dx, -dz) + Math.PI;
  }

  let id = 0;
  for (let a = 0; a < AZIMUTHS; a++) {
    const az = bias + phase + (a / AZIMUTHS) * Math.PI * 2;
    const dirX = Math.sin(az);
    const dirZ = -Math.cos(az);
    for (const hf of HEIGHTS) {
      const height = HEIGHT_MIN + (HEIGHT_MAX - HEIGHT_MIN) * hf;
      const position = vec3(
        inputs.boatPosition.x + dirX * dist,
        inputs.boatPosition.y + height,
        inputs.boatPosition.z + dirZ * dist,
      );
      // Target: weighted toward the boat (keeps the player centred) but drawn
      // toward the subject so both are in shot. Boat-only when no subject.
      const target = inputs.subject
        ? vec3(
            inputs.boatPosition.x * 0.65 + inputs.subject.x * 0.35,
            inputs.boatPosition.y,
            inputs.boatPosition.z * 0.65 + inputs.subject.z * 0.35,
          )
        : vec3(inputs.boatPosition.x, inputs.boatPosition.y, inputs.boatPosition.z);
      out.push({ position, target, id: id++ });
    }
  }
  return out;
}

/** Scratch for scoring, one set per solver instance. */
interface ScoreScratch {
  fwd: Vec3;
  tmp: Vec3;
}

function createScoreScratch(): ScoreScratch {
  return {
    fwd: vec3(),
    tmp: vec3(),
  };
}

/** Half-angle (radians) a point must be within to count as "in frame". */
function inFrameCos(point: Vec3, camPos: Vec3, fwd: Vec3, halfAngle: number, s: ScoreScratch): number {
  const to = normalize3(sub3(point, camPos, s.tmp), s.tmp);
  const c = dot3(to, fwd);
  const minCos = Math.cos(halfAngle);
  // 1 when dead-centre, →0 at the cone edge, 0 outside.
  if (c <= minCos) return 0;
  return (c - minCos) / (1 - minCos);
}

/**
 * Score a single candidate in [0,1]-ish. Higher is better. Deterministic.
 */
export function scoreBroadcastCandidate(
  cand: BroadcastCandidate,
  inputs: BroadcastInputs,
  scratch: ScoreScratch = createScoreScratch(),
): number {
  const s = scratch;
  const fwd = normalize3(sub3(cand.target, cand.position, s.fwd), s.fwd);
  if (length3(fwd) === 0) return 0;

  // Cone half-angles (vertical from fov, horizontal from fov*aspect).
  const halfV = inputs.fov * 0.5;
  const halfH = Math.min(Math.PI * 0.49, halfV * Math.max(1, inputs.aspect));
  const halfCone = Math.max(halfV, halfH);

  // Subject-in-frame.
  const boatIn = inFrameCos(inputs.boatPosition, cand.position, fwd, halfCone, s);
  const subjIn = inputs.subject
    ? inFrameCos(inputs.subject, cand.position, fwd, halfCone, s)
    : 1;
  const frameScore = 0.5 * boatIn + 0.5 * subjIn;
  if (boatIn === 0) return 0; // never frame a shot that loses the player boat.

  // Distance band.
  const d = length3(sub3(inputs.boatPosition, cand.position, s.tmp));
  const loa = Math.max(1, inputs.loa);
  const dMin = DIST_MIN_LOA * loa;
  const dIdeal = DIST_IDEAL_LOA * loa;
  const dMax = DIST_MAX_LOA * loa;
  let distScore: number;
  if (d < dMin || d > dMax) distScore = 0.1;
  else if (d <= dIdeal) distScore = (d - dMin) / Math.max(1e-6, dIdeal - dMin);
  else distScore = 1 - (d - dIdeal) / Math.max(1e-6, dMax - dIdeal);
  distScore = Math.max(0, Math.min(1, distScore));

  // Horizon: reward a gentle downward tilt (looking slightly down at the boat),
  // penalise near-vertical top-down shots. fwd.y in [-1,0] is looking down.
  const tilt = -fwd.y; // positive when looking down.
  const horizonScore = tilt <= 0 ? 0.3 : 1 - Math.min(1, Math.abs(tilt - 0.25) / 0.6);

  // Sun avoidance.
  let sunScore = 1;
  if (inputs.sunDirection) {
    const sun = normalize3(inputs.sunDirection, s.tmp);
    const towardSun = dot3(fwd, sun); // 1 when looking straight at the sun.
    const ang = Math.acos(Math.max(-1, Math.min(1, towardSun)));
    sunScore = ang >= SUN_AVOID_ANGLE ? 1 : ang / SUN_AVOID_ANGLE;
  }

  // Occlusion: penalise a camera over land (a hill between lens and boat).
  let occScore = 1;
  if (inputs.isLand && inputs.isLand(cand.position.x, cand.position.z)) {
    occScore = 0.05;
  }

  return (
    0.4 * frameScore +
    0.25 * distScore +
    0.15 * horizonScore +
    0.1 * sunScore +
    0.1 * occScore
  );
}

/** Result of a broadcast solve this frame. */
export interface BroadcastSolution {
  position: Vec3;
  target: Vec3;
  candidateId: number;
  score: number;
}

/**
 * Stateful broadcast director: scores candidates and applies dwell + margin
 * hysteresis. One instance per camera controller (holds per-instance scratch and
 * state — never module-scope, per the concurrency convention).
 */
export class BroadcastDirector {
  private currentId = -1;
  private lastCutTime = Number.NEGATIVE_INFINITY;
  private readonly candidates: BroadcastCandidate[] = [];
  private readonly scratch = createScoreScratch();
  private readonly solution: BroadcastSolution = {
    position: vec3(),
    target: vec3(),
    candidateId: -1,
    score: 0,
  };

  /** Reset director state (e.g. when switching into broadcast mode). */
  reset(): void {
    this.currentId = -1;
    this.lastCutTime = Number.NEGATIVE_INFINITY;
  }

  /**
   * Solve for this frame. Returns the chosen shot; the returned object is reused
   * every call (allocation-free). Deterministic given identical inputs and
   * identical prior state.
   */
  solve(inputs: BroadcastInputs): BroadcastSolution {
    generateBroadcastCandidates(inputs, this.candidates);

    // Find the best candidate overall.
    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < this.candidates.length; i++) {
      const cand = this.candidates[i];
      if (cand === undefined) continue;
      const sc = scoreBroadcastCandidate(cand, inputs, this.scratch);
      if (sc > bestScore) {
        bestScore = sc;
        bestIdx = i;
      }
    }
    const best = this.candidates[bestIdx];

    // First frame or lost shot: take the best immediately.
    if (this.currentId === -1 || best === undefined) {
      if (best !== undefined) {
        this.commit(best, bestScore, inputs.time);
      }
      return this.emit();
    }

    // Re-score the current shot under the current frame (it may have decayed).
    const current = this.candidates.find((c) => c.id === this.currentId);
    const currentScore = current ? scoreBroadcastCandidate(current, inputs, this.scratch) : 0;

    const dwellElapsed = inputs.time - this.lastCutTime >= BROADCAST_MIN_DWELL;
    const clearlyBetter = bestScore > currentScore + BROADCAST_HYSTERESIS_MARGIN;

    if (current === undefined || (dwellElapsed && clearlyBetter)) {
      this.commit(best, bestScore, inputs.time);
    } else {
      // Hold the current shot; keep tracking the moving subject.
      set3(this.solution.position, current.position.x, current.position.y, current.position.z);
      set3(this.solution.target, current.target.x, current.target.y, current.target.z);
      this.solution.candidateId = current.id;
      this.solution.score = currentScore;
    }
    return this.solution;
  }

  private commit(cand: BroadcastCandidate, score: number, time: number): void {
    this.currentId = cand.id;
    this.lastCutTime = time;
    set3(this.solution.position, cand.position.x, cand.position.y, cand.position.z);
    set3(this.solution.target, cand.target.x, cand.target.y, cand.target.z);
    this.solution.candidateId = cand.id;
    this.solution.score = score;
  }

  private emit(): BroadcastSolution {
    return this.solution;
  }
}

/** Pick the framing subject: the nearest mark, else the nearest other boat, else null. */
export function pickBroadcastSubject(
  boatPosition: Vec3,
  marks: readonly Vec3[],
  otherBoats: readonly Vec3[],
  out: Vec3 = vec3(),
): Vec3 | null {
  // Prefer marks; only fall back to other boats when there are no marks.
  const pool: readonly Vec3[] = marks.length > 0 ? marks : otherBoats;
  let bestIdx = -1;
  let bestD = Infinity;
  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    if (p === undefined) continue;
    const dx = p.x - boatPosition.x;
    const dy = p.y - boatPosition.y;
    const dz = p.z - boatPosition.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) {
      bestD = d;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return null;
  const chosen = pool[bestIdx];
  if (chosen === undefined) return null;
  return set3(out, chosen.x, chosen.y, chosen.z);
}
