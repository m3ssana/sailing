/**
 * AtmosphereModel — pure CPU single-scattering Rayleigh + Mie sky radiance
 * (Stream F.1). NO three.js imports: this is the headless, unit-testable
 * "model" that the TSL SkyDome mirrors. The TSL layer must reproduce these
 * same formulas so the GPU sky and the CPU reference never disagree.
 *
 * ## Physical basis
 *
 * - Rayleigh scattering coefficient beta_R (per metre, linear RGB bands):
 *   (5.8e-6, 13.5e-6, 33.1e-6), with an atmospheric scale height of 8000 m.
 * - Mie scattering coefficient beta_M ~ 21e-6 /m, scale height 1200 m.
 * - Rayleigh phase:  3/(16*pi) * (1 + cos^2(theta)).
 * - Mie phase:       Cornette–Shanks, g = 0.76.
 * - Beer–Lambert transmittance along the optical path.
 *
 * References:
 *   Nishita et al. 1993 (single-scattering sky model);
 *   Preetham et al. 1999 (coefficients & scale heights);
 *   Cornette & Shanks 1992 (improved HG phase function).
 *
 * ## Scope / approximation (labelled, per steering rules)
 *
 * This is a *single-scattering* model with a small fixed-step optical-depth
 * integration along the view ray (no multiple scattering, no ozone layer). It
 * is a stylized-realism reference adequate for driving the sky dome and water
 * reflections, NOT a reference-grade radiative transfer solver. All outputs are
 * finite for every view/sun direction including at and below the horizon.
 *
 * Conventions: Linear RGB. World space Y-up, right-handed, +X east, +Z south.
 * Directions point FROM the scene TOWARDS the body (same as SkyState).
 */

import type { RGB, Vec3 } from '@/types';

// ─── Physical constants ─────────────────────────────────────────────────────

/** Rayleigh scattering coefficient per metre, per linear-RGB band. */
export const BETA_RAYLEIGH: Readonly<RGB> = { r: 5.8e-6, g: 13.5e-6, b: 33.1e-6 };
/** Mie scattering coefficient per metre (wavelength-independent to first order). */
export const BETA_MIE = 21e-6;
/** Rayleigh density scale height, metres. */
export const H_RAYLEIGH = 8000;
/** Mie density scale height, metres. */
export const H_MIE = 1200;
/** Mean Earth radius, metres (spherical-atmosphere optical path). */
export const R_EARTH = 6_371_000;
/** Top of the modelled atmosphere, metres above sea level. */
export const R_ATMOSPHERE = R_EARTH + 60_000;
/** Cornette–Shanks asymmetry parameter for Mie forward scattering. */
export const MIE_G = 0.76;

/** Apparent angular radius of the sun's disc, radians (0.2666°). */
export const SUN_ANGULAR_RADIUS = 0.2666 * (Math.PI / 180);
/**
 * Rendering-layer enlargement of the sun disc for on-screen visibility. The
 * true disc (~0.53° diameter) is nearly a point at typical FOV; a modestly
 * enlarged disc reads better and matches stylized-realism intent. Documented
 * approximation, not physical.
 */
export const SUN_DISC_RENDER_RADIUS = SUN_ANGULAR_RADIUS * 3.5;

const FOUR_PI = 4 * Math.PI;

// ─── Phase functions ──────────────────────────────────────────────────────────

/** Rayleigh phase: 3/(16*pi) * (1 + cos^2 theta). `mu` = cos(theta). */
export function rayleighPhase(mu: number): number {
  return (3 / (16 * Math.PI)) * (1 + mu * mu);
}

/**
 * Cornette–Shanks Mie phase function. `mu` = cos(theta) between view and sun.
 * Reduces to Henyey–Greenstein when the (1+mu^2) numerator term is dropped;
 * Cornette–Shanks is the physically-improved variant used here.
 */
export function miePhase(mu: number, g: number = MIE_G): number {
  const g2 = g * g;
  const num = (3 * (1 - g2) * (1 + mu * mu));
  const denom = (FOUR_PI * 2 * (2 + g2) * Math.pow(1 + g2 - 2 * g * mu, 1.5));
  return num / denom;
}

// ─── Optical path geometry ──────────────────────────────────────────────────

/**
 * Distance from a point at radius `r` (from planet centre) travelling along a
 * ray whose cosine with the local up is `mu`, to the atmosphere shell of radius
 * `R_ATMOSPHERE`. Closed form (ray–sphere intersection, outer root).
 */
function distanceToAtmosphereTop(r: number, mu: number): number {
  // Solve |P + t*D|^2 = R_ATMOSPHERE^2 with |P| = r and P·D = r*mu.
  const disc = r * r * (mu * mu - 1) + R_ATMOSPHERE * R_ATMOSPHERE;
  // disc >= 0 always for r <= R_ATMOSPHERE.
  return Math.max(0, -r * mu + Math.sqrt(Math.max(0, disc)));
}

/**
 * Integrate the two density profiles along a ray from the ground to the top of
 * the atmosphere, returning Rayleigh and Mie optical-depth path integrals
 * (dimensionless multipliers of beta). Small fixed step count — cheap enough to
 * call per sample on the CPU, which is the point of the "analytic-ish" design.
 *
 * `cosUp` is the cosine between the ray direction and local up (zenith).
 */
function opticalDepth(cosUp: number, steps: number = 8): { rayleigh: number; mie: number } {
  const r0 = R_EARTH;
  const rayLen = distanceToAtmosphereTop(r0, cosUp);
  if (rayLen <= 0) return { rayleigh: 0, mie: 0 };

  const dt = rayLen / steps;
  let odR = 0;
  let odM = 0;
  // Midpoint rule. Height above sea level derived from law of cosines along ray.
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const r = Math.sqrt(r0 * r0 + t * t + 2 * r0 * t * cosUp);
    const h = Math.max(0, r - R_EARTH);
    odR += Math.exp(-h / H_RAYLEIGH) * dt;
    odM += Math.exp(-h / H_MIE) * dt;
  }
  return { rayleigh: odR, mie: odM };
}

// ─── Sky radiance ─────────────────────────────────────────────────────────────

/** Tunable parameters for a single sky evaluation. */
export interface AtmosphereParams {
  /** Unit sun direction, FROM scene TOWARDS sun. Y-up. */
  sunDir: Vec3;
  /**
   * Overall scattering intensity scale (sun "brightness" multiplier). 1 is the
   * calibrated clear-day value; reduce toward night / raise for stylization.
   */
  intensity: number;
  /**
   * Overcast factor 0..1. Greys and flattens the sky: at 1 the Rayleigh/Mie
   * colour is mixed toward a neutral luminance (documented rendering-layer
   * desaturation, not physical cloud transport).
   */
  overcast: number;
  /** Mie turbidity multiplier (haze). 1 = clear; >1 thickens the Mie term. */
  turbidity: number;
}

export function createAtmosphereParams(): AtmosphereParams {
  return { sunDir: { x: 0, y: 1, z: 0 }, intensity: 22, overcast: 0, turbidity: 1 };
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function luminance(c: RGB): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/**
 * Single-scattering sky radiance for a view direction, in linear RGB.
 *
 * The result is NOT clamped to 0..1 — it is a radiance (the SkyDome / tone
 * mapping scales it for display). It is however guaranteed finite and
 * non-negative for every input, including view directions at or below the
 * horizon (the view up-cosine is clamped to a small positive floor so the
 * closed-form optical path stays well-defined below the horizon — a documented
 * approximation that keeps the dome usable when the camera tilts down).
 */
export function skyRadiance(
  viewDir: Vec3,
  sunDir: Vec3,
  params: AtmosphereParams,
  out?: RGB,
): RGB {
  const res = out ?? { r: 0, g: 0, b: 0 };

  // Normalise inputs defensively (callers may pass slightly non-unit vectors).
  const vLen = Math.hypot(viewDir.x, viewDir.y, viewDir.z) || 1;
  const vx = viewDir.x / vLen;
  const vy = viewDir.y / vLen;
  const vz = viewDir.z / vLen;

  const sLen = Math.hypot(sunDir.x, sunDir.y, sunDir.z) || 1;
  const sx = sunDir.x / sLen;
  const sy = sunDir.y / sLen;
  const sz = sunDir.z / sLen;

  // cos(angle) between view and sun.
  const mu = clampMu(vx * sx + vy * sy + vz * sz);

  // View up-cosine (zenith = 1, horizon = 0). Floored so below-horizon views
  // still produce a finite path (stylized continuation below the horizon).
  const viewUp = Math.max(0.02, vy);
  // Sun up-cosine governs how much atmosphere the sunlight traverses.
  const sunUp = Math.max(0.02, sy);

  const viewOD = opticalDepth(viewUp);
  const sunOD = opticalDepth(sunUp);

  const phaseR = rayleighPhase(mu);
  const phaseM = miePhase(mu);

  const betaM = BETA_MIE * params.turbidity;

  // Beer–Lambert transmittance along (sun path + view path) per band.
  // Rayleigh and Mie extinction combined.
  const r = scatterBand(
    BETA_RAYLEIGH.r, betaM, viewOD, sunOD, phaseR, phaseM,
  );
  const g = scatterBand(
    BETA_RAYLEIGH.g, betaM, viewOD, sunOD, phaseR, phaseM,
  );
  const b = scatterBand(
    BETA_RAYLEIGH.b, betaM, viewOD, sunOD, phaseR, phaseM,
  );

  let cr = r * params.intensity;
  let cg = g * params.intensity;
  let cb = b * params.intensity;

  // Overcast: mix toward a neutral grey of equal luminance so the sky loses
  // saturation and flattens, without going dark (documented approximation).
  // The greying follows a QUADRATIC response in cover (`k = overcast^2`) rather
  // than a linear one: scattered fair-weather cloud (effective cover ~0.2, a
  // "clear" day) should leave the sky between the clouds essentially blue, not
  // grey it by ~20%. A full overcast (cover 1) still fully flattens (1^2 = 1).
  // This keeps the clear-noon zenith reading as a believable blue. Documented
  // rendering-layer shaping of the desaturation, not a cloud-transport result.
  if (params.overcast > 0) {
    const lum = luminance({ r: cr, g: cg, b: cb });
    const grey = lum;
    const cover = clamp01(params.overcast);
    const k = cover * cover;
    cr = cr * (1 - k) + grey * k;
    cg = cg * (1 - k) + grey * k;
    cb = cb * (1 - k) + grey * k;
  }

  res.r = finite(cr);
  res.g = finite(cg);
  res.b = finite(cb);
  return res;
}

/** Combined Rayleigh+Mie single-scatter contribution for one colour band. */
function scatterBand(
  betaR: number,
  betaM: number,
  viewOD: { rayleigh: number; mie: number },
  sunOD: { rayleigh: number; mie: number },
  phaseR: number,
  phaseM: number,
): number {
  // Transmittance of the SUNLIGHT reaching the scattering column (the sun's
  // slant path). Rayleigh reddens this; Mie extinguishes it a little faster
  // than it scatters. This is what reddens a low sun.
  const sunTauR = betaR * sunOD.rayleigh;
  const sunTauM = betaM * 1.1 * sunOD.mie;
  const sunTransmit = Math.exp(-(sunTauR + sunTauM));

  // In-scattered radiance toward the viewer ∝ beta * phase * (air mass along the
  // VIEW ray). A longer view path (toward the horizon) accumulates MORE density,
  // so the horizon is brighter and — because Mie's grey glow grows faster than
  // Rayleigh's blue along the long path — whiter. We intentionally do NOT
  // attenuate the in-scatter by the view-path transmittance: a single-scatter
  // closed form that multiplies by exp(-tauView) double-penalises the horizon
  // (documented approximation; the CPU model is a stylized reference).
  const inScatterR = betaR * phaseR * viewOD.rayleigh;
  const inScatterM = betaM * phaseM * viewOD.mie;

  return (inScatterR + inScatterM) * sunTransmit;
}

function clampMu(mu: number): number {
  return mu < -1 ? -1 : mu > 1 ? 1 : mu;
}

function finite(x: number): number {
  return Number.isFinite(x) ? Math.max(0, x) : 0;
}

// ─── Sun disc ─────────────────────────────────────────────────────────────────

/**
 * Relative radiance of the solar disc as a function of the angular offset
 * (radians) from the sun centre. Returns 0 outside the (render-enlarged) disc.
 * Inside, applies a classical limb-darkening law so the disc edge is softer
 * than its centre.
 *
 * Limb darkening: I(mu_disc)/I(0) = 1 - u*(1 - mu_disc), u ≈ 0.6, where
 * mu_disc = cos of the angle from disc centre as seen across the disc face.
 * Reference: Hestroffer & Magnan 1998 (solar limb-darkening coefficients).
 */
export function sunDiscRadiance(
  angularOffset: number,
  discRadius: number = SUN_DISC_RENDER_RADIUS,
): number {
  if (angularOffset >= discRadius) return 0;
  const x = clamp01(angularOffset / discRadius); // 0 centre .. 1 edge.
  // Map radial position to the cosine of the emergent angle across the disc.
  const muDisc = Math.sqrt(Math.max(0, 1 - x * x));
  const u = 0.6;
  const ld = 1 - u * (1 - muDisc);
  // Soft antialiased edge over the outer 5% of the disc.
  const edge = clamp01((discRadius - angularOffset) / (0.05 * discRadius));
  return ld * edge;
}

export const _testing = {
  opticalDepth,
  distanceToAtmosphereTop,
  scatterBand,
  luminance,
};
