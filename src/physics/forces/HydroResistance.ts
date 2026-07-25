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
    const { state, boat, environment, time, waterDensity } = ctx;
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
    const fn = froudeNumber(speed, lwl);
    const cr = sampleCurve(boat.residuaryCurve, fn);
    // Residuary is typically given as a coefficient times dynamic pressure on waterplane.
    const residuaryR = 0.5 * waterDensity * wettedSurface * speed * speed * cr;

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
    const waveR = addedResistanceInWaves(environment, position, heading, speed, lwl, time);

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
 * Added resistance in waves — the extra drag from the hull slamming through
 * oncoming seas. Proportional to significant wave height squared, modulated by
 * encounter frequency and relative heading.
 *
 * In a head sea the encounter frequency is high and the boat hits every wave;
 * running downwind the encounter is low and the boat surfs with the waves.
 */
function addedResistanceInWaves(
  environment: ForceContext['environment'],
  _position: Vec3,
  heading: number,
  speed: number,
  lwl: number,
  _time: number,
): number {
  const hs = environment.waves.params.significantHeight;
  if (hs < 0.05) return 0; // Calm water.

  // Wave encounter angle: angle between wave direction (FROM) and boat heading.
  // Head sea = waves coming from ahead = 0° relative.
  const waveDir = environment.waves.params.windDirection; // FROM direction
  const encounterAngle = Math.abs(waveDir - heading);
  // Cos of encounter: 1 in head sea, -1 in following sea.
  const cosEncounter = Math.cos(encounterAngle);

  // Added resistance is greatest in a head sea and minimal running downwind.
  // Simple empirical formula scaled by hull size.
  const headSeaFactor = clamp((1 + cosEncounter) * 0.5, 0, 1); // 1 = head sea, 0 = following

  // Encounter frequency modulation: short steep waves at high speed are worse.
  const wavePeriod = environment.waves.params.swellPeriod || 6;
  const waveFreq = (2 * Math.PI) / wavePeriod;
  // Encounter freq = wave freq * (1 + speed * cos(encounter) / wave celerity)
  const celerity = PHYSICS_CONSTANTS.GRAVITY / waveFreq; // Deep water approximation
  const encounterMod = clamp(1 + (speed * cosEncounter) / Math.max(celerity, 1), 0.3, 3);

  // Scale by waterplane area (wider boats catch more wave energy).
  const waterplaneScale = lwl * 0.3; // Rough beam estimate
  const rawResistance = 0.5 * 1025 * waterplaneScale * hs * hs * headSeaFactor * encounterMod;

  // Reduce for small boats that ride over waves rather than plowing through.
  const sizeFactor = clamp(lwl / 12, 0.3, 1.5);
  return rawResistance * sizeFactor;
}
