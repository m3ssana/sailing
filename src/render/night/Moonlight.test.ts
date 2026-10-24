import { describe, it, expect } from 'vitest';
import {
  computeMoonlight,
  moonGlitterParams,
  moonTerminator,
  FULL_MOON_ZENITH_RELATIVE,
  type MoonlightSkyInput,
} from './Moonlight';
import { createLightingState, type LightingState } from '../lighting/LightingState';

const DEG = Math.PI / 180;

function nightLighting(overrides: Partial<LightingState> = {}): LightingState {
  const l = createLightingState();
  l.nightFactor = 1;
  l.overcast = 0;
  return { ...l, ...overrides };
}

/** Moon high in the sky, given phase. */
function sky(elevationDeg: number, phase: number): MoonlightSkyInput {
  const el = elevationDeg * DEG;
  return {
    moonElevation: el,
    moonPhase: phase,
    moonDirection: { x: 0, y: Math.sin(el), z: -Math.cos(el) },
  };
}

describe('computeMoonlight — horizon gate', () => {
  it('is zero below the horizon', () => {
    const m = computeMoonlight(sky(-5, 1), nightLighting());
    expect(m.moonIlluminance).toBe(0);
  });

  it('is zero exactly at the horizon', () => {
    const m = computeMoonlight(sky(0, 1), nightLighting());
    expect(m.moonIlluminance).toBe(0);
  });

  it('fades in smoothly over the first ~2 degrees', () => {
    const atHalfDeg = computeMoonlight(sky(0.5, 1), nightLighting()).moonIlluminance;
    const at1Deg = computeMoonlight(sky(1, 1), nightLighting()).moonIlluminance;
    const at2Deg = computeMoonlight(sky(2, 1), nightLighting()).moonIlluminance;
    expect(atHalfDeg).toBeGreaterThan(0);
    expect(at1Deg).toBeGreaterThan(atHalfDeg);
    expect(at2Deg).toBeGreaterThan(at1Deg);
  });
});

describe('computeMoonlight — monotone with elevation', () => {
  it('increases with elevation up to the zenith', () => {
    let prev = -1;
    for (let el = 3; el <= 90; el += 3) {
      const m = computeMoonlight(sky(el, 1), nightLighting()).moonIlluminance;
      expect(m).toBeGreaterThan(prev);
      prev = m;
    }
  });

  it('full moon at zenith sits inside the documented artistic-lift band', () => {
    const m = computeMoonlight(sky(90, 1), nightLighting()).moonIlluminance;
    // FULL_MOON_ZENITH_RELATIVE is the cap; sin(90)=1, all other factors 1.
    expect(m).toBeCloseTo(FULL_MOON_ZENITH_RELATIVE, 6);
    expect(m).toBeGreaterThanOrEqual(0.01);
    expect(m).toBeLessThanOrEqual(0.03);
  });
});

describe('computeMoonlight — monotone with phase', () => {
  it('full moon brighter than new moon', () => {
    const full = computeMoonlight(sky(45, 1), nightLighting()).moonIlluminance;
    const neww = computeMoonlight(sky(45, 0), nightLighting()).moonIlluminance;
    expect(full).toBeGreaterThan(neww);
    expect(neww).toBe(0);
  });

  it('brightness is monotone increasing in illuminated fraction', () => {
    let prev = -1;
    for (let f = 0; f <= 1.0001; f += 0.1) {
      const m = computeMoonlight(sky(45, Math.min(1, f)), nightLighting()).moonIlluminance;
      expect(m).toBeGreaterThanOrEqual(prev);
      prev = m;
    }
  });

  it('falls faster than linear (quarter moon well below half brightness)', () => {
    const full = computeMoonlight(sky(45, 1), nightLighting()).moonIlluminance;
    const quarter = computeMoonlight(sky(45, 0.5), nightLighting()).moonIlluminance;
    // With exponent 2.0, quarter ≈ 0.25 of full — definitely < 0.5.
    expect(quarter / full).toBeLessThan(0.5);
    expect(quarter / full).toBeGreaterThan(0.1);
  });
});

describe('computeMoonlight — attenuation', () => {
  it('fades with overcast', () => {
    const clear = computeMoonlight(sky(45, 1), nightLighting({ overcast: 0 })).moonIlluminance;
    const partial = computeMoonlight(sky(45, 1), nightLighting({ overcast: 0.5 })).moonIlluminance;
    const heavy = computeMoonlight(sky(45, 1), nightLighting({ overcast: 1 })).moonIlluminance;
    expect(partial).toBeLessThan(clear);
    expect(heavy).toBeLessThan(partial);
  });

  it('fades with daylight (nightFactor)', () => {
    const night = computeMoonlight(sky(45, 1), nightLighting({ nightFactor: 1 })).moonIlluminance;
    const dusk = computeMoonlight(sky(45, 1), nightLighting({ nightFactor: 0.5 })).moonIlluminance;
    const day = computeMoonlight(sky(45, 1), nightLighting({ nightFactor: 0 })).moonIlluminance;
    expect(dusk).toBeLessThan(night);
    expect(day).toBe(0);
  });

  it('returns the cool blue-white tint when lit', () => {
    const m = computeMoonlight(sky(45, 1), nightLighting());
    expect(m.moonColor.b).toBeGreaterThan(m.moonColor.r);
    expect(m.moonColor.b).toBeGreaterThan(m.moonColor.g);
  });

  it('reuses the out param without allocating', () => {
    const out = { moonColor: { r: 0, g: 0, b: 0 }, moonIlluminance: 0 };
    const m = computeMoonlight(sky(45, 1), nightLighting(), out);
    expect(m).toBe(out);
  });
});

describe('moonGlitterParams', () => {
  it('scales intensity with illuminance, full moon ~1', () => {
    const full = moonGlitterParams(computeMoonlight(sky(90, 1), nightLighting()));
    expect(full.intensity).toBeCloseTo(1, 3);
    const none = moonGlitterParams(computeMoonlight(sky(-5, 1), nightLighting()));
    expect(none.intensity).toBe(0);
  });

  it('has a broader roughness than the sun glitter (0.03)', () => {
    const g = moonGlitterParams(computeMoonlight(sky(45, 1), nightLighting()));
    expect(g.roughness).toBeGreaterThan(0.03);
  });
});

describe('moonTerminator', () => {
  it('new moon → +1 (dark), full → -1 (lit), half → 0', () => {
    expect(moonTerminator(0)).toBeCloseTo(1, 6);
    expect(moonTerminator(1)).toBeCloseTo(-1, 6);
    expect(moonTerminator(0.5)).toBeCloseTo(0, 6);
  });

  it('is monotone decreasing in phase', () => {
    let prev = 2;
    for (let f = 0; f <= 1.0001; f += 0.1) {
      const t = moonTerminator(Math.min(1, f));
      expect(t).toBeLessThanOrEqual(prev);
      prev = t;
    }
  });
});

describe('computeMoonlight — NaN poisoning guards (audit fix #3)', () => {
  it('never returns NaN illuminance for a non-finite phase/overcast/night', () => {
    const nanPhase = computeMoonlight(sky(45, NaN), nightLighting());
    expect(Number.isNaN(nanPhase.moonIlluminance)).toBe(false);
    const nanOvercast = computeMoonlight(sky(45, 1), nightLighting({ overcast: NaN }));
    expect(Number.isNaN(nanOvercast.moonIlluminance)).toBe(false);
    const nanNight = computeMoonlight(sky(45, 1), nightLighting({ nightFactor: NaN }));
    expect(Number.isNaN(nanNight.moonIlluminance)).toBe(false);
  });

  it('a NaN moon elevation collapses to zero illuminance, not NaN', () => {
    const m = computeMoonlight(sky(NaN, 1), nightLighting());
    expect(m.moonIlluminance).toBe(0);
  });
});
