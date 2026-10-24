/**
 * HUD density presets as DATA (requirement 2.9 / 11.x).
 *
 * Which widgets appear at each information-density level is a table, not branching
 * logic scattered through the UI. It is tested exhaustively (every preset × every
 * widget) so adding a widget forces an explicit decision for every preset.
 *
 * Rationale for the tiers (art-direction §8.5, requirement 11.x "glanceable"):
 * - full:     everything — the instrument panel in its entirety.
 * - moderate: the numbers you steer by (wind, speed/VMG, compass) plus coaching;
 *             drop the finer trim/heel gauges to reduce clutter.
 * - minimal:  only the two readouts you cannot sail without — wind and speed.
 * - none:     clean screen (photo mode / replay). Nothing.
 */

import type { HudPreset, HudWidget } from './types';

/** All widgets, in canonical display order. */
export const HUD_WIDGETS: readonly HudWidget[] = [
  'wind',
  'speed',
  'trim',
  'heelHelm',
  'compass',
  'conditions',
  'coaching',
] as const;

/**
 * The preset → widget-set table. The single source of truth for widget
 * visibility.
 */
export const PRESET_WIDGETS: Record<HudPreset, readonly HudWidget[]> = {
  full: ['wind', 'speed', 'trim', 'heelHelm', 'compass', 'conditions', 'coaching'],
  moderate: ['wind', 'speed', 'compass', 'conditions', 'coaching'],
  minimal: ['wind', 'speed'],
  none: [],
} as const;

/** The cycle order used by a "cycle HUD density" control. */
export const PRESET_CYCLE: readonly HudPreset[] = ['full', 'moderate', 'minimal', 'none'] as const;

/** Build the `visible` record for a preset from {@link PRESET_WIDGETS}. */
export function widgetVisibility(preset: HudPreset): Record<HudWidget, boolean> {
  const set = new Set<HudWidget>(PRESET_WIDGETS[preset]);
  return {
    wind: set.has('wind'),
    speed: set.has('speed'),
    trim: set.has('trim'),
    heelHelm: set.has('heelHelm'),
    compass: set.has('compass'),
    conditions: set.has('conditions'),
    coaching: set.has('coaching'),
  };
}

/** The next preset in the cycle (wraps). Used by the density toggle. */
export function nextPreset(preset: HudPreset): HudPreset {
  const i = PRESET_CYCLE.indexOf(preset);
  const next = PRESET_CYCLE[(i + 1) % PRESET_CYCLE.length];
  // PRESET_CYCLE is non-empty and i is always valid; fall back defensively.
  return next ?? 'full';
}
