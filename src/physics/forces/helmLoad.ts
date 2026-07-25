/**
 * Helm load computation — exports normalized tiller force for haptics and UI.
 *
 * The helm load is the rudder's hydrodynamic moment PLUS the sail plan's yaw
 * imbalance. Weather helm (boat wanting to round up into the wind) emerges
 * naturally when the sail plan's centre of effort is aft of the hull's centre
 * of lateral resistance and the boat is overpowered.
 *
 * De-powering the rig (easing, flattening, reefing) reduces the sail force
 * imbalance, which genuinely lightens the helm — the physics produces the feel
 * rather than it being faked (requirement 5.7).
 */

import { saturate } from '@core/math';

/**
 * Compute normalized helm load from the contributing moments.
 *
 * @param rudderMoment Rudder hydrodynamic moment magnitude, N·m.
 * @param sailYawImbalance Net yaw moment from the sail plan, N·m.
 * @param boatMass Mass for normalization, kg.
 * @returns Normalized load 0..1, where 0 is light and 1 is heavy/overpowered.
 */
export function computeHelmLoad(
  rudderMoment: number,
  sailYawImbalance: number,
  boatMass: number,
): number {
  // The load the helmsperson feels is the torque they must resist.
  // Rudder moment + sail imbalance gives the total torque about the vertical axis.
  const totalMoment = Math.abs(rudderMoment) + Math.abs(sailYawImbalance) * 0.3;

  // Normalize by a reference torque proportional to boat size.
  // A typical tiller force range is 0-50N on a dinghy (arm ~0.5m = 25 N·m max)
  // and 0-200N on a keelboat (arm ~1m = 200 N·m max).
  const referenceTorque = boatMass * 0.3; // Scales with boat mass

  return saturate(totalMoment / referenceTorque);
}
