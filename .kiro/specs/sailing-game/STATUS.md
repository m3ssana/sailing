# Project status — where to pick up

**Last updated:** 2026-07-25 · **Last commit:** `eca577e` (pushed to `origin/master`) · **CI:** green

This file is the resume point. `tasks.md` is the plan; this is the progress against it.

---

## Current state

`npm run ci` passes end to end:

| Gate | Result |
|---|---|
| `tsc --noEmit` | 0 errors |
| `eslint . --max-warnings 0` | 0 warnings |
| `vitest run` | **752 tests / 35 files, all passing** |
| `vite build` | succeeds |
| `check-no-assets` | pass — no mesh, texture or audio files in the build |
| `check-budget` | **205.9 kB gzipped, 4.0% of the 5 MB budget** |

Run `npm run ci` first thing to confirm nothing has drifted.

**Streams D, E, and I are all complete (9/9, 5/5, 2/2 tasks respectively).** D.2–D.9 were built by
parallel subagents in three dependency-respecting batches; then Stream I (boat rendering) and Stream E
(ocean rendering) followed in three more batches. Every batch was verified against the full suite
before the next was dispatched, all at the 2–3 agent concurrency ceiling documented below (this
session had explicit pressure to run up to 100 agents and deliberately did not — the ceiling is
empirically load-bearing, not a guess).

All of this session's work is **committed and pushed** to `origin/master` at `eca577e`. GitHub Pages
is configured to deploy the built app to the custom domain `sailing.messana.ai` on every push to
`master` (see the GitHub Pages section below) — note the site currently shows only the existing
bootstrap UI, since none of this session's generation/render code is wired into the app entry point
yet (that wiring is Phase 2 integration work, not yet started).

---

## What is built

### Phase 0 — complete

| Task | Status | Location |
|---|---|---|
| 0.1 Scaffold, ESLint import boundaries, CI | done | `package.json`, `tsconfig.json`, `vite.config.ts`, `eslint.config.js`, `scripts/` |
| 0.2 **Frozen type surface** | done | `src/types/` (9 files) + `docs/interfaces.md` |
| 0.3 Core primitives | done | `src/core/` — `math/`, `pool/`, `events/`, `time/`, `ecs/` (14 files) |
| 0.4 Renderer bootstrap + capability probe | done | `src/render/Renderer.ts`, `GPUCapabilities.ts` |
| 0.5 Game loop + frame profiler | done | `src/app/GameLoop.ts`, `src/render/quality/` |
| 0.6 Generation harness | done | `src/generation/` — registry, worker pool, cache, `testing/geometryAssertions.ts` |
| 0.7 **Art direction** (normative) | done | `docs/art-direction.md` — 12 venue palettes with hex values |
| 0.8 Repo, licence, CI/CD | done | `LICENSE`, `README.md`, `.github/workflows/` |

### Phase 1 — partial

| Stream | Status | Notes |
|---|---|---|
| **A — Weather** | ✅ complete | `src/weather/` (11 files). Providers, normalization, timeline, cache, fallback ladder, worker. Fixtures in `tests/fixtures/open-meteo/`. |
| **B — Environment** | ✅ complete | `src/environment/` (16 files). Wind layers, wave spectrum + CPU sampler, current/tide, sky state. |
| **C — Physics** | ✅ complete | `src/physics/` (23 files). Rigid body, hydrostatics-from-mesh, buoyancy, aero, hull resistance, foils, righting, foiling, polar solver. |
| **D — Generation** | ✅ **complete (9 of 9)** | `src/generation/` — hull (`hull/StationLofter.ts`), rig (`rig/RigBuilder.ts`), sail (`sail/SailSurfaceGenerator.ts`), terrain (`terrain/TerrainBuilder.ts`), landmarks (`landmarks/` — all 7 kinds), wind influence field (`wind/WindInfluenceField.ts`), ambient (`ambient/` — moored fleet, buoys, signature vessels, wildlife). Materials (D.8) live in `src/render/materials/` instead of `src/generation/materials/` — see scoping note below. |
| **E — Ocean rendering** | ✅ **complete (5 of 5)** | `src/render/ocean/` — clipmap geometry, WebGPU compute spectrum, WebGL2 fallback, water shading, foam/spray. See completion notes below. |
| **F — Sky, lighting, post** | ❌ not started | |
| **G — Game systems** | ❌ not started | `src/game/` does not exist yet |
| **H — Audio and UI** | ❌ not started | `src/audio/`, `src/input/` do not exist; `src/ui/` has only `strings.ts` |
| **I — Boat rendering** | ✅ **complete (2 of 2)** | `src/render/boat/` (BoatView scene graph) and `src/render/cloth/` (PBD sail cloth). See completion notes below. |

Phases 2, 3 and 4 are untouched.

---

## D.8 scoping decision — materials live in `src/render/`, not `src/generation/`

Tasks.md lists D.8 under Stream D, but TSL (`three/tsl`) is a three.js API, and `generation/` is
ESLint-forbidden from importing three.js (the import boundary that keeps physics headlessly
testable). So the actual node-graph construction lives in `src/render/materials/` — one module per
`MaterialParams.kind` (gelcoat, carbon, anodized, sailcloth, teak, terrain, concrete, water) plus a
shared `wetSurface.ts` darkening helper and a `buildProceduralMaterial(params)` dispatcher. The
frozen `MaterialParams` plain-data contract in `src/types/generation.ts` is what bridges the two
sides. `water` is a deliberate placeholder — full ocean shading is Stream E.4's job.

## Known follow-ups from Stream D — updated after independent audit + fixes (2026-07-25)

An independent audit (fresh subagents, no access to the implementing agents' self-reports) reviewed
all of D.2–D.9 against the actual code. Findings and resolutions:

- **FIXED — hull lofter was ~15% short of stated `loa`.** `catmullRomSpline3D` can return more
  samples than requested; `interpolateStations` was reading only a truncated prefix of the returned
  array, silently cutting off the stern. Fixed in `StationLofter.ts` by re-indexing evenly across the
  spline's *actual* returned length instead of assuming length equals the request. Regression test
  added (`hullLofter.test.ts`: "spans the full stated loa longitudinally"). `MooredFleet`'s
  previously-loose bounds check (2–15m, which would have passed even with the bug) was tightened to
  the real expected range now that the underlying fix landed.
- **NOT FIXED, now honestly documented — `bilge: 'chine'` vs `'round'` has no geometric effect.**
  An attempt to add real faceted (flat-shaded) normals for chine hulls via per-triangle vertex
  duplication was tried and reverted: this codebase's `assertWatertight`, `computeVolume`, and
  `computeHydrostatics` all identify a closed edge by shared vertex *index*, and facet-style
  duplication breaks that by design (every triangle gets unique indices, so no edge is ever
  "shared"). That is a real architectural incompatibility, not a bug to paper over — implementing
  genuine chine support requires either a non-shared-index hydrostatics path or authoring the chine
  as a hard corner directly in `StationCurve` points (which already works today and produces a
  correctly watertight, sharp-cornered hull — just still smooth-shaded). Tests in `hullLofter.test.ts`
  now lock in current behavior explicitly (same topology for both bilge values) so a future real fix
  is a visible, deliberate diff rather than a silent regression.
- **FIXED — terrain bathymetry was non-monotonic past the outermost depth contour.** Unbounded
  inverse-distance-weighting let a point beyond the deepest contour get pulled back toward a
  numerically-closer but shallower contour, causing depth to shallow then re-deepen near the venue's
  far edge. Fixed in `TerrainBuilder.ts`'s `buildBathymetry` by holding at the deepest contour's depth
  once a point is at or beyond it, rather than continuing to blend with shallower contours.
  Regression test added.
- **FIXED (coverage gap) — terrain tests only exercised one convex rectangular coastline.** Added
  concave (L-shaped, non-convex) and multi-island (archipelago) coastline fixtures plus an explicit
  test for open (non-closed) coastlines. All passed immediately against the existing point-in-polygon
  logic — the underlying code was already correct, the audit's concern was about absence of proof,
  not a latent bug. Also documented (via the new open-coastline test) a real, previously-implicit
  limitation: `TerrainBuilder` silently produces no land mask contribution at all for non-closed
  coastline polylines. This will matter once real venue coastline data (which may not always form
  closed rings) is plugged in — worth revisiting before content fan-out (Phase 3.1).
- **Not fixed (acknowledged, lower priority) — D.7's `WindInfluenceField` output shape.** The audit
  found this is actually LOW risk, correcting the prior handoff: `WindInfluenceFieldResult` structurally
  matches `src/environment/wind/layers/terrain.ts`'s existing `TerrainInfluenceField` contract field-
  for-field (same encoding, same channel semantics, round-trips correctly). No integration work is
  actually blocked here — just needs a real end-to-end test wiring the two together, which hasn't been
  written yet.
- **Not fixed (acknowledged, cosmetic) — material tests only assert non-null node graphs**, and
  Wildlife's JSDoc triangle-count comments (~60-90) undercount actual output (~100-130) though the
  test bounds themselves are correct. Neither blocks downstream work.
- Two deliberately non-deduplicated `harbourFurniture` implementations (D.6 vs D.9) — confirmed by
  direct audit comparison to be genuinely different in API and purpose, not accidental duplication.

Full audit trail (per-generator findings, severities, verdicts) is not preserved verbatim here; the
above is the synthesized, action-relevant summary. All fixes above were verified by `npm run ci` at
the time (557 tests / 28 files, D-stream only, before Streams I/E were built) — see the "Current
state" table at the top of this file for the up-to-date count (752 / 35, after I/E).

---

## Streams I and E completion notes

**Streams I and E are now complete (2026-07-25).** Built via 3 more subagent batches
(2+2+3, same 2-3 concurrency ceiling): Stream I (I.1 BoatView, I.2 sail cloth) and
Stream E (E.1 clipmap, E.4 water shading, then E.2 compute spectrum + E.3 WebGL2
fallback + E.5 foam/spray). Full `npm run ci` green at 752 tests / 35 files, coherence
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

Remaining Phase 1 streams: F (sky/lighting/post, 4 tasks), G (game systems, 7 tasks),
H (audio/UI, 4 tasks). None of these are yet started. Recommend F next since it's the
smallest remaining stream and Stream E's water shading already reads sun direction
from `SkyState.ts`, so F.1 (atmosphere/probe) is a natural continuation of work
already touched this session.

All of F/G/H's cross-stream dependencies are satisfied per tasks.md's dependency graph:
`G.1 ◄── C.5` (rudder moment, C.5 done), `G.6 ◄── D.9` (ambient generators, D.9 done).
F has no documented cross-stream input dependency beyond Phase 0's art-direction gate,
which is done. In short: F, G, and H can each start immediately, in any order, batched
at the same 2–3 concurrency ceiling as every prior stream this session.

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
