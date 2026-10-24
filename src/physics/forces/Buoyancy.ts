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

  /**
   * Reference depth at which a point's buoyancy fraction reaches 1 (buoyancy =
   * weight share). When provided (BoatFactory computes it per boat), it is the
   * value that floats the hull at its DESIGN waterline: the volume-weighted mean
   * submergence of the buoyancy points at the design waterline, i.e.
   * `waterlineHeight − centreOfBuoyancy.y`. See the constructor doc.
   */
  private readonly _refDepth: number | undefined;

  /**
   * @param refDepth Optional per-boat reference depth (metres). Pass the value
   *   that makes total buoyancy equal total weight at the DESIGN waterline —
   *   `waterlineHeight − centreOfBuoyancy.y` — so the hull floats at its design
   *   draft instead of settling ~0.2 m deeper. When omitted the legacy
   *   `max(|CoB.y|·2, waterlineBeam·0.25, 0.1)` heuristic is used (deep-sink).
   */
  constructor(refDepth?: number) {
    this._refDepth = refDepth !== undefined && refDepth > 1e-3 ? refDepth : undefined;
  }

  evaluate(ctx: ForceContext, out: AppliedForce[]): void {
    const { state, boat, environment, time } = ctx;
    const points = boat.hydrostatics.buoyancyPoints;
    const waterDensity = ctx.waterDensity;
    const g = PHYSICS_CONSTANTS.GRAVITY;

    // Reference depth: the submergence at which a point's buoyancy equals its
    // weight share, so that summed over the hull at the design waterline total
    // buoyancy = total weight and the hull floats at its DESIGN draft.
    //
    // DEEP-SINK FIX (was a documented known-limitation). The old heuristic
    // `max(|CoB.y|·2, waterlineBeam·0.25, 0.1)` was dominated by the
    // `waterlineBeam·0.25 ≈ 0.29 m` term — not a real draft — so equilibrium
    // landed with the keel ~0.29 m below mean water instead of the ~0.12 m
    // design draft (the hull rendered nearly awash; the render layer hid it with
    // a `setHeaveOverride` hack). The correct linearisation point is the
    // volume-weighted mean submergence of the buoyancy points AT the design
    // waterline, which equals `waterlineHeight − centreOfBuoyancy.y`
    // (≈0.059 m for the dinghy). BoatFactory computes that from the lofted hull
    // and passes it in. With it, Σ ρg·V_i·(sub_i/refDepth) = ρg·displacedVolume
    // ≈ mass·g exactly at the design waterline, so the hull floats at design
    // draft BY CONSTRUCTION. A stiffer refDepth also stiffens the distributed
    // buoyancy's roll couple; `RightingMoment` compensates (its form-GZ term is
    // scaled so total static roll stiffness still equals the geometric GZ curve
    // — the two no longer double-count). See RightingMoment.ts.
    const cobY = boat.hydrostatics.centreOfBuoyancy.y;
    const refDepth =
      this._refDepth ??
      Math.max(Math.abs(cobY) * 2, boat.hydrostatics.waterlineBeam * 0.25, 0.1);

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
