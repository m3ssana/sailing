/**
 * Tests for buildHudViewModel: wiring, data-source semantics for every
 * WeatherSource, unit selection, allocation-free reuse, and distance unit
 * switching.
 */

import { describe, it, expect } from 'vitest';
import { buildHudViewModel, createHudViewModel, SHORT_DISTANCE_METRES } from '@game/hud/HudViewModel';
import type { HudInput } from '@game/hud/types';
import type { WeatherSource } from '@/types/weather';
import { UNITS } from '@/types/units';

const DEG = Math.PI / 180;

function baseInput(overrides: Partial<HudInput> = {}): HudInput {
  const input: HudInput = {
    boat: {
      heading: 45 * DEG,
      heel: 10 * DEG,
      pitch: 2 * DEG,
      speed: 3,
      helmLoad: 0.4,
      capsized: false,
      position: { x: 0, y: 0, z: 0 },
    },
    controls: {
      mainsheet: 0.7,
      jibsheet: 0.6,
      traveller: -0.2,
      board: 1,
      rudder: 0.1,
      vang: 0.5,
    },
    trueWind: { speed: 6, fromBearing: 0 },
    apparentWind: { speed: 9, angle: 30 * DEG },
    courseOverGround: 45 * DEG,
    speedOverGround: 3,
    weatherSource: 'live',
    visibility: 15000,
    current: { speed: 0.4, towardsBearing: 340 * DEG },
    targetSpeed: () => 4,
    nextMark: { id: 'windward', position: { x: 0, y: -500 } },
    sails: [{ sailId: 'main', attachment: 0.9, luffing: false }],
    coaching: { id: 'pinch', message: 'Bear away 5°', severity: 0.6 },
    preset: 'full',
    units: 'knotsNm',
    opaqueBackdrop: false,
  };
  return { ...input, ...overrides };
}

describe('buildHudViewModel — wiring', () => {
  it('converts speeds to knots when units are knotsNm', () => {
    const vm = buildHudViewModel(baseInput());
    expect(vm.speed.sog.mps).toBe(3);
    expect(vm.speed.sog.display).toBeCloseTo(3 * UNITS.MS_TO_KNOTS, 12);
    expect(vm.wind.trueSpeed.display).toBeCloseTo(6 * UNITS.MS_TO_KNOTS, 12);
  });

  it('keeps SI when units are metricSI', () => {
    const vm = buildHudViewModel(baseInput({ units: 'metricSI' }));
    expect(vm.speed.sog.display).toBe(3);
  });

  it('derives the true wind angle off the bow (heading 045, wind from 000 → −45)', () => {
    const vm = buildHudViewModel(baseInput());
    expect(vm.wind.trueAngle).toBeCloseTo(-45 * DEG, 12);
    // wind over the port bow → port tack.
    expect(vm.wind.tack).toBe('port');
    expect(vm.wind.pointOfSail).toBe('close-hauled');
  });

  it('carries the physics apparent wind through unchanged', () => {
    const vm = buildHudViewModel(baseInput());
    expect(vm.wind.apparentAngle).toBeCloseTo(30 * DEG, 12);
    expect(vm.wind.apparentSpeed.mps).toBe(9);
  });

  it('computes VMG from SOG, COG and the wind', () => {
    // COG 045, wind from 000, SOG 3 → upwind VMG = 3·cos45.
    const vm = buildHudViewModel(baseInput());
    expect(vm.speed.vmgUpwind.mps).toBeCloseTo(3 * Math.cos(45 * DEG), 12);
  });

  it('computes target fraction against the polar', () => {
    const vm = buildHudViewModel(baseInput({ targetSpeed: () => 4 }));
    expect(vm.speed.targetFraction).toBeCloseTo(3 / 4, 12);
  });

  it('copies trim controls and sail aero state', () => {
    const vm = buildHudViewModel(baseInput());
    expect(vm.trim.mainsheet).toBe(0.7);
    expect(vm.trim.board).toBe(1);
    expect(vm.trim.sails[0]?.attachment).toBe(0.9);
  });

  it('carries heel / pitch / helm load / capsized', () => {
    const vm = buildHudViewModel(baseInput({ boat: { ...baseInput().boat, capsized: true } }));
    expect(vm.heelHelm.heel).toBeCloseTo(10 * DEG, 12);
    expect(vm.heelHelm.helmLoad).toBe(0.4);
    expect(vm.heelHelm.capsized).toBe(true);
  });

  it('computes bearing and distance to the next mark', () => {
    // Boat at origin, mark due north (x0, y−500) → bearing 000, distance 500 m.
    const vm = buildHudViewModel(baseInput());
    expect(vm.compass.bearingToMark).toBeCloseTo(0, 12);
    expect(vm.compass.distanceToMark?.metres).toBeCloseTo(500, 12);
    // 500 m < 1000 m short-distance threshold → shown in metres under knots/NM.
    expect(vm.compass.distanceToMark?.unit).toBe('m');
    expect(vm.compass.markId).toBe('windward');
  });

  it('nulls mark fields when there is no next mark', () => {
    const vm = buildHudViewModel(baseInput({ nextMark: null }));
    expect(vm.compass.bearingToMark).toBeNull();
    expect(vm.compass.distanceToMark).toBeNull();
    expect(vm.compass.markId).toBeNull();
  });

  it('applies the preset visibility table', () => {
    const vm = buildHudViewModel(baseInput({ preset: 'minimal' }));
    expect(vm.visible.wind).toBe(true);
    expect(vm.visible.speed).toBe(true);
    expect(vm.visible.compass).toBe(false);
    expect(vm.visible.trim).toBe(false);
  });

  it('passes the coaching hint through, and nulls it when absent', () => {
    const withHint = buildHudViewModel(baseInput());
    expect(withHint.coaching?.message).toBe('Bear away 5°');
    const without = buildHudViewModel(baseInput({ coaching: null }));
    expect(without.coaching).toBeNull();
  });
});

describe('distance unit selection', () => {
  it('long distances read in nm under knots/NM', () => {
    const vm = buildHudViewModel(
      baseInput({ nextMark: { id: 'w', position: { x: 0, y: -2000 } } }),
    );
    expect(vm.compass.distanceToMark?.unit).toBe('nm');
    expect(vm.compass.distanceToMark?.display).toBeCloseTo(2000 * UNITS.M_TO_NM, 12);
  });

  it('switches to metres exactly at the short-distance threshold', () => {
    const justUnder = buildHudViewModel(
      baseInput({ nextMark: { id: 'w', position: { x: 0, y: -(SHORT_DISTANCE_METRES - 1) } } }),
    );
    expect(justUnder.compass.distanceToMark?.unit).toBe('m');
  });

  it('metric uses km for long distances', () => {
    const vm = buildHudViewModel(
      baseInput({ units: 'metricSI', nextMark: { id: 'w', position: { x: 0, y: -2000 } } }),
    );
    expect(vm.compass.distanceToMark?.unit).toBe('km');
    expect(vm.compass.distanceToMark?.display).toBeCloseTo(2, 12);
  });
});

describe('data-source semantics for every WeatherSource', () => {
  const sources: WeatherSource[] = ['live', 'cache', 'climatology', 'default', 'sandbox'];
  for (const source of sources) {
    it(`${source}: carries source and marks simulated only for sandbox`, () => {
      const vm = buildHudViewModel(baseInput({ weatherSource: source }));
      expect(vm.conditions.source).toBe(source);
      expect(vm.conditions.simulated).toBe(source === 'sandbox');
    });
  }
});

describe('allocation-free reuse', () => {
  it('mutates the provided out object and keeps nested references stable', () => {
    const out = createHudViewModel();
    const sogRef = out.speed.sog;
    const windSpeedRef = out.wind.trueSpeed;
    const visibleRef = out.visible;
    const r1 = buildHudViewModel(baseInput(), out);
    expect(r1).toBe(out);
    // Nested readout objects are reused, not replaced.
    expect(r1.speed.sog).toBe(sogRef);
    expect(r1.wind.trueSpeed).toBe(windSpeedRef);
    expect(r1.visible).toBe(visibleRef);

    // A second build with changed values updates in place, same references.
    const r2 = buildHudViewModel(baseInput({ speedOverGround: 5 }), out);
    expect(r2.speed.sog).toBe(sogRef);
    expect(r2.speed.sog.mps).toBe(5);
  });

  it('reuses the distance readout object across frames when a mark persists', () => {
    const out = createHudViewModel();
    buildHudViewModel(baseInput(), out);
    const distRef = out.compass.distanceToMark;
    expect(distRef).not.toBeNull();
    buildHudViewModel(baseInput(), out);
    expect(out.compass.distanceToMark).toBe(distRef);
  });

  it('reuses the coaching object when the hint id is unchanged', () => {
    const out = createHudViewModel();
    buildHudViewModel(baseInput(), out);
    const coachRef = out.coaching;
    expect(coachRef).not.toBeNull();
    buildHudViewModel(baseInput({ coaching: { id: 'pinch', message: 'updated', severity: 0.9 } }), out);
    expect(out.coaching).toBe(coachRef);
    expect(out.coaching?.message).toBe('updated');
  });
});
