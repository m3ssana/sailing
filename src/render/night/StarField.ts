/**
 * StarField — Stream F.4 (Night).
 *
 * PURE model (`generateStarCatalog`, `equatorialToHorizon`, `starVisibility`)
 * with NO three.js import, plus a THIN three/TSL `createStarField` layer.
 *
 * ## Conventions
 *
 * - World space Y-up, right-handed, +X east, +Z south. A compass bearing (azimuth
 *   clockwise from north) θ maps to the ground direction `(sin θ, 0, -cos θ)`;
 *   altitude lifts into +Y. So a horizon unit vector is
 *   `(cos alt · sin az, sin alt, -cos alt · cos az)`.
 * - Right ascension and declination in radians. Latitude in radians (+N).
 * - Sidereal time in radians (local apparent sidereal time, as produced by
 *   `src/environment/SkyState.ts#localSiderealTime` and carried on
 *   `SkyState.siderealTime`).
 *
 * ## Handedness derivation (verified from first principles)
 *
 * Hour angle `H = siderealTime - rightAscension`, increasing WESTWARD. For a
 * northern-hemisphere observer:
 *
 *   sin(alt) = sin(dec)·sin(lat) + cos(dec)·cos(lat)·cos(H)
 *   azimuth A (CW from north):
 *     sin(A) = -cos(dec)·sin(H) / cos(alt)
 *     cos(A) = (sin(dec) - sin(lat)·sin(alt)) / (cos(lat)·cos(alt))
 *
 * A star at hour angle +6h (H = +90°, i.e. just WEST of the meridian) has
 * sin(A) = -cos(dec)·sin(90°)/cos(alt) < 0 → azimuth in (180°, 360°) → west.
 * World X = cos(alt)·sin(A) < 0. So **a west star has NEGATIVE X** under this
 * convention (east = +X, as required). Correspondingly a star at H = -6h (east,
 * rising) has X > 0. The tests assert exactly this.
 */

import { createRandom, hashCombine } from '@core/math';

/** One catalogued star in equatorial coordinates. */
export interface CatalogStar {
  /** Right ascension, radians [0, 2π). */
  ra: number;
  /** Declination, radians [-π/2, π/2]. */
  dec: number;
  /** Apparent visual magnitude (smaller = brighter). */
  magnitude: number;
  /** B-V colour index (negative = blue, positive = red). */
  colorIndex: number;
  /** Linear RGB colour from the colour index (blackbody-ish). */
  color: { r: number; g: number; b: number };
  /** Relative linear intensity from magnitude, `10^(-0.4·m)`. */
  intensity: number;
}

/** A horizon-frame unit direction in WORLD coordinates. */
export interface HorizonVector {
  x: number;
  y: number;
  z: number;
}

/** Minimal lighting input for star visibility. */
export interface StarVisibilityLighting {
  nightFactor: number;
  overcast: number;
}

// ─── Catalogue generation ──────────────────────────────────────────────────────

const TWO_PI = Math.PI * 2;

/** Faintest magnitude we generate (naked-eye limit ≈ 6.0). */
export const MAX_MAGNITUDE = 6.0;
/** Brightest magnitude we generate (≈ Sirius, -1.4; use -1.5 as a floor). */
export const MIN_MAGNITUDE = -1.5;

/**
 * Map a B-V colour index to a blackbody-ish linear RGB colour.
 *
 * Uses the Ballesteros (2012) T_eff(B-V) approximation to get a colour
 * temperature, then a cheap blackbody→RGB fit. Clamped to the naked-eye range.
 * Labelled approximation — good enough for star tints, not for photometry.
 */
export function colorIndexToRGB(bv: number): { r: number; g: number; b: number } {
  // Ballesteros: T = 4600 * (1/(0.92·BV + 1.7) + 1/(0.92·BV + 0.62))
  const clampedBV = Math.max(-0.4, Math.min(2.0, bv));
  const t = 4600 * (1 / (0.92 * clampedBV + 1.7) + 1 / (0.92 * clampedBV + 0.62));
  return blackbodyRGB(t);
}

/** Cheap blackbody temperature (K) → linear RGB, normalised so max channel = 1. */
function blackbodyRGB(tempK: number): { r: number; g: number; b: number } {
  const t = Math.max(1000, Math.min(40000, tempK)) / 100;
  let r: number;
  let g: number;
  let b: number;

  // Red.
  if (t <= 66) {
    r = 255;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
  }
  // Green.
  if (t <= 66) {
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }
  // Blue.
  if (t >= 66) {
    b = 255;
  } else if (t <= 19) {
    b = 0;
  } else {
    b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  }

  const clamp255 = (x: number): number => Math.max(0, Math.min(255, x)) / 255;
  const lr = clamp255(r);
  const lg = clamp255(g);
  const lb = clamp255(b);
  // Normalise so the brightest channel is 1 (colour, not brightness — intensity
  // carries brightness separately).
  const m = Math.max(lr, lg, lb, 1e-6);
  return { r: lr / m, g: lg / m, b: lb / m };
}

/**
 * Generate a deterministic star catalogue.
 *
 * - Positions uniform on the celestial sphere: `dec = asin(2u - 1)` gives an
 *   area-uniform declination distribution (not uniform-in-angle, which would
 *   crowd the poles); `ra` uniform in [0, 2π).
 * - Magnitudes follow the observed cumulative star count law `N(<m) ∝ 10^(0.6m)`
 *   (each fainter magnitude step holds ~4× as many stars). We invert this CDF:
 *   for the range [MIN_MAGNITUDE, MAX_MAGNITUDE], `m = (1/0.6)·log10(u·(10^{0.6·mMax}
 *   - 10^{0.6·mMin}) + 10^{0.6·mMin})`. This reproduces the ~10^(0.6m) density.
 * - Colour index sampled from a plausible spread; bluer stars are rarer.
 *
 * Deterministic in `seed` (uses the repo's mulberry32 `createRandom`).
 *
 * @param seed Deterministic seed.
 * @param count Number of stars to generate.
 */
export function generateStarCatalog(seed: number, count: number): CatalogStar[] {
  const rng = createRandom(hashCombine(seed, 0x57a7));
  const stars: CatalogStar[] = [];

  const aMin = Math.pow(10, 0.6 * MIN_MAGNITUDE);
  const aMax = Math.pow(10, 0.6 * MAX_MAGNITUDE);

  for (let i = 0; i < count; i++) {
    const ra = rng.next() * TWO_PI;
    const dec = Math.asin(2 * rng.next() - 1);

    // Inverse-CDF magnitude so density ∝ 10^(0.6m).
    const u = rng.next();
    const magnitude = (1 / 0.6) * Math.log10(u * (aMax - aMin) + aMin);

    // Colour index: skew towards white/yellow, with a blue tail.
    // Normal around 0.6 (sun-like), clamped to the physical naked-eye range.
    const colorIndex = Math.max(-0.35, Math.min(1.8, 0.6 + rng.normal() * 0.45));
    const color = colorIndexToRGB(colorIndex);
    const intensity = Math.pow(10, -0.4 * magnitude);

    stars.push({ ra, dec, magnitude, colorIndex, color, intensity });
  }

  return stars;
}

// ─── Coordinate transform ──────────────────────────────────────────────────────

/**
 * Convert equatorial coordinates to a WORLD-space horizon unit vector.
 *
 * @param ra Right ascension, radians.
 * @param dec Declination, radians.
 * @param siderealTime Local apparent sidereal time, radians.
 * @param latitude Observer latitude, radians (+N).
 * @param out Optional target vector.
 * @returns Unit vector `(x=east, y=up, z=south)`, always length 1.
 */
export function equatorialToHorizon(
  ra: number,
  dec: number,
  siderealTime: number,
  latitude: number,
  out?: HorizonVector,
): HorizonVector {
  const result: HorizonVector = out ?? { x: 0, y: 0, z: 0 };

  const H = siderealTime - ra; // hour angle, increasing westward
  const sinDec = Math.sin(dec);
  const cosDec = Math.cos(dec);
  const sinLat = Math.sin(latitude);
  const cosLat = Math.cos(latitude);
  const sinH = Math.sin(H);
  const cosH = Math.cos(H);

  const sinAlt = sinDec * sinLat + cosDec * cosLat * cosH;
  const altClamped = Math.max(-1, Math.min(1, sinAlt));
  const alt = Math.asin(altClamped);
  const cosAlt = Math.cos(alt);

  // Azimuth components (CW from north). Build the world vector directly from
  // sin(A) and cos(A) to avoid an atan2 round-trip and a pole singularity.
  // sin(A) = -cos(dec)·sin(H) / cos(alt),  cos(A) = (sin(dec) - sin(lat)·sin(alt)) / (cos(lat)·cos(alt))
  // World: X = cosAlt·sin(A), Z = -cosAlt·cos(A).  Note cosAlt cancels.
  let worldX: number;
  let worldZ: number;
  if (cosAlt < 1e-9) {
    // Star at the zenith/nadir: azimuth undefined, point straight up/down.
    worldX = 0;
    worldZ = 0;
  } else {
    // X = cosAlt · sinA = cosAlt · (-cosDec·sinH / cosAlt) = -cosDec·sinH
    worldX = -cosDec * sinH;
    // cosAlt · cosA = (sinDec - sinLat·sinAlt)/cosLat  (cosAlt cancels)
    // Z = -cosAlt·cosA = -(sinDec - sinLat·sinAlt)/cosLat
    if (Math.abs(cosLat) < 1e-9) {
      // Observer at a geographic pole: azimuth is degenerate; project onto X/Z
      // using the hour angle directly (meridian = -Z south).
      worldX = -cosDec * sinH;
      worldZ = -cosDec * cosH;
    } else {
      worldZ = -(sinDec - sinLat * altClamped) / cosLat;
    }
  }

  const y = altClamped;

  // Re-normalise to guard against accumulated floating error (always unit length).
  const len = Math.sqrt(worldX * worldX + y * y + worldZ * worldZ) || 1;
  result.x = worldX / len;
  result.y = y / len;
  result.z = worldZ / len;
  return result;
}

// ─── Visibility ─────────────────────────────────────────────────────────────

function clamp01(x: number): number {
  // NaN-safe: non-finite input collapses to 0 so star visibility / point size
  // never propagate NaN from a bad nightFactor, overcast, or magnitude.
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * How visible the star field is overall, 0..1.
 *
 * - 0 by day (`nightFactor` 0), rising to ~1 on a clear moonless night.
 * - Washed out by moonlight: a bright sky from a full moon raises the sky
 *   background and drowns faint stars.
 * - Reduced by overcast cloud.
 *
 * @param lighting nightFactor + overcast.
 * @param moonIlluminance Relative moon illuminance (0 new/below horizon ..
 *   ~0.02 full at zenith on the sun==1 scale).
 * @param overcast Optional explicit overcast override; defaults to lighting.overcast.
 */
export function starVisibility(
  lighting: StarVisibilityLighting,
  moonIlluminance: number,
  overcast?: number,
): number {
  const night = clamp01(lighting.nightFactor);
  const cloud = clamp01(overcast ?? lighting.overcast);

  // Moon washout: scale moon illuminance up to a 0..1 washout. A full moon
  // (~0.02 relative) removes most of the faint field but not all of it.
  const moonWashout = clamp01(moonIlluminance / 0.02) * 0.85;

  const base = night;
  const afterCloud = base * (1 - 0.95 * cloud);
  const afterMoon = afterCloud * (1 - moonWashout);
  return clamp01(afterMoon);
}

/** Convert a star magnitude to a render point size (brighter = larger). */
export function magnitudeToPointSize(
  magnitude: number,
  minSize = 1,
  maxSize = 4,
): number {
  // Map [MIN_MAGNITUDE (bright) .. MAX_MAGNITUDE (faint)] → [maxSize .. minSize].
  const t = clamp01((magnitude - MIN_MAGNITUDE) / (MAX_MAGNITUDE - MIN_MAGNITUDE));
  return maxSize + t * (minSize - maxSize);
}
