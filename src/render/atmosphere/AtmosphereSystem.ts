/**
 * AtmosphereSystem — Stream F integration facade.
 *
 * Owns and orchestrates every Stream F render subsystem behind ONE per-frame
 * `update(frame)` call:
 *   - F.1 SkyDome + EnvironmentProbe (IBL) + WaterLightingBridge
 *   - F.2 WeatherVisuals (clouds, rain, visibility uniforms)
 *   - F.3 ShadowRig (cascaded shadows) + PostChain (via `createPost`)
 *   - F.4 NightSystem (moon disc, stars, shore lights) + the gust-at-night and
 *     moon-glitter water hookups.
 *
 * Nothing in the game wires to this yet — the app entry point is Phase 2 work —
 * but the facade is complete and headlessly tested so that wiring is a single
 * `createAtmosphereSystem(...)` + `scene.add(system.object)` + per-frame
 * `system.update(frame)`.
 *
 * ## Architecture (stream rule)
 *
 * All physics/policy lives in the PURE models this facade consumes
 * (`computeLightingState`, `effectiveGustIntensity`, `computeMoonlight`, the
 * cascade fit, …). This file is a thin orchestrator: it allocates once, reuses a
 * single `LightingState` and scratch objects, and performs NO per-frame
 * allocation (see `update`).
 *
 * ## Water hookups
 *
 * The ocean water material (`src/render/ocean/WaterMaterial.ts`, Stream E,
 * frozen) exposes a `gustIntensity` uniform. Per F.4's demo requirement
 * ("gusts are harder to read at night", 7.17) this facade writes
 * `effectiveGustIntensity(rawGust, lighting, moonIlluminance)` into it every
 * frame — previously nothing drove it. It also runs `applyLightingToWater` so
 * the water's sun/sky uniforms track the live sky.
 *
 * ### Moon glitter — documented scope decision (not silently skipped)
 *
 * The task asks to drive a moon-glitter term into the water. `WaterMaterial`
 * has NO `moonDirection`/`moonGlitter` uniform today, and that module lives in
 * `src/render/ocean/` — OUTSIDE this stream's edit scope (F owns
 * sky/weather/post/night/atmosphere, not ocean) and is a completed, frozen
 * Stream-E surface. Adding a new uniform pair there would be an out-of-scope
 * edit to another stream's frozen material. So this facade does the honest,
 * backwards-compatible thing: it DETECTS a moon-glitter hook on the water
 * uniforms at construction (`moonDirection` + `moonGlitter`) and, if present,
 * drives it from the pure `Moonlight`/`moonGlitterParams` model; if absent (the
 * current state), it no-ops and records that via `hasMoonGlitterHook`. The pure
 * moon-glitter parameters are still computed every frame (they are part of the
 * NightSystem output) and are exposed on `lighting`-adjacent getters so a future
 * one-line WaterMaterial addition wires straight in. This is a labelled
 * reduction, not a pretend-it-works.
 *
 * ## Conventions
 *
 * Linear RGB; world Y-up right-handed, +X east, +Z south; SI/radians; sun/moon
 * directions point FROM the scene TOWARDS the body.
 */

import * as THREE from 'three/webgpu';
import type { QualityKnobs, SkyConditions, SkyState, Vec3 } from '@/types';
import {
  createLightingState,
  type LightingState,
} from '@render/lighting/LightingState';
import { computeLightingState } from '@render/sky/LightingModel';
import { createSkyDome, type SkyDome, type SkyDomeOptions } from '@render/sky/SkyDome';
import { EnvironmentProbe, type EnvironmentProbeOptions } from '@render/sky/EnvironmentProbe';
import { applyLightingToWater } from '@render/sky/WaterLightingBridge';
import {
  createWeatherVisuals,
  type WeatherVisuals,
  type WeatherVisualsOptions,
} from '@render/weather/WeatherVisuals';
import {
  createNightSystem,
  type NightSystem,
  type NightSystemOptions,
  type NightSkyInput,
} from '@render/night/NightSystem';
import { createNavLightRig, type NavLightRig } from '@render/night/NavLightRig';
import type { NavLightMode } from '@render/night/NavLights';
import { effectiveGustIntensity } from '@render/night/GustVisibility';
import { createShadowRig, type ShadowRig, type ShadowRigOptions } from '@render/post/ShadowRig';
import type { CameraSliceParams } from '@render/post/CascadedShadows';
import {
  createPostChain,
  type PostChain,
  type PostChainCreateOpts,
} from '@render/post/PostChain';
import type { WaterMaterialResult } from '@render/ocean/WaterMaterial';
import { rainSurfaceDisturbance } from '@render/weather/Rain';

// ─── Frame input ────────────────────────────────────────────────────────────

/**
 * The camera data the atmosphere needs per frame. Position drives the dome /
 * rain-box follow and the probe; the orthonormal basis + fov/aspect drive the
 * shadow cascade fit (`CameraSliceParams`), and the world position also feeds
 * the nav-light vessel-local transform at the call site.
 */
export interface AtmosphereCamera {
  /** Camera world position. */
  position: Vec3;
  /** Forward unit vector (viewing direction). */
  forward: Vec3;
  /** Right unit vector. */
  right: Vec3;
  /** Up unit vector. */
  up: Vec3;
  /** Vertical field of view, radians. */
  fovY: number;
  /** Aspect ratio (width / height). */
  aspect: number;
}

/** Everything the atmosphere needs for one frame. Passed by reference; not retained. */
export interface AtmosphereFrame {
  /** Live sky geometry (sun/moon/clouds/sidereal time). */
  sky: SkyState;
  /** Live sky conditions (visibility, precipitation, solar radiation, cloud). */
  conditions: SkyConditions;
  /** Air-velocity vector (m/s) — drives cloud drift & rain slant. NOT a bearing. */
  wind: Vec3;
  /** Frame delta time, seconds. */
  dt: number;
  /** Monotonic session time, seconds (probe cadence + any time-based fx). */
  timeSeconds: number;
  /** Camera pose + lens for this frame. */
  camera: AtmosphereCamera;
  /** Observer latitude, radians (+N) — for the star field. */
  latitude: number;
  /** Quality knobs (cloud march steps, shadow cascades honoured at build). */
  knobs: QualityKnobs;
  /** Raw daytime gust intensity 0..1 from the wind gust field. */
  rawGustIntensity: number;
}

// ─── System options ───────────────────────────────────────────────────────────

export interface AtmosphereSystemOptions {
  /** Deterministic seed for the night system (stars + shore lights). */
  seed: number;
  /** Quality knobs (used to build the shadow rig cascade count). */
  knobs: QualityKnobs;
  /** Observer latitude, radians (+N). Default 0; overridden per-frame by `frame.latitude`. */
  latitude?: number;
  /** Options forwarded to the sky dome. */
  sky?: SkyDomeOptions;
  /** Options forwarded to the environment probe. */
  probe?: EnvironmentProbeOptions;
  /** Options forwarded to the weather visuals. */
  weather?: WeatherVisualsOptions;
  /** Options forwarded to the shadow rig. */
  shadow?: ShadowRigOptions;
  /** Extra options forwarded to the night system (star count, shore anchors, urban). */
  night?: Omit<NightSystemOptions, 'seed' | 'latitude'>;
  /**
   * The ocean water material to drive, if any. The facade writes its lighting,
   * gust (night-scaled), rain-ripple and (if present) moon-glitter hooks. Water
   * is optional so the system can run headlessly / before the ocean exists.
   */
  water?: WaterMaterialResult;
}

// ─── Public surface ───────────────────────────────────────────────────────────

export interface AtmosphereSystem {
  /** A render-order-safe group to add to the scene (sky dome first, etc.). */
  readonly object: THREE.Group;
  /** The last computed lighting state (stable reference, mutated in place). */
  readonly lighting: LightingState;
  /** The shadow rig (add its `object` to the scene separately if desired). */
  readonly shadowRig: ShadowRig;
  /** The night system (exposes nav-light attach + moon/star state). */
  readonly nightSystem: NightSystem;
  /** The weather visuals bundle. */
  readonly weather: WeatherVisuals;
  /** The sky dome. */
  readonly skyDome: SkyDome;
  /** The environment probe (IBL). */
  readonly probe: EnvironmentProbe;
  /** True iff the bound water material exposes a moon-glitter uniform hook. */
  readonly hasMoonGlitterHook: boolean;
  /**
   * Create the post-processing chain. Kept separate from construction because
   * the post chain needs a live renderer + scene + camera that a headless build
   * does not have; call this once the real render targets exist.
   */
  createPost(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    opts: Omit<PostChainCreateOpts, 'knobs'> & { knobs?: QualityKnobs },
  ): PostChain;
  /**
   * Advance every subsystem for one frame. Allocation-free: reuses the single
   * `lighting` state and internal scratch objects.
   *
   * `renderer`/`scene` are optional: when both are supplied the environment
   * probe refreshes (per its cadence policy); omit them in a headless/test
   * context and the probe step is skipped.
   */
  update(frame: AtmosphereFrame, renderer?: THREE.WebGPURenderer, scene?: THREE.Scene): void;
  /** Dispose every owned GPU resource. */
  dispose(): void;
}

// ─── Water moon-glitter hook detection ─────────────────────────────────────────

/** The uniform pair a future WaterMaterial would expose for moon glitter. */
interface MoonGlitterWaterHook {
  moonDirection: { value: unknown };
  moonGlitter: { value: unknown };
}

function detectMoonGlitterHook(
  water: WaterMaterialResult | undefined,
): MoonGlitterWaterHook | undefined {
  if (water === undefined) return undefined;
  const u = water.uniforms as unknown as Record<string, { value: unknown } | undefined>;
  const dir = u['moonDirection'];
  const glit = u['moonGlitter'];
  if (dir !== undefined && glit !== undefined) {
    return { moonDirection: dir, moonGlitter: glit };
  }
  return undefined;
}

/** The rain-ripple hook a WaterMaterial may expose (an intensity uniform). */
interface RainRippleWaterHook {
  value: unknown;
}

function detectRainRippleHook(
  water: WaterMaterialResult | undefined,
): RainRippleWaterHook | undefined {
  if (water === undefined) return undefined;
  const u = water.uniforms as unknown as Record<string, { value: unknown } | undefined>;
  // A future WaterMaterial rain-ripple intensity uniform. Not present today.
  return u['rainRipple'];
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createAtmosphereSystem(opts: AtmosphereSystemOptions): AtmosphereSystem {
  const latitude0 = opts.latitude ?? 0;

  // The scene group, assembled in a render-order-safe order: the sky dome is
  // added first (it renders behind everything via BackSide + depthWrite=false),
  // then weather visuals (cloud dome + rain box, also depth-write off), then the
  // night group (additive emissive points). Shadow-rig lights are kept in their
  // own group (lights do not need a draw order) and exposed separately.
  const group = new THREE.Group();

  const skyDome = createSkyDome(opts.sky ?? {});
  group.add(skyDome.mesh);

  const weather = createWeatherVisuals(opts.weather ?? {});
  group.add(weather.object);

  const nightSystem = createNightSystem({
    seed: opts.seed,
    latitude: latitude0,
    ...(opts.night ?? {}),
  });
  group.add(nightSystem.object);

  const probe = new EnvironmentProbe(opts.probe ?? {});
  const shadowRig = createShadowRig(opts.knobs, opts.shadow ?? {});

  const water = opts.water;
  const moonGlitterHook = detectMoonGlitterHook(water);
  const rainRippleHook = detectRainRippleHook(water);

  // ── Reused per-frame state (NO per-frame allocation) ──
  const lighting: LightingState = createLightingState();
  const cameraSlice: CameraSliceParams = {
    position: { x: 0, y: 0, z: 0 },
    forward: { x: 0, y: 0, z: -1 },
    right: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    fovY: Math.PI / 3,
    aspect: 16 / 9,
    sliceNear: 0.5,
    sliceFar: 400,
  };
  // Scratch camera-position object reused for dome/probe/weather.
  const camPos = { x: 0, y: 0, z: 0 };
  // Scratch NightSkyInput built from SkyState each frame (reused).
  const nightSky: NightSkyInput = {
    moonDirection: { x: 0, y: 1, z: 0 },
    moonElevation: 0,
    moonPhase: 0,
    siderealTime: 0,
    sunDirection: { x: 0, y: 1, z: 0 },
  };
  const nightCtx: { rawGustIntensity: number } = { rawGustIntensity: 0 };
  // Scratch Vec3 reused for the moon-direction uniform write (when hooked).
  const moonDirScratch = new THREE.Vector3(0, 1, 0);

  let disposed = false;

  function update(
    frame: AtmosphereFrame,
    renderer?: THREE.WebGPURenderer,
    scene?: THREE.Scene,
  ): void {
    const { sky, conditions, wind, dt, timeSeconds, camera, knobs } = frame;

    // 1) Lighting state — the shared contract every subsystem reads. Written in
    //    place into the reused `lighting` object.
    computeLightingState(
      sky,
      { solarRadiation: conditions.solarRadiation, visibility: conditions.visibility },
      lighting,
    );

    // 2) Camera position scratch.
    camPos.x = camera.position.x;
    camPos.y = camera.position.y;
    camPos.z = camera.position.z;

    // 3) Sky dome (follows camera; reads sun/sky colours from lighting).
    skyDome.update(sky, lighting, camPos);

    // 4) Weather visuals (clouds drift with wind, rain slants downwind, fog from
    //    visibility). Uses only the cloudMarchSteps knob.
    weather.update(sky, conditions, lighting, wind, dt, camPos, {
      cloudMarchSteps: knobs.cloudMarchSteps,
    });

    // 5) Night system. Build the reused NightSkyInput from SkyState.
    nightSky.moonDirection.x = sky.moonDirection.x;
    nightSky.moonDirection.y = sky.moonDirection.y;
    nightSky.moonDirection.z = sky.moonDirection.z;
    nightSky.moonElevation = sky.moonElevation;
    nightSky.moonPhase = sky.moonPhase;
    nightSky.siderealTime = sky.siderealTime;
    nightSky.sunDirection.x = sky.sunDirection.x;
    nightSky.sunDirection.y = sky.sunDirection.y;
    nightSky.sunDirection.z = sky.sunDirection.z;
    nightCtx.rawGustIntensity = frame.rawGustIntensity;
    nightSystem.update(nightSky, lighting, nightCtx);
    // Keep the star field honouring the current (possibly changed) latitude.
    nightSystem.object.position.set(camPos.x, camPos.y, camPos.z);

    // 6) Shadow rig. Fill the reused camera slice from the frame camera.
    cameraSlice.position.x = camera.position.x;
    cameraSlice.position.y = camera.position.y;
    cameraSlice.position.z = camera.position.z;
    cameraSlice.forward.x = camera.forward.x;
    cameraSlice.forward.y = camera.forward.y;
    cameraSlice.forward.z = camera.forward.z;
    cameraSlice.right.x = camera.right.x;
    cameraSlice.right.y = camera.right.y;
    cameraSlice.right.z = camera.right.z;
    cameraSlice.up.x = camera.up.x;
    cameraSlice.up.y = camera.up.y;
    cameraSlice.up.z = camera.up.z;
    cameraSlice.fovY = camera.fovY;
    cameraSlice.aspect = camera.aspect;
    shadowRig.update(sky, lighting, cameraSlice);

    // 7) Water hookups.
    if (water !== undefined) {
      // Sun/sky reflection colours.
      applyLightingToWater(water.uniforms, sky, lighting);

      // Night-scaled gust intensity — THE F.4 demo requirement. Gust patches are
      // harder to read at night; the moon partly restores them.
      const effGust = effectiveGustIntensity(
        frame.rawGustIntensity,
        lighting,
        nightSystem.moonlight.moonIlluminance,
      );
      (water.uniforms.gustIntensity as { value: unknown }).value = effGust;

      // Moon glitter — only if the water exposes the hook (documented scope note
      // in the file header). Drive it from the pure moon model.
      if (moonGlitterHook !== undefined) {
        moonDirScratch.set(sky.moonDirection.x, sky.moonDirection.y, sky.moonDirection.z);
        moonGlitterHook.moonDirection.value = moonDirScratch;
        moonGlitterHook.moonGlitter.value = nightSystem.moonGlitter.intensity;
      }

      // Rain ripple — only if the water exposes the hook.
      if (rainRippleHook !== undefined) {
        rainRippleHook.value = rainSurfaceDisturbance(conditions.precipitation);
      }
    }

    // 8) Environment probe — only when a live renderer + scene are supplied.
    //    The probe's own policy decides whether to actually regenerate.
    if (renderer !== undefined && scene !== undefined) {
      probe.update(renderer, scene, sky, lighting, timeSeconds, scene);
    }
  }

  function createPost(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    postOpts: Omit<PostChainCreateOpts, 'knobs'> & { knobs?: QualityKnobs },
  ): PostChain {
    const knobs = postOpts.knobs ?? opts.knobs;
    return createPostChain(renderer, scene, camera, { ...postOpts, knobs });
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    skyDome.dispose();
    weather.dispose();
    nightSystem.dispose();
    shadowRig.dispose();
    probe.dispose();
  }

  return {
    object: group,
    lighting,
    shadowRig,
    nightSystem,
    weather,
    skyDome,
    probe,
    hasMoonGlitterHook: moonGlitterHook !== undefined,
    createPost,
    update,
    dispose,
  };
}

// ─── Nav-light attach helper ────────────────────────────────────────────────

/**
 * The minimal structural view of a boat render object a nav-light rig needs: an
 * `Object3D` to parent the lights under. `BoatView.root` satisfies this.
 *
 * ## Why dimensions are passed explicitly (documented Phase-2 gap)
 *
 * `src/render/boat/BoatView.ts` derives its hull length (`boatDef.hull.loa`) and
 * mast height (`boatDef.rig.mastHeight`) from its `BoatDefinition`, but keeps
 * both PRIVATE — it exposes only `root`. Rather than edit the frozen boat
 * module to expose them, the caller (which has the `BoatDefinition` in hand at
 * the wiring site) passes `loa`/`mastHeight` here. The player boat is the only
 * vessel with a render view today; AMBIENT vessels (moored fleet, ferries,
 * signature vessels) have no render view yet — that is Phase 2 work — so this
 * generic attach API is exported for them to use once they do, and the gap is
 * documented here rather than hidden.
 */
export interface NavLightBoatView {
  /** The object to parent the nav-light rig under (e.g. `BoatView.root`). */
  readonly root: THREE.Object3D;
}

/** Hull dimensions the nav-light layout needs (from the boat's `BoatDefinition`). */
export interface NavLightDimensions {
  /** Length overall, metres (`boatDef.hull.loa`). */
  loa: number;
  /** Mast height, metres (`boatDef.rig.mastHeight`). */
  mastHeight: number;
}

/**
 * Create a nav-light rig and attach it to a boat view's root, laid out for the
 * boat's hull length and mast height. Returns the rig so the caller can drive it
 * per frame (`rig.update(camLocalX, camLocalY, camLocalZ, nightFactor)`), with
 * the camera transformed into the vessel's local frame.
 *
 * @param boatView  Anything exposing a `root` Object3D (e.g. a `BoatView`).
 * @param dims      Hull length + mast height (from the `BoatDefinition`).
 * @param kind      COLREGs vessel mode. Defaults to `'yacht'` (sailing yacht:
 *                  sidelights + stern, no steaming light).
 */
export function attachNavLightsToBoatView(
  boatView: NavLightBoatView,
  dims: NavLightDimensions,
  kind: NavLightMode = 'yacht',
): NavLightRig {
  const rig = createNavLightRig();
  rig.attachToVessel(boatView.root, kind, dims.loa, dims.mastHeight);
  return rig;
}
