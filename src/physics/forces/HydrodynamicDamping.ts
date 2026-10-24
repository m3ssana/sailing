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
  /** Linear surge/sway damping (horizontal linear velocity), N per m/s. Small —
   *  enough to settle/stabilise, not so much it kills sailing speed. */
  surgeLinear: number;
}

/**
 * Applies hydrodynamic damping opposing the boat's angular and translational
 * velocity. Allocation-light (pushes a few plain force literals; the simulation
 * clears its force list each step). No shared module state.
 */
export class HydrodynamicDampingForceGenerator implements ForceGenerator {
  readonly id = 'hydrodynamic-damping';

  private readonly _cfg: HydrodynamicDampingConfig;

  constructor(cfg: HydrodynamicDampingConfig) {
    this._cfg = cfg;
  }

  evaluate(ctx: ForceContext, out: AppliedForce[]): void {
    const w: Vec3 = ctx.state.angularVelocity;
    const p = ctx.state.position;
    const c = this._cfg;

    // Damping moment per axis: −(lin·ω + quad·|ω|·ω). All OPPOSE the rotation.
    const mx = -(c.rollLinear * w.x + c.rollQuad * Math.abs(w.x) * w.x); // roll (about X)
    const my = -(c.yawLinear * w.y + c.yawQuad * Math.abs(w.y) * w.y); // yaw (about Y)
    const mz = -(c.pitchLinear * w.z + c.pitchQuad * Math.abs(w.z) * w.z); // pitch (about Z)

    // Inject each moment as a force couple about its axis with a 1 m lever.
    // The couple is chosen so the NET torque equals the target moment on that
    // axis. (These signs are verified by the net-torque unit test — an earlier
    // interim version had the YAW couple inverted, turning yaw damping into
    // ANTI-damping and driving a divergence to |ω_y|≈105 rad/s in ~1.2 s.)

    // Roll (about X): vertical forces offset in ±Z.
    //   τ_x = Σ r×F = (+0.5·ẑ)×(−mx·ŷ) + (−0.5·ẑ)×(+mx·ŷ) = +mx x̂.
    if (Math.abs(mx) > 1e-6) {
      out.push({ force: { x: 0, y: -mx, z: 0 }, point: { x: p.x, y: p.y, z: p.z + 0.5 } });
      out.push({ force: { x: 0, y: mx, z: 0 }, point: { x: p.x, y: p.y, z: p.z - 0.5 } });
    }
    // Pitch (about Z): vertical forces offset in ±X.
    //   τ_z = (+0.5·x̂)×(+mz·ŷ) + (−0.5·x̂)×(−mz·ŷ) = +mz ẑ.
    if (Math.abs(mz) > 1e-6) {
      out.push({ force: { x: 0, y: mz, z: 0 }, point: { x: p.x + 0.5, y: p.y, z: p.z } });
      out.push({ force: { x: 0, y: -mz, z: 0 }, point: { x: p.x - 0.5, y: p.y, z: p.z } });
    }
    // Yaw (about Y): horizontal (Z-directed) forces offset in ±X.
    //   τ_y = (+0.5·x̂)×(−my·ẑ) + (−0.5·x̂)×(+my·ẑ) = +my ŷ.
    //   (x̂×ẑ = −ŷ, so a +Z force at +X gives −Y torque; hence −my on the +X arm.)
    if (Math.abs(my) > 1e-6) {
      out.push({ force: { x: 0, y: 0, z: -my }, point: { x: p.x + 0.5, y: p.y, z: p.z } });
      out.push({ force: { x: 0, y: 0, z: my }, point: { x: p.x - 0.5, y: p.y, z: p.z } });
    }

    // Linear hydrodynamic damping on the hull's translational velocity. The hull
    // dragging through the water damps surge/sway/heave; without it (e.g. with
    // WaveDrag disabled) the conservative buoyancy↔weight restoring sets up an
    // essentially UNDAMPED heave oscillation that never settles. Heave (y) is
    // damped hardest (vertical hull motion sweeps the most water).
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
 * Default hydrodynamic damping for a small single-handed dinghy (ILCA-scale).
 *
 * Roll is damped hardest: the daggerboard (~0.8 m span) and topsides sweep a
 * large area broadside as the boat rolls. Calibrated so a release from ~15° heel
 * settles in ~3 s (slightly overdamped, matching a Laser) and a steady heeling
 * moment reaches a stable angle; verified to keep a full 200 s soak at 30–40 kt
 * in 1.5–5 m waves bounded and NaN-free with WaveDrag disabled.
 */
export const DINGHY_HYDRO_DAMPING: HydrodynamicDampingConfig = {
  // Roll is damped hardest: the daggerboard (0.78 m span) and the hull topsides
  // sweep a large area broadside as the boat rolls, and a dinghy's roll is in
  // reality strongly (near-critically) damped — it does not ring. Sized so a
  // release from heel settles in ~2–3 s and the boat resists a transient
  // knockdown long enough for the crew to hike, without being so stiff it feels
  // locked. (Larsson, "Principles of Yacht Design": roll damping of a shallow
  // beamy hull with an immersed foil is large.)
  rollLinear: 5000,
  rollQuad: 2500,
  pitchLinear: 450,
  pitchQuad: 250,
  yawLinear: 220,
  yawQuad: 120,
  heaveLinear: 300,
  // Surge/sway: deliberately SMALL. HydroResistance (friction + residuary +
  // induced) and WaveDrag already supply the real translational drag along the
  // direction of travel; this term exists only so a passive, un-forced hull
  // settles its sway/surge drift rather than coasting forever. A large value
  // (an earlier interim crutch used 120) silently ate ~350 N at 5 kt and
  // prevented the boat from ever building sailing speed — the "it crabs and
  // never goes" symptom. Kept light enough to be negligible against drive.
  surgeLinear: 12,
};
