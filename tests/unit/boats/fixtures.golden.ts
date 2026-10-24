/**
 * Recorded golden-trajectory baseline for the dinghy (see golden.test.ts).
 *
 * These numbers are RECORDED from the deterministic 20 s open-loop trajectory,
 * not hand-authored. Re-record them deliberately (and note why in the commit)
 * if a physics change intentionally moves the trajectory; do NOT loosen the
 * tolerance to paper over an unexpected change.
 */

export interface GoldenTrajectory {
  x: number;
  y: number;
  z: number;
  heel: number;
  heading: number;
  speed: number;
  pathLength: number;
  maxHeel: number;
}

/** Decimal places for `toBeCloseTo` (2 → within 0.005). */
export const GOLDEN_TOLERANCE = 2;

/** Recorded baseline — captured from the deterministic open-loop run. */
export const GOLDEN_DINGHY_20S: GoldenTrajectory = {
  x: 25.644636309196237,
  y: -0.32849615891658046,
  z: 12.105305926289839,
  heel: 0.5643325166690046,
  heading: 2.0597003519546844,
  speed: 1.5902302008406428,
  pathLength: 28.468174779287693,
  maxHeel: 0.5643325166690046,
};
