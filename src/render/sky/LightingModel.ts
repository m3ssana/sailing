/**
 * LightingModel — pure CPU derivation of the frozen `LightingState` contract
 * from a `SkyState` plus live weather scalars (Stream F.1). NO three.js imports:
 * this is headless and unit-testable, and is the single source every TSL layer
 * reads through `LightingState`.
 *
 * ## Physical basis & citations
 *
 * - **Air mass:** Kasten & Young (1989) relative optical air mass,
 *   m = 1 / (cos z + 0.50572 (96.07995 - z_deg)^-1.6364), z = zenith angle.
 *   This is the standard empirical fit that stays finite at the horizon where
 *   the naive sec(z) diverges. The fit is only valid to z ~ 96° and is
 *   non-monotone below the horizon (it peaks near elevation -1.757° then
 *   collapses as the power term diverges); we evaluate it only down to that
 *   peak and hold the peak value flat below, a documented monotone extension so
 *   air mass — and therefore the sun's reddening — never reverses below the
 *   horizon (see `airMass` / `AIR_MASS_PEAK_ELEVATION`).
 * - **Sun colour:** Beer–Lambert extinction of a warm-white solar spectrum
 *   through Rayleigh (beta_R = (5.8,13.5,33.1)e-6 /m, H=8000 m) and Mie
 *   (beta_M = 21e-6 /m, H=1200 m) optical depth scaled by air mass. Normalised
 *   so a clear zenith sun has illuminance 1.0 and a warm-white colour.
 * - **Cloud attenuation:** Kasten & Czeplak (1980) global-radiation model,
 *   G/G_clear = 1 - 0.75 n^3.4, applied to ambient; a steeper exponent is used
 *   for the direct beam (direct sun is extinguished faster than diffuse by
 *   cloud). `n` is the *effective* cloud cover (high cloud weighted less).
 * - **Twilight / night:** `nightFactorFromSunElevation` (frozen helper).
 *
 * ## Documented rendering-layer approximations
 *
 * - Overcast "greying" of the sky colours is a luminance-preserving desaturation
 *   toward neutral, not a cloud radiative-transfer solution.
 * - `exposure` is an artistic tone-mapping multiplier (1.0 clear day → ~3.5 deep
 *   night / heavy overcast) chosen for readability, not a photometric quantity.
 *
 * Conventions: Linear RGB 0..1 for colours; illuminance is relative (1.0 = clear
 * zenith sun). World space Y-up. Directions FROM scene TOWARDS body.
 */

import type { RGB, SkyState, Vec3 } from '@/types';
import {
  createLightingState,
  nightFactorFromSunElevation,
  type LightingState,
} from '@render/lighting/LightingState';
import {
  BETA_MIE,
  BETA_RAYLEIGH,
  createAtmosphereParams,
  skyRadiance,
  type AtmosphereParams,
} from './AtmosphereModel';

const DEG = Math.PI / 180;

// ─── Effective cloud cover ──────────────────────────────────────────────────

/**
 * Combine low/mid/high cloud fractions into a single effective cover 0..1.
 *
 * Low and mid clouds (stratus/cumulus/altostratus) block sunlight strongly;
 * high clouds (cirrus) are thin and translucent, so they count less. Weights
 * (low 1.0, mid 0.85, high 0.4) are combined as a "see-through" product so two
 * thin layers don't trivially sum past 1. Documented heuristic consistent with
 * Kasten–Czeplak using total cover: high cirrus contributes a fraction of an
 * opaque layer.
 */
export function effectiveCloudCover(low: number, mid: number, high: number): number {
  const l = clamp01(low);
  const m = clamp01(mid);
  const h = clamp01(high);
  // Transmission of each layer; product gives combined transmission.
  const tLow = 1 - 1.0 * l;
  const tMid = 1 - 0.85 * m;
  const tHigh = 1 - 0.4 * h;
  return clamp01(1 - tLow * tMid * tHigh);
}

// ─── Air mass (Kasten–Young 1989) ─────────────────────────────────────────────

/**
 * Elevation (radians) of the Kasten–Young air-mass maximum.
 *
 * The Kasten & Young (1989) empirical fit
 *   m = 1 / (cos z + 0.50572 (96.07995 − z_deg)^−1.6364)
 * is only valid up to a zenith angle of ~96° (elevation ~−6°). Inside that
 * domain the air mass is NOT monotone: it rises as the sun sinks, PEAKS near
 * elevation −1.757° (m ≈ 64.85), then collapses toward zero as z → 96°, where
 * the (96.07995 − z_deg)^−1.6364 term diverges and swamps the denominator.
 *
 * Physically the slant optical path can only grow as the sun sinks, so that
 * collapse is an artefact of extrapolating the fit past its design range, not a
 * real decrease. We therefore evaluate Kasten–Young only down to this peak and
 * HOLD the peak value flat below it (a documented monotone extension). This
 * keeps air mass monotone non-decreasing as elevation falls across the whole
 * range, which in turn keeps the Beer–Lambert `sunColor` reddening monotone
 * (never re-whitening or going blue) below the horizon.
 *
 * Value located numerically by scanning the fit (step 1e-4°) over −3..0°.
 */
const AIR_MASS_PEAK_ELEVATION = -1.7572 * DEG;

/**
 * Relative optical air mass as a function of sun elevation (radians).
 *
 * Monotone non-decreasing as elevation falls, finite and positive everywhere.
 * Reference: Kasten & Young (1989); below the fit's air-mass maximum
 * (`AIR_MASS_PEAK_ELEVATION`) the peak value is held flat — see that constant's
 * doc comment for why.
 */
function airMass(sunElevation: number): number {
  // Clamp to the fit's valid (monotone) region. Below the peak the fit folds
  // back down unphysically, so we evaluate it at the peak and hold flat.
  const elev = Math.max(sunElevation, AIR_MASS_PEAK_ELEVATION);
  const zDeg = 90 - elev / DEG; // zenith angle in degrees
  const cosZ = Math.sin(elev); // = cos(zenith)
  const denom = cosZ + 0.50572 * Math.pow(Math.max(96.07995 - zDeg, 1e-3), -1.6364);
  if (denom <= 0) return 65; // defensive; unreachable given the clamp above
  return 1 / denom;
}

// ─── Sun colour via Beer–Lambert ──────────────────────────────────────────────

/**
 * Direct-sun transmittance per band after traversing `m` air masses.
 * The per-band optical depth at the zenith (m=1) is beta * scaleHeight, i.e.
 * the vertically-integrated column. Scaling by `m` gives the slant column.
 */
function sunTransmittance(m: number, band: number, betaMie: number, hMie: number, hRay: number): number {
  const tauRayZenith = band * hRay;
  const tauMieZenith = betaMie * hMie;
  return Math.exp(-(tauRayZenith + tauMieZenith) * m);
}

// Zenith (m=1) transmittances, precomputed for normalisation so a clear zenith
// sun comes out warm-white with luminance ~1.
const H_RAY = 8000;
const H_MIE = 1200;
const T_ZEN_R = sunTransmittance(1, BETA_RAYLEIGH.r, BETA_MIE, H_MIE, H_RAY);
const T_ZEN_G = sunTransmittance(1, BETA_RAYLEIGH.g, BETA_MIE, H_MIE, H_RAY);
const T_ZEN_B = sunTransmittance(1, BETA_RAYLEIGH.b, BETA_MIE, H_MIE, H_RAY);

// ─── Main entry point ──────────────────────────────────────────────────────────

/**
 * Compute the full `LightingState` from sky geometry + live weather.
 *
 * @param sky   Current solar/lunar/cloud state.
 * @param cond  `solarRadiation` (W/m², shortwave) and `visibility` (metres) from
 *              the live `SkyConditions`.
 * @param out   Optional target to fill (allocation-free path).
 */
export function computeLightingState(
  sky: SkyState,
  cond: { solarRadiation: number; visibility: number },
  out?: LightingState,
): LightingState {
  const L = out ?? createLightingState();

  const elev = sky.sunElevation;
  const nightFactor = nightFactorFromSunElevation(elev);
  const overcast = effectiveCloudCover(sky.cloudLow, sky.cloudMid, sky.cloudHigh);

  // ── Air mass & raw sun transmittance ──
  const m = airMass(elev);
  let sr = sunTransmittance(m, BETA_RAYLEIGH.r, BETA_MIE, H_MIE, H_RAY) / T_ZEN_R;
  let sg = sunTransmittance(m, BETA_RAYLEIGH.g, BETA_MIE, H_MIE, H_RAY) / T_ZEN_G;
  let sb = sunTransmittance(m, BETA_RAYLEIGH.b, BETA_MIE, H_MIE, H_RAY) / T_ZEN_B;

  // Warm-white tint for the zenith sun (mild, so midday is near-white).
  sr *= 1.0;
  sg *= 0.985;
  sb *= 0.96;

  // Normalise the colour to a 0..1 hue preserving the r:g:b ratio; brightness
  // is carried separately by sunIlluminance.
  const sMax = Math.max(sr, sg, sb, 1e-6);
  const sunColor: RGB = { r: clamp01(sr / sMax), g: clamp01(sg / sMax), b: clamp01(sb / sMax) };

  // ── Direct-sun illuminance ──
  // Geometric cosine falloff as the sun nears the horizon, times a cloud
  // direct-beam attenuation (steeper than the global 0.75 n^3.4), times the
  // extinction brightness (unnormalised transmittance luminance).
  const elevFactor = smoothstep(-2 * DEG, 6 * DEG, elev); // fades out through twilight
  const beamExtinction = relativeLuma(
    sunTransmittance(m, BETA_RAYLEIGH.r, BETA_MIE, H_MIE, H_RAY),
    sunTransmittance(m, BETA_RAYLEIGH.g, BETA_MIE, H_MIE, H_RAY),
    sunTransmittance(m, BETA_RAYLEIGH.b, BETA_MIE, H_MIE, H_RAY),
  ) / relativeLuma(T_ZEN_R, T_ZEN_G, T_ZEN_B);
  // Direct beam cloud attenuation: 1 - n^2.5 (steeper than the ambient curve).
  const directCloud = clamp01(1 - Math.pow(overcast, 2.5));
  let sunIlluminance = clamp01(beamExtinction) * elevFactor * directCloud;

  // Blend in measured clearness from solarRadiation when the sun is reasonably
  // high (> ~10°), where the model and the measurement are both reliable. We
  // compare the measured shortwave to a clear-sky expectation (a simple
  // Haurwitz-style G_clear = 1098 * cos(z) * exp(-0.059/cos(z)) W/m²) and nudge
  // the illuminance toward the observed clearness index. Documented blend.
  if (elev > 10 * DEG && cond.solarRadiation > 0) {
    const cosZ = Math.sin(elev);
    const gClear = 1098 * cosZ * Math.exp(-0.059 / cosZ);
    const clearness = clamp01(cond.solarRadiation / Math.max(gClear, 1));
    const w = smoothstep(10 * DEG, 20 * DEG, elev); // blend weight ramps in 10..20°
    sunIlluminance = sunIlluminance * (1 - w) + clamp01(clearness) * elevFactor * w;
  }

  // ── Sky dome colours from the atmosphere model ──
  const atmo: AtmosphereParams = createAtmosphereParams();
  atmo.sunDir = sky.sunDirection;
  atmo.overcast = overcast;
  // Dim the whole sky through twilight so colours darken into night.
  atmo.intensity = 22 * (1 - 0.92 * nightFactor);

  const zenithRaw = skyRadiance({ x: 0, y: 1, z: 0 }, sky.sunDirection, atmo);
  // Horizon sample taken 90° in azimuth away from the sun so it's a neutral
  // horizon rather than the glow directly under the sun.
  const horizonDir = horizonAwayFromSun(sky.sunDirection);
  const horizonRaw = skyRadiance(horizonDir, sky.sunDirection, atmo);

  const zenithColor = tonemapColor(zenithRaw);
  const horizonColor = tonemapColor(horizonRaw);

  // ── Clear-sky blue enrichment (documented stylized-realism adjustment) ──
  // The single-scattering model + the chroma-preserving Reinhard already give a
  // blue-dominant zenith, but the renderer's final ACESFilmic tone-map
  // desaturates bright colours toward white, so a tone-mapped zenith reads as a
  // washed pale blue on screen rather than the deep blue a clear midday sky
  // should show (art-direction.md target zenith ~ sRGB (70,120,200)). We
  // pre-compensate by pushing the zenith slightly toward its own blue — reducing
  // the red/green relative to blue — so that AFTER ACES it lands near the target.
  // The horizon gets a much gentler push (it should stay paler). The strength is
  // gated to CLEAR (low effective cover) and HIGH-SUN (daytime) conditions so it
  // never affects overcast grey, warm low-sun sunsets, or night — it only
  // deepens a sky that is genuinely clear blue. Labelled rendering-layer tint,
  // NOT a change to the physical radiance.
  {
    const clearness = 1 - smoothstep(0.3, 0.7, overcast); // full clear up to ~0.3 cover
    const highSun = smoothstep(10 * DEG, 35 * DEG, elev);
    const enrich = clearness * highSun * (1 - nightFactor);
    // Reference clear-midday zenith in LINEAR RGB, chosen so that after the
    // renderer's ACESFilmic + sRGB output transform it lands near the
    // art-direction target of sRGB ~ (70,120,200): a deep, saturated sky blue.
    const ZENITH_BLUE: RGB = { r: 0.055, g: 0.16, b: 0.5 };
    zenithColor.r = lerp(zenithColor.r, ZENITH_BLUE.r, enrich);
    zenithColor.g = lerp(zenithColor.g, ZENITH_BLUE.g, enrich);
    zenithColor.b = lerp(zenithColor.b, ZENITH_BLUE.b, enrich);
    // Horizon stays markedly paler; only a light saturation nudge toward blue.
    const hEnrich = enrich * 0.4;
    horizonColor.r = lerp(horizonColor.r, horizonColor.r * 0.82, hEnrich);
    horizonColor.g = lerp(horizonColor.g, horizonColor.g * 0.95, hEnrich);
  }

  // ── Ambient (hemisphere average, cosine-weighted ≈ blend of zenith & horizon) ──
  const ambientColor: RGB = {
    r: zenithColor.r * 0.35 + horizonColor.r * 0.65,
    g: zenithColor.g * 0.35 + horizonColor.g * 0.65,
    b: zenithColor.b * 0.35 + horizonColor.b * 0.65,
  };
  // Ambient illuminance: Kasten–Czeplak global attenuation 1 - 0.75 n^3.4,
  // scaled by daylight presence. A small floor keeps night scenes readable.
  const globalCloud = clamp01(1 - 0.75 * Math.pow(overcast, 3.4));
  const dayPresence = 1 - nightFactor;
  const ambientIlluminance = clamp01(0.03 + 0.37 * dayPresence * globalCloud);

  // ── Fog colour: horizon colour mixed toward grey with overcast and with
  // reduced visibility (hazier air → greyer, flatter fog). ──
  const visKm = cond.visibility / 1000;
  // Low visibility (< ~10 km) pushes fog toward neutral grey.
  const hazeMix = clamp01(1 - smoothstep(2, 20, visKm));
  const greyMix = clamp01(0.6 * overcast + 0.4 * hazeMix);
  const fogGreyTarget = relativeLuma(horizonColor.r, horizonColor.g, horizonColor.b);
  const fogColor: RGB = {
    r: lerp(horizonColor.r, fogGreyTarget, greyMix),
    g: lerp(horizonColor.g, fogGreyTarget, greyMix),
    b: lerp(horizonColor.b, fogGreyTarget, greyMix),
  };

  // ── Exposure: rises smoothly toward night and under overcast so the image
  // stays readable. Range ~1.0 (clear day) → ~3.5 (deep night / heavy overcast). ──
  const exposure = 1.0 + 2.3 * nightFactor + 0.6 * overcast;

  // ── Write out ──
  L.sunColor = sunColor;
  L.sunIlluminance = clamp01(sunIlluminance);
  L.zenithColor = zenithColor;
  L.horizonColor = horizonColor;
  L.ambientColor = ambientColor;
  L.ambientIlluminance = ambientIlluminance;
  L.fogColor = fogColor;
  L.overcast = overcast;
  L.nightFactor = nightFactor;
  L.exposure = exposure;
  return L;
}

// ─── Venue sky-base tint helper ────────────────────────────────────────────────

/**
 * Bias the daytime zenith colour toward a venue's "Sky base" palette colour
 * (docs/art-direction.md) without breaking day/night progression. The tint is
 * scaled by how much daylight there is (1 - nightFactor), so at night the
 * venue tint vanishes and the physical night sky is preserved. `strength`
 * 0..1 controls the maximum daytime bias.
 *
 * Stylized realism: the palette is only *biased* here; the hard palette lock is
 * applied later by the colour grade (F.3). Returns a NEW LightingState unless
 * `out` is supplied; mutates only `zenithColor` (+ derived ambient).
 */
export function skyTint(
  lighting: LightingState,
  venueSkyBase: RGB,
  strength: number,
  out?: LightingState,
): LightingState {
  const L = out ?? { ...lighting, sunColor: { ...lighting.sunColor } };
  const day = 1 - lighting.nightFactor;
  const k = clamp01(strength) * day;
  const z = lighting.zenithColor;
  const tinted: RGB = {
    r: lerp(z.r, venueSkyBase.r, k),
    g: lerp(z.g, venueSkyBase.g, k),
    b: lerp(z.b, venueSkyBase.b, k),
  };
  L.zenithColor = tinted;
  // Keep ambient consistent with the biased zenith.
  L.ambientColor = {
    r: tinted.r * 0.35 + lighting.horizonColor.r * 0.65,
    g: tinted.g * 0.35 + lighting.horizonColor.g * 0.65,
    b: tinted.b * 0.35 + lighting.horizonColor.b * 0.65,
  };
  L.horizonColor = { ...lighting.horizonColor };
  L.fogColor = { ...lighting.fogColor };
  return L;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Tone-map a (potentially >1) radiance to a 0..1 display colour.
 *
 * Uses a LUMINANCE-based Reinhard operator (Reinhard et al. 2002, "Photographic
 * Tone Reproduction for Digital Images", §3): compress the relative luminance
 * `L -> L/(1+L)` and scale every channel by the same ratio `Lout/Lin`, which
 * preserves the colour RATIOS (chroma/hue) exactly. The previous PER-CHANNEL
 * Reinhard `c/(1+c)` compressed the bright blue channel harder than the dim red
 * channel, DESATURATING a saturated blue sky toward grey — and because the dome
 * is then tone-mapped a second time by the renderer's ACESFilmic pass, that
 * residual desaturation washed the clear noon zenith out to a flat pale grey
 * (observed sRGB ~(110,127,151) instead of a clear blue). Keeping the chroma
 * through this first compression lets the blue survive the second (ACES) pass.
 *
 * Still guaranteed 0..1 (the luminance ratio is <=1 and each channel is clamped)
 * and still monotone in brightness, so the "blue-dominant zenith / paler, higher-
 * luminance horizon / overcast desaturates" invariants all hold.
 */
function tonemapColor(c: RGB): RGB {
  const lin = relativeLuma(c.r, c.g, c.b);
  if (lin <= 1e-6) {
    // Near-black: fall back to per-channel so a tiny colour still maps sanely.
    return { r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b) };
  }
  const lout = lin / (1 + lin);
  const scale = lout / lin;
  return {
    r: clamp01(c.r * scale),
    g: clamp01(c.g * scale),
    b: clamp01(c.b * scale),
  };
}

/** A horizon view direction rotated 90° in azimuth away from the sun. */
function horizonAwayFromSun(sunDir: Vec3): Vec3 {
  // Project sun to ground plane; rotate 90° about Y; keep on the horizon (y=0).
  const gx = sunDir.x;
  const gz = sunDir.z;
  const len = Math.hypot(gx, gz);
  if (len < 1e-4) return { x: 1, y: 0, z: 0 };
  // Perpendicular on the ground plane.
  return { x: -gz / len, y: 0, z: gx / len };
}

function relativeLuma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export const _testing = {
  airMass,
  sunTransmittance,
  tonemapColor,
  horizonAwayFromSun,
  smoothstep,
  T_ZEN_R,
  T_ZEN_G,
  T_ZEN_B,
};
