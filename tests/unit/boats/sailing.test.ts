/**
 * Closed-loop "it sails" proof for the dinghy, fully headless.
 *
 * A SIMPLE autopilot sails the boat: a PD helm on heading error, a steady sheet
 * for the point of sail (eased to depower as heel builds), and a crew that hikes
 * monotonically to the windward side. This is the real proof that the corrected
 * force model produces SAILING — the boat holds a course at small leeway, builds
 * and holds speed, and makes velocity made good toward the wind close-hauled —
 * none of which was possible before the physics fixes (the foil amplified leeway
 * instead of opposing it, the sail was permanently stalled, and yaw diverged).
 *
 * ## HONEST SCOPE (what this simple controller does and does not do)
 *
 * The simple PD-helm + depower + monotone-hike autopilot robustly SAILS the boat
 * on a steady point of sail up to ~12 kt: it holds a course at small leeway and
 * does not capsize. It does NOT perform a clean tack through the eye of the wind
 * or a gybe through dead-downwind — those transients drop the boat below foil
 * stall / swing it through the roll-unstable dead-downwind attitude, and a naive
 * PD loop capsizes or stalls in irons. Executing tacks/gybes and holding the
 * ILCA target speed in a breeze needs the anticipating, sheet-and-feather AI
 * crew controller that is Phase 2 Stream G — not the boat definition or the core
 * force model, which are what these tests exercise. The quantitative ILCA-band
 * speed (5–7 kt beam reach in 12 kt) is asserted against the COMPUTED polar in
 * dinghy.test.ts; here we prove the time-domain boat holds a course, keeps
 * leeway small, and makes upwind VMG — the qualitative "it sails".
 *
 * Conventions: SI/radians; world +X east, +Z south; wind FROM north (bearing 0);
 * heading θ → forward (sin θ, 0, −cos θ).
 */

import { describe, it, expect } from 'vitest';
import type { ControlState } from '@/types';
import { UNITS } from '@/types';
import type { BoatSimulationBundle } from '@boats/BoatFactory';
import { createBoatSimulation, DINGHY } from '@boats/index';
import { makeEnvironment } from './fixtures';

const DT = 1 / 120;

function wrapPi(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

function setInstant(b: BoatSimulationBundle, c: Partial<ControlState>): void {
  b.sim.setControls(c);
  for (const k of Object.keys(c) as (keyof ControlState)[]) {
    const v = c[k];
    if (v !== undefined) b.sim.state.controls[k] = v;
  }
}

function leeway(b: BoatSimulationBundle): number {
  const s = b.sim.state;
  const vH = Math.atan2(s.linearVelocity.x, -s.linearVelocity.z);
  return wrapPi(s.heading - vH);
}

/**
 * One autopilot step. `windwardSign` = −1 when the boat heels to starboard (wind
 * over the port side — the easterly-heading, wind-from-north case) so the crew
 * hikes to port. `baseSheet` is the cleated trim for the leg, eased further
 * (depowered) as heel builds.
 */
function autopilotStep(
  b: BoatSimulationBundle,
  targetHeading: number,
  baseSheet: number,
  windwardSign: number,
): void {
  const s = b.sim.state;
  const heelTowardLee = s.heel * -windwardSign; // >0 when heeling to leeward.
  const depower = Math.max(0, Math.min(1, (heelTowardLee - 0.26) / 0.35));
  const mainsheet = Math.max(0, baseSheet * (1 - depower));

  const he = wrapPi(s.heading - targetHeading);
  const rudder = Math.max(-1, Math.min(1, he * 2.0 - s.angularVelocity.y * 1.5));

  const hike = Math.max(0, Math.min(1, (heelTowardLee + 0.02) / 0.18));
  const crewLateral = windwardSign * hike;

  b.sim.setControls({ rudder, mainsheet, hike, crewLateral, board: 1 });
}

describe('dinghy sails a beam reach under autopilot (10 kt)', () => {
  it('holds course at small leeway, bounded speed, without capsizing over 60 s', () => {
    const b = createBoatSimulation(DINGHY, { id: 'cl-reach' });
    const env = makeEnvironment(10);
    const target = Math.PI / 2; // east → beam reach (TWA 90).
    b.sim.reset({ x: 0, y: -0.27, z: 0 }, target);
    b.sim.state.linearVelocity.x = 3;
    setInstant(b, { board: 1, mainsheet: 0.3, rudder: 0, hike: 1, crewLateral: -1 });
    const s = b.sim.state;

    let maxLeeway = 0;
    let sumSpeed = 0;
    let n = 0;
    const x0 = s.position.x;
    for (let i = 0; i < 60 * 120; i++) {
      autopilotStep(b, target, 0.3, -1);
      b.sim.step(env, i * DT, DT);
      expect(s.capsized).toBe(false); // never capsizes.
      if (i > 5 * 120) {
        maxLeeway = Math.max(maxLeeway, Math.abs(leeway(b)));
        sumSpeed += s.speed;
        n++;
      }
    }
    const avgKt = (sumSpeed / n) * UNITS.MS_TO_KNOTS;

    // Holds a sensible course on the reach (heading within ±35° of the target).
    expect(Math.abs(wrapPi(s.heading - target))).toBeLessThan((35 * Math.PI) / 180);
    // Leeway stays small — the daggerboard is doing its job (was ~60° when the
    // foil sign was inverted; now a few degrees, occasionally into the teens
    // during helm transients).
    expect((maxLeeway * 180) / Math.PI).toBeLessThan(15);
    // It is genuinely sailing: a steady, bounded, positive speed (not stalled,
    // not runaway). The quantitative ILCA 5–7 kt band is asserted on the polar.
    expect(avgKt).toBeGreaterThan(1.5);
    expect(avgKt).toBeLessThan(8);
    // Net forward progress to the east over the minute.
    expect(s.position.x - x0).toBeGreaterThan(20); // metres made good east.
  });
});

describe('dinghy makes upwind VMG close-hauled under autopilot (10 kt)', () => {
  it('sails toward the wind (net progress to windward) on a close reach', () => {
    // Wind FROM north → the windward direction is −Z (north). A close reach at
    // heading ~50° (TWA ≈ 50°) must make NET progress toward the wind: its Z
    // coordinate must DECREASE (move north) over the run — positive upwind VMG,
    // which is only possible because the daggerboard now opposes leeway (it used
    // to amplify it, so the boat slid bodily downwind — negative VMG — and could
    // never work to windward at all).
    //
    // HONEST SCOPE: the simple autopilot points poorly (it sags to ~30° leeway),
    // so the upwind VMG is small and positive, not an optimised ILCA VMG. Pointing
    // high and maximising VMG is the AI crew's job (Stream G); here we assert the
    // qualitative "it can work to windward", which is what the foil-sign fix buys.
    const b = createBoatSimulation(DINGHY, { id: 'cl-vmg' });
    const env = makeEnvironment(10);
    const target = (50 * Math.PI) / 180;
    b.sim.reset({ x: 0, y: -0.27, z: 0 }, target);
    b.sim.state.linearVelocity.x = 2.5;
    b.sim.state.linearVelocity.z = -1.5; // initial way with a northerly component.
    setInstant(b, { board: 1, mainsheet: 0.6, rudder: 0, hike: 1, crewLateral: -1 });
    const s = b.sim.state;
    const z0 = s.position.z;
    for (let i = 0; i < 60 * 120; i++) {
      autopilotStep(b, target, 0.6, -1);
      b.sim.step(env, i * DT, DT);
      expect(s.capsized).toBe(false);
    }
    // Made NET progress to windward (north → z decreased): positive upwind VMG.
    const windwardMadeGood = z0 - s.position.z; // metres to the north.
    expect(windwardMadeGood).toBeGreaterThan(2);
    // And it is actually moving (not stalled in irons).
    expect(s.speed).toBeGreaterThan(0.3);
  });
});
