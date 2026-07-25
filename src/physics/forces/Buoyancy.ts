/**
 * Distributed buoyancy force generator (includes gravitational weight).
 *
 * Physically, buoyancy and weight are inseparable: a floating body is in
 * equilibrium when ρ_water * g * V_displaced = m * g. Applying buoyancy
 * without weight causes the hull to ratchet upward on each wave crest with
 * nothing to bring it back — the classic "diverging heave" bug. So this
 * generator applies BOTH:
 *   • Weight: distributed evenly among all buoyancy points, always downward.
 *   • Buoyancy: upward, proportional to local submergence, at each point.
 *
 * Because both forces are distributed along the hull's length, the pitch and
 * roll response to waves EMERGES from the spatial distribution rather than
 * being animated. A wave crest under the bow produces more buoyancy there than
 * weight, lifting it; a trough produces less, letting it drop.
 *
 * Submergence is clamped to prevent unbounded force when the hull is deeply
 * buried — the "submarine launch" bug.
 */

import type {
  AppliedForce,
  ForceContext,
  ForceGenerator,
  Vec3,
} from '@/types';
import { PHYSICS_CONSTANTS } from '@/types';
import { vec3, rotateVec3, copy3 } from '@core/math';
import { clamp } from '@core/math';
import { allocForce } from '../RigidBody';

// Maximum submergence multiplier: buoyancy saturates at this factor of design force.
// Prevents the "submarine launch" — a deeply buried point doesn't produce runaway lift.
const MAX_FORCE_MULTIPLIER = 2.0;

// Scratch vector — zero allocation in the hot path
const _worldPoint: Vec3 = vec3();

export class BuoyancyForceGenerator implements ForceGenerator {
  readonly id = 'buoyancy';

  evaluate(ctx: ForceContext, out: AppliedForce[]): void {
    const { state, boat, environment, time } = ctx;
    const points = boat.hydrostatics.buoyancyPoints;
    const waterDensity = ctx.waterDensity;
    const g = PHYSICS_CONSTANTS.GRAVITY;

    // Reference depth: the depth at which a point's buoyancy equals its weight share.
    // At equilibrium, submergence/refDepth ≈ 1 for each submerged point, so total
    // buoyancy ≈ total weight. Using the CoB depth as proxy for half-draft.
    const cobY = boat.hydrostatics.centreOfBuoyancy.y;
    const refDepth = Math.max(Math.abs(cobY) * 2, boat.hydrostatics.waterlineBeam * 0.25, 0.1);

    // Weight per point: total weight distributed evenly
    // (uniform distribution is approximate — acceptable because the point volume
    // weighting on the buoyancy side handles the spatial variation)
    const numPoints = points.length;
    if (numPoints === 0) return;
    const weightPerPoint = (boat.mass * g) / numPoints;

    for (let i = 0; i < numPoints; i++) {
      const bp = points[i];
      if (bp === undefined) continue;

      // Transform buoyancy point from hull-local to world space
      rotateVec3(state.orientation, bp.position, _worldPoint);
      _worldPoint.x += state.position.x;
      _worldPoint.y += state.position.y;
      _worldPoint.z += state.position.z;

      // Sample wave height at this point
      const waterHeight = environment.waves.height(_worldPoint.x, _worldPoint.z, time);

      // Submergence depth (positive when below water)
      const submergence = waterHeight - _worldPoint.y;

      // Buoyancy magnitude: ρ * g * V_point * fraction, clamped
      let buoyancyMag = 0;
      if (submergence > 0) {
        const fraction = clamp(submergence / refDepth, 0, MAX_FORCE_MULTIPLIER);
        buoyancyMag = waterDensity * g * bp.volume * fraction;
      }

      // Net vertical force at this point: buoyancy up - weight down
      const netForceY = buoyancyMag - weightPerPoint;

      const applied = allocForce();
      if (applied === undefined) break;

      applied.force.x = 0;
      applied.force.y = netForceY;
      applied.force.z = 0;

      // Application point is the world-space buoyancy point
      copy3(applied.point, _worldPoint);

      out.push(applied);
    }
  }
}
