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

export class WaveDragForceGenerator implements ForceGenerator {
  readonly id = 'waveDrag';

  private readonly _eventBus: EventBus | undefined;
  private readonly _boatId: string;

  // ── Per-INSTANCE scratch vectors (allocated once per generator, reused every
  // step). These were previously module-scope and therefore shared across every
  // WaveDragForceGenerator instance — a latent aliasing hazard identical to the
  // CurrentField bug this project already fixed. Per-instance means two boats (or
  // two parallel tests) never clobber each other's working vectors.
  private readonly _worldPoint: Vec3 = vec3();
  private readonly _orbitalVel: Vec3 = vec3();
  private readonly _relativeVel: Vec3 = vec3();
  private readonly _hullVelAtPoint: Vec3 = vec3();
  private readonly _omega_cross_r: Vec3 = vec3();
  private readonly _r: Vec3 = vec3();

  // ── Per-INSTANCE slam state for slam detection (tracks whether each buoyancy
  // point was above water last step, and its prior vertical velocity). Was
  // module-scope (`_wasAbove`/`_prevVy`) and therefore SHARED across instances,
  // which made a parallel soak non-deterministic: one boat's re-entry history
  // leaked into another's slam trigger. Now owned by the generator, so the slam
  // behaviour is deterministic per boat regardless of test order or how many
  // boats run concurrently.
  private readonly _wasAbove: boolean[] = [];
  private readonly _prevVy: number[] = [];

  constructor(boatId: string, eventBus?: EventBus) {
    this._boatId = boatId;
    this._eventBus = eventBus;
  }

  evaluate(ctx: ForceContext, out: AppliedForce[]): void {
    const { state, boat, environment, time, dt } = ctx;
    const points = boat.hydrostatics.buoyancyPoints;
    const waterDensity = ctx.waterDensity;

    const _worldPoint = this._worldPoint;
    const _orbitalVel = this._orbitalVel;
    const _relativeVel = this._relativeVel;
    const _hullVelAtPoint = this._hullVelAtPoint;
    const _omega_cross_r = this._omega_cross_r;
    const _r = this._r;
    const _wasAbove = this._wasAbove;
    const _prevVy = this._prevVy;

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

      // Relative velocity of hull through the water INCLUDING wave orbital motion.
      _relativeVel.x = _hullVelAtPoint.x - _orbitalVel.x;
      _relativeVel.y = _hullVelAtPoint.y - _orbitalVel.y;
      _relativeVel.z = _hullVelAtPoint.z - _orbitalVel.z;

      const relSpeed = length3(_relativeVel);

      // Submergence factor: drag scales with how much of the point is submerged
      const subFraction = clamp(submergence / 1.0, 0, 1);

      // WAVE-ADDED resistance only. This generator models the EXTRA quadratic
      // drag (and down-wave surfing push) that the wave orbital motion adds on
      // top of the hull's steady through-water drag — it must NOT re-levy the
      // steady drag, which HydroResistance already owns via the wetted-surface /
      // residuary model. Previously this applied the FULL quadratic drag on the
      // relative velocity, which on FLAT water (orbital velocity = 0) reduced to
      // ~1000 N of pure hull drag at 5 kt — roughly 4× HydroResistance and the
      // reason the boat could never build sailing speed ("it crabs and stops").
      //
      // We therefore apply the DIFFERENCE between drag at the wave-relative
      // velocity and drag at the steady hull velocity, component-wise:
      //   F_i = −k·(|v_rel|·v_rel,i − |v_hull|·v_hull,i) · subFraction
      // On flat water v_rel = v_hull so F = 0 (no double count); in a seaway the
      // orbital fluctuation produces added resistance into a head sea and a net
      // forward push surfing down a wave face — both emergent, not scripted.
      const k = 0.5 * waterDensity * ORBITAL_DRAG_COEFF * bp.sectionArea * subFraction;
      const hullSpeed = length3(_hullVelAtPoint);
      if (relSpeed < 1e-6 && hullSpeed < 1e-6) continue;

      const applied = allocForce();
      if (applied === undefined) break;

      applied.force.x = -k * (relSpeed * _relativeVel.x - hullSpeed * _hullVelAtPoint.x);
      applied.force.y = -k * (relSpeed * _relativeVel.y - hullSpeed * _hullVelAtPoint.y);
      applied.force.z = -k * (relSpeed * _relativeVel.z - hullSpeed * _hullVelAtPoint.z);

      copy3(applied.point, _worldPoint);
      out.push(applied);
    }
  }
}
