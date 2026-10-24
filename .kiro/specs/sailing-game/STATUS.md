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
| `vitest run` | **1160 tests / 61 files, all passing** |
| `vite build` | succeeds |
| `check-no-assets` | pass — no mesh, texture or audio files in the build |
| `check-budget` | **205.9 kB gzipped, 4.0% of the 5 MB budget** (unchanged: nothing in Stream F is imported by the app entry yet, so it is tree-shaken out) |

Run `npm run ci` first thing to confirm nothing has drifted.

---

## What is built

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
| G — Game systems | ❌ not started | `src/game/` does not exist yet |
| H — Audio and UI | ❌ not started | `src/audio/`, `src/input/` do not exist; `src/ui/` has only `strings.ts` |
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

