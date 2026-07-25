# Project status — where to pick up

**Last updated:** 2026-07-24 · **Last commit:** `e1493e9` · **CI:** green

This file is the resume point. `tasks.md` is the plan; this is the progress against it.

---

## Current state

`npm run ci` passes end to end:

| Gate | Result |
|---|---|
| `tsc --noEmit` | 0 errors |
| `eslint . --max-warnings 0` | 0 warnings |
| `vitest run` | **324 tests / 20 files, all passing** |
| `vite build` | succeeds |
| `check-no-assets` | pass — no mesh, texture or audio files in the build |
| `check-budget` | **206 kB gzipped, 4.0% of the 5 MB budget** |

Run `npm run ci` first thing to confirm nothing has drifted.

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
| **D — Generation** | 🟡 **1 of 9** | Only D.1 (geometry toolkit) is done. D.2–D.9 remain. |
| **E — Ocean rendering** | ❌ not started | |
| **F — Sky, lighting, post** | ❌ not started | |
| **G — Game systems** | ❌ not started | `src/game/` does not exist yet |
| **H — Audio and UI** | ❌ not started | `src/audio/`, `src/input/` do not exist; `src/ui/` has only `strings.ts` |
| **I — Boat rendering** | ❌ not started | |

Phases 2, 3 and 4 are untouched.

---

## Next task: D.2 — hull lofter

Highest-value next step, because it unblocks the first playable boat and its consumer is already
written and tested.

- Build `src/generation/hull/StationLofter.ts` using the existing toolkit
  (`common/lofting.ts`, `common/curves.ts` — `resampleByArcLength` is the one you need to match
  station point counts).
- Emit a `GeneratedMesh` plus hydrostatic metadata per the frozen `HullParams` / `StationCurve` types.
- `src/physics/hydrostatics/computeHydrostatics.ts` already consumes this and is tested against
  synthetic meshes. Feed it a real lofted hull and the physics parameters fall out.
- Verify with `src/generation/testing/geometryAssertions.ts`: `assertWatertight`,
  `assertConsistentWinding`, `computeVolume`.

Then D.3 (rig), D.4 (sails), D.5 (terrain), D.7 (wind influence field), D.8 (TSL materials).
D.5 and D.7 unblock a venue; D.8 gates all visual work.

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
  three completed reliably every time.
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
