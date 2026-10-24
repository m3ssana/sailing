/**
 * Tests for the pure colour-grade model and palette hold.
 *
 * Palette hex values are a hard-coded copy of four venue palettes from
 * docs/art-direction.md (§4.2 San Francisco, §4.3 Sydney, §4.7 Palma,
 * §4.9 Victoria Harbour). If art-direction.md changes these, update here.
 */

import { describe, it, expect } from 'vitest';
import {
  applyColorGrade,
  paletteHold,
  luminance,
  okChroma,
  okHue,
  angularDistance,
  linearToOKLab,
  srgbHexToLinear,
} from './ColorGrade';
import type { ColorGradeParams, RGB } from '@/types';

// ─── Venue palettes (sRGB hex, from docs/art-direction.md) ─────────────────────

const PALETTES_HEX: Record<string, string[]> = {
  sanFrancisco: ['#1E3A4D', '#3D6B78', '#B8C4CC', '#A08850', '#7A6B42', '#C1440E', '#C8B896'],
  sydney: ['#1A3F6B', '#3A8B8F', '#6BA8D4', '#C4A060', '#4A7A4A', '#E8E4DC', '#2D6B4A'],
  palma: ['#0E3B6E', '#28A0A0', '#4A98D4', '#D4C4A0', '#3A6840', '#D8C090', '#B86840'],
  victoria: ['#1A3A3A', '#3A6858', '#8AA0A8', '#5A5A58', '#7898B0', '#2A5A2A', '#A83020'],
};

const PALETTES_LINEAR: Record<string, RGB[]> = Object.fromEntries(
  Object.entries(PALETTES_HEX).map(([k, hexes]) => [k, hexes.map(srgbHexToLinear)]),
);

// A fixed set of scene colours to test palette hold against.
const SCENE_COLORS: RGB[] = [
  srgbHexToLinear('#C06030'), // warm orange
  srgbHexToLinear('#3080C0'), // cool blue
  srgbHexToLinear('#50A050'), // green
  srgbHexToLinear('#A040A0'), // magenta
  srgbHexToLinear('#C0C040'), // yellow
  srgbHexToLinear('#8080FF'), // periwinkle
];

function nearestPaletteHueDistance(rgb: RGB, palette: RGB[]): number {
  const h = okHue(rgb);
  let best = Infinity;
  for (const p of palette) {
    if (okChroma(p) < 1e-3) continue;
    best = Math.min(best, angularDistance(h, okHue(p)));
  }
  return best;
}

// ─── applyColorGrade ───────────────────────────────────────────────────────────

const IDENTITY: ColorGradeParams = {
  exposure: 0,
  contrast: 0,
  saturation: 1,
  shadowTint: { r: 0, g: 0, b: 0 },
  highlightTint: { r: 0, g: 0, b: 0 },
  palette: [],
};

describe('applyColorGrade', () => {
  it('identity params leave mid-grey essentially unchanged', () => {
    const c = { r: 0.18, g: 0.18, b: 0.18 };
    const out = applyColorGrade(c, IDENTITY);
    expect(out.r).toBeCloseTo(0.18, 6);
    expect(out.g).toBeCloseTo(0.18, 6);
    expect(out.b).toBeCloseTo(0.18, 6);
  });

  it('exposure of +1 stop doubles linear values (identity contrast/sat)', () => {
    const c = { r: 0.1, g: 0.2, b: 0.3 };
    const out = applyColorGrade(c, { ...IDENTITY, exposure: 1 });
    expect(out.r).toBeCloseTo(0.2, 6);
    expect(out.g).toBeCloseTo(0.4, 6);
    expect(out.b).toBeCloseTo(0.6, 6);
  });

  it('contrast pivots around 0.18 mid-grey', () => {
    // A value exactly at mid-grey is unaffected by contrast.
    const mid = { r: 0.18, g: 0.18, b: 0.18 };
    const out = applyColorGrade(mid, { ...IDENTITY, contrast: 0.5 });
    expect(out.r).toBeCloseTo(0.18, 6);
    // A brighter value moves further from mid-grey.
    const bright = { r: 0.5, g: 0.5, b: 0.5 };
    const o2 = applyColorGrade(bright, { ...IDENTITY, contrast: 0.5 });
    expect(o2.r).toBeGreaterThan(0.5);
  });

  it('saturation 0 produces a neutral grey at the input luminance', () => {
    const c = { r: 0.6, g: 0.2, b: 0.1 };
    const out = applyColorGrade(c, { ...IDENTITY, saturation: 0 });
    expect(out.r).toBeCloseTo(out.g, 6);
    expect(out.g).toBeCloseTo(out.b, 6);
    expect(out.r).toBeCloseTo(luminance(c), 6);
  });

  it('outputs are finite for extreme params', () => {
    const c = { r: 0.5, g: 0.5, b: 0.5 };
    const out = applyColorGrade(c, {
      exposure: 3,
      contrast: 2,
      saturation: 2,
      shadowTint: { r: 0.1, g: 0, b: 0.2 },
      highlightTint: { r: 0.2, g: 0.1, b: 0 },
      palette: [],
    });
    expect(Number.isFinite(out.r)).toBe(true);
    expect(Number.isFinite(out.g)).toBe(true);
    expect(Number.isFinite(out.b)).toBe(true);
  });

  it('neutral grade is an EXACT identity on arbitrary colours (incl. black)', () => {
    // Regression: proves the post-chain default (NEUTRAL_GRADE) is a true no-op,
    // so a venue with no grade can never alter the image.
    const colours: RGB[] = [
      { r: 0, g: 0, b: 0 },
      { r: 0.001, g: 0.002, b: 0.004 },
      { r: 0.18, g: 0.18, b: 0.18 },
      { r: 0.6, g: 0.2, b: 0.1 },
      { r: 2.5, g: 1.8, b: 0.3 }, // HDR
    ];
    for (const c of colours) {
      const out = applyColorGrade(c, IDENTITY);
      expect(out.r).toBeCloseTo(c.r, 12);
      expect(out.g).toBeCloseTo(c.g, 12);
      expect(out.b).toBeCloseTo(c.b, 12);
    }
  });

  it('a non-trivial grade never lifts pure black to a positive colour', () => {
    // Regression for the night-water grey/olive wash: shadow lift + highlight
    // gain must NOT raise (0,0,0) to a visible positive value. (Contrast around
    // 0.18 drives black slightly NEGATIVE, which the renderer clamps to black —
    // the invariant that matters is "never lifted positive / tinted".)
    const grade: ColorGradeParams = {
      exposure: 0,
      contrast: 0.1,
      saturation: 1.05,
      shadowTint: { r: 0, g: 0.02, b: 0.05 },
      highlightTint: { r: 0.03, g: 0.02, b: 0 },
      palette: [],
    };
    const out = applyColorGrade({ r: 0, g: 0, b: 0 }, grade);
    expect(out.r).toBe(0);
    expect(out.g).toBe(0);
    expect(out.b).toBe(0);
  });

  it('grade output is never negative (contrast cannot drive darks below black)', () => {
    // Contrast about 0.18 would otherwise push dark values negative; the final
    // clamp keeps the output a valid scene-referred colour so ACES does not
    // turn a negative into a spurious lifted colour (the night-water wash).
    const grade: ColorGradeParams = {
      exposure: 0,
      contrast: 0.5,
      saturation: 1,
      shadowTint: { r: 0, g: 0, b: 0 },
      highlightTint: { r: 0, g: 0, b: 0 },
      palette: [],
    };
    for (const v of [0, 0.005, 0.02, 0.05, 0.1]) {
      const out = applyColorGrade({ r: v, g: v, b: v }, grade);
      expect(out.r).toBeGreaterThanOrEqual(0);
      expect(out.g).toBeGreaterThanOrEqual(0);
      expect(out.b).toBeGreaterThanOrEqual(0);
    }
  });

  it('highlightTint is a multiplicative GAIN (scales with signal, not an additive floor)', () => {
    // Pure gain: a bright white scaled up; a mid grey scaled less; black unchanged.
    const grade: ColorGradeParams = {
      exposure: 0,
      contrast: 0,
      saturation: 1,
      shadowTint: { r: 0, g: 0, b: 0 },
      highlightTint: { r: 0.5, g: 0.5, b: 0.5 },
      palette: [],
    };
    const black = applyColorGrade({ r: 0, g: 0, b: 0 }, grade);
    expect(black.r).toBeCloseTo(0, 6); // gain is ×1 at black
    const bright = { r: 1, g: 1, b: 1 };
    const outBright = applyColorGrade(bright, grade);
    // hiW at lum=1 is 1/(1+0.5)=0.667 → gain ×(1+0.5·0.667)=×1.333.
    expect(outBright.r).toBeGreaterThan(1.3);
    expect(outBright.r).toBeLessThan(1.35);
  });

  it('shadowTint lift scales in with the signal (true black not lifted)', () => {
    const grade: ColorGradeParams = {
      exposure: 0,
      contrast: 0,
      saturation: 1,
      shadowTint: { r: 0.1, g: 0.1, b: 0.1 },
      highlightTint: { r: 0, g: 0, b: 0 },
      palette: [],
    };
    const black = applyColorGrade({ r: 0, g: 0, b: 0 }, grade);
    expect(black.r).toBeCloseTo(0, 6);
    // A dim-but-nonzero shadow IS lifted (the lift mask has engaged).
    const dim = applyColorGrade({ r: 0.05, g: 0.05, b: 0.05 }, grade);
    expect(dim.r).toBeGreaterThan(0.05);
  });

  // ─── Power-law contrast pivot (the black-crush fix) ──────────────────────
  //
  // The contrast stage is a POWER-LAW ("gamma-about-pivot") about linear
  // mid-grey 0.18: out = 0.18·(max(c,eps)/0.18)^(1+contrast). art-direction.md
  // §5.3 requires a "subtle S-curve, NEVER crushing blacks or blowing whites".
  // The former LINEAR pivot `(c-0.18)·k+0.18` violated that: for any dim value
  // c < 0.18·(k-1)/k it produced ≤0 and the final max(·,0) crushed the whole
  // dim sky / water to black (observed in webgl-noon with grade=default). The
  // power-law form is positive-preserving and satisfies the requirement; these
  // tests encode that corrected behaviour.
  describe('power-law contrast pivot', () => {
    const CONTRASTS = [0, 0.03, 0.06, 0.1, 0.2, 0.35, 0.5];
    const INPUTS = [1e-4, 5e-4, 1e-3, 0.005, 0.02, 0.05, 0.1, 0.18, 0.3, 0.5, 1, 2, 4, 8];

    function contrastOnly(c: number, contrast: number): number {
      const out = applyColorGrade(
        { r: c, g: c, b: c },
        { ...IDENTITY, contrast },
      );
      return out.r;
    }

    it('output is finite, non-negative, and never crushes a positive input to black', () => {
      for (const contrast of CONTRASTS) {
        for (const c of INPUTS) {
          const o = contrastOnly(c, contrast);
          expect(Number.isFinite(o)).toBe(true);
          expect(o).toBeGreaterThanOrEqual(0);
          // Strictly positive whenever the input is positive (never crushed).
          expect(o).toBeGreaterThan(0);
        }
      }
    });

    it('has a fixed point at mid-grey 0.18 for every contrast', () => {
      for (const contrast of CONTRASTS) {
        expect(contrastOnly(0.18, contrast)).toBeCloseTo(0.18, 6);
      }
    });

    it('is monotone non-decreasing in the input for every contrast', () => {
      for (const contrast of CONTRASTS) {
        let prev = -Infinity;
        for (const c of INPUTS) {
          const o = contrastOnly(c, contrast);
          expect(o).toBeGreaterThanOrEqual(prev - 1e-12);
          prev = o;
        }
      }
    });

    it('contrast > 0 darkens below-pivot values and brightens above-pivot values', () => {
      for (const contrast of CONTRASTS.filter((x) => x > 0)) {
        // Below pivot → darkened (strictly smaller than input).
        for (const c of [0.02, 0.05, 0.1]) {
          expect(contrastOnly(c, contrast)).toBeLessThan(c);
        }
        // Above pivot → brightened (strictly larger than input).
        for (const c of [0.3, 0.5, 1, 2]) {
          expect(contrastOnly(c, contrast)).toBeGreaterThan(c);
        }
      }
    });

    it('a noon-sky-like dim colour with contrast 0.06 is NOT crushed (within 15% luminance)', () => {
      // The exact failure mode from webgl-noon: a dim zenith colour under a
      // modest contrast must stay close to its input, not collapse to black.
      const sky: RGB = { r: 0.02, g: 0.04, b: 0.09 };
      const L0 = luminance(sky);
      const out = applyColorGrade(sky, { ...IDENTITY, contrast: 0.06 });
      const L1 = luminance(out);
      expect(L1).toBeGreaterThan(0);
      expect(Math.abs(L1 - L0) / L0).toBeLessThan(0.15);
    });

    it('contrast 0 is an exact per-channel identity (k = 1 ⇒ pow(·,1))', () => {
      for (const c of INPUTS) {
        expect(contrastOnly(c, 0)).toBeCloseTo(c, 12);
      }
    });
  });
});

// ─── paletteHold property tests ────────────────────────────────────────────────

describe('paletteHold', () => {
  it('hue distance to the nearest palette colour is non-increasing (all venues)', () => {
    for (const [name, palette] of Object.entries(PALETTES_LINEAR)) {
      for (const scene of SCENE_COLORS) {
        const before = nearestPaletteHueDistance(scene, palette);
        for (const strength of [0.05, 0.15, 0.5, 1.0]) {
          const held = paletteHold(scene, palette, strength);
          const after = nearestPaletteHueDistance(held, palette);
          // Non-increasing (allow tiny float slack).
          expect(after).toBeLessThanOrEqual(before + 1e-6);
          // Strictly smaller for strength>0 unless already essentially on-palette.
          if (strength > 0 && before > 1e-4) {
            expect(after).toBeLessThan(before);
          }
        }
        void name;
      }
    }
  });

  it('preserves OKLab luminance within 1e-3', () => {
    const palette = PALETTES_LINEAR['palma']!;
    for (const scene of SCENE_COLORS) {
      const L0 = linearToOKLab(scene).L;
      for (const strength of [0.1, 0.5, 1.0]) {
        const held = paletteHold(scene, palette, strength);
        const L1 = linearToOKLab(held).L;
        expect(Math.abs(L1 - L0)).toBeLessThan(1e-3);
      }
    }
  });

  it('leaves greys (chroma ~0) unchanged', () => {
    const palette = PALETTES_LINEAR['sydney']!;
    for (const v of [0.05, 0.2, 0.5, 0.9]) {
      const grey = { r: v, g: v, b: v };
      const held = paletteHold(grey, palette, 1.0);
      expect(held.r).toBeCloseTo(grey.r, 9);
      expect(held.g).toBeCloseTo(grey.g, 9);
      expect(held.b).toBeCloseTo(grey.b, 9);
    }
  });

  it('strength 0 is identity', () => {
    const palette = PALETTES_LINEAR['victoria']!;
    const scene = SCENE_COLORS[0]!;
    const held = paletteHold(scene, palette, 0);
    expect(held.r).toBeCloseTo(scene.r, 9);
    expect(held.g).toBeCloseTo(scene.g, 9);
    expect(held.b).toBeCloseTo(scene.b, 9);
  });

  it('empty palette is identity', () => {
    const scene = SCENE_COLORS[2]!;
    const held = paletteHold(scene, [], 1.0);
    expect(held.r).toBeCloseTo(scene.r, 9);
  });

  it('outputs are finite', () => {
    const palette = PALETTES_LINEAR['sanFrancisco']!;
    for (const scene of SCENE_COLORS) {
      const held = paletteHold(scene, palette, 0.15);
      expect(Number.isFinite(held.r)).toBe(true);
      expect(Number.isFinite(held.g)).toBe(true);
      expect(Number.isFinite(held.b)).toBe(true);
    }
  });

  it('a colour already on a palette hue stays put', () => {
    const palette = PALETTES_LINEAR['palma']!;
    // Build a scene colour sharing a palette entry's hue but different L/C.
    const entry = palette[6]!; // terracotta
    const held = paletteHold(entry, palette, 1.0);
    // Hue essentially unchanged.
    expect(angularDistance(okHue(entry), okHue(held))).toBeLessThan(1e-3);
  });
});

describe('srgbHexToLinear', () => {
  it('maps black and white correctly', () => {
    expect(srgbHexToLinear('#000000')).toEqual({ r: 0, g: 0, b: 0 });
    const w = srgbHexToLinear('#ffffff');
    expect(w.r).toBeCloseTo(1, 6);
    expect(w.g).toBeCloseTo(1, 6);
    expect(w.b).toBeCloseTo(1, 6);
  });
});
