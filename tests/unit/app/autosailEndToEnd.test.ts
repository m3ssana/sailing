/**
 * Headless end-to-end autosail acceptance (Phase-2 "first sail" item 3 + the
 * browser smoke-test counters, run without a GPU).
 *
 * Replicates the Session's fixed-step autosail loop — the `ScriptedInputProvider`
 * PD-helm sequence (close-hauled → tack 26 s → broad reach → gybe 56 s) feeding
 * the REAL `SailingAssist` over the REAL dinghy `BoatSimulation` in a uniform
 * wind FROM a westerly bearing (the Newport-like case that used to capsize) —
 * and asserts the same invariants the browser `window.__sailing` hook reports:
 * at least one tack and one gybe are executed, the boat never capsizes, and the
 * worst heel stays well under a knock-down. This is the headless counterpart to
 * the real-browser run; it is deterministic and GPU-free.
 *
 * Conventions: SI/radians; world +X east, +Z south; wind bearing is FROM.
 */

import { describe, it, expect } from 'vitest';
import type { ControlState, CrewCommand, Environment, Vec3 } from '@/types';
import { PHYSICS_CONSTANTS, UNITS } from '@/types';
import { createBoatSimulation, DINGHY } from '@boats/index';
import { createSailingAssist } from '@game/assist';
import type { AssistFrame, AssistPhase } from '@game/assist';
import { ScriptedInputProvider } from '@/app/sessionHelpers';

const DT = 1 / 120;

function uniformEnv(windKnots: number, windFromBearing: number): Environment {
  const speedMs = windKnots * UNITS.KNOTS_TO_MS;
  const vel: Vec3 = {
    x: -Math.sin(windFromBearing) * speedMs,
    y: 0,
    z: Math.cos(windFromBearing) * speedMs,
  };
  const scratch: Vec3 = { x: 0, y: 0, z: 0 };
  return {
    waterDensity: PHYSICS_CONSTANTS.WATER_DENSITY,
    wind: { sample: () => ({ velocity: { ...vel }, speed: speedMs, direction: windFromBearing }) },
    waves: {
      params: { significantHeight: 0, windDirection: windFromBearing, swellPeriod: 6 },
      height: () => 0,
      orbitalVelocity: (_x: number, _z: number, _y: number, _t: number, out?: Vec3) => {
        const d = out ?? scratch; d.x = 0; d.y = 0; d.z = 0; return d;
      },
    },
  } as unknown as Environment;
}

interface Counters {
  tackCount: number;
  gybeCount: number;
  maxHeelDeg: number;
  capsized: boolean;
}

/** Replicate the Session autosail fixed-step loop for `seconds` of session time. */
function runAutosail(windFromDeg: number, windKt: number, seconds: number): Counters {
  const windFrom = (windFromDeg * Math.PI) / 180;
  const env = uniformEnv(windKt, windFrom);
  const b = createBoatSimulation(DINGHY, { id: `autosail-${windFromDeg}` });
  const assist = createSailingAssist();
  const scripted = new ScriptedInputProvider();
  const out: Partial<ControlState> = {};

  // Spawn close-hauled on starboard at this wind bearing with a little way.
  const twa0 = (45 * Math.PI) / 180;
  const h0 = ((windFrom - twa0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  b.sim.reset({ x: 0, y: -0.27, z: 0 }, h0);
  b.sim.state.linearVelocity.x = 3 * Math.sin(h0);
  b.sim.state.linearVelocity.z = -3 * Math.cos(h0);

  const c: Counters = { tackCount: 0, gybeCount: 0, maxHeelDeg: 0, capsized: false };
  let phaseWas: AssistPhase = 'idle';
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    const t = i * DT;
    const s = b.sim.state;
    const f = scripted.frame(t, {
      heading: s.heading,
      yawRate: s.angularVelocity.y,
      windFromBearing: windFrom,
    });
    const driver = f.controls;
    const commands: readonly CrewCommand[] = f.commands;
    const frame: AssistFrame = {
      state: s,
      trueWindFromBearing: windFrom,
      trueWindSpeed: windKt * UNITS.KNOTS_TO_MS,
      assist: 'assisted',
      commands,
      driverControls: { ...s.controls, ...driver } as ControlState,
      dt: DT,
    };
    assist.update(frame, out);
    // Merge driver then assist override (as the Session does).
    b.sim.setControls({ ...driver, ...out });
    b.sim.step(env, t, DT);

    if (phaseWas === 'idle' && assist.phase === 'tacking') c.tackCount++;
    if (phaseWas === 'idle' && assist.phase === 'gybing') c.gybeCount++;
    phaseWas = assist.phase;
    const heelDeg = Math.abs(s.heel) * (180 / Math.PI);
    if (heelDeg > c.maxHeelDeg) c.maxHeelDeg = heelDeg;
    if (s.capsized) c.capsized = true;
  }
  return c;
}

describe('autosail end-to-end (headless browser-smoke counterpart)', () => {
  // Wind FROM 277° is the real Newport scenario that used to end CAPSIZED at
  // ~140° heel. With the heading-convention unification it must now run the full
  // scripted sequence (≥1 tack, ≥1 gybe), never capsize, and keep heel bounded.
  it('wind FROM 277° (Newport): ≥1 tack, ≥1 gybe, no capsize, heel < 60°', () => {
    const c = runAutosail(277, 11, 70);
    expect(c.tackCount, 'executed at least one tack').toBeGreaterThanOrEqual(1);
    expect(c.gybeCount, 'executed at least one gybe').toBeGreaterThanOrEqual(1);
    expect(c.capsized, 'never capsized').toBe(false);
    expect(c.maxHeelDeg, 'heel stayed under a knock-down').toBeLessThan(60);
  });

  it('wind FROM north: same invariants (its own mirror)', () => {
    const c = runAutosail(0, 11, 70);
    expect(c.tackCount).toBeGreaterThanOrEqual(1);
    expect(c.gybeCount).toBeGreaterThanOrEqual(1);
    expect(c.capsized).toBe(false);
    expect(c.maxHeelDeg).toBeLessThan(60);
  });
});
