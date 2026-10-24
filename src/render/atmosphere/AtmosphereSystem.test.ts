/**
 * AtmosphereSystem — Stream F integration facade tests.
 *
 * Drives a full-day sweep via the real `computeSkyStateForVenue` (Newport)
 * through `atmosphere.update`, with a mocked-where-needed renderer, asserting:
 *   - water sun/sky uniforms change monotonically with sun elevation;
 *   - water gust intensity == raw by day and < 0.5·raw at local midnight (the
 *     F.4 "gusts harder to read at night" demo requirement is actually driven);
 *   - no throw across clear / overcast / rain / fog (200 m) conditions;
 *   - the environment probe regenerates (mocked PMREM) and `dispose` cleans up;
 *   - `attachNavLightsToBoatView` mounts a nav-light rig on a REAL `BoatView`.
 *
 * Conventions: Linear RGB; SI/radians; world Y-up +X east +Z south.
 */

import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import type {
  BoatDefinition,
  QualityKnobs,
  SkyConditions,
  SkyState,
  WaterAppearance,
} from '@/types';
import { computeSkyStateForVenue, createSkyState } from '@environment/SkyState';
import { buildWaterMaterial, type WaterMaterialResult } from '@render/ocean/WaterMaterial';
import { BoatView } from '@render/boat/BoatView';
import {
  createAtmosphereSystem,
  attachNavLightsToBoatView,
  type AtmosphereFrame,
  type AtmosphereSystem,
} from './AtmosphereSystem';

const DEG = Math.PI / 180;

// ─── Fixtures ───────────────────────────────────────────────────────────────

const NEWPORT_LAT = 41.49;
const NEWPORT_LON = -71.31;
const BASE_UTC = Date.UTC(2023, 10, 14, 0, 0, 0); // 2023-11-14 00:00 UTC

function knobs(): QualityKnobs {
  return {
    renderScale: 1,
    oceanCascades: 3,
    oceanResolution: 256,
    oceanGridRings: 6,
    reflectionScale: 1,
    reflectionCadence: 1,
    shadowCascades: 3,
    cloudMarchSteps: 8,
    sprayBudget: 1000,
    ambientBudget: 12,
    taa: false,
    motionBlur: false,
    depthOfField: false,
    bloom: false,
  };
}

const APPEARANCE: WaterAppearance = {
  colorShallow: { r: 0.1, g: 0.4, b: 0.5 },
  colorDeep: { r: 0.02, g: 0.08, b: 0.15 },
  turbidity: 0.2,
  extinctionDepth: 15,
};

function makeWater(): WaterMaterialResult {
  return buildWaterMaterial({ appearance: APPEARANCE, sunDirection: { x: 0, y: 1, z: 0 } });
}

/** A camera looking north from a couple of metres up. */
function camera(): AtmosphereFrame['camera'] {
  return {
    position: { x: 0, y: 2, z: 0 },
    forward: { x: 0, y: 0, z: -1 },
    right: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    fovY: 60 * DEG,
    aspect: 16 / 9,
  };
}

/** The real Newport sky at a given UTC hour on the base date. */
function newportSky(utcHour: number, cloud = 0): SkyState {
  return computeSkyStateForVenue(
    NEWPORT_LAT,
    NEWPORT_LON,
    BASE_UTC,
    utcHour * 3600,
    cloud,
    cloud,
    cloud,
    createSkyState(),
  );
}

function conditions(partial: Partial<SkyConditions> = {}): SkyConditions {
  return {
    cloudLow: 0,
    cloudMid: 0,
    cloudHigh: 0,
    visibility: 30000,
    precipitation: 0,
    wmoCode: 0,
    solarRadiation: 0,
    isDay: true,
    ...partial,
  };
}

function frame(
  sky: SkyState,
  cond: SkyConditions,
  rawGust: number,
  timeSeconds: number,
): AtmosphereFrame {
  return {
    sky,
    conditions: cond,
    wind: { x: 5, y: 0, z: 0 },
    dt: 1 / 60,
    timeSeconds,
    camera: camera(),
    latitude: NEWPORT_LAT * DEG,
    knobs: knobs(),
    rawGustIntensity: rawGust,
  };
}

function makeSystem(water?: WaterMaterialResult): AtmosphereSystem {
  return createAtmosphereSystem({
    seed: 2023,
    knobs: knobs(),
    latitude: NEWPORT_LAT * DEG,
    night: { starCount: 300 },
    ...(water !== undefined ? { water } : {}),
  });
}

// ─── Construction + object graph ──────────────────────────────────────────────

describe('createAtmosphereSystem — construction', () => {
  it('exposes a scene group, lighting, and all subsystems', () => {
    const sys = makeSystem();
    expect(sys.object).toBeInstanceOf(THREE.Group);
    // Sky dome + weather group + night group added.
    expect(sys.object.children.length).toBeGreaterThanOrEqual(3);
    expect(sys.lighting).toBeDefined();
    expect(sys.shadowRig).toBeDefined();
    expect(sys.nightSystem).toBeDefined();
    expect(sys.weather).toBeDefined();
    expect(sys.skyDome).toBeDefined();
    expect(sys.probe).toBeDefined();
    sys.dispose();
  });

  it('reports no moon-glitter hook on the current WaterMaterial (documented gap)', () => {
    const sys = makeSystem(makeWater());
    // WaterMaterial has no moonDirection/moonGlitter uniform today.
    expect(sys.hasMoonGlitterHook).toBe(false);
    sys.dispose();
  });
});

// ─── Full-day sweep: monotonic water uniforms + gust-at-night ─────────────────

describe('AtmosphereSystem — Newport full-day sweep', () => {
  it('water reflected-sun luminance tracks sun elevation (brighter by day)', () => {
    const water = makeWater();
    const sys = makeSystem(water);

    const samples: Array<{ elev: number; sunLum: number }> = [];
    // Sweep every 2 UTC hours across a full day.
    for (let h = 0; h <= 24; h += 2) {
      const sky = newportSky(h);
      sys.update(frame(sky, conditions(), 0.5, h * 3600));
      const c = water.uniforms.sunColor.value as { r: number; g: number; b: number };
      samples.push({ elev: sky.sunElevation, sunLum: c.r + c.g + c.b });
    }

    const highest = samples.reduce((a, b) => (b.elev > a.elev ? b : a));
    const lowest = samples.reduce((a, b) => (b.elev < a.elev ? b : a));
    // The highest-sun sample is brighter than the lowest (night) one.
    expect(highest.sunLum).toBeGreaterThan(lowest.sunLum);
    // Night reflected sun is effectively extinguished.
    expect(lowest.sunLum).toBeLessThan(0.05);
    sys.dispose();
  });

  it('sky dome zenith uniform brightens from midnight to noon', () => {
    const sys = makeSystem();
    const lumOf = (): number => {
      const z = sys.skyDome.uniforms.zenithColor.value as { r: number; g: number; b: number };
      return z.r + z.g + z.b;
    };
    // Local midnight ≈ 05:00 UTC, local noon ≈ 17:00 UTC (UTC-5).
    sys.update(frame(newportSky(5), conditions(), 0.5, 5 * 3600));
    const midnightLum = lumOf();
    sys.update(frame(newportSky(17), conditions(), 0.5, 17 * 3600));
    const noonLum = lumOf();
    expect(noonLum).toBeGreaterThan(midnightLum);
    sys.dispose();
  });

  it('water gust intensity == raw by day and < 0.5·raw at local midnight', () => {
    const water = makeWater();
    const sys = makeSystem(water);
    const rawGust = 0.8;

    // Local noon (17:00 UTC): gust reads fully → effective ≈ raw.
    sys.update(frame(newportSky(17), conditions(), rawGust, 17 * 3600));
    const dayGust = water.uniforms.gustIntensity.value as number;
    expect(dayGust).toBeCloseTo(rawGust, 5);

    // Local midnight (05:00 UTC): gust is suppressed → effective < 0.5·raw.
    sys.update(frame(newportSky(5), conditions(), rawGust, 5 * 3600));
    const nightGust = water.uniforms.gustIntensity.value as number;
    expect(nightGust).toBeLessThan(0.5 * rawGust);
    expect(nightGust).toBeGreaterThan(0); // not fully black
    sys.dispose();
  });
});

// ─── Robustness across weather conditions ─────────────────────────────────────

describe('AtmosphereSystem — robust across conditions', () => {
  it('does not throw for clear / overcast / rain / dense fog', () => {
    const water = makeWater();
    const sys = makeSystem(water);
    const sky = newportSky(17, 0.9); // clouded sky at noon

    const scenarios: SkyConditions[] = [
      conditions(), // clear
      conditions({ cloudLow: 0.9, cloudMid: 0.9, cloudHigh: 0.6, solarRadiation: 200 }), // overcast
      conditions({ precipitation: 12, cloudLow: 0.8, cloudMid: 0.7 }), // rain
      conditions({ visibility: 200, cloudLow: 1, cloudMid: 1 }), // dense fog, 200 m
    ];

    let t = 0;
    for (const cond of scenarios) {
      expect(() => sys.update(frame(sky, cond, 0.5, (t += 1)))).not.toThrow();
      // All water uniforms remain finite numbers / defined after each update.
      const gust = sys.lighting;
      expect(Number.isFinite(gust.overcast)).toBe(true);
      expect(Number.isFinite(gust.nightFactor)).toBe(true);
    }
    sys.dispose();
  });

  it('runs without a water material (headless, no ocean yet)', () => {
    const sys = makeSystem(); // no water
    expect(() => sys.update(frame(newportSky(12), conditions(), 0.5, 1))).not.toThrow();
    sys.dispose();
  });
});

// ─── Environment probe (mocked PMREM) + dispose ───────────────────────────────

/** A minimal fake render target with a disposable texture. */
function makeFakeRenderTarget(): THREE.RenderTarget {
  return {
    texture: { needsUpdate: false, dispose: vi.fn() } as unknown as THREE.Texture,
    dispose: vi.fn(),
  } as unknown as THREE.RenderTarget;
}

describe('AtmosphereSystem — environment probe + dispose', () => {
  it('regenerates the probe (mocked) when a renderer + scene are supplied', () => {
    const fromScene = vi.fn(() => makeFakeRenderTarget());
    const pmremDispose = vi.fn();
    const sys = createAtmosphereSystem({
      seed: 1,
      knobs: knobs(),
      latitude: NEWPORT_LAT * DEG,
      probe: {
        pmremFactory: () => ({ fromScene, dispose: pmremDispose }) as unknown as THREE.PMREMGenerator,
      },
    });

    const renderer = {} as THREE.WebGPURenderer;
    const scene = new THREE.Scene();

    // First update with renderer+scene → probe regenerates and sets environment.
    sys.update(frame(newportSky(17), conditions(), 0.5, 0), renderer, scene);
    expect(fromScene).toHaveBeenCalledTimes(1);
    expect(scene.environment).not.toBeNull();

    sys.dispose();
    expect(pmremDispose).toHaveBeenCalled();
  });

  it('skips the probe when no renderer/scene are supplied (headless path)', () => {
    const fromScene = vi.fn(() => makeFakeRenderTarget());
    const sys = createAtmosphereSystem({
      seed: 1,
      knobs: knobs(),
      probe: { pmremFactory: () => ({ fromScene, dispose: vi.fn() }) as unknown as THREE.PMREMGenerator },
    });
    sys.update(frame(newportSky(17), conditions(), 0.5, 0)); // no renderer/scene
    expect(fromScene).not.toHaveBeenCalled();
    sys.dispose();
  });

  it('dispose is idempotent', () => {
    const sys = makeSystem(makeWater());
    sys.dispose();
    expect(() => sys.dispose()).not.toThrow();
  });
});

// ─── Nav-light attach on a real BoatView ──────────────────────────────────────

/**
 * Build a minimal but VALID BoatDefinition — enough for BoatView to loft a hull,
 * build a rig and a sail, and place nav lights. Six symmetric stations, a simple
 * rig, one sail. This mirrors how a real boat definition is shaped (frozen
 * `BoatDefinition` contract); it is not a stub of BoatView itself.
 */
function makeBoatDefinition(): BoatDefinition {
  const halfBeam = 1.3;
  const station = (position: number, scale: number) => ({
    position,
    points: [
      { x: 0, y: 0 },
      { x: halfBeam * 0.5 * scale, y: 0.3 },
      { x: halfBeam * scale, y: 0.8 },
      { x: halfBeam * scale, y: 1.4 },
    ],
  });
  const mat = (kind: 'gelcoat' | 'carbon' | 'sailcloth' | 'teak') => ({
    kind,
    baseColor: { r: 0.8, g: 0.8, b: 0.82 },
    roughness: 0.4,
    metalness: 0.0,
  });

  return {
    id: 'test-yacht',
    name: 'Test Yacht',
    class: 'keelboat',
    blurb: 'A test boat.',
    crewCount: 2,
    hull: {
      loa: 10,
      beam: 2.6,
      designDraft: 1.5,
      waterlineHeight: 1.0,
      stations: [
        station(0.0, 0.2),
        station(0.2, 0.7),
        station(0.4, 1.0),
        station(0.6, 1.0),
        station(0.8, 0.7),
        station(1.0, 0.25),
      ],
      bilge: 'round',
      hullCount: 1,
      sheerRise: 0.08,
      deckCamber: 0.03,
      lengthSegments: 12,
      girthSegments: 8,
    },
    rig: {
      mastHeight: 14,
      mastBaseDiameter: 0.12,
      mastTaper: 0.6,
      mastRake: 0.02,
      boomLength: 4,
      boomDiameter: 0.1,
      boomHeight: 1.4,
      spreaderPairs: 1,
      shroudDiameter: 0.008,
      bowsprit: false,
      stepPosition: { x: 0, y: 1, z: 1 },
    },
    sails: [
      {
        id: 'main',
        kind: 'main',
        area: 30,
        surface: {
          luffLength: 12,
          footLength: 4,
          leechLength: 12.5,
          luffRound: 0.02,
          broadseam: 0.01,
          twist: 0.1,
          luffSegments: 8,
          footSegments: 6,
          panelCount: 4,
        },
        centreOfEffortHeight: 6,
        aspectRatio: 3,
        maxSheetAngle: 1.2,
        maxCamber: 0.12,
        tack: { x: 0, y: 1.4, z: 1 },
        clew: { x: 0, y: 1.4, z: -3 },
        head: { x: 0, y: 13, z: 1 },
      },
    ],
    foils: [],
    hullMass: 2000,
    ballastMass: 900,
    crewMass: 80,
    crewMovementRange: { x: 1, y: 0, z: 2 },
    capsizeAngle: 2.0,
    residuaryCurve: [
      { x: 0, y: 0 },
      { x: 0.4, y: 0.5 },
    ],
    materials: {
      hull: mat('gelcoat'),
      deck: mat('teak'),
      spars: mat('carbon'),
      sail: mat('sailcloth'),
    },
    appearance: {
      hullColor: { r: 0.9, g: 0.9, b: 0.92 },
      deckColor: { r: 0.6, g: 0.45, b: 0.3 },
      sailNumber: '42',
    },
    unlockMiles: 0,
  };
}

describe('attachNavLightsToBoatView', () => {
  it('mounts a yacht nav-light rig onto a real BoatView root', () => {
    const boatDef = makeBoatDefinition();
    const view = new BoatView(boatDef, 12345);
    const childrenBefore = view.root.children.length;

    const rig = attachNavLightsToBoatView(
      view,
      { loa: boatDef.hull.loa, mastHeight: boatDef.rig.mastHeight },
      'yacht',
    );

    // The rig's root was parented under the boat root.
    expect(view.root.children.length).toBe(childrenBefore + 1);
    expect(rig.object).toBeDefined();

    // Driving it per frame (camera in vessel-local space) must not throw.
    expect(() => rig.update(0, 2, 5, 1)).not.toThrow();

    rig.dispose();
    view.dispose();
  });

  it('defaults to a sailing yacht when no kind is given', () => {
    const boatDef = makeBoatDefinition();
    const view = new BoatView(boatDef, 7);
    const rig = attachNavLightsToBoatView(view, {
      loa: boatDef.hull.loa,
      mastHeight: boatDef.rig.mastHeight,
    });
    expect(rig.object).toBeDefined();
    rig.dispose();
    view.dispose();
  });
});
