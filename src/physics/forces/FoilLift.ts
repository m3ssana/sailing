/**
 * Foil lift — side force generation from keel, daggerboard, centreboard and rudder.
 *
 * Physics rationale:
 *
 * - Underwater foils resist leeway (sideways drift) by generating lift perpendicular
 *   to the flow. The "angle of attack" for a foil is the leeway angle: the difference
 *   between where the boat is heading and where it is actually going.
 *
 * - Effective aspect ratio falls with immersion: a half-raised centreboard loses
 *   lateral grip because the effective span is shorter. This is why you drop the
 *   board fully going upwind and raise it downwind (where you don't need side force).
 *
 * - Foils STALL at low speed — below a critical Reynolds number, the boundary layer
 *   separates and lift collapses. This is the physical reason the boat cannot point
 *   in irons: at near-zero speed, the keel/board cannot generate enough side force
 *   to prevent the boat sliding sideways. The no-go angle emerges from this.
 *
 * - The rudder is a steerable foil: its lift provides both directional control and
 *   a hydrodynamic moment. The rudder's load is exported as helm feel (requirement 5.7).
 */

import type { AppliedForce, ForceContext, ForceGenerator } from '@/types';
import type { Vec3 } from '@/types/units';
import { PHYSICS_CONSTANTS } from '@/types/units';
import { vec3, set3, dot3, normalize3 } from '@core/math';
import { saturate } from '@core/math';
import { foilLiftCoefficient, foilDragCoefficient } from '../coefficients/aeroCoefficients';
import { MIN_SPEED } from '../constants';

// Module-scope scratch vectors.
const _flowDir: Vec3 = vec3();
const _liftVec: Vec3 = vec3();
const _dragVec: Vec3 = vec3();
const _forceVec: Vec3 = vec3();
const _forwardDir: Vec3 = vec3();
const _rightDir: Vec3 = vec3();

export class FoilLift implements ForceGenerator {
  readonly id = 'foil-lift';

  /** Total side force generated this step, read by HydroResistance for induced drag. */
  totalSideForce = 0;

  /** Rudder hydrodynamic moment, N·m. Used for helm feel computation. */
  rudderMoment = 0;

  /** Total yaw moment from all foils (for helm load calculation). */
  totalYawMoment = 0;

  evaluate(ctx: ForceContext, out: AppliedForce[]): void {
    const { state, boat, waterDensity } = ctx;
    const { linearVelocity, heading, speed, controls } = state;

    this.totalSideForce = 0;
    this.rudderMoment = 0;
    this.totalYawMoment = 0;

    if (speed < MIN_SPEED) return;

    // Boat axes in world space.
    set3(_forwardDir, Math.sin(heading), 0, -Math.cos(heading));
    set3(_rightDir, Math.cos(heading), 0, Math.sin(heading));

    // Leeway angle: difference between heading and actual velocity direction.
    // Positive leeway = boat drifting to leeward (to starboard when on port tack).
    const velHeading = Math.atan2(linearVelocity.x, -linearVelocity.z);
    const leeway = heading - velHeading; // Positive = boat slips to starboard

    for (let i = 0; i < boat.foils.length; i++) {
      const foil = boat.foils[i];
      if (foil === undefined) continue;

      // Skip retracted foils.
      if (foil.retractable && controls.board < 0.05 && foil.kind !== 'rudder') continue;

      // Effective immersion: retractable foils have variable depth.
      const immersion = foil.retractable ? controls.board : 1;
      if (immersion < 0.01) continue;

      // Effective span and aspect ratio scale with immersion.
      const effectiveSpan = foil.span * immersion;
      const effectiveArea = foil.area * immersion;
      const effectiveAR = (effectiveSpan * effectiveSpan) / effectiveArea;

      // Angle of attack for this foil.
      let alpha: number;
      if (foil.steerable) {
        // Rudder: alpha is the rudder deflection relative to water flow.
        // Rudder angle is in boat coordinates; water flows at leeway angle.
        const rudderDeflection = controls.rudder * 0.6; // Max ~35° rudder
        alpha = leeway + rudderDeflection;
      } else {
        // Fixed foils: alpha is simply the leeway angle.
        alpha = leeway;
      }

      // Low-speed stall: below critical Reynolds number, flow cannot stay attached.
      // This is why the boat won't point in irons — at very low speed the foil
      // cannot generate the side force needed to resist leeway.
      const re = (speed * foil.chord) / PHYSICS_CONSTANTS.WATER_KINEMATIC_VISCOSITY;
      const lowSpeedFactor = saturate((re - 5e4) / 1e5); // Onset below Re ~150k

      // Lift and drag coefficients.
      const cl = foilLiftCoefficient(alpha, foil.thickness) * lowSpeedFactor;
      const cd = foilDragCoefficient(alpha, foil.thickness, effectiveAR);

      // Dynamic pressure.
      const q = 0.5 * waterDensity * effectiveArea * speed * speed;

      // Lift perpendicular to flow (opposes leeway), drag along flow.
      const liftMag = q * Math.abs(cl);
      const dragMag = q * cd;

      // Lift acts perpendicular to the velocity direction in the horizontal plane.
      // It opposes the leeway (pushes the boat back toward its heading).
      const liftSign = -Math.sign(cl); // Opposes leeway
      set3(_liftVec, _rightDir.x * liftSign, 0, _rightDir.z * liftSign);

      // Drag opposes motion.
      normalize3(linearVelocity, _flowDir);
      set3(_dragVec, -_flowDir.x, 0, -_flowDir.z);

      // Combine.
      set3(
        _forceVec,
        _liftVec.x * liftMag + _dragVec.x * dragMag,
        0,
        _liftVec.z * liftMag + _dragVec.z * dragMag,
      );

      // Track total side force for induced drag computation.
      const sideComp = dot3(_forceVec, _rightDir);
      this.totalSideForce += sideComp;

      // Yaw moment from this foil's position relative to centre of mass.
      // Foils aft of CoM (rudder) produce yaw when loaded.
      const yawArm = foil.position.z; // Z is positive aft in hull-local coords
      const yawMoment = sideComp * (-yawArm); // Negative z = forward, positive = aft
      this.totalYawMoment += yawMoment;

      if (foil.steerable) {
        this.rudderMoment = sideComp * Math.abs(yawArm);
      }

      // Application point: foil position in world space (approximate).
      const px = state.position.x + foil.position.x * Math.cos(heading) - foil.position.z * Math.sin(heading);
      const py = state.position.y + foil.position.y;
      const pz = state.position.z + foil.position.x * Math.sin(heading) + foil.position.z * Math.cos(heading);

      out.push({
        force: { x: _forceVec.x, y: _forceVec.y, z: _forceVec.z },
        point: { x: px, y: py, z: pz },
      });
    }
  }
}
