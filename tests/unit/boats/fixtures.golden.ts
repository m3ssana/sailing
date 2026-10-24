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

/** Recorded baseline — captured from the deterministic open-loop run.
 *
 * RE-RECORDED 2026-10-24 for the REAL-CONDITIONS SAILING FIX (RealConditions
 * stream). This pass jointly recalibrated the dinghy hydrostatics/dynamics so the
 * boat sails correctly in the real venue wave field (the "1 kt / 50° leeway on a
 * reach" defect): (1) the Buoyancy `refDepth` now floats the hull at its DESIGN
 * draft (keel ~0.12 m, not ~0.3 m deep — note y is now ~−0.12, was ~−0.34);
 * (2) the hydrodynamic roll damping was reduced from the deep-sink-era 5000 to a
 * physical ~2000 (so the 25 kt capsize completes again) and the linear damping
 * was split into light SURGE + heavy SWAY (killing the leeway runaway);
 * (3) the foil stall angle was raised ~11°→~15° and softened; (4) added
 * resistance in waves is now a bounded fraction of calm resistance. Each of these
 * legitimately moves the open-loop trajectory. Net: the boat floats higher
 * (y −0.34→−0.12), carries a touch more speed (1.76→1.83 kt), heels a little more
 * on this fixed schedule (maxHeel 6.6°→11.2°, still upright), and curves to a
 * different final position/heading. The spawn was also corrected from the stale
 * deep-sink y=−0.27 to y=0 (the hull now settles to its own design draft). The
 * NEGATIVE CONTROL (doubling the residuary curve) still diverges, so the golden
 * stays binding. */
export const GOLDEN_DINGHY_20S: GoldenTrajectory = {
  x: 12.722750235704376,
  y: -0.1179661815356912,
  z: 22.96613077957036,
  heel: -0.19587645095791917,
  heading: 4.102736103687187,
  speed: 1.833706845123965,
  pathLength: 36.72162778016377,
  maxHeel: 0.19587645095791917,
};
