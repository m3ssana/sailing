/**
 * Hydrodynamic damping — the velocity-proportional forces that bleed energy out
 * of a hull's rigid-body motion. A composable {@link ForceGenerator}.
 *
 * ## Why this exists (root-cause diagnosis, with evidence)
 *
 * The frozen conservative force set (Buoyancy, Aero, HydroResistance, FoilLift,
 * RightingMoment, WaveDrag) models the restoring MOMENTS and drag along the
 * direction of travel, but it carries NO hydrodynamic damping of the
 * rotational modes (roll/pitch/yaw) and essentially none of heave/sway. In a
 * real boat those modes are strongly damped: the hull topsides, daggerboard and
 * rudder sweep broadside through the water, and wave-making at the moving
 * gunwale radiates energy. Without that damping term:
 *
 *   - YAW is a pure free integrator (no restoring torque, no damping) — any
 *     residual aero/foil yaw moment spins it up without bound.
 *   - ROLL/PITCH are near-undamped: the conservative righting couple makes them
 *     oscillate and, under a steady heeling moment or wave forcing, ring up past
 *     the capsize angle and then diverge.
 *
 * A diagnostic soak on calm water with WaveDrag removed and NO angular damping
 * shows yaw rate growing monotonically (0.6 → 7.6 rad/s over 60 s) while the
 * heel oscillates ±130°; adding WaveDrag back only masks it because its orbital
 * drag happens to bleed some roll/heave energy. The real fix is the damping
 * that physically exists, added here.
 *
 * It is ALSO explicitly NOT a stiff-integrator problem: the buoyancy heave
 * spring is k≈4573 N/m on m≈133 kg → ω≈5.9 rad/s, so at the fixed 120 Hz outer
 * step ω·dt≈0.049 ≪ 2, far inside the explicit/symplectic stability limit.
 * Sub-stepping would buy nothing; the divergence is a missing-physics problem,
 * not a time-step problem. (See the diagnostic writeup in STATUS.md.)
 *
 * ## Model (documented engineering approximation)
 *
 * A quadratic-plus-linear damping MOMENT opposing the body angular velocity per
 * axis, and a linear damping FORCE opposing the translational velocity:
 *
 *   M_damp,axis = −(c_lin · ω + c_quad · |ω| · ω)
 *   F_damp      = −(c_surge · v_x, c_heave · v_y, c_surge · v_z)
 *
 * Each moment is injected as a vertical/horizontal force couple about a 1 m
 * lever so it composes cleanly in the existing force-summation integrator
 * (identical injection pattern to RightingMoment). Coefficients are calibrated
 * so a dinghy released from ~15° heel settles upright in a few seconds
 * (critical-to-slightly-overdamped roll, matching a Laser) and a steady
 * over-heeling moment reaches a stable heel instead of diverging.
 *
 * Deterministic and allocation-light: no module-scope mutable state shared
 * between instances (unlike WaveDrag's slam tracking), so two boats — or two
 * parallel tests — never alias each other.
 */

import type { AppliedForce, ForceContext, ForceGenerator, Vec3 } from '@/types';
import { vec3, rotateVec3, rotateVec3Inverse, addScaled3 } from '@core/math';
import { pushBodyAxisTorque } from './torqueCouple';

/** Body forward axis (bow) in hull-local coords: −Z. */
const FWD_BODY: Vec3 = { x: 0, y: 0, z: -1 };
/** Body starboard axis in hull-local coords: +X. */
const STARBOARD_BODY: Vec3 = { x: 1, y: 0, z: 0 };

/*
 * Frame (rotation-invariant) — FIXED.
 * The roll/pitch/yaw damping couples below oppose the BODY-frame angular
 * velocity (ω_body = q⁻¹·ω_world) about the hull's own axes and are injected via
 * `pushBodyAxisTorque`, which rotates the body torque into world space through
 * the orientation quaternion. This is correct at every compass heading.
 * (Historical bug: the couples were injected about fixed WORLD axes and damped
 * the WORLD components of ω, correct only pointing due north/south — a
 * heading-dependent mis-damping. See tests/unit/physics/rotationInvariance.test.ts.)
 */

/** Per-axis damping coefficients (N·m per rad/s, and per (rad/s)²; N per m/s). */
export interface HydrodynamicDampingConfig {
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
  /** Linear SURGE (fore-aft, along the bow) damping, N per m/s. Small — the
   *  streamlined hull has little fore-aft damping and HydroResistance already
   *  supplies the through-water drag; kept light so it does not eat speed. */
  surgeLinear: number;
  /** Linear SWAY (athwartships, lateral) damping, N per m/s. LARGE — a hull +
   *  daggerboard moving sideways is a flat plate edge-on with huge added mass
   *  and broadside drag, so lateral motion is strongly damped. This critically
   *  damps the leeway (sway) mode and is the fix for the wave-triggered leeway
   *  runaway. Defaults to `surgeLinear` when omitted (legacy behaviour). */
  swayLinear?: number;
}

/**
 * Applies hydrodynamic damping opposing the boat's angular and translational
 * velocity. Allocation-light (pushes a few plain force literals; the simulation
 * clears its force list each step). No shared module state.
 */
export class HydrodynamicDampingForceGenerator implements ForceGenerator {
  readonly id = 'hydrodynamic-damping';

  private readonly _cfg: HydrodynamicDampingConfig;

  // Per-INSTANCE scratch (no shared module state → deterministic in parallel runs).
  private readonly _omegaBody: Vec3 = vec3();
  private readonly _torqueBody: Vec3 = vec3();
  private readonly _worldCoM: Vec3 = vec3();
  private readonly _fwd: Vec3 = vec3();
  private readonly _stbd: Vec3 = vec3();

  constructor(cfg: HydrodynamicDampingConfig) {
    this._cfg = cfg;
  }

  evaluate(ctx: ForceContext, out: AppliedForce[]): void {
    const p = ctx.state.position;
    const c = this._cfg;
    const orientation = ctx.state.orientation;
    const _omegaBody = this._omegaBody;
    const _torqueBody = this._torqueBody;
    const _worldCoM = this._worldCoM;
    const _fwd = this._fwd;
    const _stbd = this._stbd;

    // Angular velocity in the BODY frame (ω_body = q⁻¹ · ω_world). Body axes:
    // forward = −Z (roll), starboard = +X (pitch), up = +Y (yaw).
    rotateVec3Inverse(orientation, ctx.state.angularVelocity, _omegaBody);
    const wRoll = _omegaBody.z; // about body Z (longitudinal)
    const wPitch = _omegaBody.x; // about body X (transverse)
    const wYaw = _omegaBody.y; // about body Y (vertical)

    // Damping torque per BODY axis: −(lin·ω + quad·|ω|·ω). All OPPOSE the
    // rotation. The signs are automatically correct because the torque opposes
    // the body-frame angular velocity and is injected via `pushBodyAxisTorque`.
    const tPitch = -(c.pitchLinear * wPitch + c.pitchQuad * Math.abs(wPitch) * wPitch);
    const tYaw = -(c.yawLinear * wYaw + c.yawQuad * Math.abs(wYaw) * wYaw);
    const tRoll = -(c.rollLinear * wRoll + c.rollQuad * Math.abs(wRoll) * wRoll);

    // Assemble the body torque (x=pitch about body X, y=yaw about Y, z=roll about Z).
    _torqueBody.x = tPitch;
    _torqueBody.y = tYaw;
    _torqueBody.z = tRoll;

    if (Math.abs(tPitch) > 1e-6 || Math.abs(tYaw) > 1e-6 || Math.abs(tRoll) > 1e-6) {
      // World-space centre of mass for the couple.
      rotateVec3(orientation, ctx.boat.centreOfMass, _worldCoM);
      addScaled3(_worldCoM, p, 1);
      pushBodyAxisTorque(_torqueBody, orientation, _worldCoM, out);
    }

    // Linear hydrodynamic damping on the hull's translational velocity,
    // decomposed in the BODY frame so SWAY (lateral) can be damped far harder
    // than SURGE (fore-aft) — which is the real hydrodynamics AND the fix for
    // the leeway runaway. A hull + daggerboard sweeping SIDEWAYS through the
    // water has a very large added mass and broadside drag (it is essentially a
    // flat plate edge-on to the sideways flow), so lateral motion is strongly
    // damped; fore-aft motion is streamlined and lightly damped. The old model
    // lumped both into one small `surgeLinear` (=12) applied to world x AND z,
    // leaving SWAY almost undamped. With a stiff foil that was the direct cause
    // of the wave-triggered LEEWAY RUNAWAY: a small wave-induced leeway spike
    // produced a large foil side force, accelerating the hull sideways with
    // almost no damping, overshooting into foil stall, from which the leeway/
    // speed loop never recovered (speed collapsed to ~1 kt at 50°+ leeway — the
    // real-game defect). Damping sway hard critically damps that sway mode so
    // the hull settles at its small (~2–4°) equilibrium leeway and holds it
    // through chop, WITHOUT eating forward speed (surge stays light at 12).
    // Heave (y, vertical) is damped by `heaveLinear`. Rotation-invariant: the
    // body-frame decomposition uses the orientation quaternion.
    const v = ctx.state.linearVelocity;
    // Body horizontal axes in world space (forward = −Z_body, starboard = +X_body).
    rotateVec3(orientation, FWD_BODY, _fwd);
    rotateVec3(orientation, STARBOARD_BODY, _stbd);
    // Project horizontal velocity onto forward/starboard (ignore their tiny y
    // tilt when heeled — the heave term owns vertical; this keeps the damping a
    // pure horizontal surge/sway split).
    const vSurge = v.x * _fwd.x + v.z * _fwd.z; // along the bow
    const vSway = v.x * _stbd.x + v.z * _stbd.z; // athwartships
    const fSurge = -c.surgeLinear * vSurge;
    const fSway = -(c.swayLinear ?? c.surgeLinear) * vSway;
    const fx = fSurge * _fwd.x + fSway * _stbd.x;
    const fy = -c.heaveLinear * v.y;
    const fz = fSurge * _fwd.z + fSway * _stbd.z;
    if (Math.abs(fx) > 1e-6 || Math.abs(fy) > 1e-6 || Math.abs(fz) > 1e-6) {
      out.push({ force: { x: fx, y: fy, z: fz }, point: { x: p.x, y: p.y, z: p.z } });
    }
  }
}

/**
 * Default hydrodynamic damping for a small single-handed dinghy (ILCA-scale).
 *
 * Roll is damped near its critical value: the daggerboard (~0.8 m span) and
 * topsides sweep a large area broadside as the boat rolls. Calibrated jointly
 * with the DESIGN-DRAFT buoyancy fix (see Buoyancy.ts): once the hull floats at
 * its design draft the roll restoring is physically correct (GM ≈ 1.4 m, roll
 * inertia incl. added mass ≈ 195 kg·m² → critical roll damping
 * 2·√(I·k) ≈ 1200 N·m·s/rad). The previous value (5000) was ~4× critical — an
 * empirical crutch from the DEEP-SINK era that, with the hull now floating
 * correctly, over-damped roll so hard the 25 kt cleated-no-hike knockdown could
 * no longer complete within 20 s (it settled ~31°). Set to ~1.7× critical:
 * enough that a dinghy's roll is strongly (not critically) damped and does not
 * ring, but a sustained overpowering gust still rolls it past the capsize angle
 * in a few seconds (25 kt cleated → capsize ~2–3 s) while a full-hike eased
 * sheet holds 12 kt flat. Verified against the capsize-contrast + 200 s soaks.
 * (Larsson, "Principles of Yacht Design": roll damping of a shallow beamy hull
 * with an immersed foil is large but not many multiples of critical.)
 */
export const DINGHY_HYDRO_DAMPING: HydrodynamicDampingConfig = {
  rollLinear: 2000,
  rollQuad: 1000,
  pitchLinear: 450,
  pitchQuad: 250,
  yawLinear: 220,
  yawQuad: 120,
  heaveLinear: 300,
  // SURGE (fore-aft): deliberately SMALL. HydroResistance (friction + residuary
  // + induced) and WaveDrag already supply the real through-water drag along
  // the bow; this term exists only so a passive, un-forced hull settles its
  // fore-aft drift rather than coasting forever. Kept light so it does not eat
  // sailing speed (a large value — an earlier crutch used 120 — silently ate
  // ~350 N at 5 kt, the "it crabs and never goes" symptom).
  surgeLinear: 12,
  // SWAY (athwartships): LARGE. A hull + daggerboard moving sideways is a flat
  // plate edge-on with huge added mass and broadside drag, so lateral motion is
  // strongly damped in reality. This critically damps the leeway (sway) mode:
  // without it the stiff foil + near-zero sway damping made the leeway/speed
  // loop violently underdamped, so a wave-induced leeway spike overshot into
  // foil stall and the boat crabbed off at 50°+ leeway / ~1 kt (the real-game
  // defect). Sized to roughly critically damp the sway mode (foil side-force
  // "stiffness" ~ a few hundred N/° at sailing speed on ~133 kg) so the hull
  // holds its small (~2–4°) equilibrium leeway through chop. It opposes ONLY
  // lateral motion, so it does NOT touch forward speed.
  swayLinear: 600,
};
