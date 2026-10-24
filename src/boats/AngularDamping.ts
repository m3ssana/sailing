/**
 * Hydrodynamic angular damping — a composable {@link ForceGenerator}.
 *
 * ## Why this exists (honest diagnosis)
 *
 * The frozen physics force set (Buoyancy, WaveDrag, Aero, HydroResistance,
 * FoilLift, RightingMoment) models the restoring MOMENT that returns a heeled
 * hull upright, but NOT the hydrodynamic DAMPING that bleeds energy out of the
 * roll/pitch/yaw oscillation. With a conservative righting couple and no angular
 * damping, any disturbance — a puff, a wave, an initial heel — sets up a
 * near-undamped roll oscillation that never settles and, under a steady sail
 * heeling moment, builds until it exceeds the capsize angle. A real dinghy's
 * roll is strongly damped by the hull topsides, the daggerboard and rudder
 * sweeping broadside through the water, and wave-making at the heeling gunwale.
 *
 * Rather than edit the frozen physics integrator or force modules, we add that
 * damping here as a boat-level generator (the project's intended extension
 * point: "a new physical effect is a new generator, never an edit to the
 * integrator" — design.md §7.1). This keeps the import boundary intact: pure
 * TypeScript, no three.js, allocation-free in the step path.
 *
 * ## Model (documented approximation, not first-principles)
 *
 * A quadratic-plus-linear damping MOMENT opposing the body angular velocity:
 *
 *   M_damp = −(c_lin · ω + c_quad · |ω| · ω)
 *
 * applied per axis with axis-specific coefficients scaled by the relevant
 * damping area and span (roll is damped most — the board and topsides have the
 * largest lever and swept area; yaw least). Coefficients are calibrated so that
 * a dinghy released from ~15° heel settles upright in a few seconds (critical-
 * to-slightly-overdamped roll), which matches how a Laser behaves, and so a
 * steady over-heeling moment reaches a stable heel angle instead of diverging.
 *
 * The damping moment is applied as a vertical force couple (consistent with how
 * RightingMoment injects its moment), so it composes cleanly in the integrator.
 */

import type { AppliedForce, ForceContext, ForceGenerator, Vec3 } from '@/types';

/** Per-axis damping coefficients (N·m per rad/s, and per (rad/s)²). */
export interface AngularDampingConfig {
  /** Linear roll damping (about longitudinal X). */
  rollLinear: number;
  /** Quadratic roll damping. */
  rollQuad: number;
  /** Linear pitch damping (about transverse Z). */
  pitchLinear: number;
  /** Quadratic pitch damping. */
  pitchQuad: number;
  /** Linear yaw damping (about vertical Y). */
  yawLinear: number;
  /** Quadratic yaw damping. */
  yawQuad: number;
  /** Linear heave damping (vertical linear velocity), N per m/s. */
  heaveLinear: number;
  /** Linear surge/sway damping (horizontal linear velocity), N per m/s. Small —
   *  enough to settle/stabilise, not so much it kills sailing speed. */
  surgeLinear: number;
}

/**
 * A generator that applies hydrodynamic angular damping opposing the boat's
 * angular velocity. Zero allocation in `evaluate` (pushes two pooled-size force
 * literals; the simulation clears its force list each step).
 */
export class AngularDampingForceGenerator implements ForceGenerator {
  readonly id = 'angular-damping';

  private readonly _cfg: AngularDampingConfig;

  constructor(cfg: AngularDampingConfig) {
    this._cfg = cfg;
  }

  evaluate(ctx: ForceContext, out: AppliedForce[]): void {
    const w: Vec3 = ctx.state.angularVelocity;
    const p = ctx.state.position;
    const c = this._cfg;

    // Damping moment per axis: −(lin·ω + quad·|ω|·ω).
    const mx = -(c.rollLinear * w.x + c.rollQuad * Math.abs(w.x) * w.x); // roll (about X)
    const my = -(c.yawLinear * w.y + c.yawQuad * Math.abs(w.y) * w.y); // yaw (about Y)
    const mz = -(c.pitchLinear * w.z + c.pitchQuad * Math.abs(w.z) * w.z); // pitch (about Z)

    // Inject each moment as a force couple about its axis, 1 m lever.
    // Roll (about X): couple in the Y–Z plane → vertical forces offset in Z.
    // Forces ±mx·(1) at ±0.5 m in Z sum to a net moment of exactly mx about X.
    if (Math.abs(mx) > 1e-6) {
      out.push({ force: { x: 0, y: -mx, z: 0 }, point: { x: p.x, y: p.y, z: p.z + 0.5 } });
      out.push({ force: { x: 0, y: mx, z: 0 }, point: { x: p.x, y: p.y, z: p.z - 0.5 } });
    }
    // Pitch (about Z): couple → vertical forces offset in X.
    if (Math.abs(mz) > 1e-6) {
      out.push({ force: { x: 0, y: mz, z: 0 }, point: { x: p.x + 0.5, y: p.y, z: p.z } });
      out.push({ force: { x: 0, y: -mz, z: 0 }, point: { x: p.x - 0.5, y: p.y, z: p.z } });
    }
    // Yaw (about Y): couple → horizontal forces offset in X.
    if (Math.abs(my) > 1e-6) {
      out.push({ force: { x: 0, y: 0, z: my }, point: { x: p.x + 0.5, y: p.y, z: p.z } });
      out.push({ force: { x: 0, y: 0, z: -my }, point: { x: p.x - 0.5, y: p.y, z: p.z } });
    }

    // Linear hydrodynamic damping on the hull's translational velocity. The hull
    // dragging through the water damps surge/sway/heave; without it (e.g. with
    // WaveDrag disabled) the conservative buoyancy↔weight restoring sets up an
    // essentially UNDAMPED oscillation that never settles — and under wave
    // forcing can diverge. This deterministic term (no shared module state, unlike
    // WaveDrag's stateful slam) lets the boat settle and ride a seaway stably.
    // Heave (y) is damped hardest (vertical hull motion sweeps the most water).
    const v = ctx.state.linearVelocity;
    const fx = -c.surgeLinear * v.x;
    const fy = -c.heaveLinear * v.y;
    const fz = -c.surgeLinear * v.z;
    if (Math.abs(fx) > 1e-6 || Math.abs(fy) > 1e-6 || Math.abs(fz) > 1e-6) {
      out.push({ force: { x: fx, y: fy, z: fz }, point: { x: p.x, y: p.y, z: p.z } });
    }
  }
}

/**
 * Default damping for a small single-handed dinghy (ILCA-scale).
 *
 * Roll is damped hardest: the daggerboard (~0.8 m span) and topsides sweep a
 * large area broadside as the boat rolls. Calibrated so a release from ~15°
 * heel settles in ~3–4 s (slightly overdamped, matching a Laser) and a steady
 * heeling moment reaches a stable angle.
 */
export const DINGHY_ANGULAR_DAMPING: AngularDampingConfig = {
  // Calibrated against the full frozen force set. Linear-dominant damping gives
  // a well-behaved settle from a disturbance (roll from 15° decays in ~3 s). A
  // modest quadratic term adds extra bite on fast rates. Kept below the explicit
  // integrator's stability ceiling at 120 Hz for this boat's roll inertia.
  rollLinear: 600,
  rollQuad: 400,
  pitchLinear: 450,
  pitchQuad: 250,
  yawLinear: 220,
  yawQuad: 120,
  // Heave: a light vertical damping (N per m/s). Enough to settle the flat-water
  // heave limit cycle to well under 2 cm, but light enough not to stiffen the
  // wave-forced response into divergence (a sweet spot — see AngularDamping
  // calibration in tests/unit/boats). The hull dragging vertically through the
  // water provides this physically.
  heaveLinear: 300,
  // Surge/sway: a light horizontal hull drag. Small enough that it does not
  // meaningfully cut sailing speed (HydroResistance is the dominant drag), but
  // present so a passive boat settles and rides a seaway without WaveDrag's
  // stateful slam term — making the long soak deterministic and stable.
  surgeLinear: 120,
};
