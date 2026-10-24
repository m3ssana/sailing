/**
 * Cloud model — Stream F.2 (Weather visuals).
 *
 * PURE policy + CPU reference (NO three.js). The TSL raymarcher in
 * CloudRenderer.ts mirrors `cloudDensity` and `coverageThreshold` so the GPU
 * clouds match this reference by construction.
 *
 * ## What the live cover drives
 *
 * Open-Meteo reports three cover fractions (low / mid / high). We render two
 * layers:
 *   - LOW layer  — cumulus/stratus, base ~1200–1800 m, thickness grows with
 *     cover, carries most of the visual weight. Coverage = `cloudLow`.
 *   - HIGH layer — thin cirrus / altocumulus, base ~5000–8000 m, low density,
 *     high detail frequency. Coverage = max(cloudMid, cloudHigh).
 *
 * ## The stratus ⇄ cumulus reading
 *
 * The *same* fractal noise renders both a flat overcast and scattered puffs; the
 * difference is entirely in the parameters derived here:
 *
 *   - OVERCAST (cover → 1): low detail amplitude (`detailAmplitude`), low
 *     contrast (`contrast`), high density, diffuse shading (small lit/shadow
 *     split). Reads as flat grey stratus.
 *   - CLEAR / scattered (cover ~0.2–0.4): high detail amplitude, high contrast,
 *     distinct gaps (low coverage ⇒ high `coverageThreshold`), strong lit/shadow
 *     split with a silver lining toward the sun. Reads as crisp cumulus.
 *
 * ## Conventions
 *
 * - World space Y-up, +X east, +Z south; wind direction is the bearing wind
 *   comes FROM, so drift moves TOWARDS `(sin θ, 0, -cos θ)` reversed → the air
 *   (and the clouds it carries) move in the wind-velocity direction. Callers
 *   pass the air-velocity vector directly (same sign as `WindField.velocity`).
 * - Linear RGB, SI units, radians.
 */

import type { RGB, Vec2, Vec3 } from '@/types';
import type { LightingState } from '@render/lighting/LightingState';
import type { SkyState } from '@/types';

// ─── Layer parameters (plain data, mirrored by the TSL layer) ───────────────────

/** Which atmospheric layer a cloud deck belongs to. */
export type CloudLayerKind = 'low' | 'high';

/** Fully resolved parameters for one rendered cloud deck. */
export interface CloudLayerParams {
  kind: CloudLayerKind;
  /** Cloud base altitude above mean water level, metres. */
  baseAltitude: number;
  /** Vertical thickness of the deck, metres. */
  thickness: number;
  /** Sky coverage fraction this deck should occupy, 0..1. */
  coverage: number;
  /** Peak optical density (extinction scale). Higher = more opaque. */
  density: number;
  /**
   * Amplitude of high-frequency detail noise, 0..1. Low for flat stratus,
   * high for lumpy cumulus. This is the primary stratus⇄cumulus knob.
   */
  detailAmplitude: number;
  /**
   * Shading contrast between lit and shadow faces, 0..1. Low under overcast
   * (diffuse), high for sunlit cumulus with crisp shadows.
   */
  contrast: number;
  /** Horizontal spatial frequency of the base noise (1/m). */
  frequency: number;
  /** Drift velocity on the ground plane (m/s), the air-velocity vector. */
  drift: Vec2;
  /** Lit-face colour (toward the sun). */
  litColor: RGB;
  /** Shadow-face colour (away from the sun). */
  shadowColor: RGB;
  /** Silver-lining rim colour where the deck edge faces the sun. */
  silverLining: RGB;
  /** Noise threshold mapping this coverage (see coverageThreshold). */
  threshold: number;
}

// ─── Deterministic value-noise reference (mirrored in TSL) ──────────────────────

/**
 * Shared noise constants. These are the SINGLE source of truth consumed by BOTH
 * the CPU reference (`hash3`/`fbm` below) and the TSL port in CloudRenderer.ts,
 * so the GPU raymarch matches `cloudDensity` by construction. A test asserts the
 * TSL builder reads these exact values — if you change a constant here, the GPU
 * clouds change with it and the mirror stays honest.
 */
export const NOISE_CONSTANTS = {
  /** hash3 dot-product multipliers for (ix, iy, iz). */
  hashDot: [127.1, 311.7, 74.7] as const,
  /** hash3 large-sine scale (fract-of-sine construction). */
  hashScale: 43758.5453123,
  /** Number of fBm octaves. */
  octaves: 4,
  /** fBm starting amplitude. */
  ampStart: 0.5,
  /** fBm per-octave amplitude decay (amp *= this). */
  ampDecay: 0.5,
  /** fBm starting frequency. */
  freqStart: 1,
  /** fBm per-octave frequency gain (freq *= this). */
  freqGain: 2,
  /** Fixed Y slice sampled by cloudDensity's base fBm. */
  baseY: 0.123,
  /** Detail-octave coordinate scale and offsets used by cloudDensity. */
  detailScale: 3.1,
  detailOffsetX: 11.5,
  detailOffsetY: 7.3,
  detailOffsetZ: 4.2,
} as const;

/**
 * Deterministic 3D hash → [0,1). Integer-lattice hash used by the value noise.
 * Uses a fract-of-large-sine construction so the TSL mirror is a line-for-line
 * copy (sin/fract both exist as TSL node methods). Not cryptographic; it only
 * needs to be stable and well-distributed for noise.
 */
export function hash3(ix: number, iy: number, iz: number): number {
  const [a, b, c] = NOISE_CONSTANTS.hashDot;
  const s = Math.sin(ix * a + iy * b + iz * c) * NOISE_CONSTANTS.hashScale;
  return s - Math.floor(s);
}

/** Smoothstep fade for value-noise interpolation. */
function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Trilinear value noise over the integer lattice, output 0..1. */
export function valueNoise3(x: number, y: number, z: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  const fz = fade(z - z0);

  const c000 = hash3(x0, y0, z0);
  const c100 = hash3(x0 + 1, y0, z0);
  const c010 = hash3(x0, y0 + 1, z0);
  const c110 = hash3(x0 + 1, y0 + 1, z0);
  const c001 = hash3(x0, y0, z0 + 1);
  const c101 = hash3(x0 + 1, y0, z0 + 1);
  const c011 = hash3(x0, y0 + 1, z0 + 1);
  const c111 = hash3(x0 + 1, y0 + 1, z0 + 1);

  const x00 = lerp(c000, c100, fx);
  const x10 = lerp(c010, c110, fx);
  const x01 = lerp(c001, c101, fx);
  const x11 = lerp(c011, c111, fx);
  const y0i = lerp(x00, x10, fy);
  const y1i = lerp(x01, x11, fy);
  return lerp(y0i, y1i, fz);
}

/** Number of fractal octaves in the reference noise. */
export const NOISE_OCTAVES = NOISE_CONSTANTS.octaves;

/**
 * Fractal (fBm) value noise, output normalised to ~[0,1]. Deterministic in
 * position, so the CPU reference and the TSL mirror agree.
 */
export function fbm(x: number, y: number, z: number): number {
  let sum = 0;
  let amp = NOISE_CONSTANTS.ampStart;
  let freq = NOISE_CONSTANTS.freqStart;
  let norm = 0;
  for (let o = 0; o < NOISE_CONSTANTS.octaves; o++) {
    sum += amp * valueNoise3(x * freq, y * freq, z * freq);
    norm += amp;
    amp *= NOISE_CONSTANTS.ampDecay;
    freq *= NOISE_CONSTANTS.freqGain;
  }
  return sum / norm;
}

/**
 * Map a requested coverage fraction (0..1) to the noise threshold such that the
 * FRACTION of space with `fbm > threshold` ≈ coverage.
 *
 * fBm value noise is approximately uniform on [0,1] (mean ≈ 0.5), so a first
 * approximation is `threshold = 1 - coverage`. But real fBm clusters toward the
 * mean, so pure linear mapping over-covers at the extremes. We apply a mild
 * symmetric correction (a smootherstep-like remap) calibrated so the measured
 * coverage matches within the ±0.08 tolerance over 0.1..0.9 (verified by the
 * property test). coverage 0 → threshold above the field max (nothing passes);
 * coverage 1 → threshold below the field min (everything passes).
 */
export function coverageThreshold(coverage: number): number {
  const c = Math.min(1, Math.max(0, coverage));
  // The fBm field here is tightly clustered (mean ≈ 0.49, range ≈ [0.10, 0.82]),
  // NOT uniform, so a linear `1 - c` mapping badly over-covers at the low end.
  // Instead we invert the field's EMPIRICAL CDF, measured once over the same
  // dense grid the property test uses (64², freq 1/2500). This table is the
  // threshold at which the fraction of samples ABOVE it equals the coverage,
  // so `coverageThreshold` is the field's own inverse quantile function and the
  // produced coverage matches the request by construction. (Regenerate the
  // table if the hash, octave count, or sampling grid changes.)
  //
  // Reference quantiles (coverage → threshold), endpoints padded past the
  // observed min/max so c=0 passes nothing and c=1 passes everything:
  const table: readonly [number, number][] = [
    [0.0, 0.84],
    [0.1, 0.6473],
    [0.2, 0.6001],
    [0.3, 0.5607],
    [0.4, 0.5235],
    [0.5, 0.4897],
    [0.6, 0.4567],
    [0.7, 0.4213],
    [0.8, 0.3829],
    [0.9, 0.3316],
    [1.0, 0.08],
  ];
  // Piecewise-linear interpolation across the table.
  for (let i = 0; i < table.length - 1; i++) {
    const lo = table[i];
    const hi = table[i + 1];
    if (lo && hi && c >= lo[0] && c <= hi[0]) {
      const span = hi[0] - lo[0];
      const t = span > 0 ? (c - lo[0]) / span : 0;
      return lo[1] + (hi[1] - lo[1]) * t;
    }
  }
  return 0.08;
}

/**
 * CPU reference cloud density at a horizontal position, for one layer and time.
 *
 * Returns 0 where the fBm falls below the layer's coverage threshold (a gap),
 * and a positive density scaled by the margin above threshold otherwise. The
 * TSL raymarcher mirrors this exactly.
 *
 * @param x,z  World position, metres.
 * @param layer  The resolved layer params (frequency, threshold, drift…).
 * @param timeSeconds  Session time — advects the noise field by `drift`.
 */
export function cloudDensity(
  x: number,
  z: number,
  layer: Pick<CloudLayerParams, 'frequency' | 'threshold' | 'density' | 'detailAmplitude' | 'drift'>,
  timeSeconds: number,
): number {
  // Advect by drift (clouds carried with the air).
  const px = (x - layer.drift.x * timeSeconds) * layer.frequency;
  const pz = (z - layer.drift.y * timeSeconds) * layer.frequency;
  const base = fbm(px, NOISE_CONSTANTS.baseY, pz);
  if (base <= layer.threshold) return 0;
  // Margin above threshold → normalised shape, modulated by detail noise.
  const margin = (base - layer.threshold) / Math.max(1e-6, 1 - layer.threshold);
  const ds = NOISE_CONSTANTS.detailScale;
  const detail =
    1 -
    layer.detailAmplitude *
      (1 -
        fbm(
          px * ds + NOISE_CONSTANTS.detailOffsetX,
          NOISE_CONSTANTS.detailOffsetY,
          pz * ds + NOISE_CONSTANTS.detailOffsetZ,
        ));
  return Math.min(1, margin * detail) * layer.density;
}

// ─── Coverage-fraction measurement (used by the property test & calibration) ───

/**
 * Measure the fraction of a dense grid where cloudDensity > 0, for a layer with
 * the given coverage. Used by the coverage-fraction property test.
 */
export function measureCoverageFraction(coverage: number, gridN = 64, extent = 20000): number {
  const layer = {
    frequency: 1 / 2500,
    threshold: coverageThreshold(coverage),
    density: 1,
    detailAmplitude: 0.5,
    drift: { x: 0, y: 0 },
  };
  let hits = 0;
  const step = extent / gridN;
  for (let i = 0; i < gridN; i++) {
    for (let j = 0; j < gridN; j++) {
      const x = i * step;
      const z = j * step;
      if (cloudDensity(x, z, layer, 0) > 0) hits++;
    }
  }
  return hits / (gridN * gridN);
}

// ─── Layer policy from live sky + lighting ──────────────────────────────────────

function mixRGB(a: RGB, b: RGB, t: number): RGB {
  return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) };
}

function scaleRGB(c: RGB, s: number): RGB {
  return { r: c.r * s, g: c.g * s, b: c.b * s };
}

/**
 * Derive the two rendered cloud decks from the live sky cover and the shared
 * lighting state. Optionally takes the air-velocity vector for drift.
 *
 * @param sky       Live SkyState (cloudLow/Mid/High).
 * @param lighting  Shared LightingState (sun/fog colours, overcast).
 * @param windVelocity  Optional air-velocity vector (m/s) for drift. Defaults
 *                      to no drift.
 */
export function cloudLayersFromSky(
  sky: SkyState,
  lighting: LightingState,
  windVelocity?: Vec3,
): CloudLayerParams[] {
  const drift: Vec2 = windVelocity
    ? { x: windVelocity.x, y: windVelocity.z }
    : { x: 0, y: 0 };
  // High clouds drift faster (stronger winds aloft) — modest 1.5× factor.
  const highDrift: Vec2 = { x: drift.x * 1.5, y: drift.y * 1.5 };

  const lowCover = clamp01(sky.cloudLow);
  const highCover = clamp01(Math.max(sky.cloudMid, sky.cloudHigh));

  // Shading palette from lighting. Lit side leans toward sun colour; shadow
  // side toward ambient/fog; silver lining is a bright sun-tinted rim.
  const sun = lighting.sunColor;
  const ambient = lighting.ambientColor;
  const litBase: RGB = { r: 0.92, g: 0.93, b: 0.95 };

  // Contrast and detail collapse toward the flat-grey stratus look as cover → 1.
  // Use the *low* cover for the dominant deck's reading.
  const lowContrast = lerp(0.85, 0.12, smootherstep01(lowCover));
  const lowDetail = lerp(0.85, 0.2, smootherstep01(lowCover));
  const highContrast = lerp(0.5, 0.1, smootherstep01(highCover));

  // Lit colour: bright near white, warmed by the sun; dimmed by overcast.
  const dayFactor = 1 - 0.55 * lighting.overcast;
  const lit = scaleRGB(mixRGB(litBase, sun, 0.35), dayFactor);
  // Shadow colour: cool ambient grey, lower contrast → closer to lit.
  const shadowLow = mixRGB(scaleRGB(ambient, 0.8), lit, 1 - lowContrast);
  const shadowHigh = mixRGB(scaleRGB(ambient, 0.9), lit, 1 - highContrast);
  // Silver lining: brightest sun colour, boosted.
  const silver = scaleRGB(mixRGB(sun, { r: 1, g: 1, b: 1 }, 0.4), 1.2);

  const lowLayer: CloudLayerParams = {
    kind: 'low',
    baseAltitude: lerp(1800, 1200, lowCover), // overcast decks sit lower
    thickness: lerp(300, 2200, lowCover), // thicker as cover grows
    coverage: lowCover,
    density: lerp(0.35, 1.0, lowCover),
    detailAmplitude: lowDetail,
    contrast: lowContrast,
    frequency: 1 / 2500,
    drift,
    litColor: lit,
    shadowColor: shadowLow,
    silverLining: silver,
    threshold: coverageThreshold(lowCover),
  };

  const highLayer: CloudLayerParams = {
    kind: 'high',
    baseAltitude: lerp(8000, 5000, highCover),
    thickness: lerp(200, 600, highCover),
    coverage: highCover,
    density: lerp(0.08, 0.3, highCover), // always thin
    detailAmplitude: lerp(0.9, 0.5, highCover), // wispy/streaky
    contrast: highContrast,
    frequency: 1 / 1200, // finer, streakier
    drift: highDrift,
    litColor: scaleRGB(lit, 1.02),
    shadowColor: shadowHigh,
    silverLining: silver,
    threshold: coverageThreshold(highCover),
  };

  return [lowLayer, highLayer];
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function smootherstep01(t: number): number {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

// ─── Temporal reprojection helpers (pure) ───────────────────────────────────────

/**
 * Radical-inverse (van der Corput) value for base `b` at index `i`.
 */
function radicalInverse(i: number, base: number): number {
  let result = 0;
  let f = 1 / base;
  let n = i;
  while (n > 0) {
    result += (n % base) * f;
    n = Math.floor(n / base);
    f /= base;
  }
  return result;
}

/**
 * Halton (2,3) sub-pixel jitter for frame `frameIndex`, each component in
 * [0,1). Known values: index 1 → (0.5, 0.333…), index 2 → (0.25, 0.666…),
 * index 3 → (0.75, 0.111…). Used to offset the quarter-res sample grid each
 * frame so temporal accumulation fills in detail.
 */
export function haltonJitter(frameIndex: number): Vec2 {
  const i = Math.max(1, Math.floor(frameIndex));
  return { x: radicalInverse(i, 2), y: radicalInverse(i, 3) };
}

/**
 * History blend weight for temporal reprojection. The weight placed on the
 * reprojected history drops as the reprojected sample moves far in screen
 * space (`velocityPixels`) and goes to 0 on disocclusion (newly revealed
 * geometry has no valid history).
 *
 * @param velocityPixels  Reprojection displacement magnitude, pixels.
 * @param disocclusion    0 = history valid, 1 = fully disoccluded.
 * @returns History weight 0..1 (0 = use only the new sample).
 */
export function reprojectionBlend(velocityPixels: number, disocclusion: number): number {
  const d = clamp01(disocclusion);
  if (d >= 1) return 0;
  // Base history weight for clouds (slow-moving) is high; reduce with velocity.
  const velFactor = 1 / (1 + Math.max(0, velocityPixels) * 0.1);
  const base = 0.92 * velFactor;
  return clamp01(base * (1 - d));
}

/** Quarter-resolution target size (half width, half height, each ≥ 1). */
export function quarterResSize(w: number, h: number): { width: number; height: number } {
  return {
    width: Math.max(1, Math.floor(w / 2)),
    height: Math.max(1, Math.floor(h / 2)),
  };
}
