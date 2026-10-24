/**
 * Build-and-dispose tests for the thin three/TSL night layers.
 *
 * Mirrors the ocean-layer approach: under vitest/node we don't run a GPU, but
 * three/webgpu object + TSL node-graph CONSTRUCTION must not throw, and dispose
 * must be clean. These assert the render layer wires up correctly.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import { createMoonDisc } from './MoonDisc';
import { createStarField } from './StarFieldRig';
import { createNavLightRig } from './NavLightRig';
import { createShoreLights } from './ShoreLightsRig';
import { createNightSystem } from './NightSystem';
import { generateStarCatalog } from './StarField';
import { generateShoreLights, type ShoreAnchor } from './ShoreLights';
import { createLightingState } from '../lighting/LightingState';

const DEG = Math.PI / 180;

function nightSky(elevationDeg = 40, phase = 1) {
  const el = elevationDeg * DEG;
  return {
    moonElevation: el,
    moonPhase: phase,
    moonDirection: { x: 0.3, y: Math.sin(el), z: -Math.cos(el) },
    siderealTime: 1.5,
    sunDirection: { x: 0, y: -0.5, z: -0.866 },
  };
}

/** Sun direction FROM the scene TOWARDS the sun (unit). */
const SUN_DIR = { x: 0, y: -0.5, z: -0.866 };

function nightLighting() {
  const l = createLightingState();
  l.nightFactor = 1;
  return l;
}

describe('createMoonDisc', () => {
  it('builds, updates, and disposes without throwing', () => {
    const disc = createMoonDisc();
    expect(disc.object).toBeDefined();
    expect(() => disc.update(nightSky(), nightLighting(), SUN_DIR)).not.toThrow();
    // Below horizon → hidden.
    disc.update(nightSky(-5), nightLighting(), SUN_DIR);
    expect((disc.object as THREE.Mesh).visible).toBe(false);
    // Above horizon at night → visible.
    disc.update(nightSky(40), nightLighting(), SUN_DIR);
    expect((disc.object as THREE.Mesh).visible).toBe(true);
    expect(() => disc.dispose()).not.toThrow();
  });
});

describe('createStarField', () => {
  it('builds from a catalogue, updates rotation/visibility, disposes', () => {
    const cat = generateStarCatalog(123, 500);
    const rig = createStarField(cat, { latitude: 40 * DEG });
    expect(rig.object).toBeDefined();
    expect(() => rig.update(1.2, 40 * DEG, 0.9)).not.toThrow();
    // Sidereal rotation produces a valid unit quaternion.
    const q = rig.object.quaternion;
    const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    expect(len).toBeCloseTo(1, 6);
    // Re-bake for a different latitude without throwing.
    expect(() => rig.rebake(-20 * DEG)).not.toThrow();
    expect(() => rig.dispose()).not.toThrow();
  });

  it('handles an empty catalogue', () => {
    const rig = createStarField([], {});
    expect(() => rig.update(0, 0, 1)).not.toThrow();
    rig.dispose();
  });
});

describe('createNavLightRig', () => {
  it('attaches to a vessel group, updates, and disposes', () => {
    const rig = createNavLightRig();
    const group = new THREE.Group();
    expect(() => rig.attachToVessel(group, 'powerDriven', 12, 8)).not.toThrow();
    expect(group.children.length).toBeGreaterThan(0);
    expect(() => rig.update(0, 2, 100, 1)).not.toThrow();
    expect(() => rig.dispose()).not.toThrow();
  });

  it('works for a sailing vessel and an anchored vessel', () => {
    for (const kind of ['sailing', 'anchored', 'ferry', 'yacht'] as const) {
      const rig = createNavLightRig();
      const group = new THREE.Group();
      rig.attachToVessel(group, kind, 20, 12);
      rig.update(10, 2, 0, 0.8);
      rig.dispose();
    }
  });
});

describe('createShoreLights', () => {
  it('builds a points cloud and disposes', () => {
    const anchors: ShoreAnchor[] = [
      { x: 0, y: 0, z: 0, radius: 30, height: 60 },
      { x: 100, y: 0, z: 50, radius: 20, height: 150 },
    ];
    const lights = generateShoreLights(7, anchors, { density: 0.8 });
    expect(lights.length).toBeGreaterThan(0);
    const rig = createShoreLights(lights);
    expect(rig.object).toBeDefined();
    expect(() => rig.update(1)).not.toThrow();
    expect(() => rig.update(0)).not.toThrow();
    expect(() => rig.dispose()).not.toThrow();
  });

  it('handles zero lights', () => {
    const rig = createShoreLights([]);
    expect(() => rig.update(1)).not.toThrow();
    rig.dispose();
  });
});

describe('createNightSystem (facade)', () => {
  it('bundles moon/stars/shore, updates, and disposes', () => {
    const anchors: ShoreAnchor[] = [{ x: 0, y: 0, z: 0, radius: 40, height: 80 }];
    const sys = createNightSystem({
      seed: 2024,
      starCount: 300,
      latitude: 37 * DEG,
      shoreAnchors: anchors,
      urban: 0.7,
    });
    expect(sys.object).toBeDefined();
    expect(() => sys.update(nightSky(), nightLighting(), { rawGustIntensity: 0.5 })).not.toThrow();

    // Facade surfaces the computed pure-model outputs.
    expect(sys.moonlight.moonIlluminance).toBeGreaterThan(0);
    expect(sys.starVisibility).toBeGreaterThan(0);
    expect(sys.starVisibility).toBeLessThanOrEqual(1);
    expect(sys.moonGlitter.intensity).toBeGreaterThan(0);
    expect(sys.effectiveGustIntensity).toBeDefined();
    expect(sys.effectiveGustIntensity).toBeLessThan(0.5); // darkened at night

    expect(() => sys.dispose()).not.toThrow();
  });

  it('works without shore anchors and without gust context', () => {
    const sys = createNightSystem({ seed: 1, starCount: 100 });
    expect(() => sys.update(nightSky(), nightLighting())).not.toThrow();
    expect(sys.effectiveGustIntensity).toBeUndefined();
    sys.dispose();
  });
});
