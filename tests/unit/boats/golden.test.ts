/**
 * Golden-trajectory baseline for the dinghy (headless, deterministic).
 *
 * Records summary statistics of a fixed 20 s trajectory (fixed boat, fixed
 * environment, fixed control schedule) and pins them with a tolerance. This is a
 * change-detector: any change to the force model, integrator, or dinghy
 * definition that alters the trajectory will move these numbers and fail the
 * test, forcing a conscious re-baseline.
 *
 * It includes a NEGATIVE CONTROL: perturbing a single hull drag coefficient
 * (the residuary curve) must make the trajectory summary diverge from the
 * baseline — proving the golden test genuinely binds to the physics and is not
 * trivially satisfiable.
 *
 * Conventions: SI/radians; world +X east, +Z south; wind FROM north.
 */

import { describe, it, expect } from 'vitest';
import type { BoatDefinition, ControlState } from '@/types';
import type { BoatSimulationBundle } from '@boats/BoatFactory';
import { createBoatSimulation } from '@boats/BoatFactory';
import { DINGHY } from '@boats/index';
import { makeEnvironment } from './fixtures';
import { GOLDEN_DINGHY_20S, GOLDEN_TOLERANCE } from './fixtures.golden';

const DT = 1 / 120;
const EAST = Math.PI / 2;

interface TrajSummary {
  /** Final position. */
  x: number;
  y: number;
  z: number;
  /** Final attitude / speed. */
  heel: number;
  heading: number;
  speed: number;
  /** Path length travelled (sum of per-step horizontal displacement). */
  pathLength: number;
  /** Peak heel magnitude over the run. */
  maxHeel: number;
}

function setInstant(b: BoatSimulationBundle, c: Partial<ControlState>): void {
  b.sim.setControls(c);
  for (const k of Object.keys(c) as (keyof ControlState)[]) {
    const v = c[k];
    if (v !== undefined) b.sim.state.controls[k] = v;
  }
}

/**
 * Run a fixed, fully deterministic 20 s trajectory and return summary stats.
 * A FIXED open-loop control schedule (no feedback) so the result depends only
 * on the physics, not on any controller. `def` lets the negative control pass a
 * perturbed definition.
 */
function runTrajectory(def: BoatDefinition, id: string): TrajSummary {
  const bundle = createBoatSimulation(def, { id });
  const env = makeEnvironment(12);
  bundle.sim.reset({ x: 0, y: -0.27, z: 0 }, EAST);
  setInstant(bundle, { board: 1, mainsheet: 0.3, rudder: 0, hike: 0.6, crewLateral: -0.6 });
  const s = bundle.sim.state;
  let prevX = s.position.x;
  let prevZ = s.position.z;
  let pathLength = 0;
  let maxHeel = 0;
  for (let i = 0; i < 20 * 120; i++) {
    // Fixed open-loop schedule: a gentle steady rudder nudge, constant trim/hike.
    bundle.sim.setControls({ rudder: 0.05, mainsheet: 0.3, hike: 0.6, crewLateral: -0.6, board: 1 });
    bundle.sim.step(env, i * DT, DT);
    const dx = s.position.x - prevX;
    const dz = s.position.z - prevZ;
    pathLength += Math.hypot(dx, dz);
    prevX = s.position.x;
    prevZ = s.position.z;
    maxHeel = Math.max(maxHeel, Math.abs(s.heel));
  }
  return {
    x: s.position.x, y: s.position.y, z: s.position.z,
    heel: s.heel, heading: s.heading, speed: s.speed,
    pathLength, maxHeel,
  };
}

describe('dinghy golden trajectory (20 s)', () => {
  it('matches the recorded baseline within tolerance', () => {
    const t = runTrajectory(DINGHY, 'golden-base');
    expect(t.x).toBeCloseTo(GOLDEN_DINGHY_20S.x, GOLDEN_TOLERANCE);
    expect(t.y).toBeCloseTo(GOLDEN_DINGHY_20S.y, GOLDEN_TOLERANCE);
    expect(t.z).toBeCloseTo(GOLDEN_DINGHY_20S.z, GOLDEN_TOLERANCE);
    expect(t.heel).toBeCloseTo(GOLDEN_DINGHY_20S.heel, GOLDEN_TOLERANCE);
    expect(t.heading).toBeCloseTo(GOLDEN_DINGHY_20S.heading, GOLDEN_TOLERANCE);
    expect(t.speed).toBeCloseTo(GOLDEN_DINGHY_20S.speed, GOLDEN_TOLERANCE);
    expect(t.pathLength).toBeCloseTo(GOLDEN_DINGHY_20S.pathLength, GOLDEN_TOLERANCE);
    expect(t.maxHeel).toBeCloseTo(GOLDEN_DINGHY_20S.maxHeel, GOLDEN_TOLERANCE);
  });

  it('is deterministic: the same run twice is bit-identical', () => {
    const a = runTrajectory(DINGHY, 'golden-det-a');
    const b = runTrajectory(DINGHY, 'golden-det-b');
    expect(b).toEqual(a);
  });

  it('NEGATIVE CONTROL: perturbing a hull drag coefficient breaks the baseline', () => {
    // Double the residuary (wavemaking) drag hump. A genuine physics-bound golden
    // test MUST then diverge from the baseline — if it still matched, the test
    // would not be binding to the hull drag at all.
    const draggy: BoatDefinition = {
      ...DINGHY,
      id: 'dinghy-draggy',
      residuaryCurve: DINGHY.residuaryCurve.map((p) => ({ x: p.x, y: p.y * 2 + 0.01 })),
    };
    const t = runTrajectory(draggy, 'golden-neg');
    // At least one summary statistic must differ well beyond the tolerance.
    const tol = 0.5 * 10 ** -GOLDEN_TOLERANCE;
    const diverged =
      Math.abs(t.x - GOLDEN_DINGHY_20S.x) > tol ||
      Math.abs(t.speed - GOLDEN_DINGHY_20S.speed) > tol ||
      Math.abs(t.pathLength - GOLDEN_DINGHY_20S.pathLength) > tol;
    expect(diverged).toBe(true);
  });
});
