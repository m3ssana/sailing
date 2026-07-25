/**
 * Tests for the ocean water material (E.4).
 *
 * Headless (no GPU context). Verifies:
 * 1. buildWaterMaterial produces a valid material for different venue appearances.
 * 2. Palma (clear blue, turbidity 0.15) and Guanabara (murky, turbidity 0.70)
 *    produce materials with distinct uniform values.
 * 3. TSL node graphs are wired (colorNode is non-null and constructed).
 * 4. Gust intensity defaults gracefully when not provided.
 * 5. All exposed uniforms are accessible and have sensible initial values.
 */

import { describe, expect, it } from 'vitest';
import type { WaterAppearance } from '@/types';
import { buildWaterMaterial } from '@render/ocean/WaterMaterial';
import type { WaterMaterialParams } from '@render/ocean/WaterMaterial';

// ─── Venue appearances from docs/art-direction.md ─────────────────────────────

/**
 * Palma Bay, Mallorca — clear Mediterranean blue.
 * art-direction.md §4.7:
 * - Shallow: #28A0A0 → sRGB (40, 160, 160) → linear ≈ (0.0202, 0.3185, 0.3185)
 * - Deep: #0E3B6E → sRGB (14, 59, 110) → linear ≈ (0.0046, 0.0421, 0.1412)
 * - Turbidity: 0.15
 *
 * Note: hex values from art-direction.md are sRGB. We store linear RGB in
 * WaterAppearance per the frozen type contract (units.ts: "Linear RGB in the
 * 0..1 range. Never sRGB"). Conversions done via sRGBToLinear: c/255 then
 * ((c+0.055)/1.055)^2.4 for c > 0.04045, else c/12.92.
 */
const PALMA_APPEARANCE: WaterAppearance = {
  colorShallow: { r: 0.0202, g: 0.3185, b: 0.3185 },
  colorDeep: { r: 0.0046, g: 0.0421, b: 0.1412 },
  turbidity: 0.15,
  extinctionDepth: 25,
};

/**
 * Guanabara Bay, Rio — warm murky green-brown.
 * art-direction.md §4.10:
 * - Shallow: #4A7A58 → sRGB (74, 122, 88) → linear ≈ (0.0699, 0.1906, 0.0906)
 * - Deep: #2A4038 → sRGB (42, 64, 56) → linear ≈ (0.0214, 0.0479, 0.0369)
 * - Turbidity: 0.70
 */
const GUANABARA_APPEARANCE: WaterAppearance = {
  colorShallow: { r: 0.0699, g: 0.1906, b: 0.0906 },
  colorDeep: { r: 0.0214, g: 0.0479, b: 0.0369 },
  turbidity: 0.70,
  extinctionDepth: 8,
};

const DEFAULT_SUN = { x: 0.5, y: 0.7, z: -0.5 };

function makeParams(appearance: WaterAppearance, overrides?: Partial<WaterMaterialParams>): WaterMaterialParams {
  return {
    appearance,
    sunDirection: DEFAULT_SUN,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildWaterMaterial', () => {
  describe('produces a valid material', () => {
    it('builds without throwing for Palma appearance', () => {
      const result = buildWaterMaterial(makeParams(PALMA_APPEARANCE));
      expect(result).toBeDefined();
      expect(result.material).toBeDefined();
      expect(result.material).toHaveProperty('dispose');
    });

    it('builds without throwing for Guanabara appearance', () => {
      const result = buildWaterMaterial(makeParams(GUANABARA_APPEARANCE));
      expect(result).toBeDefined();
      expect(result.material).toBeDefined();
      expect(result.material).toHaveProperty('dispose');
    });
  });

  describe('wires TSL node graphs', () => {
    it('colorNode is non-null for Palma', () => {
      const { material } = buildWaterMaterial(makeParams(PALMA_APPEARANCE));
      expect(material.colorNode).not.toBeNull();
      expect(material.colorNode).toBeDefined();
    });

    it('colorNode is non-null for Guanabara', () => {
      const { material } = buildWaterMaterial(makeParams(GUANABARA_APPEARANCE));
      expect(material.colorNode).not.toBeNull();
      expect(material.colorNode).toBeDefined();
    });

    it('roughnessNode is non-null', () => {
      const { material } = buildWaterMaterial(makeParams(PALMA_APPEARANCE));
      expect(material.roughnessNode).not.toBeNull();
      expect(material.roughnessNode).toBeDefined();
    });

    it('metalnessNode is non-null', () => {
      const { material } = buildWaterMaterial(makeParams(PALMA_APPEARANCE));
      expect(material.metalnessNode).not.toBeNull();
      expect(material.metalnessNode).toBeDefined();
    });
  });

  describe('per-venue differentiation', () => {
    it('Palma and Guanabara produce distinct materials', () => {
      const palma = buildWaterMaterial(makeParams(PALMA_APPEARANCE));
      const guanabara = buildWaterMaterial(makeParams(GUANABARA_APPEARANCE));
      expect(palma.material).not.toBe(guanabara.material);
    });

    it('turbidity uniforms differ between Palma and Guanabara', () => {
      const palma = buildWaterMaterial(makeParams(PALMA_APPEARANCE));
      const guanabara = buildWaterMaterial(makeParams(GUANABARA_APPEARANCE));
      expect(palma.uniforms.turbidity.value).not.toBe(guanabara.uniforms.turbidity.value);
      expect(palma.uniforms.turbidity.value).toBe(0.15);
      expect(guanabara.uniforms.turbidity.value).toBe(0.70);
    });

    it('colorShallow uniforms differ between venues', () => {
      const palma = buildWaterMaterial(makeParams(PALMA_APPEARANCE));
      const guanabara = buildWaterMaterial(makeParams(GUANABARA_APPEARANCE));
      // THREE.Color objects — check that they're different instances with different values
      const palmaColor = palma.uniforms.colorShallow.value as { r: number; g: number; b: number };
      const guanabaraColor = guanabara.uniforms.colorShallow.value as { r: number; g: number; b: number };
      // Palma is more blue/teal, Guanabara is more green
      expect(palmaColor.b).toBeGreaterThan(guanabaraColor.b);
      expect(guanabaraColor.g).toBeGreaterThan(guanabaraColor.b);
    });

    it('colorDeep uniforms differ between venues', () => {
      const palma = buildWaterMaterial(makeParams(PALMA_APPEARANCE));
      const guanabara = buildWaterMaterial(makeParams(GUANABARA_APPEARANCE));
      const palmaDeep = palma.uniforms.colorDeep.value as { r: number; g: number; b: number };
      const guanabaraDeep = guanabara.uniforms.colorDeep.value as { r: number; g: number; b: number };
      // Palma deep water is bluer (higher b relative to r)
      expect(palmaDeep.b).toBeGreaterThan(palmaDeep.r);
      // Guanabara deep is murky — g > b
      expect(guanabaraDeep.g).toBeGreaterThan(guanabaraDeep.b);
    });

    it('extinctionDepth differs — clear water has deeper extinction', () => {
      const palma = buildWaterMaterial(makeParams(PALMA_APPEARANCE));
      const guanabara = buildWaterMaterial(makeParams(GUANABARA_APPEARANCE));
      const palmaExtinction = palma.uniforms.extinctionDepth.value as number;
      const guanabaraExtinction = guanabara.uniforms.extinctionDepth.value as number;
      expect(palmaExtinction).toBeGreaterThan(guanabaraExtinction);
    });
  });

  describe('gust intensity defaults gracefully', () => {
    it('does not crash when gustIntensity is omitted', () => {
      const result = buildWaterMaterial(makeParams(PALMA_APPEARANCE));
      expect(result.uniforms.gustIntensity.value).toBe(0.0);
    });

    it('accepts an explicit gustIntensity', () => {
      const result = buildWaterMaterial(makeParams(PALMA_APPEARANCE, { gustIntensity: 0.8 }));
      expect(result.uniforms.gustIntensity.value).toBe(0.8);
    });

    it('material still builds with maximum gust intensity', () => {
      const result = buildWaterMaterial(makeParams(PALMA_APPEARANCE, { gustIntensity: 1.0 }));
      expect(result.material.colorNode).not.toBeNull();
    });
  });

  describe('uniforms are accessible for runtime updates', () => {
    it('exposes sunDirection uniform', () => {
      const { uniforms } = buildWaterMaterial(makeParams(PALMA_APPEARANCE));
      expect(uniforms.sunDirection).toBeDefined();
      const val = uniforms.sunDirection.value as { x: number; y: number; z: number };
      expect(val.x).toBe(DEFAULT_SUN.x);
      expect(val.y).toBe(DEFAULT_SUN.y);
      expect(val.z).toBe(DEFAULT_SUN.z);
    });

    it('exposes waveHeight uniform with default 0.5', () => {
      const { uniforms } = buildWaterMaterial(makeParams(PALMA_APPEARANCE));
      expect(uniforms.waveHeight.value).toBe(0.5);
    });

    it('exposes waterDepth uniform defaulting to extinctionDepth', () => {
      const { uniforms } = buildWaterMaterial(makeParams(PALMA_APPEARANCE));
      expect(uniforms.waterDepth.value).toBe(PALMA_APPEARANCE.extinctionDepth);
    });

    it('accepts explicit waterDepth override', () => {
      const { uniforms } = buildWaterMaterial(makeParams(PALMA_APPEARANCE, { waterDepth: 5.0 }));
      expect(uniforms.waterDepth.value).toBe(5.0);
    });
  });

  describe('sun colour and sky colour', () => {
    it('uses default sun colour when not provided', () => {
      const { uniforms } = buildWaterMaterial(makeParams(PALMA_APPEARANCE));
      const sunColor = uniforms.sunColor.value as { r: number; g: number; b: number };
      expect(sunColor.r).toBeCloseTo(1.0, 2);
      expect(sunColor.g).toBeCloseTo(0.95, 2);
      expect(sunColor.b).toBeCloseTo(0.85, 2);
    });

    it('accepts explicit sun colour', () => {
      const { uniforms } = buildWaterMaterial(
        makeParams(PALMA_APPEARANCE, { sunColor: { r: 0.9, g: 0.7, b: 0.5 } }),
      );
      const sunColor = uniforms.sunColor.value as { r: number; g: number; b: number };
      expect(sunColor.r).toBeCloseTo(0.9, 2);
    });
  });
});
