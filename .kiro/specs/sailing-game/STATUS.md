# Project status — where to pick up

**Last updated:** 2026-07-25 · **Last commit:** (uncommitted — Stream D complete, not yet committed) · **CI:** green

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

**Stream D (Generation) is now 9 of 9 complete.** D.2–D.9 were built this session by parallel
subagents in three dependency-respecting batches (batch 1: D.2/D.5/D.8; batch 2a: D.3/D.4/D.7;
batch 2b: D.6/D.9), each batch verified against the full suite before the next was dispatched.
Concurrency was capped at 2–3 agents per batch per the documented throttling ceiling below —
not run at higher concurrency despite being asked, because the ceiling is empirically load-bearing.

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
| **E — Ocean rendering** | ❌ not started | |
| **F — Sky, lighting, post** | ❌ not started | |
| **G — Game systems** | ❌ not started | `src/game/` does not exist yet |
| **H — Audio and UI** | ❌ not started | `src/audio/`, `src/input/` do not exist; `src/ui/` has only `strings.ts` |
| **I — Boat rendering** | ❌ not started | |

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
above is the synthesized, action-relevant summary. All fixes above are verified by `npm run ci`:
557 tests / 28 files passing, 0 typecheck/lint errors, 205.9 kB gzipped bundle (4.0% of budget).

---

## Next: Streams E, F, G, H, I (Phase 1 remainder)

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

## (superseded) Original Phase 1 remainder note

D.2's hydrostatics dependency (`C.2 ◄── D.2`) is now satisfiable — Stream C (physics) was already
complete and can be fed a real lofted hull instead of synthetic test meshes. Re-check
`src/physics/hydrostatics/computeHydrostatics.ts` against `StationLofter` output as a sanity pass
before building Stream I (boat rendering), which is the actual consumer of hull+rig+materials.

Per tasks.md's dependency graph, the remaining cross-stream edges are:
- `E.2/E.3 ◄── B.2` (wave spectrum) — B.2 is done, so ocean rendering is unblocked.
- `G.1 ◄── C.5` (rudder moment for helm feel) — C.5 is done, so input/helm is unblocked.
- `G.6 ◄── D.9` (ambient generators) — D.9 is done, so traffic direction is unblocked.
- `I.1 ◄── D.2/D.3/D.8`, `I.2 ◄── D.4 + C.4` — all satisfied, so boat rendering is unblocked.

In other words: every remaining Phase 1 stream (E, F, G, H, I) is now unblocked. tasks.md's suggested
allocation is E:5, F:4, G:7, H:4, I:2 — but the concurrency ceiling below still applies. Recommend
running Stream I (boat rendering, 2 tasks) and Stream E (ocean, 5 tasks) first since they gate the
2.1 "first sail" milestone; batch dispatches at 2–3 agents, verify the full suite between batches,
same discipline as Stream D.

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
