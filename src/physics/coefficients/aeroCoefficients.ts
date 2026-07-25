/**
 * Aerodynamic coefficient tables for sail forces.
 *
 * Models a thin cambered airfoil section — the class of shapes that includes
 * all soft sails. The key physics that must emerge:
 *
 * 1. Linear lift rise up to ~15-20° angle of attack.
 * 2. Rounded peak C_L ≈ 1.4–1.6 for a well-cambered sail.
 * 3. Post-stall decay — but NOT symmetrically: drag keeps climbing while lift falls.
 * 4. A low-alpha attachment threshold below which flow separates from the leeward
 *    side (luffing). This is NOT simply C_L → 0 at alpha = 0; there's a discrete
 *    onset because a sail must maintain a minimum pressure gradient to stay attached.
 *
 * The asymmetry between luffing and stall is what makes sail trim a skill:
 * - Over-eased → luffing → force collapses → boat slows AND flattens (obvious).
 * - Over-trimmed → stall → drag spikes, drive falls, but heel stays HIGH (deceptive).
 *
 * Players learn to feel this: the boat that heels a lot isn't necessarily fast.
 */

import { clamp, saturate } from '@core/math';

/** Minimum angle of attack for flow attachment (luffing threshold), radians. */
const LUFFING_ALPHA = 0.05; // ~3° — below this the sail luffs

/** Alpha at which C_L peaks before stall onset. */
const PEAK_ALPHA = 0.28; // ~16°

/** Post-stall alpha where flow is fully separated. */
const FULL_STALL_ALPHA = 0.52; // ~30°

/**
 * Compute the lift coefficient for a cambered sail section.
 *
 * The model is a composite of thin-airfoil theory (linear regime) and empirical
 * stall behaviour from Marchaj's "Aero-Hydrodynamics of Sailing" and Larsson's
 * "Principles of Yacht Design". Key features:
 *
 * 1. Linear rise at ~5 /rad (2π reduced by viscosity and finite span), offset
 *    by a camber-dependent zero-lift angle.
 * 2. Rounded peak near PEAK_ALPHA where boundary-layer separation begins on the
 *    suction side — the onset of stall.
 * 3. Post-stall decay to ~40% of peak, driven by progressive trailing-edge separation.
 *    Critically, stall is NOT symmetric with luffing: a stalled sail still produces
 *    side force (heel) even though drive collapses, because the drag component keeps
 *    the cross-flow loaded. This asymmetry is the central skill mechanic.
 *
 * @param alpha Angle of attack, radians (signed; absolute value used internally).
 * @param camber Maximum camber as a fraction of chord (0.05–0.15 typical).
 * @returns C_L, dimensionless. Zero below attachment; peaks then decays post-stall.
 */
export function sailLiftCoefficient(alpha: number, camber: number): number {
  const absAlpha = Math.abs(alpha);
  const sign = Math.sign(alpha) || 1;

  // Below attachment: flow cannot maintain pressure gradient on leeward side.
  if (absAlpha < LUFFING_ALPHA) {
    // Rapid collapse to zero as alpha drops below threshold.
    // This is NOT a gentle fade — a luffing sail produces almost nothing.
    const t = absAlpha / LUFFING_ALPHA;
    return t * t * 0.3 * camberScale(camber) * sign;
  }

  const maxCL = camberScale(camber);

  if (absAlpha <= PEAK_ALPHA) {
    // Linear lift build-up from luffing threshold to peak, shaped into a smooth
    // approach to maxCL near peak alpha. The lift slope in the truly linear portion
    // (below ~70% of peak) is governed by LIFT_SLOPE; above that, trailing-edge
    // separation progressively rounds the curve off to the peak.
    //
    // The effective slope accounts for camber's zero-lift offset: higher camber
    // means the CL at the luffing threshold is already nonzero, and the curve
    // reaches peak CL slightly sooner. But the geometric progression through the
    // attached region (luffing → peak) remains approximately linear.
    const range = PEAK_ALPHA - LUFFING_ALPHA; // Usable alpha range
    const t = (absAlpha - LUFFING_ALPHA) / range; // 0 at luff threshold, 1 at peak

    // C_L at the luffing threshold (just barely attached).
    const clAtLuff = maxCL * 0.15;

    // Pure linear interpolation with a cubic rounding near the peak to prevent
    // a slope discontinuity at stall onset. Below t ≈ 0.8 this is practically
    // linear; above that the cubic ease-out smoothly arrives at maxCL.
    const linearPortion = clAtLuff + (maxCL - clAtLuff) * t;
    // Cubic rounding: gently bends the last 30% toward the peak.
    const roundingOnset = 0.7;
    if (t < roundingOnset) {
      return linearPortion * sign;
    }
    // Ease from the linear value at roundingOnset into maxCL at t=1.
    const rt = (t - roundingOnset) / (1 - roundingOnset); // 0 → 1 in the rounded zone
    const ease = rt * rt * (3 - 2 * rt); // Hermite smoothstep
    const clAtOnset = clAtLuff + (maxCL - clAtLuff) * roundingOnset;
    const cl = clAtOnset + (maxCL - clAtOnset) * ease;
    return cl * sign;
  }

  // Post-stall decay: gradual — flow doesn't reattach instantly.
  // Decay follows a quadratic dropoff toward a residual "flat plate" lift.
  const stallProgress = saturate((absAlpha - PEAK_ALPHA) / (FULL_STALL_ALPHA - PEAK_ALPHA));
  // Decay to about 40% of max at full stall — a stalled sail still produces some force
  // but significantly less than the attached peak.
  const stalledCL = maxCL * (1 - 0.6 * stallProgress * stallProgress);
  return stalledCL * sign;
}

/**
 * Compute the drag coefficient for a cambered sail section.
 *
 * Three components:
 * 1. Parasitic (profile) drag — always present.
 * 2. Induced drag — proportional to C_L^2 / (π · AR).
 * 3. Separation drag — small when attached, rises steeply post-stall.
 *
 * The separation term is what makes over-trimming costly: drag spikes even though
 * the boat still heels (because side force persists from the remaining C_L).
 */
export function sailDragCoefficient(
  alpha: number,
  camber: number,
  aspectRatio: number,
  parasiticCd: number,
): number {
  const absAlpha = Math.abs(alpha);
  const cl = sailLiftCoefficient(absAlpha, camber);

  // Induced drag from finite span. Lower AR → more induced drag → less efficient pointing.
  const inducedCd = (cl * cl) / (Math.PI * aspectRatio);

  // Separation drag: negligible in the linear region, climbs steeply once stalled.
  let separationCd = 0;
  if (absAlpha > PEAK_ALPHA) {
    const stallProgress = saturate((absAlpha - PEAK_ALPHA) / (FULL_STALL_ALPHA - PEAK_ALPHA));
    // Separation drag can exceed the entire lift — this is why stall kills speed.
    separationCd = 0.8 * stallProgress * stallProgress;
  } else if (absAlpha < LUFFING_ALPHA) {
    // Luffing also produces parasitic drag from flapping cloth.
    const luffProgress = 1 - absAlpha / LUFFING_ALPHA;
    separationCd = 0.3 * luffProgress;
  }

  return parasiticCd + inducedCd + separationCd;
}

/**
 * Compute the flow attachment factor (0 = fully separated / luffing, 1 = fully attached).
 * Used by the sail renderer to animate cloth flutter and by audio for luffing sound.
 */
export function attachmentFactor(alpha: number): number {
  const absAlpha = Math.abs(alpha);

  if (absAlpha < LUFFING_ALPHA) {
    // Below attachment: detached, luffing.
    return saturate(absAlpha / LUFFING_ALPHA);
  }
  if (absAlpha > PEAK_ALPHA) {
    // Above stall onset: progressively separating.
    const stallProgress = saturate((absAlpha - PEAK_ALPHA) / (FULL_STALL_ALPHA - PEAK_ALPHA));
    return 1 - 0.7 * stallProgress;
  }
  return 1;
}

/**
 * Whether the sail is luffing (alpha below attachment threshold).
 */
export function isLuffing(alpha: number): boolean {
  return Math.abs(alpha) < LUFFING_ALPHA;
}

/**
 * Scale peak C_L by camber. More camber → higher C_L_max but earlier stall onset.
 * A flat sail (camber 0.05) peaks around C_L 1.1; a deep sail (0.15) peaks near 1.6.
 *
 * Reference: Marchaj "Aero-Hydrodynamics of Sailing" Fig 6.12 — wind-tunnel data
 * shows CL_max ≈ 1.0 for a flat plate rising to ~1.6 for 12-15% cambered sections.
 * Linear interpolation within this range is adequate for a game.
 */
function camberScale(camber: number): number {
  return clamp(0.5 + camber * 10, 0.8, 1.7);
}

/**
 * Compute lift coefficient for a symmetric foil section (keel, rudder, daggerboard).
 *
 * Unlike sails, symmetric foils have zero lift at zero alpha and stall at a lower
 * angle (~12-15°). The stall here is what prevents a boat from pointing in irons:
 * at very low speed, the foil cannot generate enough side force at its limited alpha
 * before stalling, so the boat slides sideways.
 *
 * @param alpha Angle of attack (leeway angle), radians.
 * @param thickness Section thickness ratio (0.08–0.15 typical).
 */
export function foilLiftCoefficient(alpha: number, thickness: number): number {
  const absAlpha = Math.abs(alpha);

  // Symmetric NACA-style section: lift slope ~2π reduced by thickness and viscosity.
  const liftSlope = 5.8 - thickness * 8; // Thicker sections are less efficient.
  const stallAlpha = 0.22 - thickness * 0.3; // ~12° for a typical section.

  if (absAlpha <= stallAlpha) {
    return liftSlope * alpha; // Sign-preserving linear region.
  }

  // Post-stall: sharper than a sail because rigid sections don't deform to soften it.
  const peak = liftSlope * stallAlpha * Math.sign(alpha || 1);
  const stallProgress = saturate((absAlpha - stallAlpha) / 0.15);
  return peak * (1 - 0.5 * stallProgress);
}

/**
 * Drag coefficient for a symmetric foil section.
 */
export function foilDragCoefficient(
  alpha: number,
  thickness: number,
  aspectRatio: number,
): number {
  const absAlpha = Math.abs(alpha);
  const cl = foilLiftCoefficient(absAlpha, thickness);

  // Profile drag increases with thickness (boundary layer is thicker).
  const profileCd = 0.006 + thickness * 0.04;

  // Induced drag from finite aspect ratio.
  const inducedCd = (cl * cl) / (Math.PI * aspectRatio * DEFAULT_FOIL_EFFICIENCY_LOCAL);

  // Separation drag post-stall.
  const stallAlpha = 0.22 - thickness * 0.3;
  let separationCd = 0;
  if (absAlpha > stallAlpha) {
    const stallProgress = saturate((absAlpha - stallAlpha) / 0.15);
    separationCd = 0.5 * stallProgress * stallProgress;
  }

  return profileCd + inducedCd + separationCd;
}

const DEFAULT_FOIL_EFFICIENCY_LOCAL = 0.9;
