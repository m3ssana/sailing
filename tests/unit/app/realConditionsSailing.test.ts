/**
 * GUARD TEST for the real-conditions sailing gap (the "1 kt / 50° leeway on a
 * reach" defect the headless acceptance tests missed because they sailed in
 * calm/synthetic water).
 *
 * It builds the EXACT world the shipped `Session` sails in — the Newport offline
 * climatology weather, the REAL spectrum-derived JONSWAP+swell wave field
 * (Hs≈0.7 m), the venue tide/current — via `buildSessionWorld` (the pure factory
 * the Session itself uses), then sails a steady heading-pinned, auto-trimmed
 * close/beam reach and asserts the boat holds a sailing speed and a small
 * leeway. This is the regression the calm-water acceptance tests could not see:
 * if the wave-added resistance, the leeway (sway) damping, or the draft/foil
 * calibration regress, the reach speed collapses and the leeway runs away, and
 * THIS test catches it in the real wave field.
 *
 * Conventions: SI/radians; world +X east, +Z south; wind bearing is FROM.
 */

import { describe, it, expect } from 'vitest';
import type { ControlState, WeatherSnapshot } from '@/types';
import { UNITS } from '@/types';
import { buildSessionWorld } from '@/app/buildSessionWorld';
import { buildClimatologySnapshot } from '@weather/index';
import { requireVenue } from '@venues/index';
import { idealSheetFor } from '@game/assist';

const DT = 1 / 120;
const MS_TO_KT = UNITS.MS_TO_KNOTS;

function wrap(a: number): number { let x = a; while (x > Math.PI) x -= 2 * Math.PI; while (x <= -Math.PI) x += 2 * Math.PI; return x; }

/**
 * Sail a steady heading-pinned reach at the given TWA in the given SessionWorld,
 * auto-trimming the main to the apparent-wind ideal, for `seconds`. Returns the
 * mean speed (kt), % of the polar target, and the mean leeway (deg) over the
 * last second.
 */
function sailReach(twaDeg: number, seconds: number): { kt: number; polarPct: number; leewayDeg: number } {
  // DETERMINISTIC: build the Newport OCTOBER climatology snapshot (the reported
  // scenario: ~11 kt from ~270°, Hs 0.7 m) with a pinned `fetchedAt`, so neither
  // the calendar month nor `Date.now()` perturbs the tide/current phase. The
  // offline ladder otherwise picks the climate by the system month and stamps
  // `fetchedAt=Date.now()`, which shifted the tidal set run-to-run and made the
  // marginal close-hauled % non-deterministic.
  const base = buildClimatologySnapshot(requireVenue('newport'), 10);
  const snapshot: WeatherSnapshot = { ...base, fetchedAt: 1_700_000_000_000 };
  const world = buildSessionWorld({ snapshot, nowMs: snapshot.fetchedAt });
  const { environment, boat, polar } = world;
  // Sail at the VENUE SPAWN (open channel, deep water) — the origin {0,0} is on
  // LAND in Newport (depth 0) where the venue wind-influence field kills the
  // breeze. Use the LOCAL real wind (bearing + speed at the CoE) as the target,
  // since the venue wind field shears/bends it from the snapshot value.
  const sx = world.spawn.position.x;
  const sz = world.spawn.position.z;
  const w0 = environment.wind.sample(sx, sz, 2.35, 0);
  const windFrom = w0.direction;
  const tws = w0.speed;
  const twa = (twaDeg * Math.PI) / 180;
  const targetHeading = ((windFrom - twa) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  boat.sim.reset({ x: sx, y: 0, z: sz }, targetHeading);
  boat.sim.state.linearVelocity.x = 2 * Math.sin(targetHeading);
  boat.sim.state.linearVelocity.z = -2 * Math.cos(targetHeading);

  let kt = 0; let polarPct = 0; let leewayDeg = 0;
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    const t = i * DT;
    const s = boat.sim.state;
    const he = wrap(s.heading - targetHeading);
    const rudder = Math.max(-1, Math.min(1, -he * 2 + s.angularVelocity.y));
    // Apparent wind for the ideal sheet (sample the LOCAL wind at the boat).
    const w = environment.wind.sample(s.position.x, s.position.z, 2.35, t);
    const awx = w.velocity.x - s.linearVelocity.x;
    const awz = w.velocity.z - s.linearVelocity.z;
    const aws = Math.hypot(awx, awz);
    const fwd = { x: Math.sin(s.heading), z: -Math.cos(s.heading) };
    const awF = awx * fwd.x + awz * fwd.z;
    const awaInc = (Math.acos(Math.max(-1, Math.min(1, -awF / (aws || 1)))) * 180) / Math.PI;
    const sheet = idealSheetFor(awaInc, aws);
    const ctrl: Partial<ControlState> = { rudder, mainsheet: sheet, board: 1, hike: 1, crewLateral: -Math.sign(Math.sin(twa)) || -1 };
    boat.sim.setControls(ctrl);
    boat.sim.step(environment, t, DT);
    if (i >= n - 120) {
      kt += (s.speed * MS_TO_KT) / 120;
      const target = polar.targetSpeed(tws, twa) * MS_TO_KT;
      polarPct += (target > 0.1 ? (s.speed * MS_TO_KT / target) * 100 : 0) / 120;
      const velH = Math.atan2(s.linearVelocity.x, -s.linearVelocity.z);
      leewayDeg += (Math.abs(wrap(velH - s.heading)) * 180 / Math.PI) / 120;
    }
  }
  return { kt, polarPct, leewayDeg };
}

describe('real-conditions reach guard (Newport wave field, the gap the calm tests missed)', () => {
  it('beam reach (TWA 90) holds ≥ 60% of polar at < 12° leeway in the REAL Hs≈0.7 m sea', () => {
    const r = sailReach(90, 45);
    expect(r.polarPct, `beam reach % of polar (got ${r.polarPct.toFixed(0)}%, ${r.kt.toFixed(2)} kt)`).toBeGreaterThanOrEqual(60);
    expect(r.leewayDeg, `beam reach leeway (got ${r.leewayDeg.toFixed(1)}°)`).toBeLessThan(12);
  });

  it('close reach (TWA 70) holds ≥ 60% of polar at < 12° leeway in the REAL sea', () => {
    const r = sailReach(70, 45);
    expect(r.polarPct, `close reach % of polar (got ${r.polarPct.toFixed(0)}%, ${r.kt.toFixed(2)} kt)`).toBeGreaterThanOrEqual(60);
    expect(r.leewayDeg, `close reach leeway (got ${r.leewayDeg.toFixed(1)}°)`).toBeLessThan(12);
  });

  it('close-hauled (TWA 50) stays attached: ≥ 55% of polar at < 12° leeway (no runaway)', () => {
    // Close-hauled is the HARDEST point in a seaway (head sea, lowest drive
    // margin, nearest the no-go zone); the pre-fix defect collapsed it to ~16% /
    // 25° leeway. With the fix it holds ~70% here — assert ≥ 55% with margin.
    const r = sailReach(50, 45);
    expect(r.polarPct, `close-hauled % of polar (got ${r.polarPct.toFixed(0)}%, ${r.kt.toFixed(2)} kt)`).toBeGreaterThanOrEqual(55);
    expect(r.leewayDeg, `close-hauled leeway (got ${r.leewayDeg.toFixed(1)}°)`).toBeLessThan(12);
  });
});
