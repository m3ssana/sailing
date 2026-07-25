/**
 * Foil flight — hydrofoil takeoff, ride-height control, and crash-down.
 *
 * This only applies to foiling boats (those with a FoilingSpec). The physics:
 *
 * 1. TAKEOFF: Above takeoffSpeed, the lifting foils generate enough vertical force
 *    to raise the hull clear of the water. Once flying, wetted surface drops to
 *    nearly zero and drag collapses by flyingDragFactor.
 *
 * 2. RIDE HEIGHT: While flying, the foils self-regulate height because as they rise
 *    toward the surface, their immersion decreases and so does lift. Stability is
 *    maintained by this negative feedback loop — no active control system needed.
 *    We model this as a spring–damper around the target ride height.
 *
 * 3. CRASH DOWN: If speed drops below takeoff speed, or if ride height is lost
 *    (nose digs in, or a wave strikes the hull), the boat drops back onto the water
 *    with an impact force. This is abrupt and costly — maintaining foil flight
 *    requires smooth, controlled sailing.
 *
 * The drag collapse when flying is what makes foiling boats so much faster than
 * displacement boats: removing the hull from the water eliminates both friction
 * and wavemaking resistance, leaving only the foils' much smaller drag.
 */

import type { AppliedForce, ForceContext, ForceGenerator } from '@/types';
import { PHYSICS_CONSTANTS } from '@/types/units';
import { clamp, saturate } from '@core/math';

export class FoilFlight implements ForceGenerator {
  readonly id = 'foil-flight';

  /** Whether the boat is currently flying. */
  flying = false;

  /** Current ride height above the mean waterline, metres. */
  rideHeight = 0;

  /** Vertical velocity for ride-height damping. */
  private verticalVelocity = 0;

  evaluate(ctx: ForceContext, out: AppliedForce[]): void {
    const { state, boat } = ctx;
    const foilingSpec = boat.foiling;

    // Only applies to foiling boats.
    if (foilingSpec === undefined) return;

    const speed = state.speed;
    const position = state.position;

    // --- Takeoff condition ---
    if (!this.flying) {
      if (speed >= foilingSpec.takeoffSpeed) {
        // Enough speed for the foils to support the boat's weight.
        this.flying = true;
        this.rideHeight = foilingSpec.rideHeightRange[0];
        this.verticalVelocity = 0;
      } else {
        // Below takeoff speed: foils provide partial lift that lightens the boat
        // (reduces wetted surface) but doesn't achieve flight.
        const liftFraction = saturate(
          (speed - foilingSpec.takeoffSpeed * 0.6) / (foilingSpec.takeoffSpeed * 0.4),
        );
        if (liftFraction > 0) {
          // Partial lift reduces effective displacement.
          const partialLift =
            liftFraction * boat.mass * PHYSICS_CONSTANTS.GRAVITY * 0.5;
          out.push({
            force: { x: 0, y: partialLift, z: 0 },
            point: { x: position.x, y: position.y, z: position.z },
          });
        }
        return;
      }
    }

    // --- Flying: ride-height control ---
    const [minHeight, maxHeight] = foilingSpec.rideHeightRange;
    const targetHeight = (minHeight + maxHeight) * 0.5;

    // Lift from the foils varies with immersion (height above water = less immersion).
    // Higher ride → less foil in water → less lift → drops back.
    // Lower ride → more foil in water → more lift → rises.
    // This is inherently stable — a negative feedback loop.
    const immersionFraction = saturate(1 - (this.rideHeight - minHeight) / (maxHeight - minHeight));

    // Lift must equal weight when in steady flight.
    const weight = boat.mass * PHYSICS_CONSTANTS.GRAVITY;
    const foilLift = weight * immersionFraction * 1.3; // 1.3 to ensure enough authority

    // Spring–damper toward target ride height.
    const heightError = targetHeight - this.rideHeight;
    const springForce = heightError * weight * 4; // Stiff spring
    const dampForce = -this.verticalVelocity * weight * 3; // Critical damping

    const netVerticalForce = foilLift - weight + springForce + dampForce;

    // Integrate ride height.
    const verticalAccel = netVerticalForce / boat.mass;
    this.verticalVelocity += verticalAccel * ctx.dt;
    this.rideHeight += this.verticalVelocity * ctx.dt;
    this.rideHeight = clamp(this.rideHeight, 0, maxHeight * 1.2);

    // --- Crash-down detection ---
    if (speed < foilingSpec.takeoffSpeed * 0.85 || this.rideHeight <= 0) {
      // Lost flight: hull splashes down.
      this.flying = false;
      this.rideHeight = 0;
      this.verticalVelocity = 0;

      // Impact force: sudden deceleration from the hull hitting the water.
      const impactForce = -boat.mass * PHYSICS_CONSTANTS.GRAVITY * 0.5;
      out.push({
        force: { x: 0, y: impactForce, z: 0 },
        point: { x: position.x, y: position.y, z: position.z },
      });
      return;
    }

    // --- Drag reduction while flying ---
    // The drag collapse is handled by HydroResistance checking the foiling state.
    // Here we just emit the net vertical force to maintain flight.
    out.push({
      force: { x: 0, y: netVerticalForce, z: 0 },
      point: { x: position.x, y: position.y, z: position.z },
    });
  }
}
