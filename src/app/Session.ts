/**
 * Session — Phase 2 task 2.1 "first sail" assembly.
 *
 * `createSession(opts)` wires every completed stream (weather, environment,
 * terrain + landmarks, boat sim + view, ocean, atmosphere, post, camera, input,
 * HUD) into a playable session: launch into a venue in real weather (with the
 * offline fallback ladder), sail the boat with the keyboard, see sea + sky +
 * boat + HUD, all driven by the 120 Hz fixed-step game loop.
 *
 * ## The assist seam
 *
 * Imported from `@/game/assist` (tack/gybe scripting, auto-trim, auto-hike).
 *
 * ## Conventions
 *
 * Only `src/render` and `src/app` may import three. three is imported as
 * `three/webgpu`, TSL from `three/tsl`. `await renderer.init()` happens in the
 * renderer bootstrap before any render/compute call. Per-frame allocation is
 * kept low: scratch objects are allocated once and reused.
 *
 * ## Documented reductions (honest, not hidden)
 *
 * - **Ocean displacement:** the clipmap is rendered with the full water material
 *   and tracks the camera, but for the first sail the GPU spectrum / CPU
 *   fallback displacement is NOT yet written into the clipmap vertex buffers —
 *   the surface renders as the shaded flat-plus-fresnel water plane. The boat's
 *   physics sits on the environment's wave field (a flat-water stub in the first
 *   sail), so the boat and the visible sea agree (both flat). Wiring the
 *   spectrum into the clipmap is a labelled follow-up. See STATUS.md.
 * - **Ambient vessels / traffic:** not placed (no render view for ambient
 *   vessels exists yet — a known Phase-2 gap, see Stream F notes). Skipped and
 *   logged once.
 * - **Nav lights at night:** attached to the boat view via the atmosphere
 *   facade but only lit by the night system; a daytime first sail shows them off.
 */

import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';

import type {
  AssistLevel,
  BoatDefinition,
  ControlState,
  CrewCommand,
  Environment,
  PolarDiagram,
  QualityKnobs,
  SkyConditions,
  Vec3,
  VenueDefinition,
  WeatherService,
  WeatherSnapshot,
} from '@/types';

import { createSessionClock } from '@core/time/SessionClock';
import type { SessionClock } from '@core/time/SessionClock';
import { createGameLoop, FIXED_TIMESTEP } from '@/app/GameLoop';
import type { GameLoopHandle } from '@/app/GameLoop';

// Weather + environment + venue
import { resolveWeather, resolveOffline } from '@weather/index';
import { fetchForecast, fetchMarine } from '@weather/index';
import type { FetchWeatherFn } from '@weather/index';
import { requireVenue, buildVenueTerrain } from '@venues/index';

// Boat
import type { BoatSimulationBundle } from '@boats/index';

// Render
import type { RendererHandle } from '@render/Renderer';
import { BoatView, toBufferGeometry } from '@render/boat';
import { createOceanClipmap } from '@render/ocean/OceanClipmap';
import type { OceanClipmapHandle } from '@render/ocean/OceanClipmap';
import { buildWaterMaterial } from '@render/ocean/WaterMaterial';
import type { WaterMaterialResult } from '@render/ocean/WaterMaterial';
import { buildProceduralMaterial } from '@render/materials/index';
import { createSceneLighting } from '@render/lighting/SceneLighting';
import type { SceneLighting } from '@render/lighting/SceneLighting';
import {
  createAtmosphereSystem,
  attachNavLightsToBoatView,
  type AtmosphereSystem,
  type AtmosphereFrame,
} from '@render/atmosphere';
import type { PostChain } from '@render/post/PostChain';
import { CameraRig } from '@render/camera/CameraRig';

// Generation (landmark registry — side-effect imports populate the registry)
import { getGenerator } from '@generation/index';
import '@generation/landmarks/LighthouseGenerator.register';
import '@generation/landmarks/SuspensionBridgeGenerator.register';
import '@generation/landmarks/BreakwaterGenerator.register';

// Camera (pure controller)
import { createCameraController } from '@game/camera';
import type { CameraController, CameraFrame, BoatCameraGeometry, CameraMode } from '@game/camera';

// Input
import {
  InputManager,
  KeyboardInput,
  MouseInput,
  GamepadInput,
  LocalStorageKeyValueStore,
} from '@/input';
import type { GamepadLike } from '@/input';
import { BindingMap, ControlsAdapter } from '@game/input';

// HUD
import { createHudViewModel, buildHudViewModel } from '@game/hud';
import type { HudViewModel, HudPreset, UnitSystem } from '@game/hud';
import { createHudStore, createHudPublisher, mountHud } from '@/ui/hud';
import type { HudStore, HudPublisher, MountedHud } from '@/ui/hud';

// Pure helpers
import {
  sessionTimeFor,
  sampleTrueWind,
  computeApparentWind,
  buildHudInput,
  buildCameraFrame,
  ScriptedInputProvider,
  toAssistLevel,
  type TrueWind,
} from './sessionHelpers';
import { buildSessionWorld } from './buildSessionWorld';

// Assist seam: tack/gybe scripting, auto-trim, auto-hike.
import { createSailingAssist } from '@/game/assist';
import type { SailingAssist, AssistFrame } from '@/game/assist';

// ─── Public surface ────────────────────────────────────────────────────────────

export interface CreateSessionOptions {
  /** The canvas the renderer draws into. */
  canvas: HTMLCanvasElement;
  /** The overlay root the HUD mounts into (`#ui-root`). */
  uiRoot: HTMLElement;
  /** Venue id. Default 'newport'. */
  venueId?: string;
  /** Boat id. Default 'dinghy'. */
  boatId?: string;
  /** Assist level. Default 'assisted'. */
  assist?: AssistLevel;
  /** Epoch-ms clock. Default `Date.now`. */
  now?: () => number;
  /** Inject a weather service (tests). When absent, the fallback ladder runs. */
  weather?: WeatherService;
  /** The renderer handle (renderer + probed capabilities). Required. */
  renderer: RendererHandle;
  /** Force the offline fallback ladder (no network). */
  offline?: boolean;
  /** Clock speed scale for the test harness only (1 = shipped). */
  speed?: number;
  /** Enable the scripted autosail input provider (browser smoke test). */
  autosail?: boolean;
  /** Initial camera mode (`?cam=chase|helm|drone|mast`). Default 'chase'. */
  startCamera?: CameraMode;
  /** Test hook populated on `window.__sailing` by the smoke harness. */
  testHook?: SailingTestHook;
}

/** The running session. */
export interface Session {
  /** Start the loop. Resolves after the first rendered frame. */
  start(): void;
  /** Pause / resume the session clock. */
  pause(): void;
  resume(): void;
  /** Tear everything down: stop the loop, remove listeners, dispose GPU. */
  dispose(): void;
  /** Which weather source produced the active conditions. */
  readonly weatherSource: WeatherSnapshot['source'];
  /** The backend in use. */
  readonly backend: 'webgpu' | 'webgl2';
}

/** The `window.__sailing` shape the browser smoke test reads. */
export interface SailingTestHook {
  frames: number;
  boatSpeedKnots: number;
  heading: number;
  tackCount: number;
  /** Number of scripted/assisted gybes completed (autosail). */
  gybeCount: number;
  /** Worst absolute heel seen over the run, degrees (browser capsize assert). */
  maxHeelDeg: number;
  /** True if the boat ever exceeded its capsize angle. */
  capsized: boolean;
  errors: string[];
  backend: 'webgpu' | 'webgl2';
  weatherSource: string;
  done: boolean;
}

const MS_TO_KNOTS = 3600 / 1852;

// ─── Default quality knobs (full fidelity; the quality manager tunes these) ───

function defaultKnobs(backend: 'webgpu' | 'webgl2'): QualityKnobs {
  const isGpu = backend === 'webgpu';
  return {
    renderScale: 1,
    oceanCascades: isGpu ? 3 : 2,
    oceanResolution: isGpu ? 256 : 128,
    oceanGridRings: 8,
    reflectionScale: 0,
    reflectionCadence: 2,
    shadowCascades: isGpu ? 3 : 2,
    cloudMarchSteps: isGpu ? 24 : 12,
    sprayBudget: isGpu ? 2000 : 500,
    ambientBudget: isGpu ? 40 : 10,
    // TAA MUST be off on WebGL2 (TRAANode crashes there, Stream F finding).
    taa: isGpu,
    motionBlur: false,
    depthOfField: false,
    bloom: isGpu,
  };
}

// ─── Weather resolution ────────────────────────────────────────────────────────

/**
 * A real-network fetch function wired to the Open-Meteo providers, shaped to the
 * weather fallback's `FetchWeatherFn` (single-coordinate forecast + marine). The
 * providers are array-batched; we request one coordinate and take the first.
 */
const networkFetch: FetchWeatherFn = async (lat, lon) => {
  const [forecasts, marines] = await Promise.all([
    fetchForecast([lat], [lon]),
    fetchMarine([lat], [lon]).catch(() => [null]),
  ]);
  const forecast = forecasts[0];
  if (forecast === undefined) {
    throw new Error('networkFetch: Open-Meteo returned no forecast');
  }
  return { forecast, marine: marines[0] ?? null };
};

/**
 * Resolve a weather snapshot with a 4 s network timeout, falling back through
 * the offline ladder (cache → climatology → hard default) on timeout/offline.
 */
async function resolveSnapshot(
  venue: VenueDefinition,
  offline: boolean,
): Promise<WeatherSnapshot> {
  if (offline) {
    return resolveOffline(venue);
  }
  const timeout = new Promise<WeatherSnapshot>((resolve) => {
    setTimeout(() => resolve(resolveOffline(venue)), 4000);
  });
  const live = resolveWeather({ venue, fetchFn: networkFetch }).catch(() =>
    resolveOffline(venue),
  );
  return Promise.race([live, timeout]);
}

// ─── Session factory ───────────────────────────────────────────────────────────

export async function createSession(opts: CreateSessionOptions): Promise<Session> {
  const venueId = opts.venueId ?? 'newport';
  const boatId = opts.boatId ?? 'dinghy';
  const assistLevel = toAssistLevel(opts.assist);
  const speed = opts.speed ?? 1;
  const { renderer, capabilities } = opts.renderer;
  const backend = capabilities.backend;
  const knobs = defaultKnobs(backend);

  const venue = requireVenue(venueId);

  // ── 1. Weather ───────────────────────────────────────────────────────────
  let weatherService: WeatherService;
  let snapshot: WeatherSnapshot;
  if (opts.weather !== undefined) {
    weatherService = opts.weather;
    snapshot = weatherService.snapshot;
  } else {
    snapshot = await resolveSnapshot(venue, opts.offline ?? false);
  }

  // ── 2. World (environment + boat + polar), via the SHARED pure factory ─────
  // `buildSessionWorld` is the single source of truth for the simulated world
  // the Session sails in — the venue Environment (REAL spectrum wave field +
  // tide/current + wind influence), the dinghy BoatSimulation, its polar, and
  // the wave field. The real-conditions acceptance tests drive the SAME factory,
  // so a headless test cannot drift from the shipped game (the gap that let the
  // "1 kt / 50° leeway on a reach" defect pass the calm-water acceptance tests).
  const world = buildSessionWorld({
    venueId,
    boatId,
    snapshot,
    nowMs: snapshot.fetchedAt,
  });
  const environment: Environment = world.environment;
  const waveField = world.waveField;
  void waveField;
  const boatDef: BoatDefinition = world.boatDef;
  if (opts.weather === undefined) {
    // The venue env wraps the snapshot in its own WeatherService; reuse it so
    // HUD source/conditions and skyAt stay consistent with the environment.
    weatherService = new WeatherServiceFromEnv(environment);
  }

  // ── 3. Scene graph ─────────────────────────────────────────────────────────
  const scene = new THREE.Scene();

  // ── 4. Terrain mesh + landmarks ────────────────────────────────────────────
  const disposables: Array<{ dispose(): void }> = [];
  const terrain = buildVenueTerrain(venue);
  addTerrainMesh(scene, terrain.terrain.mesh, disposables);
  addLandmarks(scene, venue, disposables);
  logOnce('ambient', '[Session] ambient vessels/traffic have no render view yet — skipped (Phase 2 gap).');

  // ── 5. Boat (sim + view) ────────────────────────────────────────────────────
  // The sim/polar come from the shared world; it is already reset to the venue
  // spawn. The render view is layered on here (render-only).
  const boat: BoatSimulationBundle = world.boat;
  const polar: PolarDiagram = world.polar;

  const boatView = new BoatView(boatDef, 0);
  scene.add(boatView.root);
  disposables.push(boatView);

  // ── 6. Ocean ─────────────────────────────────────────────────────────────
  const ocean: OceanClipmapHandle = createOceanClipmap(knobs.oceanGridRings);
  // Shared wave-phase clock: the SAME session time the physics WaveField is
  // evaluated at, so the visible surface and the boat agree (req 4.12). The
  // water material's Gerstner positionNode reads this uniform; `render()`
  // updates it every frame to the current session time.
  const waveTimeUniform = uniform(0);
  // Shared camera-position uniform: drives the far-field normal flatten +
  // distance roughness widening in every ring's water material (anti-aliasing).
  const waterCameraUniform = uniform(new THREE.Vector3(0, 0, 0));
  // Build ONE water material PER RING, each band-limited to that ring's vertex
  // spacing (0.5 m inner → 64 m outer). This is the fix for the radial aliasing
  // streaks: a ring only displaces/normals the wave components it can actually
  // resolve, so sub-grid chop on the coarse far rings is faded out rather than
  // aliased. The near ring keeps every component → boat↔sea coherence intact.
  const waterResults: WaterMaterialResult[] = [];
  for (let i = 0; i < ocean.ringCount; i++) {
    const mesh = ocean.getRingMesh(i);
    const info = ocean.getRingInfo(i);
    if (mesh === undefined || info === undefined) continue;
    const ringWater = buildWaterMaterial({
      appearance: venue.water,
      sunDirection: { x: 0.3, y: 0.8, z: 0.2 },
      waveComponents: environment.waves.components,
      waveTimeUniform,
      vertexSpacing: info.cellSize,
      cameraPositionUniform: waterCameraUniform,
    });
    mesh.material = ringWater.material;
    waterResults.push(ringWater);
  }
  // The first ring's result is the representative handle for atmosphere water
  // hookups (sun/sky/gust uniforms) — all rings share the same appearance, and
  // the atmosphere updates these uniforms by reference. Use ring 0 (near).
  const water: WaterMaterialResult =
    waterResults[0] ??
    buildWaterMaterial({
      appearance: venue.water,
      sunDirection: { x: 0.3, y: 0.8, z: 0.2 },
    });
  scene.add(ocean.group);
  disposables.push(ocean);

  // ── 7. Atmosphere (sky/lighting/clouds/night/shadows + water hookups) ──────
  const atmosphere: AtmosphereSystem = createAtmosphereSystem({
    seed: 0,
    knobs,
    latitude: venue.coordinates.latitude * (Math.PI / 180),
    water,
  });
  scene.add(atmosphere.object);
  scene.add(atmosphere.shadowRig.object);
  disposables.push(atmosphere);

  // ── 7b. Scene fill lighting ────────────────────────────────────────────────
  // The directional sun alone (ShadowRig) collapses toward zero under overcast /
  // low sun, and there is no guaranteed IBL, so without this the PBR boat + sea
  // render near-black (the first-run "black silhouette" defect). A hemisphere +
  // ambient fill driven by the same LightingState guarantees a lit, readable
  // scene in all conditions. Tinted toward the venue's deep-water colour below.
  const sceneLighting: SceneLighting = createSceneLighting(venue.water.colorDeep);
  scene.add(sceneLighting.object);
  disposables.push(sceneLighting);
  // Nav lights on the player boat (lit only at night by the night system).
  attachNavLightsToBoatView(boatView, {
    loa: boatDef.hull.loa,
    mastHeight: boatDef.rig.mastHeight,
  });

  // ── 8. Camera ───────────────────────────────────────────────────────────────
  const aspect = aspectOf(opts.canvas);
  const cameraController: CameraController = createCameraController({
    mode: opts.startCamera ?? 'chase',
    aspect,
  });
  const cameraRig = new CameraRig({ aspect });

  // ── 9. Post chain (needs a live renderer + scene + camera) ─────────────────
  const post: PostChain = atmosphere.createPost(renderer, scene, cameraRig.camera, {
    knobs,
    backend,
    grade: venue.grade,
  });

  // ── 10. Input ──────────────────────────────────────────────────────────────
  const kvStore = new LocalStorageKeyValueStore();
  const bindings = loadBindings(kvStore);
  const keyboard = new KeyboardInput(opts.canvas, (code) => isBoundCode(bindings, code), window);
  const mouse = new MouseInput(opts.canvas, document, () => opts.canvas.clientWidth);
  const gamepad = new GamepadInput(() =>
    typeof navigator !== 'undefined' && navigator.getGamepads
      ? (navigator.getGamepads() as unknown as readonly (GamepadLike | null)[])
      : [],
  );
  const inputManager = new InputManager(keyboard, mouse, gamepad);
  const controlsAdapter = new ControlsAdapter();

  // ── 11. HUD ──────────────────────────────────────────────────────────────
  const hudStore: HudStore = createHudStore(kvStore);
  const hudMounted: MountedHud = mountHud(opts.uiRoot, hudStore);
  const hudPublisher: HudPublisher = createHudPublisher(hudStore);
  const hudVm: HudViewModel = createHudViewModel();

  // ── 12. Assist ─────────────────────────────────────────────────────────────
  const assist: SailingAssist = createSailingAssist({ assist: assistLevel });

  // ── 13. Session clock + loop ────────────────────────────────────────────────
  const clock: SessionClock = createSessionClock(1); // real time 1×

  // Reused scratch / per-frame state (allocation-free steady state).
  const scratch = createScratch(boatDef);
  const scripted = opts.autosail ? new ScriptedInputProvider() : null;
  const testHook = opts.testHook;
  let lastTrueWind: TrueWind = { fromBearing: 0, speed: 0 };
  let tackPhaseWas: SailingAssist['phase'] = 'idle';
  let firstFrameRendered = false;
  const onFirstFrame = opts.autosail ? () => {} : () => {};

  // Derive a camera-driving boat geometry (eye slightly aft, to windward).
  const camGeometry: BoatCameraGeometry = {
    mastHeight: boatDef.rig.mastHeight,
    loa: boatDef.hull.loa,
    eyeOffset: { x: 0.2, y: 1.1, z: -0.3 },
  };

  function fixedUpdate(dt: number): void {
    const t = sessionTimeFor(clock.elapsed(), speed);

    // 1. INPUT — scripted or device.
    let driver: Partial<ControlState>;
    let commands: readonly CrewCommand[];
    if (scripted !== null) {
      // Drive the scripted autosail through its PD-helm path: supply the boat's
      // heading + yaw rate and the (last sampled) true-wind bearing so the
      // script steers to close-hauled, tacks, bears away and gybes closed-loop.
      // `lastTrueWind` is one frame stale (sampled below each step), which is
      // immaterial to a helm PD at 120 Hz and avoids reordering the wind sample.
      const f = scripted.frame(t, {
        heading: boat.sim.state.heading,
        yawRate: boat.sim.state.angularVelocity.y,
        windFromBearing: lastTrueWind.fromBearing,
      });
      driver = f.controls;
      commands = f.commands;
    } else {
      const dev = inputManager.sample();
      const res = controlsAdapter.frame(
        bindings,
        dev,
        boat.sim.state.helmLoad,
        boat.sim.state.speed,
        dt,
        assistLevel,
      );
      driver = res.controlsPatch;
      commands = res.input.crewCommands;
    }

    // 2. ASSIST — over the driver patch, with the current wind.
    const tw = sampleTrueWind(environment, boat.sim.state, t);
    lastTrueWind = tw;
    const assistFrame: AssistFrame = {
      state: boat.sim.state,
      trueWindFromBearing: tw.fromBearing,
      trueWindSpeed: tw.speed,
      assist: assistLevel,
      commands,
      driverControls: fillControlState(scratch.driverControls, driver, boat.sim.state.controls),
      dt,
    };
    const finalPatch = assist.update(assistFrame, scratch.assistPatch);

    // 3. SET CONTROLS
    boat.sim.setControls(finalPatch);

    // 4. STEP
    boat.sim.step(environment, t, dt);

    // Count tacks (assist phase idle → tacking transition).
    if (tackPhaseWas === 'idle' && assist.phase === 'tacking') {
      scratch.tackCount++;
    }
    // Count gybes (assist phase idle → gybing transition).
    if (tackPhaseWas === 'idle' && assist.phase === 'gybing') {
      scratch.gybeCount++;
    }
    tackPhaseWas = assist.phase;

    // Track the worst heel and whether the boat ever capsized (for the browser
    // smoke test's "did not capsize" assertion).
    const absHeelDeg = Math.abs(boat.sim.state.heel) * (180 / Math.PI);
    if (absHeelDeg > scratch.maxHeelDeg) scratch.maxHeelDeg = absHeelDeg;
    if (boat.sim.state.capsized) scratch.capsized = true;

    // Feed the render-side interpolation with the new physics state.
    boatView.pushState(boat.sim.state);
  }

  function render(alpha: number): void {
    const t = sessionTimeFor(clock.elapsed(), speed);
    const dtFrame = FIXED_TIMESTEP; // approximate; render smoothing is dt-based

    // Interpolated boat transform. The physics now floats the hull at its DESIGN
    // draft (the Buoyancy refDepth fix — keel ~0.12 m below mean water, design
    // waterline at the surface with full deck freeboard) and bobs with the wave
    // field through distributed buoyancy, so the render view uses the physics
    // state directly — the old `setHeaveOverride` presentation hack (which hid a
    // ~0.2 m deep-sink) is removed.
    boatView.update(alpha, dtFrame);

    // Sky state for this time.
    const sky = environment.skyAt(t);
    const kf = weatherService.sampleAt(t);
    const conditions: SkyConditions = kf.sky;

    // Camera.
    const windVelForCamera = scratch.zero;
    const camFrame: CameraFrame = buildCameraFrame(
      {
        boatState: boat.sim.state,
        geometry: camGeometry,
        slam: 0,
        time: t,
        lookDelta: scratch.lookDelta,
        marks: scratch.noMarks,
        otherBoats: scratch.noBoats,
        sunDirection: sky.sunDirection,
        isLand: (x, z) => environment.isLand(x, z),
      },
      scratch.cameraFrame,
    );
    void windVelForCamera;
    const pose = cameraController.update(camFrame, dtFrame);
    cameraRig.applyPose(pose);

    // Ocean follows the camera.
    ocean.update(pose.position.x, pose.position.z);

    // Atmosphere: build the per-frame frame and update (drives sky/water/shadows).
    updateAtmosphereFrame(scratch.atmosphereFrame, sky, conditions, environment, t, dtFrame, pose, cameraRig.camera, venue, knobs);
    atmosphere.update(scratch.atmosphereFrame, renderer, scene);

    // Fill lighting tracks the freshly-computed lighting state.
    sceneLighting.update(atmosphere.lighting);

    // Propagate the atmosphere-driven sun/sky/gust uniforms (written by
    // reference into the representative ring-0 handle) to every other ring's
    // water material, since each ring owns its own uniform objects.
    syncWaterLighting(waterResults);

    // Advance the ocean wave phase to the current session time — the SAME clock
    // the physics WaveField uses, so the visible surface stays in step with the
    // boat (req 4.12).
    waveTimeUniform.value = t;
    // Keep the water's camera-position uniform current (drives the far-field
    // normal flatten + distance roughness widening that kills aliasing streaks).
    {
      const cv = waterCameraUniform.value as THREE.Vector3;
      cv.set(pose.position.x, pose.position.y, pose.position.z);
    }

    // HUD: build the input + view model and publish (throttled to ~10 Hz).
    const settings = hudStore.getState().settings;
    publishHud(
      hudPublisher,
      hudVm,
      boat.sim.state,
      boat.sim.state.controls,
      lastTrueWind,
      environment,
      snapshot,
      polar,
      t,
      settings.preset,
      settings.units,
      settings.opaqueBackdrop,
    );

    // Draw via the post chain (single output transform in the renderer).
    post.render();

    // Test hook + first-frame signal.
    if (!firstFrameRendered) {
      firstFrameRendered = true;
      onFirstFrame();
    }
    if (testHook !== undefined) {
      testHook.frames++;
      testHook.boatSpeedKnots = boat.sim.state.speed * MS_TO_KNOTS;
      testHook.heading = boat.sim.state.heading;
      testHook.tackCount = scratch.tackCount;
      testHook.gybeCount = scratch.gybeCount;
      testHook.maxHeelDeg = scratch.maxHeelDeg;
      testHook.capsized = scratch.capsized;
      testHook.backend = backend;
      testHook.weatherSource = snapshot.source;
    }
  }

  const loop: GameLoopHandle = createGameLoop(clock, { fixedUpdate, render }, 0);

  // ── Resize handling ──────────────────────────────────────────────────────
  const handleResize = (): void => {
    const w = opts.canvas.clientWidth;
    const h = opts.canvas.clientHeight;
    const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2);
    renderer.setSize(w, h);
    renderer.setPixelRatio(dpr);
    const a = h > 0 ? w / h : 16 / 9;
    cameraRig.resize(a);
  };

  // Attach input listeners.
  inputManager.attach();

  let disposed = false;

  return {
    get weatherSource() {
      return snapshot.source;
    },
    get backend() {
      return backend;
    },
    start(): void {
      handleResize();
      if (typeof window !== 'undefined') {
        window.addEventListener('resize', handleResize);
      }
      loop.start();
    },
    pause(): void {
      clock.pause();
      hudPublisher.flush();
    },
    resume(): void {
      clock.resume();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      loop.stop();
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', handleResize);
      }
      inputManager.dispose();
      hudPublisher.dispose();
      hudMounted.unmount();
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          /* best-effort teardown */
        }
      }
      post.dispose();
    },
  };
}

// ─── Scratch / per-frame state ───────────────────────────────────────────────

interface Scratch {
  driverControls: ControlState;
  assistPatch: Partial<ControlState>;
  lookDelta: { x: number; y: number };
  cameraFrame: CameraFrame;
  atmosphereFrame: AtmosphereFrame;
  noMarks: readonly Vec3[];
  noBoats: readonly Vec3[];
  zero: Vec3;
  tackCount: number;
  gybeCount: number;
  maxHeelDeg: number;
  capsized: boolean;
}

function createScratch(boatDef: BoatDefinition): Scratch {
  return {
    driverControls: {
      rudder: 0,
      mainsheet: 0.5,
      jibsheet: 0.5,
      spinnaker: 0,
      vang: 0.5,
      traveller: 0,
      board: 1,
      crewFore: 0,
      crewLateral: 0,
      hike: 0,
    },
    assistPatch: {},
    lookDelta: { x: 0, y: 0 },
    cameraFrame: {
      boatPosition: { x: 0, y: 0, z: 0 },
      boatOrientation: { x: 0, y: 0, z: 0, w: 1 },
      boatVelocity: { x: 0, y: 0, z: 0 },
      heel: 0,
      pitch: 0,
      heading: 0,
      slam: 0,
      geometry: {
        mastHeight: boatDef.rig.mastHeight,
        loa: boatDef.hull.loa,
        eyeOffset: { x: 0.2, y: 1.1, z: -0.3 },
      },
      time: 0,
      lookDelta: { x: 0, y: 0 },
      marks: [],
      otherBoats: [],
    },
    atmosphereFrame: {
      sky: {
        sunDirection: { x: 0, y: 1, z: 0 },
        sunElevation: 0,
        sunAzimuth: 0,
        moonDirection: { x: 0, y: 1, z: 0 },
        moonElevation: 0,
        moonPhase: 0,
        siderealTime: 0,
        cloudLow: 0,
        cloudMid: 0,
        cloudHigh: 0,
        isNight: false,
      },
      conditions: {
        cloudLow: 0,
        cloudMid: 0,
        cloudHigh: 0,
        visibility: 20000,
        precipitation: 0,
        wmoCode: 0,
        solarRadiation: 500,
        isDay: true,
      },
      wind: { x: 0, y: 0, z: 0 },
      dt: FIXED_TIMESTEP,
      timeSeconds: 0,
      camera: {
        position: { x: 0, y: 0, z: 0 },
        forward: { x: 0, y: 0, z: -1 },
        right: { x: 1, y: 0, z: 0 },
        up: { x: 0, y: 1, z: 0 },
        fovY: Math.PI / 3,
        aspect: 16 / 9,
      },
      latitude: 0,
      knobs: {} as QualityKnobs,
      rawGustIntensity: 0,
    },
    noMarks: [],
    noBoats: [],
    zero: { x: 0, y: 0, z: 0 },
    tackCount: 0,
    gybeCount: 0,
    maxHeelDeg: 0,
    capsized: false,
  };
}

// ─── Per-frame atmosphere frame fill ───────────────────────────────────────────

function updateAtmosphereFrame(
  frame: AtmosphereFrame,
  sky: ReturnType<Environment['skyAt']>,
  conditions: SkyConditions,
  environment: Environment,
  t: number,
  dt: number,
  pose: { position: Vec3; quaternion: { x: number; y: number; z: number; w: number } },
  camera: THREE.PerspectiveCamera,
  venue: VenueDefinition,
  knobs: QualityKnobs,
): void {
  frame.sky = sky;
  frame.conditions = conditions;
  // Air velocity from the mean wind (the bearing it comes FROM → velocity).
  const wind = environment.wind.sample(pose.position.x, pose.position.z, 10, t);
  frame.wind.x = wind.velocity.x;
  frame.wind.y = wind.velocity.y;
  frame.wind.z = wind.velocity.z;
  frame.dt = dt;
  frame.timeSeconds = t;

  // Camera basis from the pose quaternion (three camera looks down local -Z,
  // +Y up, +X right). Derive via pure quaternion rotation — no matrixWorld needed.
  const q = pose.quaternion;
  frame.camera.position.x = pose.position.x;
  frame.camera.position.y = pose.position.y;
  frame.camera.position.z = pose.position.z;
  rotateLocalAxis(q, 1, 0, 0, frame.camera.right);
  rotateLocalAxis(q, 0, 1, 0, frame.camera.up);
  rotateLocalAxis(q, 0, 0, -1, frame.camera.forward);
  frame.camera.fovY = camera.fov * (Math.PI / 180);
  frame.camera.aspect = camera.aspect;

  frame.latitude = venue.coordinates.latitude * (Math.PI / 180);
  frame.knobs = knobs;
  frame.rawGustIntensity = Math.max(0, wind.gustFactor - 1);
}

// ─── HUD publish ──────────────────────────────────────────────────────────────

function publishHud(
  publisher: HudPublisher,
  vm: HudViewModel,
  boatState: Parameters<typeof buildHudInput>[0]['boat'],
  controls: ControlState,
  trueWind: TrueWind,
  environment: Environment,
  snapshot: WeatherSnapshot,
  polar: PolarDiagram,
  t: number,
  preset: HudPreset,
  units: UnitSystem,
  opaqueBackdrop: boolean,
): void {
  // Apparent wind from the sampled wind velocity.
  const wind = environment.wind.sample(boatState.position.x, boatState.position.z, 5, t);
  const apparent = computeApparentWind(wind.velocity, boatState);

  // Current (direction it flows TOWARDS).
  const cur = environment.current.sample(boatState.position.x, boatState.position.z, t);
  const curSpeed = Math.hypot(cur.x, cur.y);
  const curTowards = curSpeed > 1e-5 ? bearingFromVec2(cur.x, cur.y) : 0;

  const input = buildHudInput({
    boat: boatState,
    controls,
    trueWind,
    apparentWind: apparent,
    current: { speed: curSpeed, towardsBearing: curTowards },
    visibility: snapshot.sky.visibility,
    weatherSource: snapshot.source,
    polar,
    nextMark: null,
    preset,
    units,
    opaqueBackdrop,
  });
  buildHudViewModel(input, vm);
  publisher.publish(vm);
}

/** Rotate a local axis by a quaternion into world space, writing into `out`. */
function rotateLocalAxis(
  q: { x: number; y: number; z: number; w: number },
  vx: number,
  vy: number,
  vz: number,
  out: Vec3,
): void {
  const tx = 2 * (q.y * vz - q.z * vy);
  const ty = 2 * (q.z * vx - q.x * vz);
  const tz = 2 * (q.x * vy - q.y * vx);
  out.x = vx + q.w * tx + (q.y * tz - q.z * ty);
  out.y = vy + q.w * ty + (q.z * tx - q.x * tz);
  out.z = vz + q.w * tz + (q.x * ty - q.y * tx);
}

/** Bearing (clockwise from north) of a ground-plane vector (x east, y south). */
function bearingFromVec2(x: number, y: number): number {
  // +Z is south, so a Vec2 (x east, y south) maps to world (x, 0, y).
  const b = Math.atan2(x, -y);
  return b < 0 ? b + Math.PI * 2 : b;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function aspectOf(canvas: HTMLCanvasElement): number {
  const w = canvas.clientWidth || 1280;
  const h = canvas.clientHeight || 720;
  return h > 0 ? w / h : 16 / 9;
}

function loadBindings(store: LocalStorageKeyValueStore): BindingMap {
  const raw = store.get('sailing.bindings.v1');
  if (raw !== null) {
    const parsed = BindingMap.fromJSON(raw);
    if (parsed !== null) return parsed;
  }
  return new BindingMap();
}

function isBoundCode(bindings: BindingMap, code: string): boolean {
  return bindings.actionForBinding({ kind: 'key', code }) !== null;
}

/** Fill a ControlState from a partial patch, defaulting from the current state. */
function fillControlState(
  out: ControlState,
  patch: Partial<ControlState>,
  current: ControlState,
): ControlState {
  out.rudder = patch.rudder ?? current.rudder;
  out.mainsheet = patch.mainsheet ?? current.mainsheet;
  out.jibsheet = patch.jibsheet ?? current.jibsheet;
  out.spinnaker = patch.spinnaker ?? current.spinnaker;
  out.vang = patch.vang ?? current.vang;
  out.traveller = patch.traveller ?? current.traveller;
  out.board = patch.board ?? current.board;
  out.crewFore = patch.crewFore ?? current.crewFore;
  out.crewLateral = patch.crewLateral ?? current.crewLateral;
  out.hike = patch.hike ?? current.hike;
  return out;
}

function addTerrainMesh(
  scene: THREE.Scene,
  mesh: Parameters<typeof toBufferGeometry>[0],
  disposables: Array<{ dispose(): void }>,
): void {
  const geometry = toBufferGeometry(mesh);
  const material = buildProceduralMaterial({
    kind: 'terrain',
    baseColor: { r: 0.42, g: 0.44, b: 0.47 },
    roughness: 0.95,
    metalness: 0,
  });
  const terrainMesh = new THREE.Mesh(geometry, material);
  scene.add(terrainMesh);
  disposables.push({
    dispose() {
      geometry.dispose();
      material.dispose();
      terrainMesh.removeFromParent();
    },
  });
}

function addLandmarks(
  scene: THREE.Scene,
  venue: VenueDefinition,
  disposables: Array<{ dispose(): void }>,
): void {
  const material = buildProceduralMaterial({
    kind: 'concrete',
    baseColor: { r: 0.55, g: 0.55, b: 0.57 },
    roughness: 0.9,
    metalness: 0,
  });
  let placed = 0;
  for (const spec of venue.landmarks) {
    const gen = getGenerator(spec.generator);
    if (gen === undefined) {
      logOnce(`landmark-${spec.generator}`, `[Session] landmark generator '${spec.generator}' not registered — skipped.`);
      continue;
    }
    try {
      const model = gen.generate(spec.params, 0);
      const group = new THREE.Group();
      for (const genMesh of model.meshes) {
        const geometry = toBufferGeometry(genMesh);
        const lmMesh = new THREE.Mesh(geometry, material);
        group.add(lmMesh);
        disposables.push({ dispose: () => geometry.dispose() });
      }
      group.position.set(spec.position.x, spec.position.y, spec.position.z);
      group.rotation.y = spec.rotation;
      group.scale.setScalar(spec.scale);
      scene.add(group);
      placed++;
    } catch (err) {
      logOnce(`landmark-fail-${spec.generator}`, `[Session] landmark '${spec.generator}' failed to build — skipped: ${String(err)}`);
    }
  }
  disposables.push({ dispose: () => material.dispose() });
  if (placed === 0) {
    logOnce('no-landmarks', '[Session] no landmarks were placed.');
  }
}

// ─── Water lighting sync across rings ──────────────────────────────────────────

/**
 * Copy the atmosphere-driven lighting uniforms (sun direction/colour, sky
 * colours, gust intensity) from the representative ring-0 water handle to every
 * other ring, since each ring's material owns its own uniform objects. The
 * atmosphere writes ring 0 by reference each frame; this fans those values out
 * so all rings light consistently.
 */
function syncWaterLighting(rings: readonly WaterMaterialResult[]): void {
  const src = rings[0];
  if (src === undefined) return;
  const su = src.uniforms;
  const sDir = su.sunDirection.value as { x: number; y: number; z: number };
  const sSun = su.sunColor.value as { r: number; g: number; b: number };
  const sSky = su.skyColor.value as { r: number; g: number; b: number };
  const sHor = su.skyHorizonColor.value as { r: number; g: number; b: number };
  const sGust = su.gustIntensity.value as number;
  for (let i = 1; i < rings.length; i++) {
    const r = rings[i];
    if (r === undefined) continue;
    const u = r.uniforms;
    const dDir = u.sunDirection.value as { x: number; y: number; z: number };
    dDir.x = sDir.x;
    dDir.y = sDir.y;
    dDir.z = sDir.z;
    const dSun = u.sunColor.value as { r: number; g: number; b: number };
    dSun.r = sSun.r;
    dSun.g = sSun.g;
    dSun.b = sSun.b;
    const dSky = u.skyColor.value as { r: number; g: number; b: number };
    dSky.r = sSky.r;
    dSky.g = sSky.g;
    dSky.b = sSky.b;
    const dHor = u.skyHorizonColor.value as { r: number; g: number; b: number };
    dHor.r = sHor.r;
    dHor.g = sHor.g;
    dHor.b = sHor.b;
    (u.gustIntensity as { value: unknown }).value = sGust;
  }
}

// ─── Water lighting sync end ────────────────────────────────────────────────────

// ─── A WeatherService backed by the venue Environment's snapshot ───────────────

/**
 * The venue environment owns its own WeatherService internally but does not
 * expose it. We only need `snapshot`, `sampleAt`, and `timeCompression` for the
 * render loop, all derivable from the environment's snapshot via a fresh
 * WeatherServiceImpl. This keeps HUD conditions + skyAt consistent.
 */
import { WeatherServiceImpl } from '@weather/WeatherService';

class WeatherServiceFromEnv implements WeatherService {
  private readonly impl: WeatherServiceImpl;
  constructor(env: Environment) {
    this.impl = new WeatherServiceImpl(env.snapshot, 4000);
  }
  get snapshot(): WeatherSnapshot {
    return this.impl.snapshot;
  }
  get timeCompression(): number {
    return this.impl.timeCompression;
  }
  set timeCompression(v: number) {
    this.impl.timeCompression = v;
  }
  sampleAt(time: number): ReturnType<WeatherService['sampleAt']> {
    return this.impl.sampleAt(time);
  }
}

// ─── One-shot logging ──────────────────────────────────────────────────────────

const _logged = new Set<string>();
function logOnce(key: string, message: string): void {
  if (_logged.has(key)) return;
  _logged.add(key);
  console.warn(message);
}
