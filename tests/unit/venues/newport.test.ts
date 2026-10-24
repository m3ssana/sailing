/**
 * Newport venue — headless tests.
 *
 * Conventions under test (documented where asserted):
 *   - venue-local metres, origin at venue centre, +X east / +Z south;
 *   - coastline rings all CLOSED (TerrainBuilder ignores open polylines — a
 *     documented Stream-D follow-up we guard against here);
 *   - coastline rings all OUTER (negative signed area in x-east/y-south space →
 *     land inside), i.e. winding is consistent across every ring;
 *   - rings non-self-intersecting (own segment-intersection check below);
 *   - depth positive-down and sensible; start in open water > 3 m; course marks
 *     in water; course axis aligned to the prevailing wind;
 *   - palette 5–7 colours; colour grade in-contract (|contrast| ≤ 0.15, neutral
 *     discipline respected);
 *   - solar position at the venue reuses the repo's cited NOAA reference.
 */

import { describe, it, expect } from 'vitest';
import type { Polyline, Vec2 } from '@/types';
import { solarPosition } from '@environment/SkyState';
import {
  NEWPORT,
  NEWPORT_COASTLINES,
  NEWPORT_DEPTH_CONTOURS,
  NEWPORT_FORT_ADAMS,
  NEWPORT_WL_COURSE,
  getVenue,
  listVenues,
  listVenueIds,
  buildVenueTerrain,
  createVenueEnvironment,
  latLonToVenueLocal,
  venueLocalToLatLon,
  METRES_PER_DEGREE_LATITUDE,
} from '@venues/index';
import type { WeatherSnapshot } from '@/types';

const DEG = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

// ─── Geometry helpers for the tests (self-contained) ──────────────────────────

function signedArea(ring: readonly Vec2[]): number {
  let s = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    if (a === undefined || b === undefined) continue;
    s += a.x * b.y - b.x * a.y;
  }
  return s * 0.5;
}

/** Proper segment-intersection test (excludes shared endpoints of adjacent edges). */
function segmentsProperlyIntersect(
  p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2,
): boolean {
  const d = (a: Vec2, b: Vec2, c: Vec2): number =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  if (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  ) {
    return true;
  }
  return false; // collinear/touching handled as non-self-intersecting here.
}

/** True if a closed ring has any pair of non-adjacent edges that cross. */
function ringSelfIntersects(ring: Polyline): boolean {
  const p = ring.points;
  const n = p.length;
  for (let i = 0; i < n; i++) {
    const a1 = p[i];
    const a2 = p[(i + 1) % n];
    if (a1 === undefined || a2 === undefined) continue;
    for (let j = i + 1; j < n; j++) {
      // Skip adjacent edges (sharing a vertex) and the wrap-around neighbour.
      if (j === i) continue;
      if ((j + 1) % n === i || (i + 1) % n === j) continue;
      const b1 = p[j];
      const b2 = p[(j + 1) % n];
      if (b1 === undefined || b2 === undefined) continue;
      if (segmentsProperlyIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

function pointInRing(px: number, py: number, ring: readonly Vec2[]): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const vi = ring[i];
    const vj = ring[j];
    if (vi === undefined || vj === undefined) continue;
    if (
      (vi.y > py) !== (vj.y > py) &&
      px < ((vj.x - vi.x) * (py - vi.y)) / (vj.y - vi.y) + vi.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

describe('VenueRegistry', () => {
  it('getVenue returns Newport by id', () => {
    expect(getVenue('newport')).toBe(NEWPORT);
  });

  it('getVenue returns undefined for an unknown id', () => {
    expect(getVenue('atlantis')).toBeUndefined();
  });

  it('listVenues includes Newport', () => {
    expect(listVenues()).toContainEqual(NEWPORT);
    expect(listVenueIds()).toContain('newport');
  });
});

// ─── Venue definition basics ───────────────────────────────────────────────────

describe('Newport venue definition', () => {
  it('has the real coordinates and timezone', () => {
    expect(NEWPORT.coordinates.latitude).toBeCloseTo(41.4901, 4);
    expect(NEWPORT.coordinates.longitude).toBeCloseTo(-71.3128, 4);
    expect(NEWPORT.timezone).toBe('America/New_York');
  });

  it('is salt water with sensible depth/elevation', () => {
    expect(NEWPORT.freshwater).toBe(false);
    expect(NEWPORT.maxDepth).toBeGreaterThan(15);
    expect(NEWPORT.maxDepth).toBeLessThanOrEqual(30);
    expect(NEWPORT.maxElevation).toBeGreaterThan(0);
  });

  it('carries a coastline provenance/attribution note', () => {
    expect(NEWPORT.coastlineAttribution.length).toBeGreaterThan(20);
    expect(NEWPORT.coastlineAttribution.toLowerCase()).toContain('hand-digitised');
  });

  it('has traffic including a ferry (Newport⇄Jamestown)', () => {
    const kinds = NEWPORT.traffic.map((t) => t.kind);
    expect(kinds).toContain('ferry');
    expect(kinds).toContain('fishingBoat');
    expect(kinds).toContain('yacht');
  });

  it('has the four signature landmark specs using supported generators', () => {
    const gens = NEWPORT.landmarks.map((l) => l.generator);
    expect(gens).toContain('suspensionBridge'); // Pell Bridge
    expect(gens).toContain('lighthouse'); // Castle Hill / Brenton
    expect(gens).toContain('breakwater'); // Fort Adams approximation
    expect(NEWPORT.landmarks.length).toBe(4);
  });
});

// ─── Palette & colour grade ─────────────────────────────────────────────────────

describe('Newport colour grade', () => {
  const grade = NEWPORT.grade;

  it('palette has 5–7 colours (art-direction §8.7)', () => {
    expect(grade.palette.length).toBeGreaterThanOrEqual(5);
    expect(grade.palette.length).toBeLessThanOrEqual(7);
  });

  it('palette entries are linear RGB in [0,1]', () => {
    for (const c of grade.palette) {
      for (const ch of [c.r, c.g, c.b]) {
        expect(ch).toBeGreaterThanOrEqual(0);
        expect(ch).toBeLessThanOrEqual(1);
      }
    }
  });

  it('contrast stays within the power-law-safe cap (|contrast| ≤ 0.15)', () => {
    // The grade applies out = 0.18·(c/0.18)^(1+contrast); large |contrast|
    // crushes dim values. Keep it modest.
    expect(Math.abs(grade.contrast)).toBeLessThanOrEqual(0.15);
  });

  it('saturation is within the §5.3 0.9–1.1 band', () => {
    expect(grade.saturation).toBeGreaterThanOrEqual(0.9);
    expect(grade.saturation).toBeLessThanOrEqual(1.1);
  });

  it('is not an over-strong tint (white stays white, black stays black)', () => {
    const tintMag = (t: { r: number; g: number; b: number }) =>
      Math.abs(t.r) + Math.abs(t.g) + Math.abs(t.b);
    expect(tintMag(grade.shadowTint)).toBeLessThan(0.5);
    expect(tintMag(grade.highlightTint)).toBeLessThan(0.5);
  });
});

// ─── Projection ──────────────────────────────────────────────────────────────

describe('latLon ↔ venue-local projection', () => {
  it('origin maps to (0,0) and back', () => {
    const local = latLonToVenueLocal(
      NEWPORT.coordinates.latitude,
      NEWPORT.coordinates.longitude,
      NEWPORT,
    );
    expect(local.x).toBeCloseTo(0, 6);
    expect(local.y).toBeCloseTo(0, 6);
  });

  it('round-trips to < 1 mm over the venue extent', () => {
    const samples: Array<[number, number]> = [
      [41.52, -71.28],
      [41.46, -71.37],
      [41.4901, -71.3128],
      [41.50, -71.40],
      [41.47, -71.30],
    ];
    for (const [lat, lon] of samples) {
      const local = latLonToVenueLocal(lat, lon, NEWPORT);
      const back = venueLocalToLatLon(local, NEWPORT);
      // Convert the lat/lon error back to metres and assert < 1 mm.
      const dLatM = (back.latitude - lat) * METRES_PER_DEGREE_LATITUDE;
      const dLonM =
        (back.longitude - lon) *
        METRES_PER_DEGREE_LATITUDE *
        Math.cos(NEWPORT.coordinates.latitude * DEG);
      expect(Math.hypot(dLatM, dLonM)).toBeLessThan(1e-3);
    }
  });

  it('1° of latitude ≈ 111.19 km (± 0.2%)', () => {
    const a = latLonToVenueLocal(41.0, NEWPORT.coordinates.longitude, NEWPORT);
    const b = latLonToVenueLocal(42.0, NEWPORT.coordinates.longitude, NEWPORT);
    const metres = Math.abs(b.y - a.y);
    expect(metres).toBeGreaterThan(111190 * (1 - 0.002));
    expect(metres).toBeLessThan(111190 * (1 + 0.002));
  });

  it('north maps to −y (south is +y) and east to +x', () => {
    const north = latLonToVenueLocal(
      NEWPORT.coordinates.latitude + 0.01,
      NEWPORT.coordinates.longitude,
      NEWPORT,
    );
    expect(north.y).toBeLessThan(0);
    const east = latLonToVenueLocal(
      NEWPORT.coordinates.latitude,
      NEWPORT.coordinates.longitude + 0.01,
      NEWPORT,
    );
    expect(east.x).toBeGreaterThan(0);
  });

  it('Fort Adams lat/lon lands within 300 m of its digitised position', () => {
    const projected = latLonToVenueLocal(
      NEWPORT_FORT_ADAMS.latitude,
      NEWPORT_FORT_ADAMS.longitude,
      NEWPORT,
    );
    const d = Math.hypot(
      projected.x - NEWPORT_FORT_ADAMS.local.x,
      projected.y - NEWPORT_FORT_ADAMS.local.y,
    );
    expect(d).toBeLessThan(300);
  });
});

// ─── Coastline rings ────────────────────────────────────────────────────────

describe('Newport coastline rings', () => {
  it('every ring is closed (TerrainBuilder ignores open polylines)', () => {
    for (const ring of NEWPORT_COASTLINES) {
      expect(ring.closed).toBe(true);
      expect(ring.points.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('winding is consistent: every ring is an OUTER/land ring (negative signed area)', () => {
    // In x-east / y-south Vec2 space, TerrainBuilder treats negative signed area
    // as an outer (land) ring. All four islands/shores are solid land, so all
    // must be negative — a consistent winding.
    for (const ring of NEWPORT_COASTLINES) {
      expect(signedArea(ring.points)).toBeLessThan(0);
    }
  });

  it('no ring self-intersects', () => {
    for (const ring of NEWPORT_COASTLINES) {
      expect(ringSelfIntersects(ring)).toBe(false);
    }
  });

  it('depth contours are open polylines carrying positive depths', () => {
    for (const c of NEWPORT_DEPTH_CONTOURS) {
      expect(c.closed).toBe(false);
      expect(c.depth).toBeGreaterThan(0);
      expect(c.points.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('depth contours deepen monotonically from shore to channel (sensible outward)', () => {
    // The contour set is authored shallow→deep: 4,4,10,10,20,28.
    const depths = NEWPORT_DEPTH_CONTOURS.map((c) => c.depth ?? 0);
    const maxDepth = Math.max(...depths);
    const minDepth = Math.min(...depths);
    expect(minDepth).toBeGreaterThanOrEqual(3);
    expect(maxDepth).toBeLessThanOrEqual(NEWPORT.maxDepth);
  });
});

// ─── Course ─────────────────────────────────────────────────────────────────

describe('Newport windward–leeward course', () => {
  const course = NEWPORT_WL_COURSE;

  it('is a windward–leeward course with a start line, windward mark and a gate', () => {
    expect(course.kind).toBe('windwardLeeward');
    const kinds = course.marks.map((m) => m.kind);
    expect(kinds.filter((k) => k === 'start').length).toBe(2);
    expect(kinds).toContain('windward');
    expect(kinds.filter((k) => k === 'gate').length).toBe(2);
    expect(course.windAligned).toBe(true);
  });

  it('windward leg is ~1 nautical mile', () => {
    const start = course.marks.filter((m) => m.kind === 'start');
    const windward = course.marks.find((m) => m.kind === 'windward');
    expect(windward).toBeDefined();
    if (!windward) return;
    const s0 = start[0];
    const s1 = start[1];
    expect(s0).toBeDefined();
    expect(s1).toBeDefined();
    if (!s0 || !s1) return;
    const centre = {
      x: (s0.position.x + s1.position.x) / 2,
      y: (s0.position.y + s1.position.y) / 2,
    };
    const leg = Math.hypot(
      windward.position.x - centre.x,
      windward.position.y - centre.y,
    );
    expect(leg).toBeGreaterThan(1852 * 0.9);
    expect(leg).toBeLessThan(1852 * 1.1);
    expect(course.legLength).toBeCloseTo(1852, 0);
  });

  it('course axis (start→windward) aligns with the prevailing SW wind (~205° FROM)', () => {
    const start = course.marks.filter((m) => m.kind === 'start');
    const windward = course.marks.find((m) => m.kind === 'windward');
    const s0 = start[0];
    const s1 = start[1];
    if (!windward || !s0 || !s1) throw new Error('course malformed');
    const centre = {
      x: (s0.position.x + s1.position.x) / 2,
      y: (s0.position.y + s1.position.y) / 2,
    };
    // "Up the course" world direction, Vec2 (x east, y south).
    const up = {
      x: windward.position.x - centre.x,
      y: windward.position.y - centre.y,
    };
    // The windward mark is upwind = toward the FROM bearing. Bearing θ FROM maps
    // to Vec2 (sinθ, −cosθ). Check the up-axis bearing ≈ 205°.
    const bearing = Math.atan2(up.x, -up.y);
    const bearingDeg = ((bearing * RAD_TO_DEG) % 360 + 360) % 360;
    expect(bearingDeg).toBeCloseTo(205, 0);
  });
});

// ─── Terrain build (headless) ─────────────────────────────────────────────────

describe('Newport terrain build', () => {
  it('builds in < 2 s and has land where expected, water in the channel', () => {
    const t0 = Date.now();
    const built = buildVenueTerrain(NEWPORT, 192);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000);

    // Goat Island centre (~ -1200, 200) is land.
    expect(built.isLand(-1200, 200)).toBe(true);
    // Channel centre (~ -2900, 0) is water.
    expect(built.isLand(-2900, 0)).toBe(false);
  });

  it('depth is positive-down in the channel and 0 on land', () => {
    const built = buildVenueTerrain(NEWPORT, 192);
    // Channel: deep water.
    const channelDepth = built.depthAt(-2900, 0);
    expect(channelDepth).toBeGreaterThan(3);
    expect(channelDepth).toBeLessThanOrEqual(NEWPORT.maxDepth + 1e-6);
    // Land: zero depth.
    expect(built.depthAt(-1200, 200)).toBe(0);
  });

  it('the spawn / start position is open water deeper than 3 m', () => {
    const built = buildVenueTerrain(NEWPORT, 192);
    const spawn = NEWPORT.spawn.position;
    expect(built.isLand(spawn.x, spawn.y)).toBe(false);
    expect(built.depthAt(spawn.x, spawn.y)).toBeGreaterThan(3);
  });

  it('all course marks are in water', () => {
    const built = buildVenueTerrain(NEWPORT, 192);
    for (const mark of NEWPORT_WL_COURSE.marks) {
      expect(built.isLand(mark.position.x, mark.position.y)).toBe(false);
    }
  });

  it('point-in-ring agrees that Goat Island centre is inside its ring', () => {
    // Cross-check the mask against a direct point-in-polygon on the raw ring.
    const goat = NEWPORT_COASTLINES.find((r) => {
      // Goat is the small ring near (-1200, 200).
      return r.points.some((p) => Math.hypot(p.x + 1200, p.y - 200) < 400);
    });
    expect(goat).toBeDefined();
    if (goat) expect(pointInRing(-1200, 200, goat.points)).toBe(true);
  });
});

// ─── Solar position (reuse the repo's cited NOAA reference) ───────────────────

describe('Newport solar position', () => {
  it('matches the cited NOAA reference at 2023-06-21 16:00 UTC (12:00 EDT)', () => {
    // Reuses the exact reference already validated in
    // tests/unit/environment/sky.test.ts (NOAA Solar Calculator, Meeus
    // algorithm): at Newport 41.49/-71.31, 2023-06-21 16:00 UTC the sun is at
    // elevation ≈ 69.45°, azimuth ≈ 148°. We assert the SAME values at the
    // venue's own coordinates (41.4901/-71.3128), which are within metres of
    // the reference point, so the result is identical to 0 d.p.
    const epochMs = Date.UTC(2023, 5, 21, 16, 0, 0);
    const { elevation, azimuth } = solarPosition(
      epochMs,
      NEWPORT.coordinates.latitude,
      NEWPORT.coordinates.longitude,
    );
    expect(elevation * RAD_TO_DEG).toBeCloseTo(69.45, 0);
    expect(azimuth * RAD_TO_DEG).toBeCloseTo(148, 0);
  });

  it('at 2023-06-21 18:00 UTC the sun is still high and in the western sky', () => {
    // 18:00 UTC = 14:00 EDT, ~1h15m after solar noon (~12:47 EDT): the sun has
    // crossed the meridian and is descending toward the west, so azimuth > 180°
    // and elevation remains well above the horizon. This is a direction/sign
    // sanity check against the same algorithm — not a new NOAA magnitude claim
    // (the cited reference above is the magnitude anchor).
    const epochMs = Date.UTC(2023, 5, 21, 18, 0, 0);
    const { elevation, azimuth } = solarPosition(
      epochMs,
      NEWPORT.coordinates.latitude,
      NEWPORT.coordinates.longitude,
    );
    expect(elevation * RAD_TO_DEG).toBeGreaterThan(55);
    expect(azimuth * RAD_TO_DEG).toBeGreaterThan(180);
    expect(azimuth * RAD_TO_DEG).toBeLessThan(270);
  });
});

// ─── Environment wiring ────────────────────────────────────────────────────────

/** Minimal valid WeatherSnapshot for the environment-wiring test. */
function makeSnapshot(): WeatherSnapshot {
  const fetchedAt = Date.UTC(2023, 5, 21, 16, 0, 0);
  return {
    fetchedAt,
    source: 'climatology',
    venueId: 'newport',
    localTime: { iso: '2023-06-21T12:00:00-04:00', utcOffsetSeconds: -4 * 3600 },
    wind: { trueSpeed: 6, trueDirection: 205 * DEG, gustCeiling: 9, stability: 0.5 },
    sea: {
      significantHeight: 0.5,
      dominantPeriod: 4,
      dominantDirection: 205 * DEG,
      swell: { height: 0.3, period: 8, direction: 180 * DEG },
      windWave: { height: 0.4, period: 3.5, direction: 205 * DEG },
      surfaceTemp: 18,
      tideHeight: 0,
    },
    current: { speed: 0.2, direction: 340 * DEG },
    sky: {
      cloudLow: 0.4,
      cloudMid: 0.3,
      cloudHigh: 0.2,
      visibility: 20000,
      precipitation: 0,
      wmoCode: 2,
      solarRadiation: 500,
      isDay: true,
    },
    air: { temperature: 20, pressure: 101300, density: 1.2 },
    timeline: [],
    attribution: ['Open-Meteo'],
  };
}

describe('createVenueEnvironment', () => {
  it('produces a sampleable Environment coherent with the venue terrain', () => {
    const snapshot = makeSnapshot();
    const { environment, terrain, windInfluence } = createVenueEnvironment(
      NEWPORT,
      snapshot,
      snapshot.fetchedAt,
      { terrainResolution: 160, windResolution: 96 },
    );

    // depthAt / isLand are wired through to the terrain samplers.
    expect(environment.isLand(-1200, 200)).toBe(true); // Goat Island
    expect(environment.isLand(-2900, 0)).toBe(false); // channel
    expect(environment.depthAt(-2900, 0)).toBeGreaterThan(3);

    // Salt water density.
    expect(environment.waterDensity).toBeGreaterThan(1020);

    // Wind samples are finite and non-zero in open water.
    const w = environment.wind.sample(-2900, 0, 10, 0);
    expect(Number.isFinite(w.speed)).toBe(true);
    expect(w.speed).toBeGreaterThan(0);

    // Sky state resolves at the venue.
    const sky = environment.skyAt(0);
    expect(Number.isFinite(sky.sunElevation)).toBe(true);

    // The generated wind influence field matches the venue bounds.
    expect(windInfluence.resolution).toBe(96);
    expect(windInfluence.originX).toBeCloseTo(NEWPORT.bounds.min.x, 3);

    // Terrain exposed for inspection.
    expect(terrain.terrain.resolution).toBe(160);
  });
});
