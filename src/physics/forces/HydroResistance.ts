/**
 * Hull hydrodynamic resistance — the forces that slow the boat.
 *
 * Components:
 * 1. R_friction — viscous drag on the wetted surface (ITTC-57 correlation line).
 * 2. R_residuary — wavemaking resistance from the boat's residuary curve, rising
 *    steeply as Froude number approaches 0.4. This is the physics behind "hull speed":
 *    a displacement hull that tries to go faster must climb its own bow wave, so
 *    resistance rises with the cube of speed beyond Fn 0.35. Planing and foiling
 *    boats break through this wall because their hull lifts clear.
 * 3. R_induced — the keel/board's drag from generating side force to resist leeway.
 * 4. R_waves — added resistance in waves, proportional to Hs² and modulated by
 *    encounter frequency and heading. Sailing into chop is slow; running in swell
 *    is nearly free.
 */

import type { AppliedForce, ForceContext, ForceGenerator } from '@/types';
import type { Vec3 } from '@/types/units';
import { PHYSICS_CONSTANTS } from '@/types/units';
import { vec3, set3, normalize3 } from '@core/math';
import { clamp, sampleCurve } from '@core/math';
import { MIN_SPEED, DEFAULT_FOIL_EFFICIENCY } from '../constants';

// Scratch vectors — no allocation in the hot path.
const _velDir: Vec3 = vec3();
const _resistForce: Vec3 = vec3();

export class HydroResistance implements ForceGenerator {
  readonly id = 'hydro-resistance';

  /**
   * Set by FoilLift each step so induced drag can be computed.
   * This avoids circular dependency: FoilLift runs first, then HydroResistance
   * uses the total side force for induced drag.
   */
  totalSideForce = 0;

  evaluate(ctx: ForceContext, out: AppliedForce[]): void {
    const { state, boat, environment, waterDensity } = ctx;
    const { linearVelocity, heading, position } = state;

    const speed = state.speed;
    if (speed < MIN_SPEED) return;

    // Direction of motion through the water.
    normalize3(linearVelocity, _velDir);

    const hydro = boat.hydrostatics;
    const lwl = hydro.waterlineLength;
    const wettedSurface = hydro.wettedSurface;

    // --- 1. Frictional resistance (ITTC-57) ---
    const cf = ittc57(speed, lwl);
    const frictionR = 0.5 * waterDensity * wettedSurface * speed * speed * cf;

    // --- 2. Residuary resistance (wavemaking) ---
    // Froude/Delft convention: residuary resistance is non-dimensionalised by
    // the DISPLACEMENT WEIGHT, not by dynamic pressure on the wetted surface.
    //   R_r = C_r · ρ · g · ∇        (Larsson & Eliasson, "Principles of Yacht
    //                                  Design", Delft Systematic Yacht Series;
    //                                  the standard R_r/(ρ·g·∇) vs Fn form)
    // so `residuaryCurve[i].y` is the dimensionless ratio R_r/W at that Froude
    // number — a few percent near the Fn≈0.4 hump for a light planing dinghy,
    // easing as the hull lifts and planes.
    //
    // The previous formulation (0.5·ρ·S·V²·C_r) was dimensionally a drag
    // COEFFICIENT on wetted-surface dynamic pressure, which for this hull
    // produced R_r ≈ 190 N at 5 kt (≈14% of the 133 kg boat's displacement
    // weight) — physically impossible for a planing dinghy and the reason the
    // closed-loop sim stalled at ~2.5 kt against a wall of phantom wavemaking
    // drag while the real ILCA (and the computed polar at optimal trim) reach
    // 5–7 kt. With the displacement-weight form and the recalibrated dinghy
    // curve, total hull resistance at 5 kt is ~40–70 N (task-cited ILCA band;
    // consistent with the Chalmers Olympic-Laser CFD study order of magnitude).
    const fn = froudeNumber(speed, lwl);
    const cr = sampleCurve(boat.residuaryCurve, fn);
    const displacementWeight =
      boat.hydrostatics.displacement * PHYSICS_CONSTANTS.GRAVITY;
    let residuaryR = cr * displacementWeight;

    // High-Froude quadratic tail. The displacement-weight residuary above is
    // (correctly) a function of Fn only, so it does NOT grow with V² — which is
    // right at sailing speeds but removes the steep V²-growing brake that the
    // old wetted-surface form provided at EXTREME speed. In a 30–40 kt storm
    // soak the hull is driven far past hull speed; with no V² term the speed can
    // run up into a regime where the wave/slam couples diverge. Physically, past
    // the hump a planing hull DOES accrue fast-growing dynamic pressure, spray
    // and air drag (all ∝ V²). We add that only beyond the hump (Fn > 0.5), as a
    // small coefficient on wetted-surface dynamic pressure, so sailing-speed
    // resistance (Fn < 0.5) is untouched and the soak stays bounded. (Documented
    // high-speed closure term, not a tuning knob for the sailing polar.)
    if (fn > 0.5) {
      const over = fn - 0.5;
      const planingCd = 0.012 * over * over; // ramps in only well past hull speed.
      residuaryR += 0.5 * waterDensity * wettedSurface * speed * speed * planingCd;
    }

    // --- 3. Induced drag from side force ---
    // R_induced = sideForce² / (0.5 * rho * V² * π * draft² * e)
    const draft = hydro.waterlineBeam * 0.5; // Approximate effective draft
    const foilDraft = boat.foils.reduce((max, f) => Math.max(max, f.span), draft);
    const sideForce = this.totalSideForce;
    let inducedR = 0;
    if (Math.abs(sideForce) > 1 && speed > MIN_SPEED) {
      const denominator =
        0.5 * waterDensity * speed * speed * Math.PI * foilDraft * foilDraft * DEFAULT_FOIL_EFFICIENCY;
      if (denominator > 0.001) {
        inducedR = (sideForce * sideForce) / denominator;
      }
    }

    // --- 4. Added resistance in waves ---
    // A bounded, physically-calibrated INCREMENT: real added resistance for a
    // small dinghy in a Hs≈0.7 m sea is ~10–25% of the calm-water resistance
    // (higher beating into it, near zero running with it), NOT the +200–300% the
    // previous absolute formula produced close-hauled (which collapsed the boat
    // to ~1 kt in the real Newport sea — the reported defect). It is expressed as
    // a fraction of the calm friction+residuary resistance and clamped.
    const calmHullR = frictionR + residuaryR;
    const waveR = addedResistanceInWaves(environment, heading, speed, lwl, calmHullR);

    // --- Total resistance, opposing motion ---
    const totalR = frictionR + residuaryR + inducedR + waveR;

    // Resistance opposes the velocity direction.
    set3(_resistForce, -_velDir.x * totalR, -_velDir.y * totalR, -_velDir.z * totalR);

    out.push({
      force: { x: _resistForce.x, y: _resistForce.y, z: _resistForce.z },
      point: { x: position.x, y: position.y, z: position.z },
    });
  }
}

/**
 * ITTC-1957 friction coefficient.
 *
 * C_f = 0.075 / (log10(Re) - 2)²
 *
 * This is the international standard for ship model-to-full-scale extrapolation.
 * It represents the smooth flat-plate friction; real hulls add a roughness allowance,
 * but for a game that's already captured in the residuary curve calibration.
 */
export function ittc57(speed: number, waterlineLength: number): number {
  const nu = PHYSICS_CONSTANTS.WATER_KINEMATIC_VISCOSITY;
  const re = (speed * waterlineLength) / nu;

  if (re < 1e3) return 0.01; // Laminar / sub-critical — clamp to a safe value.

  const logRe = Math.log10(re);
  const denom = logRe - 2;
  if (denom <= 0) return 0.01; // Guard against degenerate case.

  return 0.075 / (denom * denom);
}

/**
 * Froude number: the ratio of boat speed to wave speed at waterline length.
 * Fn = V / sqrt(g * Lwl)
 *
 * At Fn ≈ 0.4 a displacement hull reaches its theoretical maximum speed because
 * its wavelength equals the waterline length and it sits in its own wave trough.
 * Beyond this, only planing lift or foiling can break through.
 */
export function froudeNumber(speed: number, waterlineLength: number): number {
  return speed / Math.sqrt(PHYSICS_CONSTANTS.GRAVITY * waterlineLength);
}

/**
 * Added resistance in waves — the extra drag from the hull working through a
 * seaway, as a BOUNDED FRACTION of the calm-water resistance.
 *
 * Physics + calibration. Added resistance in waves grows with Hs² and is
 * strongly heading-dependent (worst beating into a head sea, near zero running
 * with it). For a SMALL, light dinghy that rides over short wind-chop rather
 * than plowing through it, the measured added resistance at Hs≈0.7 m is modest —
 * on the order of 10–25 % of the calm resistance beating, tapering to ~0 running
 * (Bethwaite, "High Performance Sailing", ch. on waves & drag; this is an order-
 * of-magnitude engineering calibration, not a quoted coefficient).
 *
 * The PREVIOUS formula computed an ABSOLUTE force
 * (`0.5·ρ·lwl·0.3·Hs²·headSea·encounterMod·sizeFactor`) that, at the low
 * close-hauled speed and resistance of this dinghy, reached +200–300 % of the
 * calm resistance — it was the dominant term that collapsed the boat to ~1 kt in
 * the real Newport Hs 0.7 m sea (the reported defect). Here it is instead a
 * fraction of the calm hull resistance, Hs²-scaled, heading-weighted, and hard-
 * clamped to ≤ 35 % so a seaway slows the boat realistically without stopping it.
 *
 * @param calmHullR calm-water friction+residuary resistance, N (the baseline the
 *   added resistance is a fraction of).
 */
function addedResistanceInWaves(
  environment: ForceContext['environment'],
  heading: number,
  speed: number,
  lwl: number,
  calmHullR: number,
): number {
  const hs = environment.waves.params.significantHeight;
  if (hs < 0.05 || calmHullR <= 0) return 0; // Calm water / stationary.

  // Heading weight: 1 beating into a head sea, 0 running with it.
  const waveDir = environment.waves.params.windDirection; // FROM direction
  const cosEncounter = Math.cos(waveDir - heading);
  const headSeaFactor = clamp((1 + cosEncounter) * 0.5, 0, 1);

  // Hs² scaling normalised to a 1 m reference sea (so Hs 0.7 → 0.49).
  const hsScale = hs * hs;

  // A light dinghy rides over short chop: scale down for small LWL.
  const sizeFactor = clamp(lwl / 12, 0.25, 1);

  // Encounter-frequency bump: beating fast into short steep waves hurts a little
  // more, running is easier. Bounded and gentle.
  const wavePeriod = environment.waves.params.swellPeriod || 6;
  const celerity = (PHYSICS_CONSTANTS.GRAVITY * wavePeriod) / (2 * Math.PI);
  const encounterMod = clamp(1 + (0.5 * speed * cosEncounter) / Math.max(celerity, 1), 0.5, 1.6);

  // Fraction of the calm resistance. ADDED_RESISTANCE_K calibrated so a Hs 0.7 m
  // head sea adds ~15–25 % to the calm resistance for this dinghy (and a beam
  // reach ~10 %, a run ~0), matching the cited order of magnitude.
  const ADDED_RESISTANCE_K = 0.55;
  const fraction = ADDED_RESISTANCE_K * hsScale * headSeaFactor * encounterMod * sizeFactor;

  // Hard cap: a seaway never more than ~35 % of the calm resistance for a dinghy.
  const clampedFraction = clamp(fraction, 0, 0.35);
  return calmHullR * clampedFraction;
}
