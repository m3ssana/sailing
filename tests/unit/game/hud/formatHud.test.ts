/**
 * Tests for the pure formatting layer: knots, degrees, nm/m, percentages,
 * SIMULATED badge. Exact string outputs are asserted (6.2 kt, 045°, 0.32 nm).
 */

import { describe, it, expect } from 'vitest';
import {
  formatBearing,
  formatDistance,
  formatHud,
  formatPercent,
  formatRelativeAngle,
  formatSpeed,
  speedUnitLabel,
} from '@game/hud/formatHud';
import { buildHudViewModel, createHudViewModel } from '@game/hud/HudViewModel';
import type { HudInput } from '@game/hud/types';
import { UNITS } from '@/types/units';

const DEG = Math.PI / 180;

describe('formatSpeed', () => {
  it('formats m/s → knots with one decimal and a kt unit', () => {
    // 3.17 m/s = 6.16 kt → "6.2 kt".
    const readout = { mps: 3.17, display: 3.17 * UNITS.MS_TO_KNOTS };
    expect(formatSpeed(readout, 'knotsNm')).toBe('6.2 kt');
  });

  it('uses m/s label under metric', () => {
    expect(speedUnitLabel('metricSI')).toBe('m/s');
    expect(formatSpeed({ mps: 5, display: 5 }, 'metricSI')).toBe('5.0 m/s');
  });
});

describe('formatBearing', () => {
  it('zero-pads to three digits with a degree sign', () => {
    expect(formatBearing(45 * DEG)).toBe('045°');
    expect(formatBearing(0)).toBe('000°');
    expect(formatBearing(5 * DEG)).toBe('005°');
    expect(formatBearing(123 * DEG)).toBe('123°');
  });

  it('wraps 360 to 000 and handles negatives', () => {
    expect(formatBearing(360 * DEG)).toBe('000°');
    expect(formatBearing(-10 * DEG)).toBe('350°');
  });
});

describe('formatRelativeAngle', () => {
  it('suffixes S for starboard (positive) and P for port (negative)', () => {
    expect(formatRelativeAngle(45 * DEG)).toBe('45° S');
    expect(formatRelativeAngle(-30 * DEG)).toBe('30° P');
  });
});

describe('formatDistance', () => {
  it('formats nm to two decimals', () => {
    // 592.6 m = 0.32 nm.
    expect(formatDistance({ metres: 592.6, display: 592.6 * UNITS.M_TO_NM, unit: 'nm' })).toBe(
      '0.32 nm',
    );
  });

  it('formats metres as a rounded integer', () => {
    expect(formatDistance({ metres: 250.4, display: 250.4, unit: 'm' })).toBe('250 m');
  });

  it('formats km to one decimal', () => {
    expect(formatDistance({ metres: 1400, display: 1.4, unit: 'km' })).toBe('1.4 km');
  });
});

describe('formatPercent', () => {
  it('rounds a fraction to a whole percentage', () => {
    expect(formatPercent(0.617)).toBe('62%');
    expect(formatPercent(1.2)).toBe('120%');
  });
});

describe('formatHud bundle', () => {
  function input(overrides: Partial<HudInput> = {}): HudInput {
    const i: HudInput = {
      boat: { heading: 0, heel: 0, pitch: 0, speed: 3, helmLoad: 0, capsized: false, position: { x: 0, y: 0, z: 0 } },
      controls: { mainsheet: 0, jibsheet: 0, traveller: 0, board: 0, rudder: 0, vang: 0 },
      trueWind: { speed: 6, fromBearing: 45 * DEG },
      apparentWind: { speed: 9, angle: 20 * DEG },
      courseOverGround: 0,
      speedOverGround: 3,
      weatherSource: 'live',
      visibility: 10000,
      current: { speed: 0.4, towardsBearing: 90 * DEG },
      targetSpeed: () => 4,
      nextMark: { id: 'w', position: { x: 0, y: -500 } },
      preset: 'full',
      units: 'knotsNm',
      opaqueBackdrop: false,
    };
    return { ...i, ...overrides };
  }

  it('produces a complete string bundle', () => {
    const vm = buildHudViewModel(input());
    const s = formatHud(vm);
    expect(s.heading).toBe('000°');
    expect(s.sog).toBe('5.8 kt'); // 3 m/s = 5.83 kt
    expect(s.distanceToMark).toBe('500 m');
    expect(s.simulatedBadge).toBe('');
  });

  it('shows SIMULATED only for sandbox', () => {
    const live = formatHud(buildHudViewModel(input({ weatherSource: 'live' })));
    expect(live.simulatedBadge).toBe('');
    const sandbox = formatHud(buildHudViewModel(input({ weatherSource: 'sandbox' })));
    expect(sandbox.simulatedBadge).toBe('SIMULATED');
  });

  it('nulls mark strings when no mark', () => {
    const s = formatHud(buildHudViewModel(input({ nextMark: null })));
    expect(s.bearingToMark).toBeNull();
    expect(s.distanceToMark).toBeNull();
  });

  it('formats a default empty view model without throwing', () => {
    const s = formatHud(createHudViewModel());
    expect(s.sog).toBe('0.0 kt');
    expect(s.heading).toBe('000°');
  });
});
