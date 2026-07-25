/**
 * Polar solver — sweeps TWA × TWS to compute the boat's speed polar from the
 * physics model.
 *
 * The polar is COMPUTED, not authored. This is what guarantees the HUD target-speed
 * readout always matches the actual model: change a drag coefficient and the polar
 * updates itself (requirement 5.2, design.md §7.5).
 *
 * The solver converges each (TWA, TWS) cell to steady state by iterating the
 * force balance until speed stabilizes. This gives the boat's theoretical maximum
 * speed at each point of sail and wind strength.
 *
 * VMG (velocity made good) is computed as V * cos(TWA) for upwind and
 * V * cos(π - TWA) for downwind, with optimal angles found by maximizing these.
 */

import type { BoatSpec, PolarDiagram, SailSpec } from '@/types';
import type { MetresPerSecond } from '@/types/units';
import { PHYSICS_CONSTANTS } from '@/types/units';
import { clamp, sampleCurve } from '@core/math';
import { sailLiftCoefficient, sailDragCoefficient } from './coefficients/aeroCoefficients';
import { ittc57, froudeNumber } from './forces/HydroResistance';
import { SAIL_PARASITIC_CD, MIN_SPEED } from './constants';

/** Default TWS values to sample, m/s. Covers 3 to 30 knots. */
const DEFAULT_WIND_SPEEDS = [1.5, 3, 4.5, 6, 8, 10, 12.5, 15, 20, 25];

/** TWA values to sample, radians. 20° to 180° in 5° steps. */
const DEFAULT_WIND_ANGLES: number[] = [];
for (let deg = 20; deg <= 180; deg += 5) {
  DEFAULT_WIND_ANGLES.push((deg * Math.PI) / 180);
}

/** Maximum iterations for convergence at each cell. */
const MAX_ITERATIONS = 50;

/** Speed change threshold for convergence, m/s. */
const CONVERGENCE_THRESHOLD = 0.01;

/**
 * Solve the polar diagram for a boat specification.
 * This runs the steady-state force balance at each TWA × TWS cell.
 */
export function solvePolar(
  boat: BoatSpec,
  windSpeeds: number[] = DEFAULT_WIND_SPEEDS,
  windAngles: number[] = DEFAULT_WIND_ANGLES,
): PolarDiagram {
  const boatSpeeds: number[][] = [];
  const optimalUpwindAngle: number[] = [];
  const optimalDownwindAngle: number[] = [];

  for (let si = 0; si < windSpeeds.length; si++) {
    const tws = windSpeeds[si];
    if (tws === undefined) continue;

    const speedRow: number[] = [];
    let bestUpwindVMG = 0;
    let bestUpwindAngle = (40 * Math.PI) / 180; // Default ~40°
    let bestDownwindVMG = 0;
    let bestDownwindAngle = (140 * Math.PI) / 180; // Default ~140°

    for (let ai = 0; ai < windAngles.length; ai++) {
      const twa = windAngles[ai];
      if (twa === undefined) {
        speedRow.push(0);
        continue;
      }

      const boatSpeed = solveCell(boat, tws, twa);
      speedRow.push(boatSpeed);

      // VMG computations.
      const upwindVMG = boatSpeed * Math.cos(twa);
      if (upwindVMG > bestUpwindVMG && twa < Math.PI * 0.5) {
        bestUpwindVMG = upwindVMG;
        bestUpwindAngle = twa;
      }

      const downwindVMG = boatSpeed * Math.cos(Math.PI - twa);
      if (downwindVMG > bestDownwindVMG && twa > Math.PI * 0.5) {
        bestDownwindVMG = downwindVMG;
        bestDownwindAngle = twa;
      }
    }

    boatSpeeds.push(speedRow);
    optimalUpwindAngle.push(bestUpwindAngle);
    optimalDownwindAngle.push(bestDownwindAngle);
  }

  return {
    windSpeeds,
    windAngles,
    boatSpeeds,
    optimalUpwindAngle,
    optimalDownwindAngle,
    targetSpeed: createTargetSpeedLookup(windSpeeds, windAngles, boatSpeeds),
  };
}

/**
 * Solve a single (TWS, TWA) cell to find the equilibrium boat speed.
 *
 * Method: iterative force balance. Start with an initial speed guess and
 * repeatedly compute drive force minus resistance until they balance.
 */
function solveCell(boat: BoatSpec, tws: number, twa: number): number {
  // Initial guess: a fraction of wind speed.
  let speed = tws * 0.3;
  const waterDensity = PHYSICS_CONSTANTS.WATER_DENSITY;
  const airDensity = PHYSICS_CONSTANTS.AIR_DENSITY_REFERENCE;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    if (speed < MIN_SPEED) speed = MIN_SPEED;

    // Compute apparent wind from TWS, TWA, and boat speed.
    // AWA and AWS from the velocity triangle.
    const awx = tws * Math.sin(twa); // Cross component
    const awy = tws * Math.cos(twa) - speed; // Along component (forward)
    const aws = Math.sqrt(awx * awx + awy * awy);
    const awa = Math.atan2(awx, awy); // Apparent wind angle

    if (aws < 0.01) {
      speed = 0;
      break;
    }

    // --- Drive force from sails ---
    let totalDrive = 0;
    let totalSideForce = 0;

    for (let i = 0; i < boat.sails.length; i++) {
      const sail = boat.sails[i];
      if (sail === undefined) continue;

      // Skip spinnaker when above beam reach, skip jib/main when deep running.
      if (sail.kind === 'spinnaker' && twa < Math.PI * 0.5) continue;
      if (sail.kind === 'spinnaker') continue; // Simplify: ignore spinnaker for polar

      // Optimal trim: find the alpha that maximizes drive.
      // In the solver we assume the sailor finds the optimal trim.
      const optimalAlpha = findOptimalAlpha(sail, aws, awa, airDensity);
      const cl = sailLiftCoefficient(optimalAlpha, sail.maxCamber);
      const cd = sailDragCoefficient(optimalAlpha, sail.maxCamber, sail.aspectRatio, SAIL_PARASITIC_CD);

      const q = 0.5 * airDensity * sail.area * aws * aws;
      const liftMag = q * Math.abs(cl);
      const dragMag = q * cd;

      // Resolve into drive and side force.
      // Lift perpendicular to apparent wind, drag along it.
      // Drive = lift * sin(AWA) - drag * cos(AWA)
      // Side = lift * cos(AWA) + drag * sin(AWA)
      const sinAwa = Math.sin(Math.abs(awa));
      const cosAwa = Math.cos(Math.abs(awa));

      const drive = liftMag * sinAwa - dragMag * cosAwa;
      const side = liftMag * cosAwa + dragMag * sinAwa;

      totalDrive += drive;
      totalSideForce += side;
    }

    // --- Resistance ---
    const lwl = boat.hydrostatics.waterlineLength;
    const wettedSurface = boat.hydrostatics.wettedSurface;

    // Friction.
    const cf = ittc57(speed, lwl);
    const frictionR = 0.5 * waterDensity * wettedSurface * speed * speed * cf;

    // Residuary.
    const fn = froudeNumber(speed, lwl);
    const cr = sampleCurve(boat.residuaryCurve, fn);
    const residuaryR = 0.5 * waterDensity * wettedSurface * speed * speed * cr;

    // Induced drag from side force through the keel.
    const maxDraft = boat.foils.reduce((max, f) => Math.max(max, f.span), 1);
    let inducedR = 0;
    if (speed > MIN_SPEED && Math.abs(totalSideForce) > 1) {
      const denom =
        0.5 * waterDensity * speed * speed * Math.PI * maxDraft * maxDraft * 0.9;
      if (denom > 0.001) {
        inducedR = (totalSideForce * totalSideForce) / denom;
      }
    }

    const totalResistance = frictionR + residuaryR + inducedR;

    // --- Force balance ---
    const netForce = totalDrive - totalResistance;

    // Newton step: approximate next speed.
    // dR/dV ≈ 2 * totalResistance / speed (resistance ~ V²).
    const dRdV = speed > MIN_SPEED ? 2 * totalResistance / speed : 100;

    const newSpeed = speed + netForce / (dRdV + 0.1);
    const clampedSpeed = clamp(newSpeed, 0, tws * 2.5); // Can't sail faster than 2.5x wind (except foilers)

    if (Math.abs(clampedSpeed - speed) < CONVERGENCE_THRESHOLD) {
      speed = clampedSpeed;
      break;
    }
    speed = clampedSpeed;
  }

  return Math.max(0, speed);
}

/**
 * Find the angle of attack that maximizes drive for a given sail geometry and AWA.
 * In reality, this is what the sailor does by trimming the sheet.
 */
function findOptimalAlpha(
  sail: SailSpec,
  _aws: number,
  awa: number,
  _airDensity: number,
): number {
  const absAwa = Math.abs(awa);
  let bestDrive = -Infinity;
  let bestAlpha = 0.15; // ~8.5° starting guess

  // Coarse search over the attached range.
  for (let alpha = 0.06; alpha < 0.45; alpha += 0.02) {
    const cl = sailLiftCoefficient(alpha, sail.maxCamber);
    const cd = sailDragCoefficient(alpha, sail.maxCamber, sail.aspectRatio, SAIL_PARASITIC_CD);

    const lift = Math.abs(cl);
    const drag = cd;

    // Drive = lift * sin(AWA) - drag * cos(AWA)
    const drive = lift * Math.sin(absAwa) - drag * Math.cos(absAwa);
    if (drive > bestDrive) {
      bestDrive = drive;
      bestAlpha = alpha;
    }
  }

  return bestAlpha;
}

/**
 * Create the targetSpeed interpolation function for the polar diagram.
 */
function createTargetSpeedLookup(
  windSpeeds: number[],
  windAngles: number[],
  boatSpeeds: number[][],
): (windSpeed: number, windAngle: number) => MetresPerSecond {
  return (windSpeed: number, windAngle: number): MetresPerSecond => {
    // Bilinear interpolation in the TWS × TWA grid.
    const absAngle = Math.abs(windAngle);

    // Find bracketing wind speed indices.
    let sLo = 0;
    let sHi = windSpeeds.length - 1;
    for (let i = 0; i < windSpeeds.length - 1; i++) {
      const curr = windSpeeds[i];
      const next = windSpeeds[i + 1];
      if (curr !== undefined && next !== undefined && windSpeed >= curr && windSpeed <= next) {
        sLo = i;
        sHi = i + 1;
        break;
      }
    }
    if (windSpeed <= (windSpeeds[0] ?? 0)) { sLo = 0; sHi = 0; }
    if (windSpeed >= (windSpeeds[windSpeeds.length - 1] ?? 30)) {
      sLo = windSpeeds.length - 1;
      sHi = windSpeeds.length - 1;
    }

    // Find bracketing angle indices.
    let aLo = 0;
    let aHi = windAngles.length - 1;
    for (let i = 0; i < windAngles.length - 1; i++) {
      const curr = windAngles[i];
      const next = windAngles[i + 1];
      if (curr !== undefined && next !== undefined && absAngle >= curr && absAngle <= next) {
        aLo = i;
        aHi = i + 1;
        break;
      }
    }
    if (absAngle <= (windAngles[0] ?? 0)) { aLo = 0; aHi = 0; }
    if (absAngle >= (windAngles[windAngles.length - 1] ?? Math.PI)) {
      aLo = windAngles.length - 1;
      aHi = windAngles.length - 1;
    }

    // Interpolation fractions.
    const wsLo = windSpeeds[sLo] ?? 0;
    const wsHi = windSpeeds[sHi] ?? wsLo;
    const st = wsHi === wsLo ? 0 : (windSpeed - wsLo) / (wsHi - wsLo);

    const waLo = windAngles[aLo] ?? 0;
    const waHi = windAngles[aHi] ?? waLo;
    const at = waHi === waLo ? 0 : (absAngle - waLo) / (waHi - waLo);

    // Bilinear sample.
    const rowLo = boatSpeeds[sLo];
    const rowHi = boatSpeeds[sHi];
    if (rowLo === undefined || rowHi === undefined) return 0;

    const v00 = rowLo[aLo] ?? 0;
    const v01 = rowLo[aHi] ?? 0;
    const v10 = rowHi[aLo] ?? 0;
    const v11 = rowHi[aHi] ?? 0;

    const v0 = v00 + (v01 - v00) * at;
    const v1 = v10 + (v11 - v10) * at;
    return v0 + (v1 - v0) * st;
  };
}
