/**
 * Tests for the procedural TSL material library (D.8).
 *
 * These tests run headlessly (no GPU context) and verify that:
 * 1. buildProceduralMaterial returns a valid Material for every kind.
 * 2. Materials don't crash when `detail` is undefined.
 * 3. TSL node graphs are actually wired (colorNode, roughnessNode, etc. are non-null).
 */

import { describe, expect, it } from 'vitest';
import type { MaterialParams } from '@/types';
import { buildProceduralMaterial } from '@render/materials/index';

/** All material kinds as defined in the frozen MaterialParams interface. */
const ALL_KINDS = [
  'gelcoat',
  'carbon',
  'anodized',
  'sailcloth',
  'teak',
  'terrain',
  'concrete',
  'water',
] as const;

/** Representative params for each kind with detail provided. */
function makeParams(kind: MaterialParams['kind'], withDetail: boolean): MaterialParams {
  const base: Omit<MaterialParams, 'detail'> = {
    kind,
    baseColor: { r: 0.5, g: 0.5, b: 0.5 },
    roughness: 0.5,
    metalness: kind === 'anodized' ? 0.8 : 0.0,
  };

  if (!withDetail) {
    return base as MaterialParams;
  }

  const detailMap: Record<MaterialParams['kind'], Record<string, number>> = {
    gelcoat: { orangePeelScale: 80, orangePeelAmplitude: 0.002, flakeDensity: 0.05, flakeScale: 200 },
    carbon: { weaveScale: 40, weaveAngle: 0.785, weaveContrast: 0.03 },
    anodized: { grainScale: 60, grainStrength: 0.02 },
    sailcloth: { panelWidth: 0.5, seamDarkening: 0.05, seamSharpness: 30, weftScale: 200, weftStrength: 0.02 },
    teak: { plankWidth: 0.05, grainScale: 8, grainContrast: 0.025, caulkDarkening: 0.15, caulkWidth: 0.05 },
    terrain: { slopeThreshold: 0.7, slopeBlend: 0.1, rockRoughness: 0.85, altitudeScale: 0.001 },
    concrete: { surfaceScale: 10, surfaceStrength: 0.03 },
    water: {},
  };

  return { ...base, detail: detailMap[kind] } as MaterialParams;
}

describe('buildProceduralMaterial', () => {
  describe('returns a valid Material for every kind', () => {
    for (const kind of ALL_KINDS) {
      it(`builds ${kind} material without throwing`, () => {
        const params = makeParams(kind, true);
        const material = buildProceduralMaterial(params);
        expect(material).toBeDefined();
        expect(material).toHaveProperty('dispose');
      });
    }
  });

  describe('handles undefined detail gracefully', () => {
    for (const kind of ALL_KINDS) {
      it(`builds ${kind} without detail without throwing`, () => {
        const params = makeParams(kind, false);
        const material = buildProceduralMaterial(params);
        expect(material).toBeDefined();
        expect(material).toHaveProperty('dispose');
      });
    }
  });

  describe('wires TSL node graphs (nodes are non-null)', () => {
    for (const kind of ALL_KINDS) {
      it(`${kind} has colorNode set`, () => {
        const params = makeParams(kind, true);
        const material = buildProceduralMaterial(params);
        expect(material.colorNode).not.toBeNull();
        expect(material.colorNode).toBeDefined();
      });

      it(`${kind} has roughnessNode set`, () => {
        const params = makeParams(kind, true);
        const material = buildProceduralMaterial(params);
        expect(material.roughnessNode).not.toBeNull();
        expect(material.roughnessNode).toBeDefined();
      });

      it(`${kind} has metalnessNode set`, () => {
        const params = makeParams(kind, true);
        const material = buildProceduralMaterial(params);
        expect(material.metalnessNode).not.toBeNull();
        expect(material.metalnessNode).toBeDefined();
      });
    }

    it('gelcoat has normalNode set (orange-peel)', () => {
      const params = makeParams('gelcoat', true);
      const material = buildProceduralMaterial(params);
      expect(material.normalNode).not.toBeNull();
      expect(material.normalNode).toBeDefined();
    });
  });

  describe('material properties are distinct per kind', () => {
    it('gelcoat and carbon produce different materials', () => {
      const gelcoat = buildProceduralMaterial(makeParams('gelcoat', true));
      const carbon = buildProceduralMaterial(makeParams('carbon', true));
      // They should be distinct objects
      expect(gelcoat).not.toBe(carbon);
      // Gelcoat has a normalNode (orange-peel), carbon does not
      expect(gelcoat.normalNode).not.toBeNull();
      expect(carbon.normalNode).toBeNull();
    });
  });

  describe('exhaustive switch catches invalid kinds', () => {
    it('throws for an unknown kind', () => {
      const badParams = {
        kind: 'nonexistent' as MaterialParams['kind'],
        baseColor: { r: 0.5, g: 0.5, b: 0.5 },
        roughness: 0.5,
        metalness: 0.0,
      } as MaterialParams;
      expect(() => buildProceduralMaterial(badParams)).toThrow();
    });
  });
});
