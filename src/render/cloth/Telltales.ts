/**
 * Telltale orientation logic for sail cloth rendering.
 *
 * Telltales are short yarn/ribbon indicators attached at specific points on the
 * sail surface. Their orientation relative to the local cloth normal indicates
 * whether airflow is attached (streaming aft) or separated (lifting/flogging).
 *
 * ## Conventions (from AeroForce.ts)
 *
 * - `alpha > 0` → apparent wind comes from the starboard side → leeward side is +Z
 *   in the sail reference frame (matching the mesh winding: normals point +Z from
 *   the pressure/starboard side per SailSurfaceGenerator's CCW-from-+Z convention).
 * - Windward telltale: on the side the wind hits first (negative normal side when
 *   alpha > 0, positive normal side when alpha < 0).
 * - Leeward telltale: on the opposite side.
 *
 * ## Behaviour
 *
 * | Condition | Windward telltale | Leeward telltale |
 * |-----------|-------------------|------------------|
 * | Attached (attachment ≈ 1) | Streams aft smoothly | Streams aft smoothly |
 * | Luffing (under-trimmed) | Lifts/flogs (points away from sail) | Streams aft |
 * | Stalled (over-trimmed) | Streams aft | Lifts/flogs (turbulent separation) |
 *
 * This is the real-world behaviour that experienced sailors read. The model must
 * reproduce this so the demo requirement ("telltales read correctly on both sides")
 * is satisfied.
 *
 * ## Implementation
 *
 * Each telltale is a 3-segment ribbon attached at one end. The free-end direction
 * is computed per frame from the sail's aerodynamic state. The angle is expressed
 * as a deflection from the "streaming aft" baseline:
 * - 0° = perfectly streaming (attached flow)
 * - 90° = perpendicular to sail surface (fully detached / flogging)
 *
 * Engine-agnostic — no three.js. Orientation is a unit vector in the sail's local
 * tangent plane (or lifting off-surface when detached).
 */

import type { Vec3 } from '@/types';
import type { SailAeroState } from '@physics/forces/AeroForce';

/** Which side of the sail this telltale is on. */
export type TelltaleSide = 'windward' | 'leeward';

/** Conventional telltale positions on a sail (girth fraction u, luff fraction v). */
export interface TelltalePosition {
  /** Girth fraction from luff (0 = at luff, 1 = at leech). Typically 0.05–0.15. */
  u: number;
  /** Luff fraction from foot (0 = foot, 1 = head). */
  v: number;
  /** Which side of the sail. */
  side: TelltaleSide;
}

/**
 * Standard telltale layout: 3 height stations × 2 sides = 6 telltales.
 * Positions follow racing convention: ~10% back from the luff at 25%, 50%, 75% height.
 */
export const STANDARD_TELLTALE_POSITIONS: readonly TelltalePosition[] = [
  { u: 0.08, v: 0.25, side: 'windward' },
  { u: 0.08, v: 0.25, side: 'leeward' },
  { u: 0.08, v: 0.50, side: 'windward' },
  { u: 0.08, v: 0.50, side: 'leeward' },
  { u: 0.08, v: 0.75, side: 'windward' },
  { u: 0.08, v: 0.75, side: 'leeward' },
];

/**
 * Result of computing a telltale's orientation.
 */
export interface TelltaleOrientation {
  /** Direction vector in sail-local coordinates (tangent to surface or lifting off).
   * Normalized. When streaming, this points along the -u direction (toward leech).
   * When lifting, the normal component increases. */
  direction: Vec3;
  /** 0 = streaming perfectly, 1 = fully lifted/flogging. */
  liftAmount: number;
}

/**
 * Compute the orientation of a single telltale given the sail's aerodynamic state.
 *
 * @param side - Which side of the sail this telltale is on.
 * @param sailState - Current aerodynamic state from AeroForce.
 * @returns The telltale's direction and lift amount.
 */
export function computeTelltaleOrientation(
  side: TelltaleSide,
  sailState: SailAeroState,
): TelltaleOrientation {
  const { attachment, luffing, alpha } = sailState;

  // Determine which side is windward based on alpha sign.
  // alpha > 0 → wind from starboard → windward is +Z face (normal direction)
  // alpha < 0 → wind from port → windward is -Z face
  // The sail normal points +Z (per winding convention), so:
  // - When alpha > 0: the +Z face is windward, -Z is leeward.
  // - When alpha < 0: the -Z face is windward, +Z is leeward.
  const windwardIsNormalSide = alpha >= 0;
  const isOnWindwardSide = side === 'windward';

  // Is this telltale on the side that matches the wind direction?
  const isOnExposedSide = isOnWindwardSide === windwardIsNormalSide;

  // --- Compute lift amount ---
  // Luffing (under-trimmed): windward telltale lifts, leeward streams.
  // Stalled (over-trimmed): leeward telltale lifts, windward streams.
  let liftAmount: number;

  if (luffing) {
    // Under-trimmed: flow separates on windward side first.
    // Windward lifts proportionally to how separated the flow is.
    if (isOnExposedSide) {
      // Windward telltale lifts during luffing
      liftAmount = 1 - attachment; // 0 at barely luffing, 1 at fully separated
    } else {
      // Leeward telltale still streams during luffing (it's on the attached side)
      liftAmount = Math.max(0, (1 - attachment) * 0.2); // Slight disturbance only
    }
  } else if (attachment < 1.0) {
    // Stalled (over-trimmed): flow separates on leeward side.
    if (!isOnExposedSide) {
      // Leeward telltale lifts during stall
      liftAmount = 1 - attachment;
    } else {
      // Windward telltale still streams during stall
      liftAmount = Math.max(0, (1 - attachment) * 0.15);
    }
  } else {
    // Fully attached: both telltales stream aft.
    liftAmount = 0;
  }

  // --- Compute direction vector ---
  // Streaming direction: along the chord, toward the leech (-u direction in sail coords).
  // In the sail reference frame: u runs along +X (luff to leech), so streaming = +X.
  // Lifting: the telltale lifts perpendicular to the sail surface.
  // Normal is +Z (from winding convention). Lift direction depends on which side:
  // - Telltale on +Z face lifts toward +Z.
  // - Telltale on -Z face lifts toward -Z.
  const normalSign = isOnExposedSide ? (windwardIsNormalSide ? 1 : -1) : (windwardIsNormalSide ? -1 : 1);
  const liftZ = liftAmount * normalSign;

  // Streaming component: decreases as lift increases.
  const streamX = Math.sqrt(Math.max(0, 1 - liftAmount * liftAmount));

  // Normalize (should already be approximately unit length)
  const len = Math.sqrt(streamX * streamX + liftZ * liftZ);
  const direction: Vec3 = len > 1e-10
    ? { x: streamX / len, y: 0, z: liftZ / len }
    : { x: 1, y: 0, z: 0 };

  return { direction, liftAmount };
}
