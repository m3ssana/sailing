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
 *
 * ## Frame (rotation-invariant) — FIXED
 *
 * The righting couple is a ROLL moment about the hull's longitudinal axis, so it
 * is built in the BODY frame (torque about +Z_body, which per the canonical
 * convention reduces heel) and injected via `pushBodyAxisTorque`, which rotates
 * it through the orientation quaternion into world space. This is correct at
 * every compass heading. (Historical bug: the couple was injected about a fixed
 * WORLD axis, so stability depended on the absolute heading — the direct cause
 * of the real-game Newport heading-dependent capsize. See
 * `tests/unit/physics/rotationInvariance.test.ts`, now asserting invariance.)
 */

import type { AppliedForce, ForceContext, ForceGenerator } from '@/types';
import type { Vec3 } from '@/types/units';
import { PHYSICS_CONSTANTS } from '@/types/units';
import { sampleCurve, vec3, rotateVec3, addScaled3 } from '@core/math';
import { pushBodyAxisTorque } from './torqueCouple';

// Scratch for the world-space centre of mass and the body-frame torque.
const _worldCoM: Vec3 = vec3();
const _torqueBody: Vec3 = vec3();

export class RightingMoment implements ForceGenerator {
  readonly id = 'righting-moment';

  /** Whether the boat has capsized. Updated every step. */
  capsized = false;

  /** Recovery progress, 0..1. When it reaches 1, the boat rights itself. */
  recoveryProgress = 0;

  evaluate(ctx: ForceContext, out: AppliedForce[]): void {
    const { state, boat } = ctx;
    const { heel, controls } = state;

    const absHeel = Math.abs(heel);

    // World-space centre of mass (the couple is injected about it).
    rotateVec3(state.orientation, boat.centreOfMass, _worldCoM);
    addScaled3(_worldCoM, state.position, 1);

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

      // During capsize, apply a damped restoring ROLL toward 90° (lying on side)
      // in the body frame. This prevents the boat from going fully inverted
      // (turtling) too quickly. Positive τ_z about +Z_body reduces heel.
      const targetHeel = Math.PI * 0.5 * Math.sign(heel);
      const restoringMoment = (heel - targetHeel) * boat.mass * 2;
      _torqueBody.x = 0;
      _torqueBody.y = 0;
      _torqueBody.z = restoringMoment;
      pushBodyAxisTorque(_torqueBody, state.orientation, _worldCoM, out);
      return;
    }

    // --- Form stability from righting curve ---
    // The curve gives GZ (righting arm in metres) at each heel angle.
    // Righting moment = displacement * g * GZ(heel)
    const gz = sampleCurve(boat.hydrostatics.rightingCurve, absHeel);
    const formRighting = boat.hydrostatics.displacement * PHYSICS_CONSTANTS.GRAVITY * gz;

    // --- Crew weight as movable mass ---
    // crewLateral: -1 (port) .. 1 (starboard); hike: 0 .. 1.
    // The player and AI both write to these controls; the physics doesn't care who.
    const crewLateral = controls.crewLateral;
    const hikeEffort = controls.hike;

    // Crew arm = how far the crew mass is from centreline. At max hike, crew is
    // at the gunwale + extended (crewMovementRange.x gives half-beam).
    const maxArm = boat.crewMovementRange.x;
    const crewArm = crewLateral * maxArm * (0.4 + 0.6 * hikeEffort);

    // Crew righting moment: mass * g * arm * cos(heel). cos(heel) because the
    // effective arm shortens as the boat heels. Positive when crew is to
    // windward (opposing heel).
    const crewRighting =
      boat.crewMass * boat.crewMovementRange.x > 0
        ? boat.crewMass * PHYSICS_CONSTANTS.GRAVITY * crewArm * Math.cos(heel)
        : 0;

    // --- Total restoring ROLL torque, in the body frame ---
    // Form righting always opposes heel (restore to upright): a positive heel
    // needs a positive τ_z (about +Z_body reduces heel), hence `* sign(heel)`.
    // Crew righting is already signed (positive = windward = restoring), and
    // enters with a sign chosen so that crew to WINDWARD reduces heel: a boat
    // heeled to starboard (heel > 0) is restored by crew to PORT (crewLateral
    // < 0 → crewRighting < 0), which must ADD a positive τ_z → so −crewRighting.
    const heelSign = Math.sign(heel) || 1;
    const torqueZ = formRighting * heelSign - crewRighting;

    _torqueBody.x = 0;
    _torqueBody.y = 0;
    _torqueBody.z = torqueZ;
    pushBodyAxisTorque(_torqueBody, state.orientation, _worldCoM, out);
  }
}
