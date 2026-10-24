/**
 * Tests for the three-layer ShadowRig: build/update/dispose without throwing in
 * node, and enableRigShadows marks the right meshes on a BoatView-like
 * hierarchy.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import { createShadowRig, enableRigShadows } from './ShadowRig';
import { createLightingState } from '../lighting/LightingState';
import { shadowLightUp } from './CascadedShadows';
import type { QualityKnobs, SkyState } from '@/types';
import type { CameraSliceParams } from './CascadedShadows';

function knobs(shadowCascades: 1 | 2 | 3 | 4): QualityKnobs {
  return {
    renderScale: 1,
    oceanCascades: 3,
    oceanResolution: 256,
    oceanGridRings: 6,
    reflectionScale: 1,
    reflectionCadence: 1,
    shadowCascades,
    cloudMarchSteps: 16,
    sprayBudget: 1000,
    ambientBudget: 12,
    taa: false,
    motionBlur: false,
    depthOfField: false,
    bloom: false,
  };
}

function daySky(): SkyState {
  const el = 45 * (Math.PI / 180);
  return {
    sunDirection: { x: 0.3, y: Math.sin(el), z: -Math.cos(el) },
    sunElevation: el,
    sunAzimuth: 1.2,
    moonDirection: { x: 0, y: -1, z: 0 },
    moonElevation: -0.5,
    moonPhase: 0.5,
    siderealTime: 1,
    cloudLow: 0,
    cloudMid: 0,
    cloudHigh: 0,
    isNight: false,
  };
}

function camera(): CameraSliceParams {
  return {
    position: { x: 0, y: 2, z: 0 },
    forward: { x: 0, y: 0, z: -1 },
    right: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    fovY: 60 * (Math.PI / 180),
    aspect: 16 / 9,
    sliceNear: 0.5,
    sliceFar: 400,
  };
}

describe('createShadowRig', () => {
  it('builds the requested number of cascades for each quality level', () => {
    for (const n of [1, 2, 3, 4] as const) {
      const rig = createShadowRig(knobs(n));
      expect(rig.cascadeCount).toBe(n);
      expect(rig.object.children.length).toBeGreaterThanOrEqual(n);
      rig.dispose();
    }
  });

  it('updates from day sky/lighting without throwing and lights are visible', () => {
    const rig = createShadowRig(knobs(3));
    const light = createLightingState();
    light.sunIlluminance = 1;
    light.nightFactor = 0;
    expect(() => rig.update(daySky(), light, camera())).not.toThrow();
    const first = rig.object.children[0] as THREE.DirectionalLight;
    expect(first.visible).toBe(true);
    expect(first.intensity).toBeGreaterThan(0);
    rig.dispose();
  });

  it('disables cascades at night (sun faded out)', () => {
    const rig = createShadowRig(knobs(2));
    const light = createLightingState();
    light.nightFactor = 1;
    light.sunIlluminance = 0;
    rig.update(daySky(), light, camera());
    const first = rig.object.children[0] as THREE.DirectionalLight;
    expect(first.visible).toBe(false);
    rig.dispose();
  });

  it('clamps cascade count into 1..4', () => {
    const rig = createShadowRig(knobs(3), { cascades: 4 });
    expect(rig.cascadeCount).toBe(4);
    rig.dispose();
  });

  it("sets each cascade light.up to the model's chosen world-up (shimmer-free snap)", () => {
    const rig = createShadowRig(knobs(3));
    const light = createLightingState();
    light.sunIlluminance = 1;
    light.nightFactor = 0;

    // A normal day sun → model uses world-up (0,1,0).
    const sky = daySky();
    rig.update(sky, light, camera());
    const expectDay = shadowLightUp(sky.sunDirection);
    // The group holds both lights and their targets; a DirectionalLight has an
    // `intensity`, a target does not. Only inspect the lights.
    const lightsOf = (): THREE.DirectionalLight[] =>
      rig.object.children.filter(
        (c) => typeof (c as unknown as { intensity?: number }).intensity === 'number',
      ) as THREE.DirectionalLight[];
    for (const l of lightsOf()) {
      if (!l.visible) continue;
      expect(l.up.x).toBeCloseTo(expectDay.x, 6);
      expect(l.up.y).toBeCloseTo(expectDay.y, 6);
      expect(l.up.z).toBeCloseTo(expectDay.z, 6);
    }

    // A near-zenith sun → model switches to (0,0,1); the rig must follow so
    // three's shadow-camera basis stays aligned with the texel snap grid.
    const zenithSky: SkyState = {
      ...sky,
      sunDirection: { x: 0.02, y: 0.9998, z: 0 },
      sunElevation: Math.asin(0.9998),
    };
    rig.update(zenithSky, light, camera());
    const expectZenith = shadowLightUp(zenithSky.sunDirection);
    expect(expectZenith.z).toBeCloseTo(1, 6); // sanity: it did switch
    for (const l of lightsOf()) {
      if (!l.visible) continue;
      expect(l.up.x).toBeCloseTo(expectZenith.x, 6);
      expect(l.up.y).toBeCloseTo(expectZenith.y, 6);
      expect(l.up.z).toBeCloseTo(expectZenith.z, 6);
    }
    rig.dispose();
  });

  it('sets a positive normalBias on every cascade (ocean acne fix)', () => {
    // A large near-flat receiver (the ocean) at grazing sun angles needs a
    // normal-offset bias in addition to the constant depth bias; without it the
    // planar receiver self-shadows (acne). Assert it is configured and small
    // (so thin rigging does not peter-pan).
    const rig = createShadowRig(knobs(3));
    for (const child of rig.object.children) {
      const light = child as THREE.DirectionalLight;
      if (!light.shadow) continue;
      expect(light.shadow.normalBias).toBeGreaterThan(0);
      expect(light.shadow.normalBias).toBeLessThanOrEqual(0.05);
      // Constant depth bias is still negative (pushes toward the light).
      expect(light.shadow.bias).toBeLessThan(0);
    }
    rig.dispose();
  });
});

// ─── enableRigShadows ──────────────────────────────────────────────────────────

/** Build a BoatView-like hierarchy: root → hull/rig/sail/lights groups. */
function boatLikeHierarchy(): {
  root: THREE.Group;
  hullMesh: THREE.Mesh;
  mastMesh: THREE.Mesh;
  sailMesh: THREE.Mesh;
  light: THREE.PointLight;
} {
  const root = new THREE.Group();
  const hullGroup = new THREE.Group();
  const rigGroup = new THREE.Group();
  const sailGroup = new THREE.Group();
  const lightsGroup = new THREE.Group();

  const geo = new THREE.BufferGeometry();
  const mat = new THREE.MeshStandardNodeMaterial();
  const hullMesh = new THREE.Mesh(geo, mat);
  hullMesh.name = 'hull';
  const mastMesh = new THREE.Mesh(geo, mat);
  mastMesh.name = 'mast';
  const sailMesh = new THREE.Mesh(geo, mat);
  sailMesh.name = 'main-sail';
  const light = new THREE.PointLight(0xffffff, 1);

  hullGroup.add(hullMesh);
  rigGroup.add(mastMesh);
  sailGroup.add(sailMesh);
  lightsGroup.add(light);
  root.add(hullGroup);
  root.add(rigGroup);
  root.add(sailGroup);
  root.add(lightsGroup);

  return { root, hullMesh, mastMesh, sailMesh, light };
}

describe('enableRigShadows', () => {
  it('sets cast+receive on hull/mast/sail meshes and nothing on lights', () => {
    const h = boatLikeHierarchy();
    enableRigShadows(h.root);
    for (const m of [h.hullMesh, h.mastMesh, h.sailMesh]) {
      expect((m as unknown as { castShadow?: boolean }).castShadow).toBe(true);
      expect((m as unknown as { receiveShadow?: boolean }).receiveShadow).toBe(true);
    }
    expect((h.light as unknown as { castShadow?: boolean }).castShadow).toBe(false);
    expect((h.light as unknown as { receiveShadow?: boolean }).receiveShadow).toBe(false);
  });

  it('water and terrain receive but do not cast', () => {
    const root = new THREE.Group();
    const geo = new THREE.BufferGeometry();
    const mat = new THREE.MeshStandardNodeMaterial();
    const water = new THREE.Mesh(geo, mat);
    water.name = 'ocean-water';
    const terrain = new THREE.Mesh(geo, mat);
    terrain.name = 'terrain-tile-3';
    root.add(water);
    root.add(terrain);

    enableRigShadows(root);

    expect((water as unknown as { castShadow?: boolean }).castShadow).toBe(false);
    expect((water as unknown as { receiveShadow?: boolean }).receiveShadow).toBe(true);
    expect((terrain as unknown as { castShadow?: boolean }).castShadow).toBe(false);
    expect((terrain as unknown as { receiveShadow?: boolean }).receiveShadow).toBe(true);
  });

  it('does not throw on an empty hierarchy', () => {
    expect(() => enableRigShadows(new THREE.Group())).not.toThrow();
  });
});
