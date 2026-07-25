/**
 * Wave drag force generator.
 *
 * Two components:
 * 1. Orbital drag: relative velocity between the hull and the wave's orbital
 *    motion produces a quadratic drag force. This is what slows the boat
 *    going into a head sea and the primary wave-added resistance.
 * 2. Surfing acceleration: on the down-wave face, the orbital velocity has a
 *    forward component that reduces the apparent velocity of the hull through
 *    the water, effectively "pushing" the boat. This is what makes surfing
 *    down waves faster than flat-water speed — an emergent result, not a hack.
 *
 * Also includes slam detection: when a forward buoyancy point re-enters after
 * being airborne, the vertical velocity at that point is watched. Above a
 * threshold, an impulse is applied plus a 'boat:slam' event is emitted on
 * the EventBus with the impact energy (for spray particle triggers and audio).
 */

import type {
  AppliedForce,
  ForceContext,
  ForceGenerator,
  Vec3,
} from '@/types';
import { vec3, copy3, rotateVec3, length3 } from '@core/math';
import { clamp } from '@core/math';
import { allocForce } from '../RigidBody';
import type { EventBus } from '@core/events';

// Drag coefficient for orbital velocity interaction.
// Calibrated so that wave-added resistance at Hs=1m is ~10-15% of calm-water resistance.
const ORBITAL_DRAG_COEFF = 0.35;

// Slam threshold: vertical velocity in m/s at re-entry that triggers a slam event
const SLAM_VELOCITY_THRESHOLD = 2.0;

// Slam impulse coefficient: fraction of kinetic energy converted to vertical impulse
const SLAM_IMPULSE_COEFF = 0.5;

// Scratch vectors
const _worldPoint: Vec3 = vec3();
const _orbitalVel: Vec3 = vec3();
const _relativeVel: Vec3 = vec3();
const _hullVelAtPoint: Vec3 = vec3();
const _omega_cross_r: Vec3 = vec3();
const _r: Vec3 = vec3();

// Per-point state for slam detection (tracks whether each point was above water last step)
const _wasAbove: boolean[] = [];
const _prevVy: number[] = [];

export class WaveDragForceGenerator implements ForceGenerator {
  readonly id = 'waveDrag';

  private readonly _eventBus: EventBus | undefined;
  private readonly _boatId: string;

  constructor(boatId: string, eventBus?: EventBus) {
    this._boatId = boatId;
    this._eventBus = eventBus;
  }

  evaluate(ctx: ForceContext, out: AppliedForce[]): void {
    const { state, boat, environment, time, dt } = ctx;
    const points = boat.hydrostatics.buoyancyPoints;
    const waterDensity = ctx.waterDensity;

    for (let i = 0; i < points.length; i++) {
      const bp = points[i];
      if (bp === undefined) continue;

      // Transform point to world space
      rotateVec3(state.orientation, bp.position, _worldPoint);
      _worldPoint.x += state.position.x;
      _worldPoint.y += state.position.y;
      _worldPoint.z += state.position.z;

      // Sample wave surface height
      const waterHeight = environment.waves.height(_worldPoint.x, _worldPoint.z, time);
      const submergence = waterHeight - _worldPoint.y;

      // Compute hull velocity at this point: v_hull + ω × r
      _r.x = _worldPoint.x - state.position.x;
      _r.y = _worldPoint.y - state.position.y;
      _r.z = _worldPoint.z - state.position.z;

      // ω × r
      _omega_cross_r.x = state.angularVelocity.y * _r.z - state.angularVelocity.z * _r.y;
      _omega_cross_r.y = state.angularVelocity.z * _r.x - state.angularVelocity.x * _r.z;
      _omega_cross_r.z = state.angularVelocity.x * _r.y - state.angularVelocity.y * _r.x;

      _hullVelAtPoint.x = state.linearVelocity.x + _omega_cross_r.x;
      _hullVelAtPoint.y = state.linearVelocity.y + _omega_cross_r.y;
      _hullVelAtPoint.z = state.linearVelocity.z + _omega_cross_r.z;

      // ── Slam detection ──────────────────────────────────────────────────
      // Only check forward points (first 1/3 of the hull)
      const isForward = i < points.length / 3;
      if (isForward) {
        const wasAbove = _wasAbove[i] ?? false;
        const isAbove = submergence <= 0;

        if (wasAbove && !isAbove) {
          // Re-entry! Check vertical velocity
          const verticalVelocity = -_hullVelAtPoint.y; // Positive when moving down
          if (verticalVelocity > SLAM_VELOCITY_THRESHOLD) {
            // Apply slam impulse
            const slamEnergy = 0.5 * waterDensity * bp.sectionArea * verticalVelocity * verticalVelocity;
            const impulseMag = SLAM_IMPULSE_COEFF * slamEnergy * dt;

            const slamForce = allocForce();
            if (slamForce !== undefined) {
              slamForce.force.x = 0;
              slamForce.force.y = impulseMag / dt; // Convert impulse back to force for this timestep
              slamForce.force.z = 0;
              copy3(slamForce.point, _worldPoint);
              out.push(slamForce);
            }

            // Emit slam event for audio and spray
            if (this._eventBus !== undefined) {
              this._eventBus.emit('boat:slam', {
                boatId: this._boatId,
                energy: slamEnergy,
              });
            }
          }
        }

        _wasAbove[i] = isAbove;
        _prevVy[i] = _hullVelAtPoint.y;
      }

      // ── Wave drag (only when submerged) ─────────────────────────────────
      if (submergence <= 0) continue;

      // Sample orbital velocity at this point
      environment.waves.orbitalVelocity(_worldPoint.x, _worldPoint.z, _worldPoint.y, time, _orbitalVel);

      // Relative velocity of hull through the water (hull - water motion)
      _relativeVel.x = _hullVelAtPoint.x - _orbitalVel.x;
      _relativeVel.y = _hullVelAtPoint.y - _orbitalVel.y;
      _relativeVel.z = _hullVelAtPoint.z - _orbitalVel.z;

      const relSpeed = length3(_relativeVel);
      if (relSpeed < 1e-6) continue;

      // Quadratic drag: F = -0.5 * ρ * Cd * A * |v| * v
      // Area is the section area of this buoyancy point
      const dragMag = 0.5 * waterDensity * ORBITAL_DRAG_COEFF * bp.sectionArea * relSpeed;

      // Submergence factor: drag scales with how much of the point is submerged
      const subFraction = clamp(submergence / 1.0, 0, 1);

      const applied = allocForce();
      if (applied === undefined) break;

      // Drag opposes relative motion
      applied.force.x = -_relativeVel.x * dragMag * subFraction;
      applied.force.y = -_relativeVel.y * dragMag * subFraction;
      applied.force.z = -_relativeVel.z * dragMag * subFraction;

      copy3(applied.point, _worldPoint);
      out.push(applied);
    }
  }
}
