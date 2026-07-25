/**
 * Righting moment — the force that keeps the boat upright.
 *
 * Sources of righting moment:
 * 1. Hull form stability — from the frozen Hydrostatics.rightingCurve, computed by
 *    sweeping the generated hull through heel angles. Wider boats have more initial
 *    stability; narrow deep-keeled boats have more reserve at high angles.
 * 2. Ballast — keel weight below the centre of buoyancy creates a pendulum effect.
 * 3. Crew weight — the most important dynamic control the player has in a dinghy.
 *    Hiking (moving crew mass to windward) is genuinely moving mass and MUST go
 *    through the same physics path for player and AI crew (requirement 5.4b).
 *
 * Capsize is EMERGENT: when the heeling moment from sails exceeds the maximum
 * righting moment on the curve, the boat inverts. Recovery requires the heeling
 * moment to drop (sails in the water produce no drive) and, for dinghies, crew
 * action (stepping on the board).
 */

import type { AppliedForce, ForceContext, ForceGenerator } from '@/types';
import type { Vec3 } from '@/types/units';
import { PHYSICS_CONSTANTS } from '@/types/units';
import { sampleCurve } from '@core/math';

export class RightingMoment implements ForceGenerator {
  readonly id = 'righting-moment';

  /** Whether the boat has capsized. Updated every step. */
  capsized = false;

  /** Recovery progress, 0..1. When it reaches 1, the boat rights itself. */
  recoveryProgress = 0;

  evaluate(ctx: ForceContext, out: AppliedForce[]): void {
    const { state, boat } = ctx;
    const { heel, position, controls } = state;

    const absHeel = Math.abs(heel);

    // --- Capsize detection ---
    if (absHeel >= boat.capsizeAngle && !this.capsized) {
      this.capsized = true;
      this.recoveryProgress = 0;
    }

    // --- Capsize recovery ---
    if (this.capsized) {
      // In a capsize, recovery happens when heel is past 90° (inverted) and
      // crew weight on the centreboard pulls it back, or when conditions ease.
      // Modelled as slow progress toward righting.
      this.recoveryProgress += ctx.dt * 0.15; // ~7 seconds to right

      if (this.recoveryProgress >= 1) {
        this.capsized = false;
        this.recoveryProgress = 0;
      }

      // During capsize, apply a damped restoring force toward 90° (lying on side).
      // This prevents the boat from going fully inverted (turtling) too quickly.
      const targetHeel = Math.PI * 0.5 * Math.sign(heel);
      const restoringMoment = (targetHeel - heel) * boat.mass * 2;
      applyRightingForce(restoringMoment, heel, position, out);
      return;
    }

    // --- Form stability from righting curve ---
    // The curve gives GZ (righting arm in metres) at each heel angle.
    // Righting moment = displacement * g * GZ(heel)
    const gz = sampleCurve(boat.hydrostatics.rightingCurve, absHeel);
    const formRighting = boat.hydrostatics.displacement * PHYSICS_CONSTANTS.GRAVITY * gz;

    // --- Ballast contribution ---
    // Ballast below CoB acts as a pendulum: moment = mass * g * arm * sin(heel).
    // The arm is the vertical distance from CoM to CoB (captured in the righting curve
    // for keelboats, but we add it explicitly for clarity and for cases where the
    // righting curve doesn't include it fully).
    // For keelboats this is already in the curve; for dinghies ballastMass is 0.
    // Skip explicit ballast to avoid double-counting with the curve.

    // --- Crew weight as movable mass ---
    // crewLateral: -1 (port) .. 1 (starboard)
    // hike: 0 (sitting in) .. 1 (fully extended)
    // The player and AI both write to these controls; the physics doesn't care who.
    const crewLateral = controls.crewLateral;
    const hikeEffort = controls.hike;

    // Crew arm = how far the crew mass is from centreline.
    // At max hike, crew is at the gunwale + extended (crewMovementRange.x gives half-beam).
    const maxArm = boat.crewMovementRange.x;
    const crewArm = crewLateral * maxArm * (0.4 + 0.6 * hikeEffort);

    // Crew righting moment: mass * g * arm * cos(heel)
    // cos(heel) because as the boat heels, the effective arm shortens.
    const crewRighting =
      boat.crewMass * boat.crewMovementRange.x > 0
        ? boat.crewMass * PHYSICS_CONSTANTS.GRAVITY * crewArm * Math.cos(heel)
        : 0;

    // --- Total righting ---
    // Form righting always opposes heel (restore to upright).
    // Crew righting is positive when crew is to windward (opposing heel).
    const heelSign = Math.sign(heel) || 1;
    const totalRighting = formRighting * heelSign + crewRighting;

    // The righting moment acts as a torque about the longitudinal axis.
    // We model it as a force couple: one force up on the windward side,
    // one force down on the leeward side, separated by some arm.
    applyRightingForce(-totalRighting, heel, position, out);
  }
}

/**
 * Apply a righting moment as a vertical force couple separated by 1m arm.
 * Negative moment = opposes positive heel.
 */
function applyRightingForce(
  moment: number,
  _heel: number,
  position: Vec3,
  out: AppliedForce[],
): void {
  if (Math.abs(moment) < 0.01) return;

  // Model as a vertical force applied at a lateral offset.
  // Moment = F * arm. We use arm = 1m for simplicity; F = moment / 1m.
  const force = moment; // N, applied at 1m offset

  // Apply upward on one side, downward on the other.
  // Force perpendicular to heel (vertical) to create roll torque.
  out.push({
    force: { x: 0, y: -force, z: 0 },
    point: { x: position.x + 0.5, y: position.y, z: position.z },
  });
  out.push({
    force: { x: 0, y: force, z: 0 },
    point: { x: position.x - 0.5, y: position.y, z: position.z },
  });
}
