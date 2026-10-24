/**
 * Exhaustive preset table tests. Every preset × every widget is asserted so a new
 * widget forces an explicit decision for each preset.
 */

import { describe, it, expect } from 'vitest';
import {
  HUD_WIDGETS,
  PRESET_CYCLE,
  PRESET_WIDGETS,
  nextPreset,
  widgetVisibility,
} from '@game/hud/presets';
import type { HudPreset, HudWidget } from '@game/hud/types';

/** The authoritative expectation, written out independently of the source table. */
const EXPECTED: Record<HudPreset, Record<HudWidget, boolean>> = {
  full: {
    wind: true,
    speed: true,
    trim: true,
    heelHelm: true,
    compass: true,
    conditions: true,
    coaching: true,
  },
  moderate: {
    wind: true,
    speed: true,
    trim: false,
    heelHelm: false,
    compass: true,
    conditions: true,
    coaching: true,
  },
  minimal: {
    wind: true,
    speed: true,
    trim: false,
    heelHelm: false,
    compass: false,
    conditions: false,
    coaching: false,
  },
  none: {
    wind: false,
    speed: false,
    trim: false,
    heelHelm: false,
    compass: false,
    conditions: false,
    coaching: false,
  },
};

const PRESETS: HudPreset[] = ['full', 'moderate', 'minimal', 'none'];

describe('widgetVisibility — exhaustive', () => {
  for (const preset of PRESETS) {
    for (const widget of HUD_WIDGETS) {
      it(`${preset} / ${widget}`, () => {
        expect(widgetVisibility(preset)[widget]).toBe(EXPECTED[preset][widget]);
      });
    }
  }
});

describe('preset invariants', () => {
  it('each tier is a subset of the one above it (monotone decreasing)', () => {
    const order: HudPreset[] = ['full', 'moderate', 'minimal', 'none'];
    for (let i = 1; i < order.length; i++) {
      const prev = order[i - 1];
      const curr = order[i];
      if (prev === undefined || curr === undefined) throw new Error('bad order');
      const prevSet = new Set(PRESET_WIDGETS[prev]);
      for (const w of PRESET_WIDGETS[curr]) {
        expect(prevSet.has(w)).toBe(true);
      }
    }
  });

  it('none shows nothing', () => {
    expect(PRESET_WIDGETS.none).toHaveLength(0);
  });

  it('full shows every widget', () => {
    expect(new Set(PRESET_WIDGETS.full)).toEqual(new Set(HUD_WIDGETS));
  });
});

describe('nextPreset cycle', () => {
  it('cycles full → moderate → minimal → none → full', () => {
    expect(nextPreset('full')).toBe('moderate');
    expect(nextPreset('moderate')).toBe('minimal');
    expect(nextPreset('minimal')).toBe('none');
    expect(nextPreset('none')).toBe('full');
  });

  it('the cycle contains every preset exactly once', () => {
    expect(new Set(PRESET_CYCLE)).toEqual(new Set(PRESETS));
    expect(PRESET_CYCLE).toHaveLength(PRESETS.length);
  });
});
