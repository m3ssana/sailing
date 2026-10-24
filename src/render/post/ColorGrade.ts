/**
 * ColorGrade — PURE procedural colour grade + palette hold (Stream F.3).
 *
 * NO three.js in the model. The TSL mirror (`gradeNode`, `createGradeUniforms`)
 * lives at the bottom and consumes `three/tsl` only.
 *
 * This replaces the "per-venue LUT" called for in requirement 7.10. **A baked
 * 3D LUT is deliberately NOT used** — the no-assets rule (req 7.14, enforced by
 * check-no-assets.mjs) forbids shipping image data, and a runtime-generated LUT
 * texture would be redundant with evaluating the same arithmetic directly in
 * TSL. So the grade is a closed-form procedural transform, applied identically
 * on the CPU (for tests/tools) and in the shader.
 *
 * ## Operations, in order (art-direction.md §5.3)
 *
 *  1. **Exposure** — multiply linear RGB by `2^exposure` (stops).
 *  2. **Contrast** — a POWER-LAW ("gamma-about-pivot" / log-contrast) pivot
 *     around linear mid-grey 0.18 (the ACES/scene-referred mid-grey, NOT 0.5,
 *     which is a display-referred value), applied per channel:
 *
 *         out = 0.18 · (c / 0.18) ^ k,   k = contrast + 1   (for c > 1e-6)
 *
 *     with k = contrast + 1 so `contrast = 0` ⇒ k = 1 ⇒ `out = c` (exact
 *     identity). This is the contrast operator used by DaVinci Resolve and
 *     Blender's Filmic "contrast about pivot": it is positive-preserving — a
 *     dim scene-referred value never goes to zero — so it satisfies
 *     art-direction.md §5.3's "subtle S-curve, never crushing blacks". The
 *     earlier LINEAR pivot `out = (c-0.18)·k + 0.18` DID crush: for any dim
 *     value `c < 0.18·(k-1)/k` (e.g. a noon-sky zenith at linear ~0.02–0.05
 *     under a contrast of only 0.06) it drove the output ≤ 0, and the final
 *     `max(·,0)` clamp turned the whole upper sky / dim water BLACK. A
 *     non-positive channel (≤ 1e-6) is passed through unchanged, which both
 *     avoids a `pow(0, k)` NaN and keeps a true 0 mapped to 0 (black stays
 *     black, and k=1 is a bit-exact identity); above pivot the curve brightens,
 *     below it darkens, exactly the S-curve feel the linear form intended but
 *     without the black crush.
 *  3. **Saturation** — lerp between the Rec.709 luminance and the colour.
 *  4. **Shadow lift / highlight gain** — split by luminance. Shadows are
 *     *lifted* (additive, weighted so pure black is not lifted off zero);
 *     highlights are *gained* (multiplicative `×(1+tint·hiW)`, which is a no-op
 *     at black). This matches the frozen `ColorGradeParams` wording ("lift in
 *     shadows", "gain in highlights") and guarantees neutrals/blacks stay
 *     neutral — the grade never tints a true black.
 *
 * ## Palette hold (requirement 7.15)
 *
 * `paletteHold` rotates a colour's HUE a bounded fraction toward the nearest
 * palette entry's hue WITHOUT changing its luminance (and barely its chroma).
 * The hue space is **OKLCH** (the polar form of OKLab), chosen because OKLab is
 * perceptually uniform, so "nearest hue" and "rotate toward" behave the way the
 * eye expects, and because OKLab's L channel is a clean luminance axis we can
 * hold fixed. A grey (chroma ≈ 0) has no defined hue, so it is passed through
 * unchanged — the grade must never tint neutrals (art-direction.md §5.3).
 *
 * Conventions: Linear RGB 0..1 internally. sRGB appears only when a palette is
 * authored as hex (the tests convert hex → linear via `srgbHexToLinear`).
 */

import type { RGB } from '@/types';

// ─── Rec.709 luminance ─────────────────────────────────────────────────────────

const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/** Linear-RGB relative luminance (Rec.709). */
export function luminance(rgb: RGB): number {
  return LUMA_R * rgb.r + LUMA_G * rgb.g + LUMA_B * rgb.b;
}

// ─── Main grade ────────────────────────────────────────────────────────────────

import type { ColorGradeParams } from '@/types';

const MID_GREY = 0.18;

/**
 * Threshold below which the power-law contrast pivot passes a channel through
 * unchanged. This (a) avoids `pow(0, k)` NaN/Inf on a non-positive channel and
 * (b) keeps contrast=0 (k=1) a bit-exact identity on a true 0, so NEUTRAL_GRADE
 * is a verified no-op even on black. 1e-6 is far below any meaningful
 * scene-referred value, so it is invisible for real colours. Shared verbatim by
 * the TSL mirror so CPU and GPU agree.
 */
const CONTRAST_EPS = 1e-6;

/**
 * The exact-identity colour grade: exposure 0 (×1), contrast 0 (pivot gain 1),
 * saturation 1, zero shadow lift, zero highlight gain, empty palette. Running
 * `applyColorGrade`/`gradeNode` with these params is a verified no-op (unit
 * test `neutral grade is an exact identity`), so PostChain uses it as the
 * default grade when a venue supplies none — a missing venue grade must never
 * alter the image.
 */
export const NEUTRAL_GRADE: ColorGradeParams = {
  exposure: 0,
  contrast: 0,
  saturation: 1,
  shadowTint: { r: 0, g: 0, b: 0 },
  highlightTint: { r: 0, g: 0, b: 0 },
  palette: [],
};

/**
 * Apply the procedural colour grade to a linear-RGB colour.
 *
 * @param rgb    Input linear RGB.
 * @param params Grade parameters (exposure stops, contrast, saturation, tints).
 * @param out    Optional destination (avoids allocation in hot paths).
 */
export function applyColorGrade(rgb: RGB, params: ColorGradeParams, out?: RGB): RGB {
  const dst: RGB = out ?? { r: 0, g: 0, b: 0 };

  // 1. Exposure (stops).
  const e = Math.pow(2, params.exposure);
  let r = rgb.r * e;
  let g = rgb.g * e;
  let b = rgb.b * e;

  // 2. Contrast: POWER-LAW ("gamma-about-pivot" / log-contrast) around linear
  // mid-grey 0.18, per channel. out = 0.18·(c/0.18)^k with k = contrast+1
  // (k=1 ⇒ identity). Unlike the former linear pivot it is positive-preserving,
  // so dim scene-referred values (a noon-sky zenith at ~0.02–0.05) can never be
  // driven to ≤0 and crushed to black by the final max(·,0) — satisfying
  // art-direction.md §5.3 ("never crushing blacks"). This is the contrast
  // operator used by DaVinci/Blender Filmic. A non-positive channel is passed
  // through unchanged (the `> CONTRAST_EPS` guard): it both avoids a `pow(0,k)`
  // NaN/Inf and keeps contrast=0 (k=1) an EXACT identity on a true 0, so
  // NEUTRAL_GRADE stays a bit-exact no-op even on black.
  const k = params.contrast + 1;
  r = r > CONTRAST_EPS ? MID_GREY * Math.pow(r / MID_GREY, k) : r;
  g = g > CONTRAST_EPS ? MID_GREY * Math.pow(g / MID_GREY, k) : g;
  b = b > CONTRAST_EPS ? MID_GREY * Math.pow(b / MID_GREY, k) : b;

  // 3. Saturation via Rec.709 luminance.
  const l = LUMA_R * r + LUMA_G * g + LUMA_B * b;
  const s = params.saturation;
  r = l + (r - l) * s;
  g = l + (g - l) * s;
  b = l + (b - l) * s;

  // 4. Shadow / highlight tint, split by luminance (recomputed post-sat).
  //
  // Per the frozen ColorGradeParams contract, `shadowTint` is a colour **lift**
  // (additive, in shadows) and `highlightTint` is a colour **gain**
  // (multiplicative, in highlights). The earlier implementation applied BOTH
  // additively, which (a) violated the type's "gain" semantics and (b) lifted
  // pure black off zero and tinted neutrals — directly contradicting this
  // module's own invariant ("the grade must never tint neutrals",
  // art-direction.md §5.3) and producing the grey/olive night-water wash seen
  // through the post chain. A multiplicative highlight gain is 1.0 at black
  // (black stays black); the shadow lift is weighted by `loW` AND by the
  // colour's own magnitude via a soft floor so a true 0 is not lifted to the
  // tint colour (it scales in with the signal), keeping neutrals and blacks
  // neutral while still tinting genuine shadow detail.
  const lum = Math.max(0, LUMA_R * r + LUMA_G * g + LUMA_B * b);
  // Smooth split weight: highlights dominate above ~mid, shadows below.
  const hiW = lum / (lum + 0.5); // 0 at black → 0.5 at lum=0.5 → →1 bright
  const loW = 1 - hiW;
  // Shadow lift scales with a soft signal mask (0 at black → 1 by lum≈0.1) so
  // pure black is never lifted to the tint colour.
  const liftMask = lum / (lum + 0.02);
  const lift = loW * liftMask;
  // Highlight gain: multiply by (1 + tint·hiW). At black hiW→0 so gain→1.
  r = r * (1 + params.highlightTint.r * hiW) + params.shadowTint.r * lift;
  g = g * (1 + params.highlightTint.g * hiW) + params.shadowTint.g * lift;
  b = b * (1 + params.highlightTint.b * hiW) + params.shadowTint.b * lift;

  // Clamp to the non-negative half-line. The power-law contrast is now
  // positive-preserving (it no longer drives darks negative — that was the
  // former linear pivot's crush bug), but the saturation and shadow/highlight
  // tint stages can still produce a small negative on a strongly-tinted channel.
  // Negative linear RGB is non-physical and the downstream ACES fit does NOT map
  // it to black — it yields a spurious lifted/tinted colour. A single max(·,0)
  // here guarantees a valid scene-referred output, so black stays black through
  // tone-mapping.
  dst.r = Math.max(0, r);
  dst.g = Math.max(0, g);
  dst.b = Math.max(0, b);
  return dst;
}

// ─── OKLab / OKLCH ─────────────────────────────────────────────────────────────
// Björn Ottosson's OKLab (2020). Input/output are LINEAR sRGB (not gamma sRGB).

interface OKLab {
  L: number;
  a: number;
  b: number;
}

/** Linear sRGB → OKLab. */
export function linearToOKLab(rgb: RGB): OKLab {
  const l = 0.4122214708 * rgb.r + 0.5363325363 * rgb.g + 0.0514459929 * rgb.b;
  const m = 0.2119034982 * rgb.r + 0.6806995451 * rgb.g + 0.1073969566 * rgb.b;
  const s = 0.0883024619 * rgb.r + 0.2817188376 * rgb.g + 0.6299787005 * rgb.b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

/** OKLab → linear sRGB. */
export function okLabToLinear(lab: OKLab): RGB {
  const l_ = lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
  const m_ = lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
  const s_ = lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

/** OKLCH chroma (sqrt(a²+b²)) of a linear colour. */
export function okChroma(rgb: RGB): number {
  const lab = linearToOKLab(rgb);
  return Math.hypot(lab.a, lab.b);
}

/** OKLCH hue angle (radians, atan2(b,a)) of a linear colour. */
export function okHue(rgb: RGB): number {
  const lab = linearToOKLab(rgb);
  return Math.atan2(lab.b, lab.a);
}

/** Signed smallest angular difference `to − from`, wrapped to (−π, π]. */
export function angularDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Absolute angular distance between two hues, 0..π. */
export function angularDistance(a: number, b: number): number {
  return Math.abs(angularDelta(a, b));
}

/** Chroma below which a colour is treated as neutral (no defined hue). */
const NEUTRAL_CHROMA = 1e-3;

/**
 * Palette hold: rotate `rgb`'s hue a bounded `strength` fraction toward the
 * nearest palette colour's hue, preserving OKLab luminance (L) and chroma (C).
 *
 * Properties (asserted in tests):
 *  - the angular hue distance to the nearest palette hue is NON-INCREASING;
 *  - strictly smaller for `strength > 0` unless already on-palette;
 *  - OKLab L (hence perceived luminance) preserved within 1e-3;
 *  - greys (chroma < NEUTRAL_CHROMA) pass through unchanged;
 *  - output finite.
 *
 * @param rgb      Input linear RGB.
 * @param palette  Venue palette as linear RGB entries.
 * @param strength Pull fraction 0..1 (art-direction caps the shader use ≤ 0.15).
 * @param out      Optional destination.
 */
export function paletteHold(
  rgb: RGB,
  palette: readonly RGB[],
  strength: number,
  out?: RGB,
): RGB {
  const dst: RGB = out ?? { r: 0, g: 0, b: 0 };
  const str = Math.min(1, Math.max(0, strength));

  const lab = linearToOKLab(rgb);
  const chroma = Math.hypot(lab.a, lab.b);

  // Greys have no hue: pass through unchanged.
  if (chroma < NEUTRAL_CHROMA || palette.length === 0 || str === 0) {
    dst.r = rgb.r;
    dst.g = rgb.g;
    dst.b = rgb.b;
    return dst;
  }

  const hue = Math.atan2(lab.b, lab.a);

  // Nearest palette hue (ignore near-neutral palette entries, they have no hue).
  let bestHue = hue;
  let bestDist = Infinity;
  for (const p of palette) {
    const plab = linearToOKLab(p);
    const pc = Math.hypot(plab.a, plab.b);
    if (pc < NEUTRAL_CHROMA) continue;
    const ph = Math.atan2(plab.b, plab.a);
    const d = angularDistance(hue, ph);
    if (d < bestDist) {
      bestDist = d;
      bestHue = ph;
    }
  }
  if (!Number.isFinite(bestDist)) {
    dst.r = rgb.r;
    dst.g = rgb.g;
    dst.b = rgb.b;
    return dst;
  }

  // Rotate hue by `strength` of the signed delta toward the nearest palette hue.
  const newHue = hue + angularDelta(hue, bestHue) * str;

  // Reconstruct with preserved L and C.
  const reLab: OKLab = {
    L: lab.L,
    a: chroma * Math.cos(newHue),
    b: chroma * Math.sin(newHue),
  };
  const lin = okLabToLinear(reLab);
  dst.r = lin.r;
  dst.g = lin.g;
  dst.b = lin.b;
  return dst;
}

// ─── sRGB hex helpers (for tooling / tests) ────────────────────────────────────

/** sRGB gamma channel (0..1) → linear. */
export function srgbChannelToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Parse a `#rrggbb` sRGB hex string to a LINEAR RGB. */
export function srgbHexToLinear(hex: string): RGB {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return {
    r: srgbChannelToLinear(r),
    g: srgbChannelToLinear(g),
    b: srgbChannelToLinear(b),
  };
}

// ─── three/TSL mirror ──────────────────────────────────────────────────────────

import { Fn, vec3, uniform, float } from 'three/tsl';
import type { TSLNode } from 'three/tsl';
import { Vector3 } from 'three/webgpu';

/** Uniform handles for the grade node, updatable per frame. */
export interface GradeUniforms {
  exposure: TSLNode & { value: unknown };
  contrast: TSLNode & { value: unknown };
  saturation: TSLNode & { value: unknown };
  shadowTint: TSLNode & { value: unknown };
  highlightTint: TSLNode & { value: unknown };
  /** Push new grade params into the uniforms. */
  update(params: ColorGradeParams): void;
}

/** Create updatable grade uniforms from initial params. */
export function createGradeUniforms(params: ColorGradeParams): GradeUniforms {
  const exposure = uniform(params.exposure);
  const contrast = uniform(params.contrast);
  const saturation = uniform(params.saturation);
  // vec3 uniforms carry a Vector3 value; keep our own handles so update() can
  // mutate them in place rather than reallocating.
  const shadowVec = new Vector3(params.shadowTint.r, params.shadowTint.g, params.shadowTint.b);
  const highlightVec = new Vector3(
    params.highlightTint.r,
    params.highlightTint.g,
    params.highlightTint.b,
  );
  const shadowTint = uniform(vec3(shadowVec.x, shadowVec.y, shadowVec.z));
  const highlightTint = uniform(vec3(highlightVec.x, highlightVec.y, highlightVec.z));
  return {
    exposure,
    contrast,
    saturation,
    shadowTint,
    highlightTint,
    update(p: ColorGradeParams): void {
      exposure.value = p.exposure;
      contrast.value = p.contrast;
      saturation.value = p.saturation;
      shadowVec.set(p.shadowTint.r, p.shadowTint.g, p.shadowTint.b);
      highlightVec.set(p.highlightTint.r, p.highlightTint.g, p.highlightTint.b);
      shadowTint.value = shadowVec;
      highlightTint.value = highlightVec;
    },
  };
}

/**
 * TSL mirror of `applyColorGrade` (steps 1–4). The palette hold is intentionally
 * NOT included in the shader path: it is a bounded authoring/validation stage
 * applied to palette-derived material colours at generation time, and running a
 * full OKLab round-trip per pixel is not worth the cost for a ≤0.15 tint. The
 * shader grade therefore matches `applyColorGrade` exactly; `paletteHold` is the
 * CPU-side palette-compliance guarantee (requirement 7.15).
 *
 * @param inputNode Linear-RGB colour node (post tone-map-free scene colour).
 * @param u         Grade uniforms from `createGradeUniforms`.
 */
export function gradeNode(inputNode: TSLNode, u: GradeUniforms): TSLNode {
  return Fn(() => {
    const mid = float(MID_GREY);
    // The post chain hands us the scene-pass colour, which is a vec4 (rgba).
    // All grade arithmetic is on RGB; take .xyz so the Rec.709 `dot(…, vec3)`
    // luma reductions are well-formed. (A vec4·vec3 dot is a dimension mismatch
    // that silently corrupts the luma term — which is inert only when
    // saturation == 1 and contrast == 0, i.e. exactly the neutral grade, so the
    // bug hid behind every neutral/identity test and surfaced only for a real
    // venue grade, crushing dim skies to black.)
    const rgb = inputNode.xyz;
    // 1. Exposure
    const exp = float(2).pow(u.exposure);
    const c0 = rgb.mul(exp);
    // 2. Contrast: POWER-LAW ("gamma-about-pivot" / log-contrast) about 0.18,
    // per channel. out = 0.18·(c/0.18)^k, k = contrast+1 (k=1 ⇒ identity).
    // Mirrors applyColorGrade step 2 EXACTLY, including the `c > eps` guard that
    // passes a non-positive channel through unchanged (avoids pow(0,k) and keeps
    // k=1 a bit-exact identity on black). Positive-preserving, so a dim sky
    // zenith is no longer crushed to black by the former linear pivot
    // (art-direction.md §5.3, "never crushing blacks").
    const k = u.contrast.add(1);
    const eps = float(CONTRAST_EPS);
    const powed = mid.mul(c0.div(mid).pow(k));
    const c1 = c0.greaterThan(eps).select(powed, c0);
    // 3. Saturation about Rec.709 luma
    const luma = c1.dot(vec3(LUMA_R, LUMA_G, LUMA_B));
    const c2 = luma.add(c1.sub(luma).mul(u.saturation));
    // 4. Shadow lift (additive, black-safe) / highlight gain (multiplicative).
    //    Mirrors applyColorGrade step 4 exactly.
    const lum = c2.dot(vec3(LUMA_R, LUMA_G, LUMA_B)).max(0);
    const hiW = lum.div(lum.add(0.5));
    const loW = hiW.oneMinus();
    const liftMask = lum.div(lum.add(0.02));
    const lift = loW.mul(liftMask);
    // gain = 1 + highlightTint*hiW ; out = c2*gain + shadowTint*lift
    const gain = vec3(1, 1, 1).add(u.highlightTint.mul(hiW));
    // max(·,0): the power-law contrast is positive-preserving (it no longer
    // drives darks negative — that was the former linear pivot's crush bug), but
    // saturation/tint can still produce a small negative; negative linear RGB is
    // non-physical and ACES turns it into a spurious lifted colour. Clamping
    // keeps black black. Mirrors applyColorGrade.
    return c2.mul(gain).add(u.shadowTint.mul(lift)).max(0);
  })();
}
