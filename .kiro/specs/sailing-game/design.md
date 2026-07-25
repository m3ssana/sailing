# Design — Live Weather 3D Sailing Simulator

## 1. Technology choices

| Concern | Choice | Why |
|---|---|---|
| Renderer | **three.js `WebGPURenderer`** (`three/webgpu`) | WebGPU backend primary, automatic WebGL2 backend fallback from the same renderer class. One renderer, two backends. |
| Shading | **TSL** (`three/tsl`) | Node-based shading compiles to *both* WGSL and GLSL. Without it we'd maintain two shader codebases. Non-negotiable given the dual-backend requirement. |
| GPU compute | **TSL compute** — `Fn(...).compute(n)`, `instancedArray`, `renderer.compute()` | Ocean FFT, spray, foam accumulation. WebGPU only; §2.2 covers the fallback. |
| Language / build | **TypeScript strict + Vite** | Fast HMR, native ESM, code-splitting, bundle budgets. |
| Rigid-body / collision | **Rapier3D** (Rust→WASM) | Deterministic fixed-step, good CCD. Collision and constraints *only*; sailing forces are ours. |
| Post-processing | three.js `PostProcessing` + TSL passes | Node-based post works across both backends; avoids the WebGL-only `EffectComposer` ecosystem. |
| State / UI | **Zustand + React** | UI is a thin overlay; React never touches the render loop. ~45 KB gzipped against a 5 MB budget. |
| Noise | Seeded simplex, CPU (`simplex-noise`) and TSL (procedural) | Gusts, clouds, terrain relief, all materials. Must be seedable for determinism. |
| Content | **100% procedural** | No glTF, no textures, no audio files. See §8. |
| Art direction | **Stylized realism** | PBR lighting, simplified forms, curated palettes. Fidelity concentrated in water/sky/light. See §8.7. |
| Replay | **Inputs + 1 Hz state checkpoints** | Float results are not bit-identical across machines; checkpoints make replays portable. See §12.2. |
| Storage | **IndexedDB** (`idb`) | Weather cache, replays, settings, cached generated geometry. |
| Tests | **Vitest** + Playwright | Headless generator/physics tests; Playwright for smoke and local visual/perf gates. |
| Backend | **None** | v1 is fully client-side. Daily Challenge is date-seeded; leaderboards are local; sharing is via replay codes. |
| Distribution | **GitHub Pages** via Actions on merge to `main` | Continuous live build; MIT licensed; no telemetry of any kind. |

**Deliberate non-choices:** no game engine, no off-the-shelf boat physics, no art pipeline. Sailing
dynamics and generated content *are* the product.

---

## 2. Rendering backend strategy

### 2.1 One renderer, two backends

```ts
// render/Renderer.ts
import * as THREE from 'three/webgpu';

export async function createRenderer(canvas: HTMLCanvasElement) {
  const webgpuAvailable = typeof navigator !== 'undefined' && 'gpu' in navigator;

  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: false,          // TAA handles this; MSAA is expensive on the ocean
    forceWebGL: !webgpuAvailable,
  });

  await renderer.init();

  const backend: 'webgpu' | 'webgl2' = renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';

  if (backend === 'webgpu') {
    // Recover from GPU resets — common on thermally throttling laptops.
    renderer.backend.device.lost.then(handleDeviceLoss);
  }

  return { renderer, capabilities: probeCapabilities(renderer, backend) };
}
```

`await renderer.init()` before any `renderer.compute()` or first render. Device-loss recovery matters
specifically because the reference target is a laptop that will throttle and occasionally reset the
GPU driver.

### 2.2 The compute gap

TSL compute shaders exist only on the WebGPU backend. Three features depend on compute, and each needs
a designed fallback — not a disabled feature (req 7.13).

| Feature | WebGPU path | WebGL2 fallback |
|---|---|---|
| Ocean spectrum → surface | Compute IFFT over storage buffers, 3 cascades, 256² | Ping-pong render-target IFFT via TSL fullscreen passes, 2 cascades, 128²; on Low, drop to a 32-component Gerstner sum evaluated directly in the vertex shader |
| Foam accumulation | Compute pass over a persistent storage texture | Ping-pong render targets (foam is already a texture-space accumulation, so this is a clean substitution) |
| Spray particles | `instancedArray` positions/velocities updated in compute, `PointsNodeMaterial.positionNode` reads the buffer | CPU-simulated pool writing into an `InstancedBufferAttribute`, budget reduced ~8× |
| Volumetric clouds | Quarter-res TSL raymarch (fragment, works on both) | Same shader, fewer steps; billboard cumulus on Low |

Cloud and water *shading* need no fallback at all — TSL fragment shading compiles to GLSL
transparently. Only the compute-driven simulation steps split.

`GPUCapabilities` is probed once and injected into every renderer subsystem, so no subsystem sniffs
the backend itself:

```ts
interface GPUCapabilities {
  backend: 'webgpu' | 'webgl2';
  compute: boolean;
  storageTextures: boolean;
  timestampQueries: boolean;     // GPU-side profiling where available
  maxTextureSize: number;
  float32Filterable: boolean;
}
```

### 2.3 TSL discipline

- Every shader is a TSL node graph in `.ts` files. No `.glsl`/`.wgsl` files anywhere.
- Shared TSL helpers (noise, spectrum evaluation, water optics, tonemap) live in `render/tsl/` and are
  imported by node materials — the shader equivalent of shared functions.
- `Fn()` node functions are defined at module scope, not per frame, so the node graph compiles once.
- Uniforms are created once via `uniform()` and mutated by `.value` assignment. Never rebuild a node
  graph in the render loop.

---

## 3. High-level architecture

```
┌───────────────────────────────────────────────────────────────────┐
│                            App Shell                              │
│   scene routing · generation phase · settings · save/load         │
└───────────────┬───────────────────────────────┬───────────────────┘
                │                               │
     ┌──────────▼──────────┐        ┌───────────▼────────────┐
     │   UI Layer (React)  │        │  Game Loop (rAF)       │
     │  menus · HUD · map  │◄──────►│  fixed-step accumulator│
     └─────────────────────┘  state └───────────┬────────────┘
                                                │
   ┌────────────────────────────────────────────▼──────────────────┐
   │                        World  (ECS-lite)                      │
   │  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐   │
   │  │  Simulation  │◄─┤  Environment │  │      Rules         │   │
   │  │ aero · hydro │  │ WindField    │  │ start · marks      │   │
   │  │ rigid body   │◄─┤ WaveField    │  │ right-of-way       │   │
   │  │ foils·capsize│  │ CurrentField │  │ scoring            │   │
   │  └──────┬───────┘  │ SkyState     │  └────────────────────┘   │
   │         │          └──────▲───────┘                           │
   │  ┌──────▼───────┐  ┌──────┴────────┐  ┌───────────────────┐   │
   │  │  AI Fleet    │  │ WeatherService│  │  Replay Recorder  │   │
   │  └──────────────┘  └──────▲────────┘  └───────────────────┘   │
   └───────────────────────────┼───────────────────────────────────┘
                               │ (worker + IndexedDB)
                    ┌──────────┴──────────┐
                    │  Open-Meteo APIs    │
                    └─────────────────────┘

   ┌───────────────────────────────────────────────────────────────┐
   │              Generation Layer  (workers, load-time)           │
   │  HullLofter · RigBuilder · SailSurface · TerrainBuilder        │
   │  LandmarkGenerators · SpectrumTables · PolarSolver             │
   │        outputs: ArrayBuffers + derived physics parameters      │
   └───────────────────────────┬───────────────────────────────────┘
                               │
   ┌───────────────────────────▼───────────────────────────────────┐
   │                Render Layer (three.js / TSL)                  │
   │  Ocean · Sky · BoatView · SailCloth · Spray · Terrain          │
   │  Reflections · PostFX · AdaptiveQuality                        │
   └───────────────────────────────────────────────────────────────┘
```

**The critical boundary:** `Simulation`, `Environment`, `Weather`, and the geometry generators know
nothing about three.js. They produce plain numbers and `ArrayBuffer`s; `Render` consumes them. This is
what makes physics headlessly testable (req 11.3), golden-run regression possible (req 11.4), and
generators unit-testable without a GPU (req 9.8).

---

## 4. Weather pipeline

### 4.1 Requests

Two endpoints, both keyless. Venue browser uses **one multi-coordinate call** for all 12 venues
(Open-Meteo accepts comma-separated lat/lon lists), satisfying the batching requirement (req 2.7).

```
GET https://api.open-meteo.com/v1/forecast
  ?latitude=41.49&longitude=-71.31
  &current=wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,
           pressure_msl,cloud_cover,visibility,precipitation,weather_code,is_day
  &minutely_15=wind_speed_10m,wind_direction_10m,wind_gusts_10m
  &hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,
          pressure_msl,cloud_cover_low,cloud_cover_mid,cloud_cover_high,
          visibility,precipitation,weather_code,shortwave_radiation
  &wind_speed_unit=kn&timezone=auto&past_hours=1&forecast_hours=12

GET https://marine-api.open-meteo.com/v1/marine
  ?latitude=41.49&longitude=-71.31
  &current=wave_height,wave_direction,wave_period,swell_wave_height,
           swell_wave_direction,swell_wave_period,ocean_current_velocity,
           ocean_current_direction,sea_surface_temperature,sea_level_height_msl
  &hourly=wave_height,wave_direction,wave_period,wind_wave_height,
          wind_wave_direction,wind_wave_period,swell_wave_height,
          swell_wave_direction,swell_wave_period,ocean_current_velocity,
          ocean_current_direction,sea_level_height_msl
  &cell_selection=sea&timezone=auto&past_hours=1&forecast_hours=12
```

`minutely_15` gives native 15-minute wind resolution in North America and Central Europe, interpolated
elsewhere — enough to seed gust structure, with the synthetic gust layer (§5.3) supplying finer detail.

### 4.2 Normalization

Raw responses convert once into an engine-native snapshot. Everything downstream is SI plus degrees
true; unit conversion never leaks into physics.

```ts
interface WeatherSnapshot {
  fetchedAt: number;
  source: 'live' | 'cache' | 'climatology' | 'default' | 'sandbox';
  venueId: string;
  localTime: { iso: string; utcOffsetSeconds: number };

  wind: {
    trueSpeed: number;        // m/s at 10 m
    trueDirection: number;    // deg FROM, meteorological
    gustCeiling: number;      // m/s
    stability: number;        // 0..1, derived
  };
  sea: {
    significantHeight: number; dominantPeriod: number; dominantDirection: number;
    swell: { height: number; period: number; direction: number };
    windWave: { height: number; period: number; direction: number };
    surfaceTemp: number; tideHeight: number;
  };
  current: { speed: number; direction: number };   // direction TOWARDS
  sky: {
    cloudLow: number; cloudMid: number; cloudHigh: number;
    visibility: number; precipitation: number; wmoCode: number;
    solarRadiation: number; isDay: boolean;
  };
  air: { temperature: number; pressure: number; density: number };
  timeline: WeatherKeyframe[];
}
```

`air.density` is computed from `pressure_msl` and `temperature_2m` rather than assumed at 1.225,
because a cold high-pressure day genuinely delivers more drive at the same wind speed — a detail that
rewards players who notice it.

`wind.stability` is derived, not fetched: `clamp((gustCeiling − trueSpeed) / trueSpeed)` blended with
the air/sea temperature delta. Gusty offshore breeze over cold water → unstable → big oscillations and
hard puffs. Steady sea breeze over warm water → stable → smooth.

### 4.3 Evolution during play

`WeatherService` holds the keyframe timeline and exposes `sampleAt(sessionTime)`. Interpolation is
**not** naive lerp:

- **Direction** — shortest-arc circular interpolation (350° → 10° must cross 0°, not sweep back through 180°).
- **Speed** — Catmull-Rom for smooth build/die rather than piecewise-linear kinks.
- **Wave height** — lagged behind wind by a venue-specific time constant, so the sea builds *after* the
  breeze, as it actually does.

Session clock supports 1×–60× time compression (default 8×), so an hour of forecast evolution plays out
in a race-length session (req 2.4).

### 4.4 Resilience and caching

```
request → memory cache (session)
        → IndexedDB cache (TTL 15 min)   ── stale-while-revalidate
        → network (5 s timeout, 2 retries, exponential backoff, AbortController)
        → stale IndexedDB entry of any age
        → bundled per-venue seasonal climatology (12 months × 8 direction bins)
        → hard default: 12 kt onshore, 0.4 m chop
```

The HUD conditions panel always names the active source. Runs in a **Web Worker**, so fetch, parse, and
normalization never touch the frame budget.

---

## 5. Wind field

The single most important system for making the game feel like sailing. Layered, sampled by everything:

```ts
interface WindField {
  sample(x: number, z: number, height: number, t: number): WindSample;
  /** Cheap grid sample feeding the water-surface gust visualization. */
  sampleGridInto(target: Float32Array, origin: Vec2, cellSize: number, t: number): void;
}
```

**5.1 Base** — live forecast speed/direction from `WeatherService.sampleAt(t)`, uniform in space.

**5.2 Oscillation** — three incommensurate sinusoids (~40 s / 130 s / 420 s) plus low-frequency simplex
noise. Amplitude scales with `wind.stability`: ±3° on a stable sea breeze, ±20° on an unstable
offshore. Phase seeded from `hash(venueId, fetchedAt, seed)` → deterministic (req 3.7).

**5.3 Gusts** — 2D simplex field advecting downwind at ~1.2× mean wind speed, sampled in a
**wind-aligned frame** so puffs elongate along the wind and stay coherent across it, which is what makes
them readable. Magnitude mapped to `[trueSpeed × 0.8, gustCeiling]`. Gusts carry a small direction bias
(veer in the puff, back in the lull) because that's the shift pattern players actually learn.

The same field is written to a small `DataTexture` consumed by the ocean shader to darken and ruffle
the surface — **you see the puff before you feel it** (req 3.4). Shared sampling is what makes the
visual honest rather than decorative.

**5.4 Terrain** — per venue, a generated 512×512 RG influence field over the sailable area:
R = speed multiplier (0.15 deep lee → 1.35 gap acceleration), G = direction bias ±45°. Generated at
load from the venue's coastline polylines and relief by a diffusion/advection approximation, so a new
venue needs no hand-painted map and no code (req 3.5).

**5.5 Vertical gradient** — power law `v(h) = v₁₀ · (h/10)^α`, α ≈ 0.11 offshore to 0.20 in built-up
harbours. Sails sample at their centre-of-effort height, so a tall rig genuinely sees more wind and
masthead apparent wind differs from deck level (req 3.6).

---

## 6. Wave field

### 6.1 Spectrum

JONSWAP for wind sea, parameterized by fetch and wind speed, superposed with a narrow-band swell from
the marine API. Directional spreading via `cos^{2s}(θ/2)`.

| Cascade | Patch | Res (WebGPU) | Res (WebGL2) | Represents |
|---|---|---|---|---|
| 0 | 2048 m | 256² | 128² | swell, long ocean waves |
| 1 | 256 m | 256² | 128² | wind sea — the waves the boat sails through |
| 2 | 32 m | 256² | *dropped* | chop and capillary detail |

### 6.2 The GPU/CPU coherence problem

Req 4.12 demands the boat sit in the waves you *see*, within 5 cm. This is the hard problem in any
sailing sim and it drives the design.

- **Rendering** uses a full IFFT ocean (Tessendorf). On WebGPU: a TSL compute pass over storage
  buffers, Stockham butterflies, log₂256 = 8 stages per cascade per component. On WebGL2: the same
  butterfly math as TSL fullscreen ping-pong render-target passes at reduced resolution. Outputs
  displacement, derivative/normal, and Jacobian (folding → foam).
- **Physics** cannot read those every frame without a stalling GPU→CPU readback. Instead the CPU
  evaluates a **truncated Gerstner reconstruction of the same spectrum** — the ~24 highest-energy
  components with identical amplitudes, wavenumbers, directions, and phases as the GPU cascades. Those
  components carry >95% of the variance, so the boat matches the rendered surface well inside 5 cm at
  boat scale, while the GPU's remaining thousands of components supply detail finer than the hull can
  respond to.

One `WaveSpectrum` object owns the parameters and derives both paths. A unit test samples random points
and asserts CPU height against a full-spectrum CPU reference within 5 cm — a CI gate, not a hope.

```ts
interface WaveField {
  height(x: number, z: number, t: number): number;
  displacement(x: number, z: number, t: number): Vec3;
  normal(x: number, z: number, t: number): Vec3;
  orbitalVelocity(x: number, z: number, y: number, t: number): Vec3;
}
```

### 6.3 Current–wave interaction

Where current opposes wind, wavelength shortens and steepness rises
(`k' = k / (1 − 2·U·ω/g)²`, clamped). This produces the venue-characteristic nastiness of an ebb tide
against a sea breeze in San Francisco Bay, straight from live current data (req 4.10).

---

## 7. Boat physics

### 7.1 Structure

Force generators are independent, each producing `{force, applicationPoint}`. The integrator sums them.
A new appendage is a new generator, not an integrator edit.

```
Per fixed step (1/120 s):
  1. sample environment at hull reference points
  2. AeroForce       × sails             → drive + heel + yaw
  3. HydroResistance × hull              → friction, wave-making, added-in-waves
  4. FoilLift        × keel/board/rudder → side force, induced drag
  5. Buoyancy        × N hull points against WaveField
  6. WaveDrag        × orbital velocity relative to hull
  7. RightingMoment  × ballast + crew position
  8. FoilFlight      × foiling boats     → lift, ride-height control
  9. sum → semi-implicit Euler (RK4 angular) → integrate
 10. Rapier step for collision resolution
 11. record replay frame
```

Semi-implicit Euler at 120 Hz is stable for these force magnitudes; angular dynamics get RK4 because
roll near capsize is the stiffest term. Fixed step decoupled from render, with render-side interpolation
of position and orientation (req 4.1).

### 7.2 Geometry-derived parameters

Because hulls are generated (§8.2), the physics parameters that *can* be derived from geometry are
derived, not authored:

| Parameter | Source |
|---|---|
| Displacement / volume | numerical integration of the generated hull below the design waterline |
| Wetted surface area | triangle-area sum of submerged faces at design trim |
| Waterplane area, LCF | waterline slice of the generated mesh |
| Buoyancy sample points | evenly distributed along the generated hull's length, volume-weighted |
| Centre of buoyancy | volume centroid of the submerged region |
| Righting curve | volume centroid recomputed across a heel sweep at load |

This closes the most common source of simulator wrongness: a hull that looks like one boat and behaves
like another. Change a station curve and both the visuals and the physics move together (req 9.1).

### 7.3 Aerodynamics

```
V_apparent = V_trueWind(CoE position, height, t) − V_boat − ω × r_CoE
α = angle_of_attack(V_apparent, sail chord from trim)
L = ½ ρ_air A V_a² C_L(α, camber)
D = ½ ρ_air A V_a² C_D(α, camber, AR)
```

`C_L(α)` from a tabulated thin-cambered-airfoil curve: linear rise to ~15–20°, rounded peak, post-stall
decay. `C_D(α)` = parasitic + induced (`C_L²/πAR`) + a separation term climbing steeply once stalled.
Resolve into boat axes → drive, side force, heeling and yaw moments.

Two failure modes must be **visible**, not merely numeric (req 4.3):
- **Over-eased → luffing.** α below attachment; force collapses; luff flutters, windward telltale streams forward.
- **Over-trimmed → stall.** α past separation; drag spikes, drive falls, heel stays high; leeward telltale swirls.

That asymmetry — over-trimming *feels* fast because you heel more — is the central skill of sailing, and
the model has to reproduce it faithfully. Main and headsail modify each other's effective angle (slot
effect), so they must be trimmed together.

### 7.4 Hydrodynamics

```
R_total     = R_friction + R_residuary + R_induced + R_waves + R_appendage
R_friction  = ½ ρ_w S V² C_f,   C_f from the ITTC-57 line
R_residuary = f(Froude number),  rising steeply as Fn → 0.4
R_induced   = (side force)² / (½ ρ_w V² π draft² e)
R_waves     ∝ H_s² · f(encounter frequency, heading)
```

`R_residuary` is what gives displacement boats a hull-speed ceiling and lets planing and foiling boats
break through it (req 4.4). Foils use the same lift/drag machinery as sails with water density and a
symmetric-section `C_L(β)` in leeway angle. Effective aspect ratio falls with immersion, so a
half-raised board loses grip, and foils stall at low speed — which is why the boat won't point in irons
(req 4.5, 4.7).

### 7.5 Polars, derived

Each boat's polar (req 5.2) is **computed**, not authored: on load, `polar.worker` sweeps TWA × TWS,
converging each cell to steady state, and caches the table in IndexedDB. The HUD target-speed readout
therefore always reflects the actual model. Change a drag coefficient and the target updates itself.

### 7.6 Crew, helm feel, and physics LOD

**Crew.** The player is always the helm (req 5.4a). Additional crew are AI-operated agents whose only
physical effect is where their mass sits and which lines they are working. A command layer (hike / ease,
hoist, douse, move fore, move aft) issues intents; the crew agent executes with a competence and reaction
delay set by assist level. Crucially, AI crew mass applies the *same* righting moment as player-moved
mass — there is no separate code path, so a well-crewed boat is faster for real physical reasons.

**Helm feel** (req 5.7). Rudder hydrodynamic moment is already computed by `FoilLift`; the tiller force
the player feels is that moment plus the sail-plan imbalance about the boat's vertical axis. It is
exported as a normalized `helmLoad` value consumed by the input layer for gamepad rumble and steering
resistance. Weather helm building as the boat becomes overpowered therefore emerges from the existing
force model rather than being faked — de-powering the rig genuinely lightens the helm.

**Physics LOD** (req 8.13). Boats are tiered by distance and relevance:

| Tier | Condition | Rate | Model |
|---|---|---|---|
| 0 | Player boat | 120 Hz | Full force model, all buoyancy points |
| 1 | Within 150 m, or tactically relevant | 120 Hz | Full model, reduced buoyancy points |
| 2 | 150–600 m | 30 Hz | Simplified: polar-driven speed with wave heave overlay |
| 3 | Beyond 600 m | 10 Hz | Kinematic along a planned track |

Promotion and demotion blend over ~0.5 s so there is no visible position or speed pop. Ambient traffic
(ferries, moored boats) never rises above tier 3.

---

## 8. Procedural content generation

No art pipeline. Every mesh, material, and sound is synthesized. This is a hard constraint that turns
out to be a design advantage: the payload is tiny, content is diffable and reviewable as code, and
§7.2's geometry-derived physics becomes possible.

### 8.1 Generation phase

On venue/boat entry, generators run in workers and transfer `ArrayBuffer`s back (req 9.9):

```ts
interface GeneratedMesh {
  positions: Float32Array; normals: Float32Array; uvs: Float32Array;
  indices: Uint32Array;
  meta: Record<string, number>;   // computed volume, area, centroid, …
}
interface Generator<P> {
  generate(params: P, seed: number): GeneratedMesh | GeneratedMesh[];
}
```

Every generator is pure and deterministic in `(params, seed)`, so it is unit-testable with no GPU
(req 9.8) and its output is cacheable in IndexedDB (req 8.12). Target: full venue + boat generation
under 3 s on the reference machine, behind a progress indicator.

### 8.2 Hulls — parametric lofting

The boat definition carries a table of **station curves**: at each of ~14 stations along the length, a
half-breadth curve as control points (chine or round-bilge). The lofter:

1. Resamples each station curve to a common number of points via Catmull-Rom.
2. Interpolates longitudinally between stations to the target resolution.
3. Mirrors to port, welds the centreline, caps transom, generates deck and sheerline.
4. Computes volume, wetted surface, waterplane, centroids, buoyancy points (§7.2).

Hull *class* differences come entirely from the station table — a flat-bottomed skiff, a round-bilge
keelboat, and a slender catamaran demihull are the same generator with different numbers.

### 8.3 Rig and sails

Rig: mast and boom as swept tapered tubes along a spline; spreaders, shrouds, and running rigging as
thin extruded lines. All from rig parameters (req 9.2).

Sails: parametric surface from luff, foot, and leech lengths plus luff round and broadseam, producing a
quad grid that **is** the cloth simulation grid (§9.4) — no separate sim mesh, so simulated shape and
rendered shape are identical by construction (req 9.3).

### 8.4 Terrain and landmarks

Per venue, hand-simplified **coastline and depth-contour polylines** as JSON — a few KB each, derived
from open data (OpenStreetMap coastlines, published chart contours) with attribution carried in the
venue definition and shown in credits (req 9.4). The terrain builder:

1. Rasterizes coastline polylines into a land/water mask over the venue bounds.
2. Builds a signed-distance field from the coast; drives inland elevation from a per-venue relief
   profile plus layered ridged noise.
3. Builds bathymetry inward from depth contours, interpolated and smoothed.
4. Emits the render mesh, the collision heightfield, and the depth field used by water shading, wave
   shoaling, and grounding.

Landmarks are **parametric generators** targeting recognizable silhouettes, not photographic accuracy
(req 9.5): a suspension-bridge generator (towers, catenary main cable, hangers, deck) covers the Golden
Gate and the Verrazzano; a shell-vault generator covers the Opera House; a ridge-plateau generator
covers Table Mountain; a curtain-wall skyline generator with parameterized height distribution covers
Hong Kong and Chicago. Each is configured per venue.

### 8.5 Materials

All TSL procedural shading (req 9.6). Gelcoat with flake and orange-peel, anodized alloy spars,
carbon weave from a rotated-checker basis, sailcloth with visible panel seams and scrim, wood decking
from banded noise, wet-surface darkening driven by a spray/wetness mask, terrain colour by
slope/altitude/distance-from-water. Where a genuine texture is needed — foam accumulation, spectrum
data, environment probe — it is rendered or computed into a render target, never loaded.

### 8.6 Audio

Web Audio synthesis only (req 9.7). Wind in rig = filtered noise bank whose band centres and Q track
apparent wind speed, plus a resonant whistle on standing rigging above a threshold. Hull through water
= noise through a lowpass whose cutoff and gain track speed, plus bubble grains on wake intensity.
Slams = enveloped noise burst filtered by impact energy. Ambience = layered noise beds, gull grains,
distant surf. Because everything is synthesized, a 25 kt gust *continuously* differs from 12 kt rather
than switching clips.

No music during sailing. Menus get subtle procedurally generated ambient pads.

### 8.7 Art direction — stylized realism

**This section is normative.** With dozens of agents generating content independently, an art direction
that isn't written down precisely becomes dozens of art directions. `docs/art-direction.md` is a Phase 0
deliverable and every generator and material agent works against it.

The target is *stylized realism*: convincing light and water, deliberately simplified everything else.
Nearest reference points are Sea of Thieves for water and palette confidence, and modern sailing
broadcast graphics for UI. Explicitly **not** photoreal, and explicitly **not** cel-shaded.

**Rules**

| Aspect | Direction |
|---|---|
| Lighting | Fully physically based. HDR, ACES, IBL, energy-conserving materials. Stylization never comes from breaking PBR. |
| Form | Silhouette-first. Clean chamfered geometry. No micro-detail. A shape must read at 2 km against sky. |
| Surface | No grunge, wear, dirt, or rust noise. Broad regions of confident colour. Restrained roughness variation. |
| Palette | 5–7 curated colours per venue, enforced by a procedural colour grade so no venue drifts off-palette. |
| Where fidelity goes | Water, foam, spray, sky, volumetrics, and light. These keep full effort. Everything else is simpler on purpose. |
| Proportion | Gentle heightening allowed for readability — slightly fuller sails, more generous spray, visually amplified heel. **Physics stays unexaggerated.** |
| Silhouette separation | Subtle rim lighting and aerial perspective. No outlines, no toon ramps. |
| Typography / UI | Nautical-instrument language: high contrast, thin strokes, monospace numerics, restrained colour. |

**Why this is the right call for a procedural project.** Procedural geometry cannot compete with
authored art on detail, but it competes very well on *form and consistency*. Photorealism would put
every generator in a race it cannot win; stylization plays to exactly what generators are good at —
clean, parameterized, coherent shapes — while the fidelity budget concentrates on the ocean and sky,
which are simulation-driven and where procedural techniques genuinely beat authored assets.

The practical consequence: a stylized target *raises* the achievable quality ceiling here rather than
lowering it.

---

## 9. Rendering

### 9.1 Pipeline

```
shadow pass (CSM cascades)
  → reflection RT (half-res, alternating-frame)
  → refraction RT (half-res)
  → opaque forward (HDR float RT)
  → ocean (needs opaque depth + refraction)
  → transparent: sails, spray, rain
  → post: TAA → bloom → motion blur → DoF → LUT grade → ACES → sRGB
```

HDR float targets throughout, ACES filmic tonemap at the end. IBL from a PMREM-filtered cubemap of the
procedural sky, regenerated only when the sun moves past a threshold or cloud cover changes materially
— not per frame.

### 9.2 Ocean

Vertex: sample cascade displacement, with per-cascade distance fade so distant water flattens instead
of aliasing into noise.

Fragment (all TSL, both backends):
- **Reflection** — screen-space march against opaque depth; miss → sky cubemap; Fresnel-weighted.
- **Refraction** — refraction RT sampled with normal-based offset, attenuated by Beer-Lambert
  absorption over the generated depth field. Per-venue water colour and turbidity: Newport green-grey,
  Palma clear blue, Guanabara murkier.
- **Subsurface scattering** — thin-crest approximation: where the surface is high and the sun behind it,
  add scattered light. This is what makes a breaking wave glow and does more for the look of the ocean
  than anything except foam.
- **Foam** — Jacobian of displacement detects folding → foam mask, accumulated in a persistent buffer
  with decay so wakes and whitecap trails persist; blended with wake foam injected along boat paths.
  Coverage floor rises with wind speed (whitecaps from ~12 kt, per Beaufort).
- **Sun glitter** — GGX against the small-cascade slope distribution, roughness driven by wind speed.
  Feeds bloom.
- **Gust visualization** — the wind field's gust texture darkens and roughens the surface where puffs
  are (§5.3).

### 9.3 Sky and weather

Rayleigh + Mie atmosphere. Sun position from real latitude/longitude and venue local time via a
standard solar-position algorithm, so a morning session in Sydney has a low easterly sun while it's
night in Newport (req 7.6).

Clouds: two raymarched layers (cumulus low, cirrus high) with coverage mapped from
`cloud_cover_low/mid/high`, quarter-resolution with temporal reprojection and blue-noise offset.
Rain from `precipitation` and `weather_code`: instanced streaks, surface ring disturbance, cockpit lens
droplets. Aerial perspective density from live `visibility`, so a foggy Solent morning genuinely limits
how far you can see the next mark (req 7.7).

**Night** (req 7.17). Because sessions run on the venue's real local time, roughly half of all venues are
dark at any moment, so night is a first-class state rather than an edge case. The same solar-position
machinery yields lunar position and phase; a procedural star field is generated from a compact catalogue
of bright stars plus statistical filler, correctly oriented for the venue's latitude and sidereal time.
Moonlight drives a dimmed, cool-shifted version of the sun path including its own specular glitter track
on the water. Navigation lights (red/green/white, correct arcs) render on the player's boat, the AI fleet,
and ambient traffic; shorelines carry procedural lit windows and harbour lighting. Night deliberately
raises difficulty: gust patches on the water are far harder to read, which is exactly true to life.

### 9.4 Sails

Position-based-dynamics cloth on the generated sail grid (~12×18), constrained at luff, head, tack, and
clew, loaded by the aerodynamic pressure the physics module already computed. Not decorative animation
— same pressure field, so draft position and twist read correctly and luff flutter appears exactly when
the aero model reports under-attachment (req 7.8). Double-sided with translucency and backlit scatter.

### 9.5 Adaptive quality

```ts
interface QualityKnobs {
  renderScale: number;        // 0.6 .. 1.0
  oceanCascades: 1|2|3;
  oceanResolution: 128|256;
  oceanGridRings: number;
  reflectionScale: number;    // 0 (sky only) .. 1.0
  reflectionCadence: 1|2|3;   // frames between updates
  shadowCascades: 1|2|3|4;
  cloudMarchSteps: number;
  sprayBudget: number;
  taa: boolean; motionBlur: boolean; dof: boolean;
}
```

Driven by a rolling 30-frame **median** frame time — median, not mean, so one GC spike can't trigger a
downgrade. Over budget for 45 consecutive frames → step down the cheapest-impact knob first
(renderScale → reflection cadence → cloud steps → spray → cascades). Under 70% of budget for 180 frames
→ step back up. Asymmetric thresholds provide the hysteresis req 8.3 demands.

**Laptop-specific** (req 8.1a): sustained frame-time drift with unchanged scene complexity is treated as
thermal throttling and triggers a quality step-down rather than dropped frames; a user frame cap
(30/60/120/uncapped) limits power draw; VRAM use is held under 4 GB.

---

## 10. Performance strategy

**Ocean geometry** — camera-centred concentric-ring clipmap, 8 rings × 64×64 quads, doubling cell size
outward. Fixed ~65k triangles regardless of view distance (req 8.4). Vertex snapping prevents swimming.

**Instancing** — fleet boats, marks, buildings, birds, spray, rain via instanced draws with per-instance
attributes written from preallocated `Float32Array`s (req 8.5). On WebGPU, spray positions live in
`instancedArray` storage buffers and are read directly by `PointsNodeMaterial.positionNode`, so the CPU
never touches particle state.

**Workers**
- `weather.worker` — fetch, parse, normalize, cache
- `spectrum.worker` — spectrum tables, wave component precomputation
- `geometry.worker` — hull lofting, rig, sails, terrain, landmarks (pool of N)
- `polar.worker` — headless polar sweeps on boat load
- `tactics.worker` — AI tactical planning at 4 Hz (steering stays on the main thread at sim rate)

Physics stays on the main thread: 120 Hz for ~10 boats costs well under the 4 ms budget, and worker
round-trip latency would hurt control feel more than it would help throughput.

**Zero-allocation hot path** — module-scope scratch `Vector3`/`Quaternion`/`Matrix4`, particle and
audio-voice pools, no array literals or closures inside step or render (req 8.8). A dev-build assertion
samples memory growth over 600 idle frames and fails loudly on sustained climb.

**Payload** — no binary assets at all, so the 5 MB gzipped budget (req 8.7) is almost entirely code plus
venue/boat JSON. Route-level code splitting keeps generators out of the menu bundle. CI enforces the
budget.

**Render-target discipline** — reflections and refraction at half resolution, reflections on alternating
frames (imperceptible on moving water), clouds at quarter resolution with temporal reprojection.

---

## 11. Project structure

```
sailing/
├─ index.html · vite.config.ts · tsconfig.json · .eslintrc.cjs · .prettierrc
├─ src/
│  ├─ main.ts
│  ├─ app/            App · GameLoop · Settings · SaveGame · GenerationPhase
│  ├─ core/           math/ (vec, quat, circularLerp, catmullRom, seededRandom, hash)
│  │                  ecs/ · events/ · pool/ · time/
│  ├─ weather/        WeatherService · providers/{OpenMeteoForecast,OpenMeteoMarine,Climatology}
│  │                  normalize · interpolate · cache · types · weather.worker
│  ├─ environment/    wind/{WindField, layers/{base,oscillation,gust,terrain,gradient}}
│  │                  waves/{WaveSpectrum, WaveFieldCPU, spectrum.worker}
│  │                  CurrentField · TideModel · SkyState
│  ├─ physics/        RigidBody · Integrator · BoatSimulation · PolarSolver
│  │                  forces/{Aero,HydroResistance,FoilLift,Buoyancy,WaveDrag,
│  │                          RightingMoment,FoilFlight}
│  │                  coefficients/ · hydrostatics/ (volume, wetted area from mesh)
│  │                  collision/ (Rapier adapter)
│  ├─ generation/     ← no three.js import; emits plain buffers
│  │                  hull/{StationLofter, Hydrostatics}
│  │                  rig/{MastBuilder, RiggingBuilder}
│  │                  sail/{SailSurface}
│  │                  terrain/{CoastlineRasterizer, ReliefBuilder, BathymetryBuilder}
│  │                  landmarks/{SuspensionBridge, ShellVault, RidgePlateau, Skyline, Lighthouse}
│  │                  ambient/{MooredFleet, Buoys, HarbourFurniture, SignatureVessel, Birds}
│  │                  common/{lofting, sweep, extrude, noise, csg-lite}
│  │                  geometry.worker
│  ├─ boats/          BoatFactory · definitions/*.json · types
│  ├─ venues/         VenueRegistry · definitions/*.json · coastlines/*.json · courses/
│  ├─ game/           modes/ · rules/ · scoring/ · ai/ · coaching/ · replay/ · progression/
│  │                  crew/          CrewAgent · CommandLayer
│  │                  ambient/       TrafficDirector · WildlifeDirector · PhysicsLOD
│  ├─ render/         ← the only place three.js is imported
│  │                  Renderer (WebGPU + WebGL2 fallback) · GPUCapabilities · SceneGraph
│  │                  tsl/            shared TSL: noise, spectrum, waterOptics, tonemap, sky
│  │                  ocean/          OceanRenderer · Clipmap · SpectrumCompute
│  │                                  SpectrumFallbackRT · FoamAccumulator
│  │                  sky/            SkyRenderer · VolumetricClouds · StarField · MoonLight
│  │                  boat/           BoatView · SailCloth · WakeRenderer · NavLights
│  │                                  SprayCompute · SprayCPUFallback
│  │                  terrain/        TerrainRenderer · LandmarkRenderer · ShoreLights
│  │                  weather/        RainRenderer · LensDroplets · AerialPerspective
│  │                  lighting/       SunLight · CSMShadows · EnvironmentProbe
│  │                  materials/      procedural TSL materials (gelcoat, carbon, sailcloth, …)
│  │                  postfx/ · reflections/ · cameras/ · quality/ · photomode/
│  ├─ audio/          AudioEngine · WindSynth · WaterSynth · ImpactSynth · Ambience
│  ├─ input/          InputManager · bindings · GamepadAdapter
│  ├─ ui/             screens/ · hud/ · components/ · store/
│  └─ types/
├─ tests/             unit/ · fixtures/open-meteo/ · golden/ · e2e/
└─ docs/              adding-a-venue · adding-a-boat · physics-model · procedural-generation
                      · tsl-conventions · performance-budget · interfaces
```

**Rules that keep this honest**
- `physics/`, `environment/`, `weather/`, `generation/`, `core/` must not import three.js. Enforced by
  ESLint `no-restricted-imports` so the boundary can't erode.
- `render/` reads simulation state; it never mutates it.
- No `.glsl`/`.wgsl` files. All shading is TSL in `.ts`.
- UI subscribes to a throttled 10 Hz projection of sim state, never raw per-frame state.
- Content (venues, boats, courses) is JSON. Adding either is data plus generator parameters.

---

## 12. Data contracts

```ts
interface VenueDefinition {
  id: string; name: string; region: string;
  coordinates: { latitude: number; longitude: number };
  timezone: string;
  difficulty: 1|2|3|4|5;
  bounds: { min: Vec2; max: Vec2 };            // local metres, origin at venue centre
  coastline: { polylines: string; attribution: string };   // → venues/coastlines/*.json
  depthContours: { polylines: string; maxDepth: number };
  relief: { profile: 'flat'|'hilly'|'mountainous'; maxElevation: number; noiseSeed: number };
  landmarks: LandmarkSpec[];                   // { generator, params, transform }
  water: { colorShallow: RGB; colorDeep: RGB; turbidity: number };
  windProfile: { shearExponent: number; oscillationScale: number };
  tide: { amplitude: number; phaseOffsetHours: number; currentStrength: number };
  courses: CourseRef[];
  climatology: MonthlyClimate[];               // 12 entries — the offline fallback
  grade: ColorGradeParams;                     // procedural LUT parameters
  ambience: AmbienceParams;                    // synthesis parameters, not a file
}

interface BoatDefinition {
  id: string; name: string; class: BoatClass;
  hull: {
    loa: number; beam: number; designDraft: number;
    stations: StationCurve[];                  // ← geometry AND physics come from this
    bilge: 'chine' | 'round'; hulls: 1 | 2;
  };
  rig: { mastHeight: number; taper: number; boomLength: number;
         sails: SailSpec[]; riggingLayout: RiggingSpec };
  foils: FoilDefinition[];
  stability: { ballast: number; crewWeight: number;
               crewMovementRange: Vec3; capsizeAngle: number };
  foiling?: { takeoffSpeed: number; liftCurve: CurvePoint[]; rideHeightRange: [number, number] };
  materials: { hull: MaterialParams; deck: MaterialParams; sail: MaterialParams };
  controls: ControlSchemeRef;
}
```

Note what is *absent*: no mesh paths, no texture paths, no audio paths. `stations` is the single source
for both the rendered hull and its hydrostatics.

### 12.2 Replay — checkpointed, not input-only

Input-only replay assumes bit-identical floating-point results. That assumption does not survive
different CPUs, browsers, or JS engine versions: `Math.sin`, `Math.pow`, and FMA contraction all vary,
and a 120 Hz integrator amplifies a one-ULP difference into a visibly different track within a minute.
Since replay codes are meant to be shared between machines (req 6.6), input-only replay would quietly
produce ghosts that sail a different race.

```ts
interface Replay {
  version: number;
  venueId: string; boatId: string; courseId: string;
  seed: number;
  snapshot: WeatherSnapshot;          // embedded, never refetched (req 6.5b)
  assistLevel: AssistLevel;
  /** Quantized control samples at 30 Hz — the dominant cost, heavily compressible. */
  inputs: Int8Array;
  /** Full state every 1 s: position, orientation, linear + angular velocity, controls. */
  checkpoints: Float32Array;          // 13 floats × duration seconds
  result: { elapsed: number; marks: number[] };
}
```

Playback re-simulates from inputs and **corrects toward each checkpoint** — snapping outright would
stutter, so the correction is a critically damped blend applied over the following interval. At 1 Hz
checkpoints the correction per interval is well below perceptual threshold on a machine that diverges
only by float noise, while on a genuinely divergent machine it still keeps the ghost on the right track.

Cost: ~52 bytes/s of checkpoints plus ~120 bytes/s of inputs, so a 10-minute race is roughly 100 KB
before compression and comfortably under 30 KB after — small enough for a pasteable replay code.

Divergence between re-simulation and the next checkpoint is measured every interval. Float noise
produces a small bounded error; a real determinism bug produces monotonic growth. Development builds log
that distinction (req 6.5c), which turns the replay system into a free continuous determinism test.

### 12.3 Save data

Settings, logbook statistics, unlocks, local best times, and cached generated geometry live in
IndexedDB under a versioned schema with forward migrations, so a save survives updates.

---

## 13. Testing strategy

| Layer | Approach |
|---|---|
| Generators | Vitest, headless. Vertex/index counts, watertightness, bounds, and computed volume against analytic references (a generated box hull must integrate to its analytic volume). Determinism: same params+seed → identical buffers. |
| Hydrostatics | Generated hull volume × ρ_w must equal stated displacement within tolerance; centre of buoyancy must sit on the centreline for a symmetric hull. |
| Physics | Analytical checks: static equilibrium; boat in irons makes no progress; drive peaks near expected TWA; no NaN over 200k steps at 40 kt / 5 m. |
| Wave coherence | Truncated-Gerstner CPU height vs. full-spectrum reference < 5 cm over 10k random samples (req 4.12). CI gate. |
| Wind determinism | Same `(seed, snapshot)` → bit-identical samples across runs and across worker/main thread (req 3.7). |
| Weather mapping | Contract tests against recorded Open-Meteo fixtures, including error payloads, null-heavy responses, and an inland lake with no marine coverage. |
| Fallback chain | Simulated failure at each stage, asserting documented degradation order and the surfaced `source`. |
| Backend parity | Same scene rendered on WebGPU and forced-WebGL2; assert both initialize, produce no shader-compile errors, and land within a perceptual diff tolerance. |
| Golden runs | Fixed inputs + fixed weather snapshot → trajectory compared to stored baseline within tolerance. |
| Rules | Unit tests per right-of-way scenario and mark-rounding geometry case. |
| Performance | Playwright frame-time capture on a fixed camera path. **Local-only gate** — CI runners are software-rendered, so perf and visual regression run on the dev machine, and CI enforces only logic, types, lint, and bundle size. |

---

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| GPU ocean and CPU physics visibly disagree | Shared `WaveSpectrum`; truncated-Gerstner CPU path; automated 5 cm coherence gate. Front-loaded before any ocean rendering work. |
| WebGL2 fallback ends up broken or unshipped | Backend parity test in CI from the first ocean milestone; fallback paths designed up front (§2.2), not retrofitted. |
| Procedural boats look like programmer art | Stylized realism (§8.7) is chosen precisely because it plays to what generators do well. Station-curve lofting driven by real published hull lines; invest early in the material system, since gelcoat/carbon/sailcloth shading carries most of the perceived quality. |
| Art direction drifts across dozens of agents | `docs/art-direction.md` is a Phase 0 deliverable and normative. Per-venue palettes enforced by procedural grade. Screenshot review per venue against the palette. |
| Shared replays diverge across machines | Checkpointed replay (§12.2) rather than input-only. Divergence measured every interval; monotonic growth flagged as a real bug. |
| Night sessions look bad or are unplayable | Night treated as a first-class state, not an edge case: real moon phase and position, star field, nav lights, shore lighting. Difficulty increase from unreadable gusts is intentional and true to life. |
| Procedural landmarks unrecognizable | Target silhouette, not detail — recognition from the water is about profile against sky. Validate by screenshot review per venue. |
| Physics feels wrong to actual sailors | Validate computed polars against published polars for comparable real classes; sailor playtesters early; tune coefficients, never the architecture. |
| Live weather is boring (0 kt or a hurricane) | Briefing screen before commit; "find me wind" filter; sandbox override; Daily Challenge biased to sailable conditions. |
| Inland venues have no marine coverage | Detect null marine response; generate wind-sea from fetch-limited JONSWAP using venue fetch length. Lake Michigan is the explicit test case. |
| Open-Meteo rate limits or downtime | Aggressive caching, batched multi-coordinate calls, 15-minute throttle, three-stage fallback, honest source labelling. |
| Laptop thermal throttling | Throttle detection feeding the quality manager, user frame cap, 4 GB VRAM ceiling, Ultra calibrated to 1080p rather than 1440p. |
| Generation stalls startup | All generators in workers, buffers transferred not copied, IndexedDB caching of deterministic output, 3 s budget with progress UI. |
| Parallel-agent development produces incoherent code | Phase 0 freezes every module interface and the shared type surface before implementation fans out; ESLint import boundaries; every workstream ships with its own tests. |
| Scope | `tasks.md` is ordered so a playable, good-looking single-boat single-venue game exists before racing, AI, or progression begin. |
