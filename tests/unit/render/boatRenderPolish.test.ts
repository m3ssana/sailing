/**
 * Tests for the BoatView render-polish helpers added to fix the first-browser
 * defects: the invisible (near-white-on-pale-water) hull and the flat grey sail.
 */

import { describe, expect, it } from 'vitest';
import type { RGB } from '@/types';
import { pickVisibleHullColor } from '@render/boat/BoatView';
import { buildSailSurfaceMaterial } from '@render/boat/sailSurfaceMaterial';

describe('pickVisibleHullColor', () => {
  it('prefers the darker/more-saturated deck colour when the hull is near-white', () => {
    const hull: RGB = { r: 0.9, g: 0.9, b: 0.88 }; // DINGHY gelcoat, luma ~0.9
    const deck: RGB = { r: 0.1, g: 0.2, b: 0.5 }; // DINGHY navy deck
    const picked = pickVisibleHullColor(hull, deck);
    expect(picked).toEqual(deck);
  });

  it('keeps a hull colour that already has contrast', () => {
    const hull: RGB = { r: 0.8, g: 0.1, b: 0.1 }; // a red hull, luma < 0.8
    const deck: RGB = { r: 0.1, g: 0.2, b: 0.5 };
    const picked = pickVisibleHullColor(hull, deck);
    expect(picked).toEqual(hull);
  });

  it('keeps the hull colour when the deck is not meaningfully darker', () => {
    const hull: RGB = { r: 0.95, g: 0.95, b: 0.95 };
    const deck: RGB = { r: 0.9, g: 0.9, b: 0.9 }; // also near-white
    const picked = pickVisibleHullColor(hull, deck);
    expect(picked).toEqual(hull);
  });
});

describe('buildSailSurfaceMaterial', () => {
  it('builds a two-sided cream material with colour/roughness/metalness/emissive nodes', () => {
    const mat = buildSailSurfaceMaterial({ baseColor: { r: 0.95, g: 0.95, b: 0.95 }, panelCount: 5 });
    // DoubleSide === 2 in three.js.
    expect((mat as unknown as { side: number }).side).toBe(2);
    expect(mat.colorNode).not.toBeNull();
    expect(mat.roughnessNode).not.toBeNull();
    expect(mat.metalnessNode).not.toBeNull();
    expect(mat.emissiveNode).not.toBeNull();
  });

  it('uses a default cream colour when none is supplied', () => {
    const mat = buildSailSurfaceMaterial();
    expect(mat.colorNode).not.toBeNull();
    expect((mat as unknown as { side: number }).side).toBe(2);
  });
});
