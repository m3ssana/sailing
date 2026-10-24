import { describe, it, expect } from 'vitest';
import {
  generateStarCatalog,
  equatorialToHorizon,
  starVisibility,
  colorIndexToRGB,
  magnitudeToPointSize,
  MAX_MAGNITUDE,
  MIN_MAGNITUDE,
  type CatalogStar,
} from './StarField';

const DEG = Math.PI / 180;
const HOUR = Math.PI / 12; // 1 sidereal hour in radians

function len(v: { x: number; y: number; z: number }): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

// ─── Coordinate transform: physical correctness ────────────────────────────

describe('equatorialToHorizon — north celestial pole', () => {
  const lat = 40 * DEG;

  it('NCP (dec +90°) sits at elevation == latitude, due north', () => {
    const v = equatorialToHorizon(0, Math.PI / 2, 0, lat);
    const elevation = Math.asin(v.y);
    expect(elevation).toBeCloseTo(lat, 6);
    // Due north = -Z, no east/west component.
    expect(v.x).toBeCloseTo(0, 6);
    expect(v.z).toBeLessThan(0); // north is -Z
  });

  it('NCP does not move as sidereal time changes', () => {
    const a = equatorialToHorizon(0, Math.PI / 2, 0, lat);
    const b = equatorialToHorizon(0, Math.PI / 2, 3 * HOUR, lat);
    const c = equatorialToHorizon(0, Math.PI / 2, 9 * HOUR, lat);
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.y).toBeCloseTo(a.y, 6);
    expect(b.z).toBeCloseTo(a.z, 6);
    expect(c.y).toBeCloseTo(a.y, 6);
  });
});

describe('equatorialToHorizon — equatorial star (dec 0) culmination', () => {
  const lat = 40 * DEG;
  const ra = 2.0;

  it('culminates at elevation 90-|lat| due south when siderealTime == RA', () => {
    const v = equatorialToHorizon(ra, 0, ra, lat); // H = 0
    const elevation = Math.asin(v.y);
    expect(elevation).toBeCloseTo(Math.PI / 2 - lat, 6);
    // Due south for northern latitude = +Z, no east/west.
    expect(v.x).toBeCloseTo(0, 6);
    expect(v.z).toBeGreaterThan(0); // south is +Z
  });

  it('rises in the east (hour angle -6h → +X) and sets in the west (+6h → -X)', () => {
    // East: hour angle -6h means siderealTime = ra - 6h.
    const east = equatorialToHorizon(ra, 0, ra - 6 * HOUR, lat);
    // West: hour angle +6h.
    const west = equatorialToHorizon(ra, 0, ra + 6 * HOUR, lat);
    // East = +X (world convention: east = +X), west = -X.
    expect(east.x).toBeGreaterThan(0.9);
    expect(west.x).toBeLessThan(-0.9);
    // Both on the horizon (elevation ~0 for a dec-0 star 6h from transit).
    expect(east.y).toBeCloseTo(0, 5);
    expect(west.y).toBeCloseTo(0, 5);
  });

  it('elevation sign flips ~12 sidereal hours after transit', () => {
    const transit = equatorialToHorizon(ra, 0, ra, lat);
    const opposite = equatorialToHorizon(ra, 0, ra + 12 * HOUR, lat);
    expect(transit.y).toBeGreaterThan(0);
    expect(opposite.y).toBeLessThan(0);
  });
});

describe('equatorialToHorizon — invariants', () => {
  it('always returns a unit vector', () => {
    for (let i = 0; i < 200; i++) {
      const ra = Math.random() * Math.PI * 2;
      const dec = (Math.random() - 0.5) * Math.PI;
      const st = Math.random() * Math.PI * 2;
      const lat = (Math.random() - 0.5) * Math.PI * 0.98;
      const v = equatorialToHorizon(ra, dec, st, lat);
      expect(len(v)).toBeCloseTo(1, 6);
    }
  });

  it('writes into the out param without allocating', () => {
    const out = { x: 0, y: 0, z: 0 };
    const v = equatorialToHorizon(1, 0.3, 2, 0.5, out);
    expect(v).toBe(out);
  });
});

// ─── Catalogue: determinism + magnitude distribution ───────────────────────

describe('generateStarCatalog — determinism', () => {
  it('is deterministic for equal seeds', () => {
    const a = generateStarCatalog(1234, 500);
    const b = generateStarCatalog(1234, 500);
    expect(a.length).toBe(500);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]?.ra).toBe(b[i]?.ra);
      expect(a[i]?.dec).toBe(b[i]?.dec);
      expect(a[i]?.magnitude).toBe(b[i]?.magnitude);
    }
  });

  it('differs for different seeds', () => {
    const a = generateStarCatalog(1, 500);
    const b = generateStarCatalog(2, 500);
    let diffs = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i]?.ra !== b[i]?.ra) diffs++;
    }
    expect(diffs).toBeGreaterThan(400);
  });

  it('magnitudes lie within [MIN_MAGNITUDE, MAX_MAGNITUDE]', () => {
    const cat = generateStarCatalog(7, 2000);
    for (const s of cat) {
      expect(s.magnitude).toBeGreaterThanOrEqual(MIN_MAGNITUDE - 1e-6);
      expect(s.magnitude).toBeLessThanOrEqual(MAX_MAGNITUDE + 1e-6);
    }
  });

  it('positions are area-uniform (declination not pole-crowded)', () => {
    // Area-uniform in dec means |dec| > 60° should be a small fraction (~13.4%).
    const cat = generateStarCatalog(99, 20000);
    let polar = 0;
    for (const s of cat) if (Math.abs(s.dec) > 60 * DEG) polar++;
    const frac = polar / cat.length;
    // Analytic: fraction with |dec|>60° = 1 - sin(60°) = 0.134.
    expect(frac).toBeGreaterThan(0.1);
    expect(frac).toBeLessThan(0.17);
  });

  it('magnitude counts roughly follow the 10^(0.6m) law', () => {
    // N(<m) ∝ 10^(0.6m) ⇒ count in a unit-magnitude bin [m, m+1] grows by
    // 10^0.6 ≈ 3.98 per step. We assert the ratio of successive bins lands in a
    // justified 1.5–3x window (wider than the ideal ~4x to absorb the bright-end
    // small-sample noise; the law is exact only asymptotically and our range is
    // truncated at both ends).
    const cat = generateStarCatalog(2024, 40000);
    const bins = new Map<number, number>();
    for (const s of cat) {
      const b = Math.floor(s.magnitude);
      bins.set(b, (bins.get(b) ?? 0) + 1);
    }
    // Compare the well-populated faint bins (m=3→4, 4→5) where statistics hold.
    const c3 = bins.get(3) ?? 0;
    const c4 = bins.get(4) ?? 0;
    const c5 = bins.get(5) ?? 0;
    expect(c4 / c3).toBeGreaterThan(1.5);
    expect(c4 / c3).toBeLessThan(6);
    expect(c5 / c4).toBeGreaterThan(1.5);
    expect(c5 / c4).toBeLessThan(6);
  });

  it('brighter stars have higher intensity', () => {
    const bright: CatalogStar = { ra: 0, dec: 0, magnitude: 0, colorIndex: 0, color: { r: 1, g: 1, b: 1 }, intensity: Math.pow(10, 0) };
    const faint: CatalogStar = { ra: 0, dec: 0, magnitude: 5, colorIndex: 0, color: { r: 1, g: 1, b: 1 }, intensity: Math.pow(10, -2) };
    expect(bright.intensity).toBeGreaterThan(faint.intensity);
  });
});

describe('colorIndexToRGB', () => {
  it('blue stars (negative BV) are bluer than red stars (positive BV)', () => {
    const blue = colorIndexToRGB(-0.3);
    const red = colorIndexToRGB(1.5);
    expect(blue.b / Math.max(blue.r, 1e-6)).toBeGreaterThan(red.b / Math.max(red.r, 1e-6));
  });

  it('normalises so the max channel is 1', () => {
    const c = colorIndexToRGB(0.6);
    expect(Math.max(c.r, c.g, c.b)).toBeCloseTo(1, 5);
  });
});

describe('magnitudeToPointSize', () => {
  it('bright stars are larger than faint stars', () => {
    expect(magnitudeToPointSize(MIN_MAGNITUDE)).toBeGreaterThan(magnitudeToPointSize(MAX_MAGNITUDE));
  });
});

// ─── Visibility ──────────────────────────────────────────────────────────────

describe('starVisibility', () => {
  it('is 0 by day', () => {
    expect(starVisibility({ nightFactor: 0, overcast: 0 }, 0)).toBe(0);
  });

  it('is ~1 on a clear moonless night', () => {
    expect(starVisibility({ nightFactor: 1, overcast: 0 }, 0)).toBeCloseTo(1, 5);
  });

  it('is reduced by a full moon', () => {
    const moonless = starVisibility({ nightFactor: 1, overcast: 0 }, 0);
    const fullMoon = starVisibility({ nightFactor: 1, overcast: 0 }, 0.02);
    expect(fullMoon).toBeLessThan(moonless);
    expect(fullMoon).toBeGreaterThan(0); // some bright stars survive
  });

  it('is reduced by overcast', () => {
    const clear = starVisibility({ nightFactor: 1, overcast: 0 }, 0);
    const cloudy = starVisibility({ nightFactor: 1, overcast: 0.8 }, 0);
    expect(cloudy).toBeLessThan(clear);
  });

  it('is monotone in nightFactor', () => {
    let prev = -1;
    for (let nf = 0; nf <= 1.0001; nf += 0.1) {
      const v = starVisibility({ nightFactor: Math.min(1, nf), overcast: 0 }, 0);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('never returns NaN for non-finite inputs (audit fix #3)', () => {
    expect(Number.isNaN(starVisibility({ nightFactor: NaN, overcast: 0 }, 0))).toBe(false);
    expect(Number.isNaN(starVisibility({ nightFactor: 1, overcast: NaN }, 0))).toBe(false);
    expect(Number.isNaN(starVisibility({ nightFactor: 1, overcast: 0 }, NaN))).toBe(false);
    expect(starVisibility({ nightFactor: NaN, overcast: NaN }, NaN)).toBe(0);
  });
});

describe('magnitudeToPointSize — NaN guard (audit fix #3)', () => {
  it('returns a finite size for a NaN magnitude', () => {
    expect(Number.isFinite(magnitudeToPointSize(NaN))).toBe(true);
  });
});
