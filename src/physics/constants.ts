/**
 * Physics constants and shared configuration for force generators.
 *
 * Re-exports PHYSICS_CONSTANTS from units.ts and adds derived values that are
 * used by multiple generators. Keeping them here prevents magic numbers from
 * scattering across the codebase and makes the coefficient choices auditable.
 */

export { PHYSICS_CONSTANTS } from '@/types/units';

/**
 * Minimum speed threshold below which velocity-dependent computations are
 * clamped. Prevents division by zero in Reynolds number, Froude number, and
 * lift/drag formulas when the boat is nearly stationary.
 */
export const MIN_SPEED = 0.01;

/**
 * Minimum apparent wind speed below which sail forces are zeroed.
 * At true zero the angle of attack is undefined.
 */
export const MIN_APPARENT_WIND = 0.05;

/**
 * Efficiency factor for induced drag on underwater foils. Typical values 0.85–0.95
 * for well-designed keels. We use 0.9 as the default; individual foils may override.
 */
export const DEFAULT_FOIL_EFFICIENCY = 0.9;

/**
 * Slot effect bonus on effective AoA when main and headsail are both working.
 * The headsail accelerates flow over the main's leeward side, delaying separation.
 * This is applied as a multiplier on the effective alpha range before stall.
 */
export const SLOT_EFFECT_ALPHA_BONUS = 0.12; // ~7° additional effective range in radians

/**
 * Parasitic drag coefficient for sails (profile drag at zero lift from mast,
 * surface roughness, seams, hardware). Typical range 0.01–0.03.
 */
export const SAIL_PARASITIC_CD = 0.015;
