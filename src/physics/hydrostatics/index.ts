/**
 * Hydrostatics computed from generated hull geometry.
 *
 * The central contract: every physical parameter that CAN be derived from
 * the geometry IS derived from it, so the simulated hull and rendered hull
 * are always the same object. Change a station curve, and both the look and
 * the behaviour move together.
 */

export { computeHydrostatics } from './computeHydrostatics';
export { clipTriangleAgainstWaterline } from './waterlineClip';
export { computeRightingCurve } from './rightingCurve';
export { distributeBuoyancyPoints } from './buoyancyPoints';
