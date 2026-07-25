/**
 * Aerodynamic force generator — the sail plan's contribution to drive, heel, and yaw.
 *
 * Physics rationale for key decisions:
 *
 * - Apparent wind is computed at each sail's centre-of-effort HEIGHT, not at deck
 *   level. A taller rig genuinely sees more wind due to the atmospheric boundary
 *   layer power law. This is why a fractional-rig keelboat with a tall thin main
 *   outpoints a gaff rig of equal area (requirement 3.6).
 *
 * - The angle of attack includes a slot effect between main and headsail: the jib
 *   accelerates flow over the main's leeward side, effectively increasing the
 *   main's alpha before stall. Trimming them together is not cosmetic — it is load-bearing.
 *
 * - Two distinct failure modes are physically real, not cosmetic:
 *   (a) Over-eased → alpha below attachment → force COLLAPSES → boat flattens.
 *   (b) Over-trimmed → alpha past separation → drag spikes, drive falls, but HEEL
 *       STAYS HIGH because the cross-flow component doesn't vanish at stall.
 *   This asymmetry is the central skill of sailing and the model MUST reproduce it.
 */

import type {
  AppliedForce,
  BoatSpec,
  ForceContext,
  ForceGenerator,
  SailSpec,
} from '@/types';
import type { Vec3 } from '@/types/units';
import {
  vec3,
  set3,
  sub3,
  cross3,
  dot3,
  length3,
  normalize3,
  addScaled3,
  zero3,
} from '@core/math';
import { clamp } from '@core/math';
import {
  sailLiftCoefficient,
  sailDragCoefficient,
  attachmentFactor,
  isLuffing,
} from '../coefficients/aeroCoefficients';
import { SAIL_PARASITIC_CD, SLOT_EFFECT_ALPHA_BONUS, MIN_APPARENT_WIND } from '../constants';

/**
 * Per-sail aerodynamic state, exposed for rendering (cloth animation) and audio (luffing sound).
 * These are updated every physics step.
 */
export interface SailAeroState {
  readonly sailId: string;
  /** 0 = fully separated/luffing, 1 = fully attached flow. */
  attachment: number;
  /** True when alpha is below the luffing threshold. */
  luffing: boolean;
  /** Current angle of attack, radians. */
  alpha: number;
  /** Lift coefficient being produced. */
  cl: number;
  /** Drag coefficient being produced. */
  cd: number;
  /** Drive force component (along boat's forward axis), newtons. */
  driveForce: number;
  /** Side force component (perpendicular to forward, in the waterplane), newtons. */
  sideForce: number;
  /** Heeling moment from this sail, newton-metres. Positive heels to starboard. */
  heelingMoment: number;
}

// --- Scratch vectors (module scope, reused every frame to avoid allocation) ---
const _apparentWind: Vec3 = vec3();
const _omegaCross: Vec3 = vec3();
const _coeWorld: Vec3 = vec3();
const _liftDir: Vec3 = vec3();
const _dragDir: Vec3 = vec3();
const _forceVec: Vec3 = vec3();
const _pointVec: Vec3 = vec3();
const _forward: Vec3 = vec3();
const _right: Vec3 = vec3();
const _windNorm: Vec3 = vec3();

export class AeroForce implements ForceGenerator {
  readonly id = 'aero';

  /** Per-sail state exposed for rendering and audio. */
  readonly sailStates: SailAeroState[];

  /** Total yaw moment from all sails, N·m. Positive turns bow to starboard. */
  yawMoment = 0;

  constructor(spec: BoatSpec) {
    this.sailStates = spec.sails.map((sail) => ({
      sailId: sail.id,
      attachment: 1,
      luffing: false,
      alpha: 0,
      cl: 0,
      cd: 0,
      driveForce: 0,
      sideForce: 0,
      heelingMoment: 0,
    }));
  }

  evaluate(ctx: ForceContext, out: AppliedForce[]): void {
    const { state, boat, environment, time, airDensity } = ctx;
    const { linearVelocity, angularVelocity, controls, heading } = state;

    // Boat forward direction from heading (bow points along the heading bearing).
    // World: +X east, +Z south. bearing θ → (sin θ, 0, -cos θ)
    set3(_forward, Math.sin(heading), 0, -Math.cos(heading));
    // Right is perpendicular in the waterplane (starboard). Forward × Up = Right.
    // Actually: right = (cos heading, 0, sin heading) for Y-up right-handed.
    set3(_right, Math.cos(heading), 0, Math.sin(heading));

    this.yawMoment = 0;

    // Determine if slot effect applies: need both a main and a headsail active.
    const hasMain = boat.sails.some((s) => s.kind === 'main');
    const hasHeadsail = boat.sails.some(
      (s) => (s.kind === 'jib' || s.kind === 'genoa') && controls.jibsheet > 0.05,
    );
    const slotActive = hasMain && hasHeadsail;

    for (let i = 0; i < boat.sails.length; i++) {
      const sail = boat.sails[i];
      if (sail === undefined) continue;

      const sailState = this.sailStates[i];
      if (sailState === undefined) continue;

      // Skip doused sails.
      if (sail.kind === 'spinnaker' && controls.spinnaker < 0.05) {
        sailState.attachment = 0;
        sailState.luffing = true;
        sailState.alpha = 0;
        sailState.cl = 0;
        sailState.cd = 0;
        sailState.driveForce = 0;
        sailState.sideForce = 0;
        sailState.heelingMoment = 0;
        continue;
      }

      // --- Apparent wind at the sail's centre of effort ---
      // Sample true wind at CoE height for boundary-layer shear.
      const coeHeight = sail.centreOfEffortHeight;
      const windSample = environment.wind.sample(
        state.position.x,
        state.position.z,
        coeHeight,
        time,
      );

      // Compute the boat's velocity at the CoE point (includes rotation).
      // CoE position in world space is approximated: centre of mass + height offset.
      set3(_coeWorld, 0, coeHeight, 0);
      cross3(angularVelocity, _coeWorld, _omegaCross);
      // V_apparent = V_trueWind - V_boat - ω × r_CoE
      sub3(windSample.velocity, linearVelocity, _apparentWind);
      _apparentWind.x -= _omegaCross.x;
      _apparentWind.y -= _omegaCross.y;
      _apparentWind.z -= _omegaCross.z;

      const apparentSpeed = length3(_apparentWind);
      if (apparentSpeed < MIN_APPARENT_WIND) {
        sailState.attachment = 0;
        sailState.luffing = true;
        sailState.alpha = 0;
        sailState.cl = 0;
        sailState.cd = 0;
        sailState.driveForce = 0;
        sailState.sideForce = 0;
        sailState.heelingMoment = 0;
        continue;
      }

      // Normalize apparent wind direction.
      normalize3(_apparentWind, _windNorm);

      // --- Angle of attack ---
      // The apparent wind angle relative to the boat's centreline.
      const awaRaw = Math.atan2(
        dot3(_apparentWind, _right),
        dot3(_apparentWind, _forward),
      );

      // Sail trim angle from controls: how far the sail is eased from centreline.
      const trimAngle = getSailTrim(sail, controls);

      // Angle of attack = apparent wind angle - sail chord angle.
      // The chord is angled at (trimAngle) from the centreline on the leeward side.
      // AoA is the difference between wind direction and sail chord.
      let alpha = awaRaw - trimAngle * Math.sign(awaRaw);

      // Slot effect: main gets additional effective alpha when headsail is working.
      if (slotActive && sail.kind === 'main') {
        // The headsail bends the apparent wind, effectively increasing the main's alpha.
        const slotBonus = SLOT_EFFECT_ALPHA_BONUS * controls.jibsheet;
        alpha += slotBonus * Math.sign(alpha);
      }

      // Effective camber — vang tension reduces camber (flattens the sail for depower).
      const effectiveCamber = sail.maxCamber * (1 - 0.3 * controls.vang);

      // --- Coefficients ---
      const cl = sailLiftCoefficient(alpha, effectiveCamber);
      const cd = sailDragCoefficient(alpha, effectiveCamber, sail.aspectRatio, SAIL_PARASITIC_CD);
      const attachment = attachmentFactor(alpha);
      const luffing = isLuffing(alpha);

      // --- Force magnitude ---
      // F = 0.5 * rho * A * V^2 * C
      const dynamicPressure = 0.5 * airDensity * sail.area * apparentSpeed * apparentSpeed;

      // Lift is perpendicular to apparent wind, in the horizontal plane.
      // Drag is parallel to apparent wind direction.
      // Lift direction: rotate windNorm 90° in the waterplane.
      // (perpendicular in the XZ plane, sign based on which side of the sail)
      const liftSign = Math.sign(awaRaw) || 1;
      set3(_liftDir, -_windNorm.z * liftSign, 0, _windNorm.x * liftSign);

      // Drag direction: along apparent wind (the wind pushes the boat).
      set3(_dragDir, _windNorm.x, 0, _windNorm.z);

      // Total force = Lift * C_L + Drag * C_D, both in the apparent wind direction.
      const liftMag = dynamicPressure * Math.abs(cl);
      const dragMag = dynamicPressure * cd;

      zero3(_forceVec);
      addScaled3(_forceVec, _liftDir, liftMag);
      addScaled3(_forceVec, _dragDir, dragMag);

      // --- Resolve into boat axes ---
      const drive = dot3(_forceVec, _forward);
      const side = dot3(_forceVec, _right);

      // Heeling moment: side force × CoE height above the waterline.
      // Positive side force to starboard produces starboard heel moment.
      const heelMoment = side * coeHeight;

      // Yaw moment: force arm from the sail position relative to CLR.
      // Main is aft (positive yaw = weather helm), headsail is forward (negative).
      const yawArm = getSailYawArm(sail, boat);
      const sailYawMoment = side * yawArm;
      this.yawMoment += sailYawMoment;

      // --- Update exposed state ---
      sailState.attachment = attachment;
      sailState.luffing = luffing;
      sailState.alpha = alpha;
      sailState.cl = cl;
      sailState.cd = cd;
      sailState.driveForce = drive;
      sailState.sideForce = side;
      sailState.heelingMoment = heelMoment;

      // --- Emit the force ---
      // Application point is at the centre of effort (simplified to waterline + CoE height).
      set3(_pointVec, state.position.x, state.position.y + coeHeight, state.position.z);

      out.push({
        force: { x: _forceVec.x, y: _forceVec.y, z: _forceVec.z },
        point: { x: _pointVec.x, y: _pointVec.y, z: _pointVec.z },
      });
    }
  }
}

/**
 * Get the sheet angle for a given sail based on control state.
 * Returns the sail chord angle from centreline in radians.
 */
function getSailTrim(
  sail: SailSpec,
  controls: { mainsheet: number; jibsheet: number; spinnaker: number; traveller: number },
): number {
  let sheetPosition: number;
  switch (sail.kind) {
    case 'main':
      sheetPosition = controls.mainsheet;
      break;
    case 'jib':
    case 'genoa':
      sheetPosition = controls.jibsheet;
      break;
    case 'spinnaker':
    case 'code0':
      sheetPosition = controls.spinnaker;
      break;
    default:
      sheetPosition = 0.5;
  }

  // Sheet at 0 = fully eased (maxSheetAngle from centreline).
  // Sheet at 1 = fully trimmed (close to centreline).
  // Traveller shifts the base angle for the main.
  let baseAngle = sail.maxSheetAngle * (1 - sheetPosition);
  if (sail.kind === 'main') {
    // Traveller: -1 to port, +1 to starboard. Shifts the boom angle.
    baseAngle += controls.traveller * 0.1; // ~6° of traveller range
  }

  return clamp(baseAngle, 0, sail.maxSheetAngle);
}

/**
 * Get the yaw arm for a sail: distance of its centre of effort fore/aft of the
 * boat's centre of lateral resistance (approximated as centre of mass).
 * Positive = aft of CLR → weather helm contribution.
 */
function getSailYawArm(sail: SailSpec, boat: BoatSpec): number {
  // This is a simplification: ideally we'd use the exact fore-aft position of
  // each sail's CoE relative to the CLR. We approximate using sail kind.
  // Main is typically aft of centre, headsail forward.
  const lwl = boat.hydrostatics.waterlineLength;
  switch (sail.kind) {
    case 'main':
      return lwl * 0.1; // Aft of CLR
    case 'jib':
    case 'genoa':
      return -lwl * 0.15; // Forward of CLR
    case 'spinnaker':
    case 'code0':
      return -lwl * 0.3; // Well forward
    default:
      return 0;
  }
}
