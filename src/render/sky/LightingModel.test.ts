/**
 * Tests for LightingModel (F.1) — physically-grounded assertions on the derived
 * LightingState across a real sunrise-to-sunset sweep and a dense synthetic
 * sweep of elevations and cloud combinations.
 */

import { describe, it, expect } from 'vitest';
import type { SkyState } from '@/types';
import { computeSkyStateForVenue, createSkyState } from '@environment/SkyState';
import {
  computeLightingState,
  effectiveCloudCover,
  skyTint,
  _testing,
} from './LightingModel';
import { createLightingState } from '@render/lighting/LightingState';

const DEG = Math.PI / 180;

// Newport, RI on the 2023 summer solstice.
const NEWPORT_LAT = 41.49;
const NEWPORT_LON = -71.31;
// 2023-06-21T00:00:00Z epoch ms.
const SOLSTICE_UTC = Date.UTC(2023, 5, 21, 0, 0, 0);

/** Build a SkyState for Newport at a given UTC hour on the solstice. */
function newportSkyAtUtcHour(hour: number, clouds = { low: 0, mid: 0, high: 0 }): SkyState {
  const out = createSkyState();
  // computeSkyStateForVenue takes fetchedAt + sessionTime(s); use hour as session.
  return computeSkyStateForVenue(
    NEWPORT_LAT,
    NEWPORT_LON,
    SOLSTICE_UTC,
    hour * 3600,
    clouds.low,
    clouds.mid,
    clouds.high,
    out,
  );
}

const CLEAR = { solarRadiation: 0, visibility: 30000 };

function isFiniteRGB(c: { r: number; g: number; b: number }): boolean {
  return Number.isFinite(c.r) && Number.isFinite(c.g) && Number.isFinite(c.b);
}
function in01(c: { r: number; g: number; b: number }): boolean {
  return c.r >= 0 && c.r <= 1 && c.g >= 0 && c.g <= 1 && c.b >= 0 && c.b <= 1;
}

// ─── effectiveCloudCover ─────────────────────────────────────────────────────

describe('effectiveCloudCover', () => {
  it('is 0 for a clear sky and 1 for fully low-overcast', () => {
    expect(effectiveCloudCover(0, 0, 0)).toBe(0);
    expect(effectiveCloudCover(1, 0, 0)).toBeCloseTo(1, 10);
  });

  it('weights high cloud less than low cloud', () => {
    const low = effectiveCloudCover(0.5, 0, 0);
    const high = effectiveCloudCover(0, 0, 0.5);
    expect(high).toBeLessThan(low);
  });

  it('layers combine but stay within 0..1', () => {
    const n = effectiveCloudCover(0.6, 0.6, 0.6);
    expect(n).toBeGreaterThan(0.6);
    expect(n).toBeLessThanOrEqual(1);
  });
});

// ─── Sunrise-to-sunset sweep ─────────────────────────────────────────────────

describe('LightingModel — Newport solstice sweep (clear sky)', () => {
  // Sweep local daytime. Newport is UTC-4 in summer, so ~09:00–24:00 UTC spans
  // roughly 05:00–20:00 local. Collect only above-horizon samples.
  const hours: number[] = [];
  for (let h = 8; h <= 24; h++) hours.push(h);

  it('sun colour r/b ratio increases as elevation drops below ~30°', () => {
    // Gather (elevation, r/b) for samples with the sun up.
    const samples: Array<{ elev: number; rb: number }> = [];
    for (const h of hours) {
      const sky = newportSkyAtUtcHour(h);
      if (sky.sunElevation <= 0) continue;
      const L = computeLightingState(sky, CLEAR);
      samples.push({ elev: sky.sunElevation, rb: L.sunColor.r / Math.max(L.sunColor.b, 1e-6) });
    }
    expect(samples.length).toBeGreaterThan(3);
    // Restrict to low-sun region and sort by descending elevation; r/b must be
    // monotonically non-decreasing as the sun sinks.
    const low = samples
      .filter((s) => s.elev < 30 * DEG)
      .sort((a, b) => b.elev - a.elev);
    expect(low.length).toBeGreaterThan(2);
    for (let i = 1; i < low.length; i++) {
      const prev = low[i - 1];
      const cur = low[i];
      if (prev === undefined || cur === undefined) continue;
      // Allow a tiny epsilon for numeric wobble.
      expect(cur.rb).toBeGreaterThanOrEqual(prev.rb - 1e-6);
    }
  });

  it('zenith colour is blue-dominant at local midday', () => {
    // Find the highest-elevation sample.
    let best: SkyState | null = null;
    for (const h of hours) {
      const sky = newportSkyAtUtcHour(h);
      if (best === null || sky.sunElevation > best.sunElevation) best = sky;
    }
    expect(best).not.toBeNull();
    const L = computeLightingState(best as SkyState, CLEAR);
    expect(L.zenithColor.b).toBeGreaterThan(L.zenithColor.r);
    expect(L.zenithColor.b).toBeGreaterThan(L.zenithColor.g);
  });

  it('horizon colour is lighter (higher luminance) than zenith by day', () => {
    let best: SkyState | null = null;
    for (const h of hours) {
      const sky = newportSkyAtUtcHour(h);
      if (best === null || sky.sunElevation > best.sunElevation) best = sky;
    }
    const L = computeLightingState(best as SkyState, CLEAR);
    const lum = (c: { r: number; g: number; b: number }) =>
      0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    expect(lum(L.horizonColor)).toBeGreaterThan(lum(L.zenithColor));
  });

  it('nightFactor is monotone non-decreasing as the sun sets', () => {
    // Sample from local afternoon into night: UTC 20..28 (wrap via +24h session).
    const nightSamples: Array<{ elev: number; nf: number }> = [];
    for (let h = 20; h <= 30; h++) {
      const sky = newportSkyAtUtcHour(h);
      const L = computeLightingState(sky, CLEAR);
      nightSamples.push({ elev: sky.sunElevation, nf: L.nightFactor });
    }
    // Sort by descending elevation (i.e. progressing toward night).
    nightSamples.sort((a, b) => b.elev - a.elev);
    for (let i = 1; i < nightSamples.length; i++) {
      const prev = nightSamples[i - 1];
      const cur = nightSamples[i];
      if (prev === undefined || cur === undefined) continue;
      expect(cur.nf).toBeGreaterThanOrEqual(prev.nf - 1e-9);
    }
  });

  it('sunIlluminance is ~0 when the sun is well below the horizon', () => {
    const sky = newportSkyAtUtcHour(6); // pre-dawn local (UTC 06 ≈ 02 local)
    expect(sky.sunElevation).toBeLessThan(-5 * DEG);
    const L = computeLightingState(sky, CLEAR);
    expect(L.sunIlluminance).toBeLessThan(1e-3);
  });

  it('exposure rises at night relative to midday', () => {
    let best: SkyState | null = null;
    for (const h of hours) {
      const sky = newportSkyAtUtcHour(h);
      if (best === null || sky.sunElevation > best.sunElevation) best = sky;
    }
    const dayL = computeLightingState(best as SkyState, CLEAR);
    const night = newportSkyAtUtcHour(5); // deep night local
    const nightL = computeLightingState(night, CLEAR);
    expect(nightL.exposure).toBeGreaterThan(dayL.exposure);
    expect(dayL.exposure).toBeCloseTo(1.0, 1);
  });
});

// ─── Overcast behaviour ──────────────────────────────────────────────────────

describe('LightingModel — overcast', () => {
  it('strongly reduces sunIlluminance and desaturates the sky', () => {
    const skyClear = newportSkyAtUtcHour(16); // sun well up local afternoon
    const skyOvercast = newportSkyAtUtcHour(16, { low: 1, mid: 1, high: 0 });
    const clear = computeLightingState(skyClear, CLEAR);
    const overcast = computeLightingState(skyOvercast, CLEAR);

    expect(overcast.sunIlluminance).toBeLessThan(clear.sunIlluminance * 0.25);
    expect(overcast.overcast).toBeGreaterThan(0.9);

    // Desaturation: chroma of the zenith colour shrinks under overcast.
    const chroma = (c: { r: number; g: number; b: number }) =>
      Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
    expect(chroma(overcast.zenithColor)).toBeLessThan(chroma(clear.zenithColor));
  });
});

// ─── Dense finite/range sweep ────────────────────────────────────────────────

describe('LightingModel — dense sweep is always finite and colours in 0..1', () => {
  it('holds across elevations -90..90 and all cloud combos', () => {
    const out = createLightingState();
    const covers = [0, 0.3, 0.6, 1];
    for (let elevDeg = -90; elevDeg <= 90; elevDeg += 2.5) {
      const elev = elevDeg * DEG;
      for (const cl of covers) {
        for (const cm of covers) {
          for (const ch of covers) {
            const sky: SkyState = {
              sunDirection: { x: 0, y: Math.sin(elev), z: -Math.cos(elev) },
              sunElevation: elev,
              sunAzimuth: 0,
              moonDirection: { x: 0, y: 0, z: 1 },
              moonElevation: 0,
              moonPhase: 0,
              siderealTime: 0,
              cloudLow: cl,
              cloudMid: cm,
              cloudHigh: ch,
              isNight: elev < 0,
            };
            const L = computeLightingState(sky, { solarRadiation: 500, visibility: 5000 }, out);
            expect(isFiniteRGB(L.sunColor)).toBe(true);
            expect(in01(L.sunColor)).toBe(true);
            expect(in01(L.zenithColor)).toBe(true);
            expect(in01(L.horizonColor)).toBe(true);
            expect(in01(L.ambientColor)).toBe(true);
            expect(in01(L.fogColor)).toBe(true);
            expect(L.sunIlluminance).toBeGreaterThanOrEqual(0);
            expect(L.sunIlluminance).toBeLessThanOrEqual(1);
            expect(L.nightFactor).toBeGreaterThanOrEqual(0);
            expect(L.nightFactor).toBeLessThanOrEqual(1);
            expect(Number.isFinite(L.exposure)).toBe(true);
          }
        }
      }
    }
  });
});

// ─── solarRadiation clearness blend ──────────────────────────────────────────

describe('LightingModel — measured solarRadiation blend', () => {
  it('low measured radiation at high sun reduces illuminance vs clear model', () => {
    const sky = newportSkyAtUtcHour(16);
    expect(sky.sunElevation).toBeGreaterThan(15 * DEG);
    const noMeasure = computeLightingState(sky, { solarRadiation: 0, visibility: 30000 });
    const hazy = computeLightingState(sky, { solarRadiation: 120, visibility: 30000 });
    expect(hazy.sunIlluminance).toBeLessThan(noMeasure.sunIlluminance);
  });
});

// ─── skyTint ─────────────────────────────────────────────────────────────────

describe('skyTint', () => {
  it('biases the daytime zenith toward the venue sky base but leaves night alone', () => {
    const day = newportSkyAtUtcHour(16);
    const dayL = computeLightingState(day, CLEAR);
    const base = { r: 0.29, g: 0.6, b: 0.83 }; // Southern Clear-ish
    const tinted = skyTint(dayL, base, 0.6);
    // Moved toward the base in at least one channel.
    const moved =
      Math.abs(tinted.zenithColor.r - base.r) < Math.abs(dayL.zenithColor.r - base.r) ||
      Math.abs(tinted.zenithColor.g - base.g) < Math.abs(dayL.zenithColor.g - base.g);
    expect(moved).toBe(true);

    // At night the tint strength collapses.
    const night = newportSkyAtUtcHour(5);
    const nightL = computeLightingState(night, CLEAR);
    const nightTinted = skyTint(nightL, base, 1.0);
    expect(nightTinted.zenithColor.r).toBeCloseTo(nightL.zenithColor.r, 5);
    expect(nightTinted.zenithColor.b).toBeCloseTo(nightL.zenithColor.b, 5);
  });

  it('does not mutate the input lighting state', () => {
    const day = newportSkyAtUtcHour(16);
    const dayL = computeLightingState(day, CLEAR);
    const before = { ...dayL.zenithColor };
    skyTint(dayL, { r: 1, g: 0, b: 0 }, 1.0);
    expect(dayL.zenithColor).toEqual(before);
  });
});


// ─── Air mass monotonicity (Kasten–Young + monotone below-horizon extension) ──

describe('airMass — monotone non-decreasing as elevation falls', () => {
  const { airMass } = _testing;

  it('is finite and positive over +90..-18° in 0.25° steps', () => {
    for (let elevDeg = 90; elevDeg >= -18; elevDeg -= 0.25) {
      const m = airMass(elevDeg * DEG);
      expect(Number.isFinite(m)).toBe(true);
      expect(m).toBeGreaterThan(0);
    }
  });

  it('never decreases as the sun sinks (no below-horizon collapse)', () => {
    // Sweep from high sun down past the horizon. Air mass must be monotone
    // non-decreasing — the old Kasten–Young extrapolation peaked near -1.76°
    // then collapsed (37.9 @ 0°, 40(cap) @ -1°, 35.8 @ -3°, 2.79 @ -5°, 0.03
    // @ -6°), which is the bug this guards against.
    let prev = -Infinity;
    for (let elevDeg = 90; elevDeg >= -18; elevDeg -= 0.25) {
      const m = airMass(elevDeg * DEG);
      expect(m).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = m;
    }
  });

  it('holds flat below the fit peak rather than collapsing', () => {
    // Well below the horizon the value is the held peak, not a small number.
    expect(airMass(-10 * DEG)).toBeGreaterThan(60);
    expect(airMass(-10 * DEG)).toBeCloseTo(airMass(-6 * DEG), 6);
  });
});

// ─── sunColor reddening is monotone INCLUDING below the horizon ───────────────

describe('sunColor — r/b ratio monotone as elevation falls, +90..-18°', () => {
  function skyAtElevation(elevDeg: number): SkyState {
    const elev = elevDeg * DEG;
    return {
      sunDirection: { x: 0, y: Math.sin(elev), z: -Math.cos(elev) },
      sunElevation: elev,
      sunAzimuth: 0,
      moonDirection: { x: 0, y: 0, z: 1 },
      moonElevation: 0,
      moonPhase: 0,
      siderealTime: 0,
      cloudLow: 0,
      cloudMid: 0,
      cloudHigh: 0,
      isNight: elev < 0,
    };
  }

  it('r/b never decreases as elevation drops (no re-whiten / blue below horizon)', () => {
    let prevRB = -Infinity;
    for (let elevDeg = 90; elevDeg >= -18; elevDeg -= 0.25) {
      const L = computeLightingState(skyAtElevation(elevDeg), CLEAR);
      const rb = L.sunColor.r / Math.max(L.sunColor.b, 1e-6);
      expect(rb).toBeGreaterThanOrEqual(prevRB - 1e-6);
      prevRB = rb;
    }
  });

  it('sunColor channels remain within 0..1 across the full range', () => {
    for (let elevDeg = 90; elevDeg >= -18; elevDeg -= 0.25) {
      const L = computeLightingState(skyAtElevation(elevDeg), CLEAR);
      expect(in01(L.sunColor)).toBe(true);
      expect(isFiniteRGB(L.sunColor)).toBe(true);
    }
  });
});


// ─── Clear-noon blue sky + overcast grey (regression: FixSkyLook) ────────────
//
// Guards the two defects fixed in the FixSkyLook pass:
//   (1) a clear midday sky must read as a CLEAR BLUE at the zenith (it had been
//       rendering as a flat dull grey). We assert the derived zenith colour is
//       strongly blue-dominant and lands near the art-direction target
//       (docs/art-direction.md: zenith ~ sRGB (70,120,200), i.e. linear ~
//       (0.06, 0.18, 0.55)), with a paler horizon.
//   (2) a fully-overcast sky must stay FLAT NEUTRAL GREY (no blue enrichment
//       may leak into it).
//
// These assert NUMERIC colour properties, not merely that the code runs.

describe('LightingModel — clear noon is a saturated blue (FixSkyLook regression)', () => {
  const DEG2 = Math.PI / 180;

  // Synthetic clear, high sun (like the smoke harness "noon": Newport, sun ~65°,
  // scattered fair-weather cloud 0.2/0/0.1).
  function clearNoonSky(): SkyState {
    const elev = 65 * DEG2;
    return {
      sunDirection: { x: 0, y: Math.sin(elev), z: -Math.cos(elev) },
      sunElevation: elev,
      sunAzimuth: 0,
      moonDirection: { x: 0, y: 0, z: 1 },
      moonElevation: 0,
      moonPhase: 0,
      siderealTime: 0,
      cloudLow: 0.2,
      cloudMid: 0,
      cloudHigh: 0.1,
      isNight: false,
    };
  }

  const luma = (c: { r: number; g: number; b: number }) =>
    0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

  it('zenith is strongly blue-dominant (not a dull grey)', () => {
    const L = computeLightingState(clearNoonSky(), { solarRadiation: 600, visibility: 30000 });
    const z = L.zenithColor;
    // Blue clearly dominates both other channels (a grey would have r≈g≈b).
    expect(z.b).toBeGreaterThan(z.g);
    expect(z.g).toBeGreaterThan(z.r);
    // Strong blue dominance: blue is at least ~2.5× the red (a grey is ~1×).
    expect(z.b / Math.max(z.r, 1e-6)).toBeGreaterThan(2.5);
  });

  it('zenith lands near the art-direction target linear ~(0.06,0.18,0.55)', () => {
    const L = computeLightingState(clearNoonSky(), { solarRadiation: 600, visibility: 30000 });
    const z = L.zenithColor;
    // Within a generous band around the target so the test is robust to small
    // tuning changes but still fails if the sky reverts to grey/black.
    expect(z.r).toBeGreaterThanOrEqual(0.0);
    expect(z.r).toBeLessThan(0.15);
    expect(z.g).toBeGreaterThan(0.08);
    expect(z.g).toBeLessThan(0.3);
    expect(z.b).toBeGreaterThan(0.38);
    expect(z.b).toBeLessThanOrEqual(1.0);
  });

  it('horizon is paler (higher luminance, lower blue-saturation) than the zenith', () => {
    const L = computeLightingState(clearNoonSky(), { solarRadiation: 600, visibility: 30000 });
    expect(luma(L.horizonColor)).toBeGreaterThan(luma(L.zenithColor));
    const sat = (c: { r: number; g: number; b: number }) =>
      (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / Math.max(c.r, c.g, c.b, 1e-6);
    expect(sat(L.horizonColor)).toBeLessThan(sat(L.zenithColor));
  });

  it('scattered fair-weather cloud (0.2/0/0.1) does NOT grey the sky much', () => {
    // The effective cover here is ~0.23; the quadratic greying must keep the
    // sky clearly blue (this is the "clear" noon case, not overcast).
    const L = computeLightingState(clearNoonSky(), { solarRadiation: 600, visibility: 30000 });
    expect(L.overcast).toBeLessThan(0.35);
    // Still blue-dominant despite the scattered cloud.
    expect(L.zenithColor.b / Math.max(L.zenithColor.r, 1e-6)).toBeGreaterThan(2.5);
  });
});

describe('LightingModel — overcast stays flat neutral grey (FixSkyLook regression)', () => {
  const DEG3 = Math.PI / 180;
  function fullOvercastSky(): SkyState {
    const elev = 55 * DEG3;
    return {
      sunDirection: { x: 0, y: Math.sin(elev), z: -Math.cos(elev) },
      sunElevation: elev,
      sunAzimuth: 0,
      moonDirection: { x: 0, y: 0, z: 1 },
      moonElevation: 0,
      moonPhase: 0,
      siderealTime: 0,
      cloudLow: 1,
      cloudMid: 1,
      cloudHigh: 1,
      isNight: false,
    };
  }

  it('zenith and horizon are near-neutral grey (chroma ~ 0, no blue leak)', () => {
    const L = computeLightingState(fullOvercastSky(), { solarRadiation: 150, visibility: 8000 });
    expect(L.overcast).toBeGreaterThan(0.95);
    const chroma = (c: { r: number; g: number; b: number }) =>
      Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
    // Flat grey: the clear-sky blue enrichment must be fully gated off here.
    expect(chroma(L.zenithColor)).toBeLessThan(0.02);
    expect(chroma(L.horizonColor)).toBeLessThan(0.02);
  });
});
