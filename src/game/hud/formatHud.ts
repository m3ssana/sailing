/**
 * `formatHud` — the pure string-formatting layer.
 *
 * Separated from the view model so the numeric model stays string-free and
 * testable, and so i18n (number locale, unit words) is a single-module change.
 * This layer NEVER converts units — it formats the already-converted display
 * values the view model produced.
 *
 * Formatting conventions (art-direction §8.5, maritime abbreviations):
 * - Speeds: one decimal, e.g. `6.2 kt`.
 * - Bearings/headings: zero-padded three-digit degrees with a degree sign and no
 *   space, e.g. `045°`.
 * - Distances: `0.32 nm`, `250 m`, `1.4 km` depending on the readout's unit.
 */

import { UNITS } from '@/types/units';
import type {
  DistanceReadout,
  HudViewModel,
  SpeedReadout,
  UnitSystem,
} from './types';

/** The unit word shown next to a speed, per system. */
export function speedUnitLabel(units: UnitSystem): string {
  return units === 'knotsNm' ? 'kt' : 'm/s';
}

/** Format a speed readout's display value, e.g. `6.2`. */
export function formatSpeedValue(readout: SpeedReadout, decimals = 1): string {
  return readout.display.toFixed(decimals);
}

/** Format a speed with its unit, e.g. `6.2 kt`. */
export function formatSpeed(readout: SpeedReadout, units: UnitSystem, decimals = 1): string {
  return `${formatSpeedValue(readout, decimals)} ${speedUnitLabel(units)}`;
}

/**
 * Format a bearing/heading in radians (compass) as zero-padded degrees, e.g.
 * `045°`. Wraps into 0..360 and rounds to the nearest degree; 360 reads as 000.
 */
export function formatBearing(radians: number): string {
  let deg = Math.round(radians * UNITS.RAD_TO_DEG) % 360;
  if (deg < 0) deg += 360;
  return `${deg.toString().padStart(3, '0')}°`;
}

/**
 * Format a signed angle off the bow in radians as degrees with a port/starboard
 * suffix, e.g. `45° S` (starboard) / `30° P` (port). Magnitude only, 0..180.
 */
export function formatRelativeAngle(radians: number): string {
  const deg = Math.round(Math.abs(radians) * UNITS.RAD_TO_DEG);
  const side = radians >= 0 ? 'S' : 'P';
  return `${deg}° ${side}`;
}

/** Format a distance readout, choosing decimals by unit: `0.32 nm`, `250 m`. */
export function formatDistance(readout: DistanceReadout): string {
  switch (readout.unit) {
    case 'nm':
      return `${readout.display.toFixed(2)} nm`;
    case 'km':
      return `${readout.display.toFixed(1)} km`;
    case 'm':
    default:
      return `${Math.round(readout.display)} m`;
  }
}

/** Format a 0..1 fraction as a percentage, e.g. `0.84 → "84%"`. */
export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/**
 * A fully pre-formatted string bundle for the primary readouts, convenient for
 * tests and for components that want strings without re-deriving them.
 */
export interface HudStrings {
  sog: string;
  vmgUpwind: string;
  vmgDownwind: string;
  target: string;
  targetFraction: string;
  heading: string;
  cog: string;
  trueWind: string;
  apparentWind: string;
  trueWindAngle: string;
  apparentWindAngle: string;
  bearingToMark: string | null;
  distanceToMark: string | null;
  /** 'SIMULATED' when sandbox, otherwise empty. */
  simulatedBadge: string;
}

/** Build the pre-formatted string bundle from a view model. */
export function formatHud(vm: HudViewModel): HudStrings {
  const units = vm.units;
  return {
    sog: formatSpeed(vm.speed.sog, units),
    vmgUpwind: formatSpeed(vm.speed.vmgUpwind, units),
    vmgDownwind: formatSpeed(vm.speed.vmgDownwind, units),
    target: formatSpeed(vm.speed.target, units),
    targetFraction: formatPercent(vm.speed.targetFraction),
    heading: formatBearing(vm.compass.heading),
    cog: formatBearing(vm.compass.cog),
    trueWind: formatSpeed(vm.wind.trueSpeed, units),
    apparentWind: formatSpeed(vm.wind.apparentSpeed, units),
    trueWindAngle: formatRelativeAngle(vm.wind.trueAngle),
    apparentWindAngle: formatRelativeAngle(vm.wind.apparentAngle),
    bearingToMark: vm.compass.bearingToMark === null ? null : formatBearing(vm.compass.bearingToMark),
    distanceToMark: vm.compass.distanceToMark === null ? null : formatDistance(vm.compass.distanceToMark),
    simulatedBadge: vm.conditions.simulated ? 'SIMULATED' : '',
  };
}
