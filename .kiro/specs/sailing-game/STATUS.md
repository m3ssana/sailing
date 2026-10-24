# Project status — where to pick up

**Last updated:** 2026-10-24 · **Last commit:** `2b95b01` (HEAD, pushed). **Stream F is complete but
UNCOMMITTED** — it lives in the working tree (new dirs `src/render/{sky,weather,night,post,lighting,atmosphere}/`,
plus edits to `SkyState.ts`, `three-env.d.ts`, `WaterMaterial.ts`, `materials/{noise,terrain}.ts`, one new
test in `tests/unit/environment/`). **CI:** green (`npm run ci` exit 0).

This file is the resume point. `tasks.md` is the plan; this is the progress against it.

---

## Current state

`npm run ci` passes end to end:

| Gate | Result |
|---|---|
| `tsc --noEmit` | 0 errors |
| `eslint . --max-warnings 0` | 0 warnings |
| `vitest run` | 1160 tests / 61 files was the Stream F baseline. **G.1 adds +91 tests / +7 files** (`tests/unit/game/input`, `tests/unit/input`), all passing in isolation (`npx vitest run tests/unit/input tests/unit/game`). Full-suite total not re-run here (a concurrent boats agent is also changing counts). |
| `vite build` | succeeds |
| `check-no-assets` | pass — no mesh, texture or audio files in the build |
| `check-budget` | **205.9 kB gzipped, 4.0% of the 5 MB budget** (unchanged: nothing in Stream F is imported by the app entry yet, so it is tree-shaken out) |

Run `npm run ci` first thing to confirm nothing has drifted.

---

## What is built

### Phase 2 task 2.1 — DINGHY boat + factory (boats agent, 2026-10-24, UNCOMMITTED)

New dir `src/boats/` + `tests/unit/boats/`. The ILCA/Laser single-hander as a
`BoatDefinition` plus a factory that wires the frozen physics into a runnable sim.

| File | What |
|---|---|
| `src/boats/definitions/dinghy.ts` | `DINGHY` BoatDefinition (LOA 4.23, beam 1.37, hull 58 kg + crew 75 kg, 7.06 m² cat sail, daggerboard + rudder; class numbers cited inline) |
| `src/boats/BoatFactory.ts` | `buildBoatSpec(def)` (lofts hull → hydrostatics → righting curve about real CoG → sails/foils → distributed-mass inertia; cached by id) and `createBoatSimulation(def, opts?)` (registers Buoyancy, FoilLift, side-force bridge, HydroResistance, WaveDrag, Aero, RightingMoment, AngularDamping in a sensible order; `opts.includeWaveDrag` toggle) |
| `src/boats/AngularDamping.ts` | boat-level hydrodynamic roll/pitch/yaw + heave/surge damping generator — the frozen force set models the righting moment but NOT the damping that lets a dinghy settle; added as a composable generator (design.md §7.1 extension point), NOT an edit to frozen physics |
| `src/boats/index.ts` | barrel + `getBoatDefinition(id)` / `listBoatDefinitions()` registry, DINGHY registered |

Tests: `tests/unit/boats/dinghy.test.ts` (21) + `tests/unit/physics/forceAccumulation.test.ts` (2 regression).
Measured: canoe-body draft 0.118 m; displacement 135 kg vs 133 kg mass (ratio 1.016, within 15%); LWL 4.01 m (95% of LOA);
polar beam-reach (TWA 90°, 12 kt) **5.64 kt** (ILCA 5–7 kt band); polar max 5.72 kt at TWA 115°; upwind VMG optimum 35°,
downwind 160°; capsize in 25 kt sheet-cleated no-hike at **2.6 s**.

**Two real frozen-physics bugs found and fixed (first exposure of the sail-force path through the integrator):**
1. `src/physics/BoatSimulation.ts` — `step()` integrated forces from the global force POOL
   (`getForcePoolSlice`/`getForceCount`) but generators push into the `out` array; the four generators that push
   object literals (AeroForce, FoilLift, HydroResistance, RightingMoment) were SILENTLY DROPPED and `_forces` was never
   cleared. Fixed to clear + accumulate from `out`. Regression: `forceAccumulation.test.ts`.
2. `src/physics/forces/AeroForce.ts` — sail lift-direction sign was inverted (rot +90° instead of −90°), so sail DRIVE
   came out negative on a reach (boat sailed backwards). Fixed; verified forward drive + leeward heel on both tacks.

**Honest scope reductions (documented in code + here):**
- UPDATED by the PhysicsStability stream — the predecessor's reductions below are
  **superseded**. The NaN divergence, the "fragile above ~10 kt" roll, the
  module-scope WaveDrag slam state, the leeway crab, and the 20 s-window soak are
  all RESOLVED (see the PhysicsStability section further down). What remains
  scoped-down and documented: (a) the fully-autonomous closed-loop autopilot
  holds a steady beam reach without capsize up to ~12 kt, not 15 kt+, and does
  not execute clean tacks/gybes — that needs the anticipating AI crew (Stream G);
  (b) the polar's upwind VMG optimum is still ~35° (the leeway/foil-stall term
  was attempted and reverted as it didn't robustly widen it — Task E left
  documented).

### PhysicsStability stream (2026-10-24, UNCOMMITTED) — divergence + crab fixed, real acceptance tests restored

Root cause of the NaN/roll fragility (with evidence), found via a calm-water
diagnostic harness (WaveDrag off, damping off):

1. **It was NOT a stiff integrator / buoyancy spring.** Measured heave stiffness
   k≈4573 N/m on m≈133 kg → ω≈5.86 rad/s, so at 120 Hz ω·dt≈0.049 ≪ 2 — far
   inside the explicit/symplectic stability limit. Sub-stepping would buy
   nothing. The predecessor's "needs implicit/substepped integrator" hypothesis
   was wrong.
2. **The frozen conservative force set has no rotational damping and yaw is a
   free integrator.** With no damping, yaw spun up monotonically (0.6 → 7.6 rad/s
   over 60 s) and roll rang ±130°. WaveDrag was the only velocity sink, and its
   orbital-drag term double-counted the steady hull drag (≈1000 N at 5 kt on
   FLAT water — it was secretly most of the drag).
3. **The interim `AngularDamping` generator had an inverted YAW force couple** →
   it was ANTI-damping yaw, driving |ω_y| to ~105 rad/s in ~1.2 s and cascading
   to a finite-but-astronomical (~1e141) blow-up that `isStateFinite` doesn't
   catch (Number.isFinite(1e141) is true).

What changed (all in `src/physics` / `src/boats`, no frozen types touched):
- **WaveDrag** (`forces/WaveDrag.ts`): slam state (`_wasAbove`/`_prevVy`) and the
  scratch vectors are now INSTANCE-scoped (no cross-instance aliasing → parallel
  runs deterministic). Its orbital drag is now a wave-ADDED increment
  (`drag(v_rel) − drag(v_hull)`), ≈0 on flat water, so it no longer double-counts
  HydroResistance.
- **HydrodynamicDamping** (`forces/HydrodynamicDamping.ts`, NEW; folds in and
  replaces `boats/AngularDamping.ts`, which is deleted): roll/pitch/yaw + heave/
  surge damping with the CORRECT yaw-couple sign. Roll damped hardest (1400→5000
  lin / 2500 quad) so a dinghy's roll is near-critically damped and passively
  stable to ~10 kt; surge kept small (12) so it does not eat sailing speed.
- **FoilLift** (`forces/FoilLift.ts`): daggerboard lift SIGN fixed — it was
  `−sign(cl)` (amplifying leeway → the boat crabbed off at 50–70° leeway and
  never held a course); now `+sign(cl)`, opposing leeway (verified: at 9°
  starboard leeway the foil now pulls +823 N to port, was +792 N to starboard).
- **AeroForce** (`forces/AeroForce.ts`): apparent-wind angle was computed from
  the wind VELOCITY direction (180° off the aerodynamic comes-from convention),
  so the sail was permanently past stall and drive was INDEPENDENT of the sheet.
  Now uses the comes-from incidence; drive responds to trim and peaks attached
  (beam reach, 5 kt: ~186 N drive at the optimum vs ~27 N stalled).

Real acceptance tests restored (`tests/unit/boats/stability.test.ts`,
`sailing.test.ts`, `golden.test.ts`):
- FULL 200 s soaks, finite + bounded every step: 30 kt/1.5 m and 35 kt/3 m WITH
  WaveDrag, and **40 kt/5 m WITHOUT WaveDrag** (proving stability no longer
  depends on it). Capsize allowed, divergence not.
- Capsize contrast: capsizes < 20 s in 25 kt cleated no-hike; does NOT capsize in
  a 12 kt beam reach hiking with the sheet eased (the 15 kt target exceeds the
  simple-controller roll ceiling — AI-crew work).
- Golden 20 s trajectory baseline (`fixtures.golden.ts`) + determinism + a
  NEGATIVE CONTROL (doubling the residuary drag must break the baseline — it
  does).
- Determinism: same seed/inputs twice → bit-identical state; two interleaved
  instances don't alias.
- Closed-loop "it sails" (simple PD-helm + depower + monotone hike autopilot,
  10 kt): beam reach holds course (±35°) at **leeway < 15°** (was ~60°), bounded
  speed, >20 m made good east over 60 s, no capsize; close reach makes **net
  positive upwind VMG** (was negative — bodily downwind). Measured steady beam-
  reach speed under the simple autopilot ≈ 2.4–3.0 kt; the quantitative ILCA 5–7
  kt band is on the computed polar (`dinghy.test.ts`, still 5.64 kt).

Also: added additive `terrainField?: TerrainInfluenceField` to
`EnvironmentConfig` (`src/environment/Environment.ts`), forwarded to
`createWindField`; `createVenueEnvironment` now injects the generated wind
influence field through it (return shape unchanged) — the former contract gap is
closed. Test: `tests/unit/physics/environmentTerrainField.test.ts`.

Verification (PhysicsStability): `npx vitest run tests/unit src/physics src/boats`
→ **827 passed / 52 files**; `npx tsc --noEmit` 0 errors; `npx eslint src/physics
src/boats src/environment src/venues tests/unit --max-warnings 0` clean. Did NOT
run `npm run ci` (per task). `src/types` untouched.

<details><summary>Predecessor's now-superseded reductions (kept for history, all RESOLVED above)</summary>

- ~~Free-sailing tests use the polar because the sim crabs and can't hold a line.~~
- ~~Capsize-does-not-happen demonstrated only at 8 kt; roll fragile above ~10 kt.~~
- ~~200 s soak reduced to a 20 s window; WaveDrag slam state shared across
  instances; without WaveDrag the integrator diverges to NaN.~~

</details>

### Phase 0 — complete

| Task | Status | Location |
|---|---|---|
| 0.1 Scaffold, ESLint import boundaries, CI | done | `package.json`, `tsconfig.json`, `vite.config.ts`, `eslint.config.js`, `scripts/` |
| 0.2 **Frozen type surface** | done | `src/types/` (9 files) + `docs/interfaces.md` |
| 0.3 Core primitives | done | `src/core/` |
| 0.4 Renderer bootstrap + capability probe | done | `src/render/Renderer.ts`, `GPUCapabilities.ts` |
| 0.5 Game loop + frame profiler | done | `src/app/GameLoop.ts`, `src/render/quality/` |
| 0.6 Generation harness | done | `src/generation/` |
| 0.7 **Art direction** (normative) | done | `docs/art-direction.md` |
| 0.8 Repo, licence, CI/CD | done | `LICENSE`, `README.md`, `.github/workflows/` |

### Phase 1

| Stream | Status | Notes |
|---|---|---|
| A — Weather | ✅ complete | `src/weather/` |
| B — Environment | ✅ complete | `src/environment/` |
| C — Physics | ✅ complete | `src/physics/` |
| D — Generation | ✅ complete (9/9) | `src/generation/`; materials live in `src/render/materials/` (D.8 note below) |
| E — Ocean rendering | ✅ complete (5/5) | `src/render/ocean/` |
| **F — Sky, lighting, post** | ✅ **complete (4/4), uncommitted** | `src/render/{sky,weather,post,night,lighting,atmosphere}/` — see "Stream F" below |
| G — Game systems | 🚧 in progress (1/7) | **G.1 Input & helm feel done** (`src/game/input/`, `src/input/`) — see "Stream G.1" below. G.2–G.5 not started. |
| H — Audio and UI | 🚧 in progress | **H.3 HUD done** (`src/game/hud/` view-models + `src/ui/hud/` React/Zustand). **H.4 Cameras & photo mode done** (`src/game/camera/` pure models + `src/render/camera/` three driver) — see "Stream H.4" below. Audio + other UI not started. `src/input/` exists (G.1). |
| I — Boat rendering | ✅ complete (2/2) | `src/render/boat/`, `src/render/cloth/` |

Phases 2, 3 and 4 are untouched. **Nothing in Streams D/E/F/I is wired to the app entry point** — that is
Phase 2 task 2.1 ("first sail"). The deployed site (sailing.messana.ai) still shows only the bootstrap UI.

---

## Stream F — Sky, lighting, post (complete 2026-10-24)

Architecture rule used throughout: **pure-TypeScript model (no three) + thin TSL layer that mirrors it**; tests
assert on the model and build the TSL graph without throwing. Shared contract: `src/render/lighting/LightingState.ts`.

| Task | Location | Tests | Delivered |
|---|---|---|---|
| F.1 Atmosphere + probe | `src/render/sky/` | AtmosphereModel, LightingModel, EnvironmentProbe, WaterLightingBridge, ColorSpaceAndNight | Rayleigh+Mie CPU reference, `computeLightingState` (Kasten–Young air mass, Beer–Lambert, Kasten–Czeplak cloud attenuation, Haurwitz clearness), `SkyDome`, PMREM `EnvironmentProbe` + `ProbeRegenPolicy`, `applyLightingToWater` |
| F.2 Clouds, rain, visibility | `src/render/weather/` | Visibility, CloudModel, CloudRenderer, Rain, WeatherVisuals | Koschmieder aerial perspective, fBm cloud model + real TSL slab raymarch (shared `NOISE_CONSTANTS`), rain streaks, rain ripple hook, `LensDropletState` |
| F.3 Shadows + post | `src/render/post/` | CascadedShadows, ShadowRig, ColorGrade, TAA, PostChain | PSSM cascades w/ bounding-sphere fit + texel snap, `ShadowRig`, procedural colour grade + `paletteHold`, TAA/bloom/motion-blur/DoF/lens-droplet chain (`postChainConfig` is the single source of truth) |
| F.4 Night | `src/render/night/` | Moonlight, StarField, StarFieldRig, MoonDisc, NavLights, ShoreLights, GustVisibility, NightRender, NightSystemSweep | Moon (phase/elevation/overcast), catalogued star field oriented by latitude + sidereal time, COLREGs Rule 21 nav-light arcs (in-shader), shore lights, gust-contrast scaling |
| Facade | `src/render/atmosphere/` | atmosphere.test | `createAtmosphereSystem(opts).update(frame)` orchestrates all of the above, drives water sun/sky uniforms **and** night gust darkening; `attachNavLightsToBoatView` |

### Verification that was done

- Unit + CI gates above.
- **Independent audit passes** (fresh agents, no access to self-reports) over F.1/F.2 and F.4. They found real bugs, all fixed
  with regression tests: air mass non-monotone below the horizon (sun colour went red→white→**blue**), dead rain alpha,
  star-field rotation **wrong sign**, moon-disc lit limb never updated, NaN poisoning in night models, stars baked to the
  origin (`Float32BufferAttribute` copies its input), shadow snap grid not aligned to three's real shadow-camera axes.
- **Real-browser GPU smoke test** (headless Chrome / SwiftShader, WebGL2 backend), 7 scenarios × post-chain combos, 32
  frames each, 0 shader errors. Found and fixed bugs unit tests cannot see (below). The harness (`tmp-smoke/`, a
  puppeteer runner under `%TEMP%`) was temporary and has been **deleted**; rebuilding it is the way to re-verify shaders.

### Hard-won Stream F knowledge — do not rediscover

- **TSL `.mix()` method is a trap in three r0.180.** The chaining method is `mixElement(t, e1, e2)`: the *receiver is the
  interpolation factor*, so `a.mix(b, t)` silently computes `mix(b, t, a)`. It blacked out the whole sky dome and mis-blended
  water, cloud noise, terrain and shore lights. **Always use the free function `mix(a, b, t)`.** The `.mix` method has been
  removed from the `TSLNode` typing in `src/three-env.d.ts` so tsc rejects it. All uses were converted.
- **Contrast must be a power-law about 0.18**, `out = 0.18·(c/0.18)^k`. The original linear pivot sent dim values (noon sky
  zenith ≈ 0.02–0.05) negative and the clamp turned the sky black (violates art-direction "never crushing blacks").
- `gradeNode` receives a **vec4** scene colour: always operate on `.xyz` (a `vec4·vec3` luma dot was inert at the neutral
  grade, so neutral-grade tests hid it). Neutral grade (`NEUTRAL_GRADE`: exposure 0, contrast 0, saturation 1) is an exact identity.
- Bloom input must be sanitised (`select(c==c, c, 0)` + clamp 0..64): NaN/Inf from HDR specular poisoned the blur pyramid.
- Tone mapping: ACES stays the **renderer's single output transform**; every post stage is linear→linear and runs before it.
  Do not also apply `LightingState.exposure` at `renderer.toneMappingExposure` (double counts with the grade).
- **TAA is force-disabled on the WebGL2 backend** (`postChainConfig`): in r0.180 `TRAANode`'s private history/resolve render
  targets lack the backend bookkeeping `WebGLTextureUtils.copyTextureToTexture` needs (`backend.get(undefined)` → "Invalid value
  used as weak map key", every frame). Motion blur needs a texture node (`convertToTexture(node)` before `motionBlur`).
- `THREE.Float32BufferAttribute(typedArray)` **copies** the array; mutate `attribute.array` + `needsUpdate`, not the source.
- Three's `Color.set(r,g,b)` is linear under the default working colour space in r180 — not an sRGB decode (locked by a test).
- Solar azimuth had a negative-modulo bug for western longitudes around 00:00 UTC (`src/environment/SkyState.ts`, fixed, test
  `tests/unit/environment/solarAzimuth.test.ts`). Watch for JS `%` on possibly-negative values.

### Stream F reductions and follow-ups (all labelled in code too)

- **Clouds:** real TSL slab raymarch on a camera-following full-res dome. **Not** the spec'd quarter-res render target with
  temporal reprojection (an `rtt()` quad has no scene-camera ray; needs inverse-VP + history ping-pong). Halton jitter /
  `reprojectionBlend` are computed and pushed as uniforms for a future RT path.
- **Shadows:** custom N-light cascades driven by the pure model, not three's `CSMShadowNode`. Sun light's `up` is set to match
  the model's snap basis.
- **Colour grade:** procedural grade replaces the spec's per-venue 3D LUT (no image assets). `paletteHold` is CPU/generation-time only.
- **Screen-space reflections / true refraction** (E.4's deferred items) are still not done; the post chain exists now, so SSR is
  the natural next step for water.
- **Moon glitter and rain ripples:** pure models exist (`moonGlitterParams`, `rainRippleNormalNode`); `WaterMaterial` has no hook
  for either yet, so the facade detects a hook and no-ops (`hasMoonGlitterHook=false`). Add a backwards-compatible uniform pair
  to `WaterMaterial` to light them up.
- **Nav lights** are attached to the player `BoatView` via `attachNavLightsToBoatView` (dims passed explicitly: `BoatView` keeps
  `loa`/`mastHeight` private). Ambient vessels have no render view yet — Phase 2 gap. Shore-light anchors are caller-supplied
  (`SkylineGenerator` exports only counts, not per-building footprints).
- **Not verified without a real GPU:** native WebGPU backend (headless Chrome here is SwiftShader/WebGL2 only) incl. WebGPU
  TAA, velocity MRT correctness; `EnvironmentProbe.update` with a live renderer in the shipped app path.
- **Visual caveats:** on-screen sky is slightly paler than `LightingState.zenith` because ACES desaturates highlights
  (fix would be `skyDome.material.toneMapped=false` or a Renderer tone-map change). Moonlight is artistically lifted (0.02 vs
  physical 2.7e-6); moon-disc limb shading is first-order. `SkyState.lunarPosition` phase mixes ecliptic latitude into the
  elongation (quarters read ~0.55, not 0.50) — harmless at its ~1° accuracy.
- **Shimmer residual:** cascade texel-snap now matches three's shadow-camera axes by construction (tested with an independent
  `lookAt`); the actual absence of shimmer on a GPU was not observed.

---
## Stream G.1 — Input and helm feel (complete 2026-10-24, uncommitted)

Architecture: **pure headless models in `src/game/input/` (no DOM, no three) + thin DOM adapters in
`src/input/`**. The pure models are the engine-agnostic contract; the DOM adapters only shape browser
events into a plain `DeviceSnapshot`. All adapter dependencies (event targets, gamepad provider,
storage) are dependency-injected, so every test runs under vitest's existing `node` environment with
hand-written fakes — **no jsdom was added**.

Files:
- `src/game/input/`: `types.ts` (local, non-frozen input types + `COMMAND_ACTION_MAP`),
  `BindingMap.ts` (defaults, one-handed preset, rebind+conflicts, versioned JSON), `SteeringFilter.ts`
  (keyboard ramp/recentre, analog deadzone+curve, progressive resistance, `rumbleFromHelmLoad`),
  `InputMapper.ts` (`steerScale`, rate-integrated trim, edge-triggered crew commands), `ControlsAdapter.ts`
  (allocation-free per-frame `frame()`), `KeyValueStore.ts` (interface + `MemoryKeyValueStore`), `index.ts`.
- `src/input/`: `KeyboardInput.ts`, `MouseInput.ts`, `GamepadInput.ts`, `InputManager.ts`,
  `LocalStorageKeyValueStore.ts`, `index.ts`.
- Tests: `tests/unit/game/input/` (SteeringFilter, BindingMap, ControlsAdapter, KeyValueStore) +
  `tests/unit/input/` (Keyboard, Mouse, Gamepad+Manager+Storage). **91 tests, all passing.**

Per-frame session API (the layer wiring the game to the boat calls these each frame):
- `InputManager.sample(): DeviceSnapshot` (DOM read; reused object).
- `ControlsAdapter.frame(bindings, deviceSnapshot, helmLoad, speed, dt, assist, slam?) => { controlsPatch, rumble, input }`
  — pass `controlsPatch` to `BoatSimulation.setControls`, drive `InputManager.gamepadInput.rumble(weak, strong)`
  from `rumble`, consume `input` (frozen `InputState`) for crew commands / camera / pause. Allocation-free:
  returns the SAME object references every frame (asserted by test).

Key design facts / deviations (all honest, labelled in code):
- `helmLoad` consumed exactly as `computeHelmLoad` normalises it (0..1, `saturate`d): rising load
  monotonically attenuates BOTH reachable analog rudder authority and the approach rate (`SteeringFilter`),
  and drives dual-rumble (`rumbleFromHelmLoad`: zero at helmLoad≈0, monotone, saturating). Verified by
  monotonicity + `[-1,1]` bound tests.
- Assist levels affect ASSISTS ONLY (req 5.5): arcade = gentler low-speed steering + faster trim;
  simulation = full 1:1 authority + realistic (slower) trim. Documented and tested (`steerScale`, trim-rate
  tests).
- The frozen `InputState`/`ControlState`/`CrewCommand` surface was NOT edited. Extra shapes the mapper needs
  (`InputAction`, `InputBinding`, `DeviceSnapshot`, `RumbleOutput`) live in `src/game/input/types.ts`.
- One-handed preset (req 12.4): every ESSENTIAL_ACTION reachable with a single hand on the arrow/nav cluster
  (+Enter/Backspace/RightShift/numpad) OR mouse-only (mouse X steers, wheel trims main). Asserted by test.
- Binding JSON is versioned: malformed → rejected (`null`); unknown version → migrated to defaults (never
  throws on load); partial payload → filled from defaults.

Reductions/notes for whoever wires G.1 into Phase 2 task 2.1:
- Nothing here is imported by the app entry yet (same tree-shake caveat as Streams D/E/F/I).
- `GamepadInput.rumble` guards `vibrationActuator.playEffect('dual-rumble')` and swallows rejected promises
  for browsers lacking the API — no-op rather than throw.
- Camera `lookDelta` is only populated while pointer-locked; unlocked mouse X is reserved for steering.

### Import-path gotcha (cost a lint round)
Bare alias `@input` is NOT resolvable (tsconfig `paths` only defines `@input/*`, no bare entry), so ESLint's
type-checker typed those imports as `any`/error. Tests import the DOM layer as **`@/input`** (via `@/*` →
`src/*`); the pure layer imports as **`@game/input`** (via `@game/*`). Use those, not `@input`.

---


## Stream H.3 — HUD (complete 2026-10-24, uncommitted)

Architecture: **pure view-model layer `src/game/hud/` (no React, no three, no DOM) +
React/Zustand UI in `src/ui/hud/`**. The render loop builds a view model each UI tick
and publishes it into a vanilla Zustand store through a throttle; React only READS the
store (never touches the render loop — the architectural rule). No new dependencies
added; no jsdom (markup is tested via `react-dom/server` `renderToStaticMarkup`, store/
throttle via `vi.useFakeTimers`). `src/types` untouched.

Files:
- `src/game/hud/`: `types.ts` (local, non-frozen view-model types), `presets.ts`
  (density table Full/Moderate/Minimal/None as DATA + `widgetVisibility`/`nextPreset`),
  `navMath.ts` (`computeVmg`, `apparentWindAngle`, `targetSpeedFraction`, `laylineBearings`,
  `windAngleOffBow`, `optimalUpwindTwa`, `pointOfSail`, `bearingTo`/`distanceTo`),
  `HudViewModel.ts` (`buildHudViewModel(input, out?)` allocation-reuse builder +
  `createHudViewModel`), `formatHud.ts` (pure string layer: `6.2 kt`, `045°`, `0.32 nm`,
  `SIMULATED`), `index.ts`.
- `src/ui/hud/`: `hudStyles.ts` (CSS-in-TS tokens from art-direction §8, no assets, no
  drop shadows, opaque-backdrop variable), `hudStore.ts` (vanilla `createStore`,
  settings persisted via the reused `KeyValueStore` seam, `createHudPublisher` 10 Hz
  throttle), `Panel.tsx`, `WindIndicator.tsx`, `SpeedPanel.tsx`, `TrimGauge.tsx`,
  `HeelHelmGauge.tsx`, `CompassPanel.tsx`, `ConditionsPanel.tsx`, `CoachingBanner.tsx`,
  `HudRoot.tsx` (pure `HudRoot` + store-bound `HudRootConnected`), `mountHud.ts`
  (`mountHud(container, store)` + idempotent `ensureHudStyles`), `index.ts`.
- Tests: `tests/unit/game/hud/` (navMath 25, presets 33, HudViewModel 23, formatHud 13)
  + `tests/unit/ui/` (hudStore 13, hudPublisher 9, hudMarkup 13, mountHud 2).
  **131 tests, all passing** (`npx vitest run tests/unit/game/hud tests/unit/ui`).

Per-frame session API (what wires the game to the HUD):
1. `const store = createHudStore(new LocalStorageKeyValueStore())` (DOM) or
   `createHudStore()` (headless); `mountHud(uiRootEl, store)` once at startup.
2. `const out = createHudViewModel()` once; `const pub = createHudPublisher(store)` once.
3. Each frame: `buildHudViewModel(hudInput, out)` then `pub.publish(out)`. The publisher
   throttles to ~10 Hz and `structuredClone`s on store entry (default `snapshot`) so React
   gets immutable frames even though `out` is reused. `pub.flush()` on pause; `pub.dispose()`
   + `mountedHud.unmount()` on teardown.

Design facts / deviations (all honest, labelled in code):
- `HudSailTrim` MIRRORS the parts of the frozen physics `SailAeroState` the trim gauge
  shows (attachment, luffing) rather than importing the type, so the game/hud layer stays
  decoupled from physics internals — the render loop maps `SailAeroState → HudSailTrim`.
- `formatHud` does NOT import `@/ui/strings` (would be a game→ui layering inversion); it
  returns the raw `WeatherSource` enum via the view model and the UI component localizes the
  source label through `strings.weather.sourceLabels` (which already covers all 5 sources).
  The `'SIMULATED'` sandbox badge is a fixed token the spec mandates.
- CSS is a typed CSS-in-TS string injected by `mountHud` (the project loads CSS inline in
  `index.html` and has no `import './x.css'` precedent in `src/`); keeps the HUD asset-free
  and importable headlessly.
- Units: knots/nm live ONLY in the view-model/format layer, converted with the exact `UNITS`
  constants (1852/3600). Mark distance shows metres under ~1000 m, nm beyond (km for metric).
- Accessibility: every panel is an aria-labelled region; SVG instruments are `role="img"`
  with text alternatives carrying the same numbers; luff/capsize/source are visible TEXT not
  colour-only; `prefers-reduced-motion` disables transitions; opaque backdrop (Instrument
  Black @92% → 16.5:1, WCAG AA) is a toggle.

Verification: `npx vitest run tests/unit/game/hud tests/unit/ui` → 131/131 pass;
`npx eslint src/game/hud src/ui tests/unit/game/hud tests/unit/ui --max-warnings 0` → 0
warnings; `npx tsc --noEmit` → 0 errors in any HUD file (the one remaining repo tsc error is
`tests/unit/boats/_diag8.test.ts`, owned by the concurrent boats agent). Did NOT run
`npm run ci` (per task). Nothing here is wired into the app entry yet (same tree-shake caveat
as other unwired streams) — wiring the publisher into the frame loop + `mountHud` into
`#ui-root` is Phase 2 task 2.1 integration.

## Stream H.4 — Cameras and photo mode (complete 2026-10-24, uncommitted)

Architecture: **pure camera models in `src/game/camera/` (no three, no DOM) + thin
three.js driver in `src/render/camera/`**. The pure layer produces a plain-data
`CameraPose`; the render layer applies it to a `THREE.PerspectiveCamera`. This
keeps the whole camera brain headlessly testable (all tests run under vitest
`node`, no WebGL context).

Files:
- `src/game/camera/`: `types.ts` (CameraFrame/CameraPose/CameraMode + cycle),
  `cameraMath.ts` (`lookRotationZNeg` in the three -Z-forward convention,
  `applyViewRoll`, `dampVec3`), `settings.ts` (per-mode FOV, horizon-lock,
  reduced-roll, head-motion caps, smoothing, `CAMERA_NEAR`/`CAMERA_FAR`),
  `modes.ts` (helm/chase/mast/drone placements + bounded head motion),
  `broadcast.ts` (`BroadcastDirector` scoring + dwell/margin hysteresis),
  `photo.ts` (`PhotoCamera` free-fly, focal-length→FOV, exposure, DoF, capture),
  `controller.ts` (`createCameraController`), `index.ts` barrel.
- `src/render/camera/`: `CameraRig.ts` (wraps `THREE.PerspectiveCamera`,
  `applyPose`/`resize`), `PhotoCapture.ts` (`capturePhoto(canvas): Promise<Blob>`
  guarded for no-`toBlob` environments), `index.ts`.
- Tests: `tests/unit/game/camera/` (cameraMath, photo, broadcast, controller) +
  `src/render/camera/{CameraRig,PhotoCapture}.test.ts`. **63 tests, all passing.**

Per-frame session API (the layer wiring game→render calls these each frame):
- `const cam = createCameraController({ mode?, settings?, aspect? })`.
- `const pose = cam.update(frame: CameraFrame, dt): CameraPose` — build the frame
  from the interpolated player `BoatState` (position/orientation/velocity/heel/
  pitch/heading), a `slam` 0..1, boat geometry (`mastHeight`/`loa`/`eyeOffset`),
  `marks`/`otherBoats` world positions, `time`, `lookDelta`, optional
  `sunDirection`/`isLand`. Pose reused every frame (allocation-free steady state).
- `cam.cycle()` on `InputState.cameraCycle`; `cam.setMode(m)`; `cam.togglePhoto()`
  on `InputState.pausePressed` → read `cam.paused` to pause the sim.
- `cam.photo.{focalLengthMm,exposure,focusDistance,aperture,hideHud}` are the
  photo controls; `cam.getPhotoFrame().move/boost` is how the session drives
  free-fly translation (frozen `InputState` carries only `lookDelta`);
  `cam.capture()` returns a `CaptureRequest` the DOM layer feeds to
  `capturePhoto(canvas)`.
- Render side: `const rig = new CameraRig({aspect}); rig.applyPose(pose);
  rig.resize(aspect)`; pass `rig.camera` to the renderer / PostChain.

Key design facts / deviations (all honest, labelled in code):
- **-Z forward convention** made explicit and tested: a camera at the stern
  looking along the boat's forward has the bow ahead in view (dot ≈ +1, not the
  flipped −1). Roll about the view axis (`applyViewRoll`) tested for sign/axis.
- **Horizon lock** is a 0..1 fraction of boat heel fed to `applyViewRoll`:
  tested lock=0 → camera roll ≈ 0 at 30° heel, lock=1 → roll == heel, and **RMS
  camera roll over a synthetic ±25° rolling sequence decreases monotonically as
  lock drops 1→0** (the measurable-reduction demo from tasks.md). Reduced-roll
  halves head motion; reduced-motion-zero zeroes it (tested).
- **Frame-rate independence:** all smoothing is exponential in dt (`dampVec3` /
  `damp`); tested that two 0.05 s half-steps equal one 0.1 s step, and chase
  converges to the same place at 30 Hz and 120 Hz within tolerance.
- **Head motion** (helm) is bounded by explicit caps (`maxTranslation` 0.12 m,
  `maxPitch`); tested the slam-induced eye delta stays < 0.2 m.
- **Broadcast** scores a deterministic candidate ring (subject-in-frame,
  pleasant distance band, gentle downward horizon, sun-avoidance when
  `sunDirection` given, land-occlusion penalty when `isLand` given) with
  **dwell (4 s) + margin (0.12) hysteresis**; tested deterministic, flicker-free
  (cuts respect the dwell gate; < 10 cuts over 20 s of jitter), and the player
  boat is never lost from frame. Candidate distance adapts to subject separation
  so a boat + a far mark both fit the narrow (38°) broadcast cone.
- **Photo mode:** `fov = 2·atan(12/f)` for a 24 mm-tall sensor (tested: 50 mm →
  27°, 12 mm → 90°); exposure in stops flows to `CameraPose.exposure`; aperture →
  `bokehScale`, focus distance + focal length → `CameraDoF` mapped to
  `PostChain`'s `DoFConfig`; `hideHud` flag; `capture()` returns a cloned,
  reproducible pose + request id.
- **Clip planes:** `far = 20000` m clears the 8000 m sky dome and 12000 m cloud
  dome (both camera-following); `near = 0.1` m for a cockpit-close helm view.
- **One additive edit outside the owned dirs:** `src/three-env.d.ts` gained
  `fov`/`near`/`far` on `PerspectiveCamera` (standard three members the minimal
  ambient decl lacked). Purely additive — widens types only, cannot break
  existing render code. The file was NOT deleted (per steering). `src/types/`
  untouched.

Verification: `npx vitest run tests/unit/game/camera src/render/camera` → 63/63
pass; `npx eslint src/game/camera src/render/camera tests/unit/game/camera
--max-warnings 0` → clean (exit 0); `npx tsc --noEmit` → zero errors in the
camera dirs (the only repo tsc error is in a concurrently-in-flight
`tests/unit/boats/*` owned by another agent). Did NOT run `npm run ci` (per task).

### Honest reduction / integration notes for whoever wires H.4 into Phase 2 task 2.1
- Nothing here is imported by the app entry yet (same tree-shake caveat as the
  other unwired streams).
- `slam` intensity is an input the session must derive (e.g. from recent hull
  vertical acceleration); the camera only consumes it.
- `CameraFrame.isLand`/`sunDirection` are optional; broadcast simply skips those
  score terms when they are absent.
- `capturePhoto` only performs the canvas read; the caller must time it within
  the rendered frame (or set `preserveDrawingBuffer`) for a non-blank grab.

## Known follow-ups from Stream D (independent audit, 2026-07-25)

- **FIXED** hull lofter ~15% short of `loa`; terrain bathymetry non-monotonic past the outermost contour; added concave and
  multi-island terrain tests.
- **NOT FIXED, documented:** `bilge: 'chine'` vs `'round'` has no geometric effect (faceted-normal attempt broke index-shared
  watertightness in `assertWatertight`/`computeVolume`/`computeHydrostatics`; reverted). Real chines need either a non-shared-index
  hydrostatics path or hard corners authored in `StationCurve` points.
- `TerrainBuilder` silently produces no land mask for **non-closed** coastline polylines — revisit before real venue data (Phase 3.1).
- `WindInfluenceField` structurally matches `TerrainInfluenceField` but has no end-to-end integration test yet.
- I.2 sail cloth pressure is an approximation derived from C.4's scalar `SailAeroState` (C.4 exposes no spatial field).

---

## Phase 2 task 2.1 — Newport venue (first content venue, complete 2026-10-24)

`src/venues/` created (owned solely by this stream). **34 tests / 1 file, all passing**
(`npx vitest run tests/unit/venues`); `npx eslint src/venues tests/unit/venues --max-warnings 0`
clean; `npx tsc --noEmit` reports **zero errors in `src/venues` or `tests/unit/venues`** (the only
remaining repo tsc errors are in the concurrently-in-flight `tests/unit/boats` / `tests/unit/input`
owned by other agents — not this stream).

Files: `definitions/newport.ts`, `data/newport.coastline.ts` (coordinate tables + provenance),
`projection.ts`, `buildVenueTerrain.ts`, `createVenueEnvironment.ts`, `geometry.ts`,
`VenueRegistry.ts`, `index.ts` (barrel). Public API: `getVenue`/`requireVenue`/`listVenues`/
`listVenueIds`, `NEWPORT`, `buildVenueTerrain`, `createVenueEnvironment`, `latLonToVenueLocal`/
`venueLocalToLatLon`, plus the Newport data exports.

**CONTRACT GAP — now CLOSED (by the PhysicsStability stream):** `EnvironmentConfig`
(`src/environment/Environment.ts`) now carries an additive, backward-compatible
`terrainField?: TerrainInfluenceField` that `createEnvironment` forwards to
`createWindField`; `WindInfluenceFieldResult` structurally matches that type, so
`createVenueEnvironment` injects the generated field straight through (its return
shape — still exposing `windInfluence` — is unchanged). The venue's lee/gap/bend
wind effects now modulate the simulated wind, giving `WindInfluenceField` its
end-to-end venue integration (closes part of the Stream-D follow-up above). Test:
`tests/unit/physics/environmentTerrainField.test.ts`.

**Closed-ring follow-up guarded:** TerrainBuilder ignores open coastline polylines, so all four
Newport rings (Aquidneck W shore, Conanicut E shore, Goat I., Rose I.) are authored `closed: true`
with **consistent winding — all OUTER/land rings (negative signed area** in x-east/y-south space,
which TerrainBuilder reads as land-inside). Tests assert closure, winding sign, non-self-intersection
(own segment-intersection check), Goat-centre land / channel-centre water, start/spawn in water
> 3 m, all course marks in water, and a < 2 s build.

**What is approximated (labelled in code):** coastline + bathymetry are hand-digitised, NOT
chart-accurate and NOT from NOAA ENC / any licensed dataset (provenance block +
`coastlineAttribution`). Landmarks map Newport's signatures onto shipped generators: Pell Bridge →
`suspensionBridge` (genuine structural match), Castle Hill + Brenton Reef → `lighthouse`, Fort Adams
→ `breakwater` stand-in (no fort generator exists). Projection is equirectangular tangent-plane
(mean-Earth radius 6371008.8 m → 1° lat = 111.195 km, within 0.005% of 111.19 km); round-trips
< 1 mm; Fort Adams lands < 300 m from its digitised apex. Solar test **reuses** the repo's cited
NOAA reference at 2023-06-21 16:00 UTC (elev 69.45°, az 148°) rather than inventing an unsourced
18:00 UTC magnitude; the 18:00 UTC case is a direction/sign sanity check only.

---

## D.8 scoping decision — materials live in `src/render/`, not `src/generation/`

Tasks.md lists D.8 under Stream D, but TSL (`three/tsl`) is a three.js API, and `generation/` is
ESLint-forbidden from importing three.js (the import boundary that keeps physics headlessly
testable). So the actual node-graph construction lives in `src/render/materials/` — one module per
`MaterialParams.kind` (gelcoat, carbon, anodized, sailcloth, teak, terrain, concrete, water) plus a
shared `wetSurface.ts` darkening helper and a `buildProceduralMaterial(params)` dispatcher. The
frozen `MaterialParams` plain-data contract in `src/types/generation.ts` is what bridges the two
sides. `water` is a deliberate placeholder — full ocean shading is Stream E.4's job.


## Streams I and E completion notes

**Streams I and E are now complete (2026-07-25).** Built via 3 more subagent batches
(2+2+3, same 2-3 concurrency ceiling): Stream I (I.1 BoatView, I.2 sail cloth) and
Stream E (E.1 clipmap, E.4 water shading, then E.2 compute spectrum + E.3 WebGL2
fallback + E.5 foam/spray). Full `npm run ci` green at 752 tests / 35 files at the time (1160 / 61 now, after Stream F), coherence
gate still holding at 1.09cm.

**Real contract gap found and handled, not papered over:** tasks.md's I.2 acceptance
criteria claims cloth is "loaded by the aerodynamic pressure field C.4 already
computes" — this is false. `AeroForce` (C.4) only exposes a scalar `SailAeroState`
per sail (attachment, alpha, driveForce, heelingMoment), never a spatial pressure
field. I.2 derives an approximate per-vertex pressure distribution FROM that scalar
state (luff-to-leech taper scaled by `attachment`, side selected by `alpha`'s sign),
clearly documented in `src/render/cloth/PressureField.ts` as a rendering-layer
approximation layered on top of C.4's real output — not as if the field already
existed. Flag this to whoever eventually revisits C.4/I.2 integration.

**Interface reconciliation across the E.2/E.3/E.5 split:** E.5 was dispatched with
an assumed Jacobian interface since E.2 hadn't landed yet when it was written; once
all three landed, the assumed threshold default (0.5) was recalibrated to 0.3 to
match E.2's actual documented scale (`0 < J < 0.3` = moderate foam, `J < 0` = strong
foam). E.3 independently chose a direct-sum-over-render-targets approach (documented
reasoning: EXT_color_buffer_float isn't universal on mobile WebGL2, so CPU
evaluation was chosen over GPU render-target ping-pong) — this is a legitimate,
separately-justified engineering choice, not a bug, and doesn't need reconciling
with E.2's WebGPU compute approach since they're genuinely different code paths for
different backends by design.

**E.2's scope decision:** true butterfly IFFT via TSL compute was judged impractical
given the current API surface (`instancedArray`/`element()` gives storage-buffer
access, not the 2D `textureStore` read/write a butterfly network needs) — implemented
as a direct Gerstner sum over 128 components per texel instead, using the exact same
spectrum/formula as `WaveFieldCPU.ts` so GPU/CPU coherence is guaranteed by
construction rather than approximated. Verified numerically to agree with
`WaveFieldCPU.ts` at matching query points to <1e-10.

Remaining Phase 1 streams after F: G (game systems, 7 tasks) and H (audio/UI, 4 tasks). Their cross-stream
dependencies are satisfied (`G.1 <- C.5`, `G.6 <- D.9`), so each can start immediately, in any order, batched at the
2-3 agent concurrency ceiling. Recommended next: G (it unblocks Phase 2 task 2.1 together with wiring F/E/I into the app).

---

## GitHub Pages deployment

The app deploys to the custom domain **sailing.messana.ai** on every push to `main`/`master`,
via `.github/workflows/deploy.yml`. Configuration:

- `DEPLOY_BASE=/` is set for the Pages build (not `/sailing/`) because a custom domain serves
  from the root, not a `github.io/<repo>/` subpath. `vite.config.ts` reads this env var.
- The workflow writes `dist/CNAME` containing `sailing.messana.ai` before uploading the Pages
  artifact, so the built output declares its own custom domain independent of the source tree.
- A second, source-tree-level `CNAME` file (repo root, tracked in git) was added by GitHub's
  Pages settings UI when the custom domain was configured there — this is normal and expected;
  both files are redundant with each other by design and neither should be removed.
- Repo owner already completed: (1) setting the custom domain in Settings → Pages, (2) adding
  the DNS `CNAME` record pointing `sailing.messana.ai` → `m3ssana.github.io`. If Pages is ever
  reconfigured, both of these are manual steps outside version control — check Settings → Pages
  first if the deployed site stops resolving.
- **The deployed site is not yet the game.** No app-entry-point wiring exists yet connecting
  Stream D/E/I's generation and rendering code to what actually renders at the URL — that's
  Phase 2 integration work (task 2.1, "first sail"), not started. Visiting the URL currently
  shows whatever the pre-existing bootstrap UI renders.

---

## Hard-won knowledge — read before continuing

Things that cost real debugging time. Do not rediscover them.

### Conventions that bite

- **Winding:** counter-clockwise viewed from **outside** a solid, which yields **positive** signed
  volume from `computeVolume`. An inverted-winding bug was systemic across lofting, sweep and extrude
  and produced correct magnitudes with negative sign — check the sign, not just the number.
- **Wave normals:** the upward normal for a Y-up parametric surface is `T_z × T_x`, *not* `T_x × T_z`.
  The wrong order gives exactly `(0, -1, 0)` on flat water.
- **Direction conventions:** wind and wave directions are the bearing they come **FROM**; current
  direction is where it flows **TOWARDS**. That asymmetry is inherited from Open-Meteo and is
  deliberate. `windVector()` returns the air's velocity, pointing opposite the meteorological bearing.
- **World space:** Y-up, right-handed, `+X` east, `+Z` **south**. Bearing θ → `(sin θ, 0, -cos θ)`.
- **Units:** SI and radians internally, always. Knots and nautical miles exist only in the UI layer.

### Traps in the toolchain

- `three` must be imported as **`three/webgpu`**, and TSL from **`three/tsl`**. Neither ships type
  declarations in 0.180 — `src/three-env.d.ts` provides them. Do not delete it.
- `await renderer.init()` before any render or compute call.
- **Compute shaders are WebGPU-only.** Every compute-dependent feature needs a designed WebGL2
  fallback (ocean spectrum, foam, spray). See `design.md` §2.2.
- Do **not** add a `@types` path alias — it collides with the `node_modules/@types` convention.
  Use `@/types`.
- `noUncheckedIndexedAccess` is on and non-null assertions are ESLint-banned. Array indexing yields
  `T | undefined`; handle it explicitly.

### Bugs already fixed — do not reintroduce

- Knot conversions must derive from `1852/3600` to be exact reciprocals; hand-written decimals were
  off by 4e-6 per round trip.
- Buoyancy was over-counting volume 3× and launching the hull out of the water. The sum of
  `buoyancyPoints[].volume` must equal the computed displaced volume.
- `sailLiftCoefficient` was clamping flat at 1.3, which silently removed stall — and with it the
  central skill mechanic. The curve must rise to a genuine peak and decay.
- Righting-moment GZ had an inverted sign, which would capsize a stable boat spontaneously.
- Module-scope scratch vectors shared across instances caused two `CurrentField`s to alias each
  other's results. Per-instance scratch where instances can be compared.

### Two test expectations were wrong, and were corrected with citations

Both are documented in code comments — do not "fix" them back:

- **Solar position:** 12:00 local *clock* time is **not** solar noon. Expected elevations were
  solar-noon maxima; corrected against the NOAA algorithm.
- **`circularLerp(270°, 90°)`:** exactly antipodal, so both arcs are equally short and the test was
  ill-posed. Replaced with a genuinely non-antipodal case (300° → 60° must cross north).

### The coherence gate

Requirement 4.12 — the boat must sit within 5 cm of the waves the player sees — **passes at 1.09 cm
max / 0.77 cm RMS**, 100% of spectral variance, 24 components, ~600–810 ns per sample.

It first failed at 2.78 m. The cause was a normalization mismatch: the truncated and reference
component sets were built on different frequency grids, so they were not subsets of each other and no
component count could ever have converged. If this test regresses, suspect normalization before
suspecting the component count.

---

## Working practices that held up

- **Concurrency ceiling is 2–3 agents.** Five or six concurrent agents hit service throttling that
  killed stages mid-write, leaving half-implemented files with unused imports as the tell. Two or
  three completed reliably every time. **Reconfirmed 2026-07-25:** all of D.2–D.9 (8 tasks) was
  completed in three batches of 2–3 concurrent agents each, with a full `npm run typecheck && lint
  && test` gate between batches. Every batch landed clean on the first attempt. Do not increase
  concurrency past this ceiling on a hunch that more agents finish faster — the ceiling is
  empirical, not a guess, and this session had explicit pressure to go to 100 and deliberately did
  not, because the actual constraint is service throttling, not task count.
- **Give each agent the full convention block.** Unit, direction and winding conventions, the import
  boundary, and the frozen-types rule. Agents that got this produced code that integrated; the cost
  of omitting it is a repair round.
- **Instruct agents to fix code, not tests.** With one explicit exception for demonstrably wrong
  expectations, requiring a cited reference. This is what caught the two genuinely bad tests instead
  of papering over them.
- **An independent audit agent found a real gap** the authoring pass missed — no workstream owned
  boat rendering or sail cloth, which is why Stream I exists.

---

## Where the authority lives

| Question | File |
|---|---|
| What must be true | `.kiro/specs/sailing-game/requirements.md` |
| How it works | `.kiro/specs/sailing-game/design.md` |
| What to do next, and the DAG | `.kiro/specs/sailing-game/tasks.md` |
| Contracts and their invariants | `docs/interfaces.md` |
| How anything visual must look | `docs/art-direction.md` |
| Branch and PR workflow | `CONTRIBUTING.md` |


---

