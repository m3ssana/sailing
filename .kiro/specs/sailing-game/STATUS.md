# Project status — where to pick up

**Last updated:** 2026-11-11 · **Last commit:** `50ce7de` (HEAD, pushed to `origin/master`; working
tree clean apart from untracked `.kiro/settings/`). **CI:** green (`npm run ci` exit 0, 1620 tests, stable
across repeated runs). **Latest work: the RealConditions stream** — the real-wave "1 kt / 50° leeway on
a reach" defect is FIXED (leeway sway-damping, bounded wave-added resistance, design-draft flotation,
raised foil stall, completing tacks); the dinghy now sails ≥73–85% of polar on reaches in the REAL
Newport Hs 0.7 m sea, the hull floats at its design waterline (render heave-override hack removed), and
tacks COMPLETE at 8/11 kt. See the "RealConditions stream" section below. The remaining limit is the
SCRIPTED autosail helm pinching in the live venue (Stream G crew), not the physics.

This file is the resume point. `tasks.md` is the plan; this is the progress against it.

> **WaterBoatLook render-polish pass (2026-10-24, supersedes the RenderLook summary
> below):** second-browser-run visual defects fixed — (1) **water radial-streak aliasing**: added
> PER-RING BAND-LIMITING to the Gerstner nodes (`src/render/ocean/SpectrumFallback.ts`
> `bandLimitWeight` + `spacing` arg on `buildGerstnerPositionNode`/`buildGerstnerNormalNode`), a
> far-field normal flatten toward (0,1,0) and a distance roughness widening (`buildDistanceRoughnessNode`,
> Toksvig-style); `WaterMaterial` gained `vertexSpacing` + `cameraPositionUniform`, and `Session` now
> builds ONE water material PER clipmap ring, each band-limited to that ring's cell size (0.5 m inner →
> 64 m outer) with a shared camera uniform, so coarse far rings no longer alias sub-grid chop into
> needles. Near-ring coherence still < 5 cm (new tests in `waveCoherence.test.ts`). (2) **Hull
> invisible**: root cause was TWO things — the near-white gelcoat hull vanished against the pale
> overcast sea (fixed: `BoatView` now picks the boat's distinctive `appearance.deckColor` (navy) when
> `hullColor` is near-white, via `pickVisibleHullColor`), AND the boat floated too low. **UPDATE
> (RealConditions, 2026-10-24): the deep-sink is now FIXED in the physics** — `Buoyancy`'s `refDepth`
> references the design-waterline submergence so the keel settles at ~0.12 m (design draft), and the
> render-side `BoatView.setHeaveOverride` presentation hack (+ the Session line that drove it) has been
> REMOVED; the render view uses the physics heave directly and the hull sits at its waterline with full
> freeboard by construction. (3) **Flat grey sail**:
> replaced the single-sided generic `buildSailcloth` (the chase cam saw its unlit back face) with a new
> two-sided CREAM sailcloth (`src/render/boat/sailSurfaceMaterial.ts`): `DoubleSide`, panel seam lines
> from the generator's vertex-colour panel fraction, and a backlit scatter glow; camber/twist come from
> the baked sail geometry. Verified in headless Chrome/SwiftShader (WebGL2) from chase/helm/drone cams:
> resolved swell with a soft hazy horizon and NO streaking, a navy hull sitting in the water at the
> waterline, and a cream two-sided sail — 0 console/shader errors (only a benign favicon 404).
> `npx vitest run src/render tests/unit/render tests/unit/app` → **709/709**; eslint clean on
> `src/render src/app` + the touched tests; tsc clean on the render/app surface (the only repo tsc
> error is the concurrent physics agent's mid-write `tests/unit/physics/rotationInvariance.test.ts`).
> KNOWN, NOT MINE: during the autosail run the dinghy over-heels / capsizes in the breeze (HEEL 58–84°)
> — the physics roll-fragility / tack-capsize limit owned by `src/physics`/`src/game/assist`, not a
> render defect (the hull + sail render correctly through the heel). **UPDATE (HeadingUnify, 2026-10-24):
> this capsize was the engine-wide heading-convention bug and is now FIXED — the autosail run heels only
> ~6–7° and never capsizes; see the HeadingUnify section below.**
>
> **RenderLook render-polish pass (2026-10-24, earlier, superseded above):** first-browser visual
> defects fixed — the black boat (`src/render/lighting/SceneLighting.ts` hemisphere+ambient fill + a
> ShadowRig `SUN_KEY_GAIN`), the flat ocean (wired a real spectrum `WaveField` from the snapshot into
> the env via `createVenueEnvironment({waveField})`; clipmap water displaces + re-normals per-vertex
> from the SAME components), the glary/over-concentrated water (turbidity-capped Fresnel + scaled
> glitter), and the tilted horizon / cramped chase cam (`horizonLock` 0.35, framing, `?cam=` param).

---

## Current state

`npm run ci` passes end to end:

| Gate | Result |
|---|---|
| `tsc --noEmit` | 0 errors |
| `eslint . --max-warnings 0` | 0 warnings |
| `vitest run` | **1620 tests / 101 files, all passing** (full `npm run ci`, RealConditions stream 2026-10-24; stable across repeated runs). Adds the real-wave sailing GUARD (`tests/unit/app/realConditionsSailing.test.ts`, +3: ≥60% polar on reaches + ≥55% close-hauled, <12° leeway, in the REAL Newport Hs 0.7 m sea). Keeps the rotation-invariance harness (6), mirror symmetry (9), 200 s soaks + capsize contrast (12), assist tack/gybe robustness (tacks now assert COMPLETE at 8/11 kt), re-recorded golden (+ binding negative control), headless autosail end-to-end (2). |
| `vite build` | succeeds |
| `check-no-assets` | pass — no mesh, texture or audio files in the build |
| `check-budget` | **354.0 kB gzipped, 6.9% of the 5 MB budget** (the whole game is imported by the app entry). |

Run `npm run ci` first thing to confirm nothing has drifted.

---

## What is built

### Phase 2 task 2.1 — DINGHY boat + factory (boats agent, 2026-10-24)

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
- UPDATED by the Symmetry stream (2026-10-24) — supersedes the AssistAndSpeed
  reductions about tacking. The predecessor's "a clean tack works in only ONE
  rotational sense because the frozen model is not perfectly port/starboard
  symmetric" was a REAL PHYSICS BUG and is now **FIXED**: `FoilLift` computed
  leeway as `heading − velHeading` WITHOUT wrapping, so on any heading in (π, 2π)
  (the whole westerly half — e.g. the Newport spawn at ~232°) the foils saw a
  leeway off by ≈2π and a nonsense angle of attack. This both broke
  port/starboard mirror symmetry AND was the direct cause of the real-game
  capsize + half-speed on the reported ?autosail run. Fixed to
  `wrapAngleSigned(heading − velHeading)`. A second asymmetry — `AeroForce`'s
  traveller term added to the UNSIGNED boom magnitude — is also fixed (tack-aware
  now). A generic MIRROR-SYMMETRY harness (`tests/unit/physics/mirrorSymmetry.
  test.ts`) proves every force generator and a full 20 s trajectory are now
  port/starboard mirror-images. With the leeway fix + a reworked assist tack
  (foot off to build speed → carry the main sheeted-in through the eye so it
  backs the bow across → heel-capped depower), the assisted tack now completes
  from BOTH senses at 8/11/14 kt with < 45° heel (see the Symmetry section).
  STILL scoped-down and documented: (1) ROTATION-INVARIANCE bug — investigated
  in depth by the PhysicsHeading stream (2026-10-24); see its section below for
  the full diagnosis, the attempted-and-reverted fix, and the characterisation
  harness. (2) A steady controller still can't hit the polar (close reach ~55 %
  of 6.5 kt at 11 kt) or hold a flat 14 kt downwind gybe — the roll-fragility /
  pointing limit that needs the anticipating AI crew (Stream G).

### HeadingUnify stream (2026-10-24) — rotation-invariance FIXED (engine-wide heading-convention unification)

**This supersedes the PhysicsHeading stream's "diagnosed but reverted" writeup
below.** The two-opposite-handed-frames root cause PhysicsHeading diagnosed is
now FIXED engine-wide, and the rotation-invariance harness asserts invariance
and PASSES.

**Root cause (re-verified with numbers):** `fromAxisAngle({0,1,0}, +h)` rotating
`(0,0,-1)` yields `(-sin h, 0, -cos h)` — the X-MIRROR of the physical
`(sin h, 0, -cos h)` the force generators + velocity use (agree only at h=0/π).
`headingFromQuat`'s internal `fx` formula also disagreed in sign with the actual
`rotateVec3((0,0,-1))`. Measured: at h∈{37,90,200,305}° the quat forward x was
exactly `-sin h` vs the physical `+sin h`.

**The unification (all in non-frozen code; `src/types` untouched):**
- `src/core/math/quat.ts`: NEW `quatFromHeading(h)` = rotation about +Y by **−h**
  (so `rotateVec3(q,(0,0,−1)) === (sin h,0,−cos h)` to machine precision — the two
  frames are now ONE). Rewrote `headingFromQuat` to `atan2(f.x,−f.z)` on the real
  rotated forward; rewrote `heelFromQuat` (`atan2(−s.y,u.y)`, +=starboard down)
  and `pitchFromQuat` (`asin(f.y)`, +=bow-up) as geometric extractors; rewrote
  `fromYawPitchRoll` = `qYaw(−yaw)·qPitch(+X)·qRoll(−Z)` so `fromYawPitchRoll(h,0,0)
  === quatFromHeading(h)`. Added `forwardFromQuat/starboardFromQuat/upFromQuat`.
  All round-trip to machine precision (verified for heading/heel/pitch combos).
- `BoatSimulation.reset` uses `quatFromHeading`.
- `RightingMoment` + `HydrodynamicDamping`: now build their roll/pitch/yaw couples
  in the BODY frame and inject via a new `src/physics/forces/torqueCouple.ts`
  `pushBodyAxisTorque` (pure couple = exactly the requested body torque rotated to
  world, zero net force — verified ‖τ_err‖≈1e-12, ‖F_net‖=0 over 5000 random cases).
  HydrodynamicDamping damps `ω_body = q⁻¹·ω_world` per body axis.
- `BoatFactory.estimateInertia`: fixed the roll↔pitch transposition — now returns
  `{x: pitch, y: yaw, z: roll}` to match the integrator's `.x`-about-local-X /
  `.z`-about-local-Z. Documented the mapping in both files.
- `src/game/assist`, the `ScriptedInputProvider` PD helm, the sailing/tack test
  harnesses, and the closed-loop sailing tests: the rudder→heading and ω_y→heading
  signs FLIPPED with the frame unification, so every PD helm became
  `rudder = −he + ω_y` (was `+he − ω_y`) and the assist's bear-off / turn-through-
  the-eye signs were corrected (first-principles justified in-code). The anti-stall
  now LATCHES its bear-off direction (no helm chatter at the eye).
- Camera `modes.ts`: the "fromYawPitchRoll yaw sign and bearingToDirection disagree"
  workaround note is now stale and rewritten — the code already derived body axes
  via `rotateVec3`, which is now correct by construction. All 63 camera tests pass
  unchanged.

**Rotation-invariance harness (`tests/unit/physics/rotationInvariance.test.ts`,
6 tests) now ASSERTS invariance and PASSES:** for θ∈{0,37,90,142,200,305}° the
body-frame scalars (speed/heel/pitch/leeway/yaw-rate) of the same rotated scenario
agree within 0.03 m/s and 0.5°, for Buoyancy / FoilLift / RightingMoment /
HydrodynamicDamping each in isolation AND a driven reach, AND for the full sim over
20 s (worst heel-divergence < 0.5° vs the old > 30°).

**SPEED (the real goal) — MET, and heading-independent.** Heading-pinned PD helm,
11 kt, assisted auto-trim, 40 s per heading, measured % of `solvePolar`:

| TWA | polar (kt) | all 8 wind-FROM bearings {0,45,90,135,180,225,270,315}° |
|---|---|---|
| 50 (close-hauled) | 5.40 | **4.68 kt = 87%** (identical to 2 d.p. at EVERY bearing) |
| 70 | 6.47 | **5.43 kt = 84%** (identical at every bearing) |
| 90 (beam reach) | 6.61 | **5.57 kt = 84%** (identical at every bearing) |

0.00 % variation across all four quadrants (≪ the 10 % tolerance). Thresholds met:
close-hauled 87 % ≥ 55 %, TWA 70 → 84 % ≥ 65 %, beam reach 84 % ≥ 70 %. (Pre-fix:
~20 % of polar and CAPSIZED on westerly/Newport headings.)

**Real browser (headless Chrome/SwiftShader, WebGL2), `?backend=webgl&autosail=1&
offline=1&speed=8`:** `backend=webgl2`, `weatherSource=climatology`, `capsized=false`,
`maxHeelDeg≈6.9°` (pre-fix 58–84° / inverted), `tackCount=1`, boatSpeed ~1.5 kt,
0 errors (only a favicon 404). Screenshots (chase + drone + helm) LOOKED AT: at
Newport wind FROM ~271°, HDG ~209°, the boat heels 6° to **port = leeward** (wind on
the starboard bow), the sail sets out to **port = leeward** — all correct — and the
drone-cam visible heading agrees with the HUD compass. The autosail **gybe** does
not fire in the compressed-clock live run (a timing/venue-wind artifact), but the
headless end-to-end test (`tests/unit/app/autosailEndToEnd.test.ts`, uniform wind
FROM 277° AND north) proves the full scripted sequence executes **≥1 tack, ≥1 gybe,
no capsize, heel < 60°** with the same assist+script+sim.

**Verification:** `npm run ci` exit 0 — tsc 0 errors, eslint 0 warnings, **1617
tests / 100 files pass**, build + no-assets + budget (353 kB, 6.9 %) green. Mirror
symmetry (9), all 12 stability tests incl. the 200 s 30/35/40 kt soaks, the 25 kt
capsize-contrast + 12 kt no-capsize, assist tack/gybe robustness (38), golden
(re-recorded with documented justification; negative control still binds) — all green.

### RealConditions stream (2026-10-24) — real-wave sailing fixed; draft fixed; tacks complete

**This SUPERSEDES the two "DOCUMENTED, NOT fully met" reductions that used to sit
here (the dinghy deep-sink revert, and the tack-completion-only-SAFE reduction).
Both are now FIXED.** The headless acceptance tests passed (84–87% of polar) only
because they sailed in CALM/synthetic water; the REAL game builds a venue
environment with a spectrum wave field (Hs≈0.70 m JONSWAP+swell) + tide/current,
and in it the dinghy collapsed to ~1 kt / 50° leeway on a reach (the reported
browser defect). Reproduced HEADLESSLY via a new pure `buildSessionWorld` (the
factory the Session AND the tests now share), bisected, and fixed at the root.

**Reproduction + bisect (Newport offline, Oct climatology: 11 kt FROM 270°, Hs 0.70 m):**
the exact Session loop (input→assist→setControls→step @1/120) with the autosail
script collapsed from 3.9 kt to ~1.0 kt by t=5 s, leeway −50…−74°, heel 6–7°,
~18–24% of polar — matching the report. Bisect: FLAT water and no-WaveDrag also
collapsed (leeway runaway was the common factor), so waves were the TRIGGER, not
the sole cause. Root causes found (with evidence) and fixed:

1. **Leeway RUNAWAY (dominant) — sway damping.** `HydrodynamicDamping`'s linear
   term lumped surge+sway into one tiny `surgeLinear`=12, so the athwartships
   (leeway) mode was almost UNDAMPED. With the stiff foil, a wave-induced leeway
   spike produced a large unbalanced side force that accelerated the hull
   sideways and overshot into foil stall, from which the leeway/speed loop never
   recovered. Fix: split the linear damping in the BODY frame — light SURGE (12),
   heavy SWAY (600, ~critical for the sway mode), rotation-invariant. Leeway on a
   real-wave reach dropped from −50…−74° to ≈ −1…−3°.
2. **Added resistance in waves — 2–8× too strong.** `HydroResistance.addedResistanceInWaves`
   returned an ABSOLUTE force that at the dinghy's low close-hauled speed was
   +200–300 % of calm resistance (measured +209 % close-hauled). Rewrote it as a
   BOUNDED fraction of the calm friction+residuary (Hs²-scaled, heading-weighted,
   capped ≤ 35 %), matching the cited ~10–25 % for a dinghy at Hs 0.7 m.
3. **Deep sink — FIXED (was the reverted item).** `Buoyancy` `refDepth` now uses
   the volume-weighted mean submergence of the buoyancy points AT the design
   waterline (`≈ waterlineHeight − CoB.y`, computed per-boat in `BoatFactory`),
   so Σ buoyancy = weight at the DESIGN draft by construction: the keel now
   settles at ~0.12 m (design), not ~0.3 m. The previous "it over-stiffened
   stability" finding was traced to the deep-sink-era roll damping (5000 ≈ 4×
   critical), NOT the draft itself — so the JOINT recalibration here lands it:
   roll damping → 2000 (≈1.7× critical), and the foil stall raised ~11°→~15° with
   a gentler post-stall decay (real NACA 00xx). ALL invariants hold: 25 kt
   cleated-no-hike capsizes ~2.4 s; 12 kt full-hike eased does not; 200 s 30/35/40
   kt soaks bounded; mirror symmetry (9); rotation-invariance (6); golden
   RE-RECORDED (justified; negative control still binds). The render
   `BoatView.setHeaveOverride` hack and its Session call site are REMOVED — the
   physics floats the hull right.

**Tacks now COMPLETE (restored from "SAFE only").** The tack technique was
rewritten: the speed thresholds were in m/s but had been set to knot-sized values
(so the boat always ran the long build-to-TWA-90 and never committed); now it
foots only slightly (to a close reach, not a beam reach), carries the main HARD
through the eye to back the bow across, then bears away to a reach to rebuild.
Measured (uniform wind, both senses): tacks CROSS the eye onto the opposite tack
within 12 s, max heel 8–14°, no capsize, at 8 & 11 kt (restored COMPLETES
assertions in `tackRobustness`/`closedLoop`); 14 kt is marginal (asserted SAFE —
documented top-of-range limit). GYBES complete cleanly at 8/11/14 kt (1–5 s, heel
1–4°). Headless end-to-end autosail (`autosailEndToEnd`) still ≥1 tack + ≥1 gybe,
no capsize.

**REAL-wave reach speed — MET (the headline fix):** heading-pinned auto-trim in the
REAL Newport Hs 0.7 m sea at the venue spawn:

| TWA | FLAT (calm) | REAL waves (Hs 0.7) |
|---|---|---|
| 50 close-hauled | 70 % | **73 %** |
| 70 close reach | 86 % | **77 %** |
| 90 beam reach | 86 % | **85 %** |

(Pre-fix in the real sea: close-hauled 16 %, close reach 58 %, beam 78 % with
−25…−50° leeway.) New GUARD test `tests/unit/app/realConditionsSailing.test.ts`
(deterministic, pinned Oct snapshot) asserts ≥60 % of polar on the reaches and
≥55 % close-hauled, all at < 12° leeway, IN the real wave field — the regression
the calm-water acceptance tests could not see.

**Real browser (headless Chrome/SwiftShader, WebGL2), `?autosail=1&offline=1&speed=1`:**
`backend=webgl2`, `weatherSource=climatology`, `capsized=false`, `maxHeelDeg≈14.5`,
`tackCount=1`, `gybeCount=1`, 0 errors (benign favicon 404 only). Screenshots LOOKED
AT (chase): the navy hull sits IN the water with full freeboard (NOT awash — deep-sink
gone), the cream sail sets to the correct leeward side, and the boat moves through
resolved swell with a hazy horizon. **NOTE on the live scripted run:** `?speed>1`
scales the ENV/script time but not the 120 Hz physics step, so a large speed races
the SCRIPT ahead of the physics and the scripted maneuvers do not complete — the
browser acceptance therefore runs at `speed=1` (and `main.ts` now signals `done`
once a tack AND gybe are observed, not on a fixed wall timer). The live scripted HUD
still shows the boat PINCHING/under-performing on its close-hauled legs (~30 % polar)
because the scripted PD helm points too high and the post-tack low-speed recovery is
weak — a scripted-autosail-quality limit (the same steady-controller / Stream-G
limit), NOT a physics defect: the physics itself achieves ≥60 % on reaches with a
proper helm (proven by the guard test, and by a headless replication of the live
loop in the real world which reached 4 kt / ~75 % before the first maneuver).

**Files changed (RealConditions):** `src/physics/forces/Buoyancy.ts` (per-boat
design-draft refDepth), `src/physics/forces/HydrodynamicDamping.ts` (roll 5000→2000,
surge/sway split + `swayLinear`), `src/physics/forces/HydroResistance.ts` (bounded
fractional added-resistance), `src/physics/coefficients/aeroCoefficients.ts` (foil
stall ~11°→~15°, gentler decay), `src/boats/BoatFactory.ts` (`designDraftRefDepth`,
`damping` option), `src/game/assist/index.ts` (tack technique + m/s thresholds +
reach-exit + completion), `src/app/sessionHelpers.ts` (scripted helm leaves the
mainsheet to the assist), `src/app/buildSessionWorld.ts` (NEW shared world factory),
`src/app/Session.ts` (uses buildSessionWorld; heave-override removed),
`src/render/boat/BoatView.ts` (heave-override removed), `src/main.ts` (autosail done
on tack+gybe observed). Tests: `tests/unit/app/realConditionsSailing.test.ts` (NEW
guard), re-recorded `fixtures.golden.ts`, restored COMPLETES in
`tackRobustness`/`closedLoop`, updated the foil-stall-angle test (cited). `npm run
ci` exit 0 — tsc 0, eslint 0, **1620 tests / 101 files**, build + no-assets + budget
(354 kB, 6.9 %) green; full suite stable across repeated runs.

**STILL a documented limit:** the SCRIPTED autosail helm pinches on close-hauled
legs in the live venue, so the live browser run under-performs the polar there and
can look slow; the completing, speed-holding sail needs the anticipating AI crew
(Stream G). The PHYSICS (the actual reported bug) is fixed and guarded.

### PhysicsHeading stream (2026-10-24) — rotation-invariance DIAGNOSED; fix attempted & REVERTED; autosail hook extended

Owns `src/physics`, `src/boats`, `src/game/assist`, `tests/unit/{physics,boats,
game/assist}`, `src/app/sessionHelpers.ts`, and ONLY the autosail/Scripted call
site in `src/app/Session.ts`. `src/types` untouched. Verification (all green):
`npx vitest run tests/unit src/physics src/boats` → **920 passed / 62 files**;
`npx eslint src/physics src/boats src/game/assist src/app tests/unit
--max-warnings 0` → clean; `npx tsc --noEmit` → 0 errors. Did NOT run `npm run ci`.

**ROTATION-INVARIANCE (item 1) — root cause fully diagnosed, fix reverted.**
A new harness `tests/unit/physics/rotationInvariance.test.ts` runs the SAME
body-frame scenario (close reach, uniform wind) at θ ∈ {0,37,90,142,200,305}°
about +Y and compares the frame-free derived scalars (speed/heel/pitch/leeway/
yaw-rate). It CHARACTERISES (and now pins) the bug. Findings:
  - `RightingMoment` and `HydrodynamicDamping` inject their roll/pitch/yaw
    couples about FIXED WORLD axes (a vertical force couple offset in world ±X/
    ±Z → torque about world Z/Y), driven by `state.heel` and the WORLD components
    of `angularVelocity`. Correct only at heading 0/π; grossly heading-dependent
    elsewhere. Isolated body-frame divergence 0.16–0.18 within ~0.5 s vs the
    ~0.08 hull-loft floor for Buoyancy/FoilLift. **This is the direct cause of
    the real-game Newport (spawn ~204–232°, wind ~277°) heading-dependent
    capsize.**
  - `BoatSpec.inertia` (BoatFactory `estimateInertia`) TRANSPOSES roll↔pitch:
    it returns `{x: roll, y: yaw, z: pitch}` but the integrator applies `.x`
    about local X = TRANSVERSE (pitch axis) and `.z` about local Z = LONGITUDINAL
    (roll axis). So the hull resists pitching with the small roll inertia and
    rolling with the large pitch inertia (backwards), and the anisotropy couples
    heading-dependently through `computeWorldInertiaInverse`.
  - DEEPER root cause: the codebase has TWO opposite-handed frames. The force
    generators + the boat's velocity use the PHYSICAL `forward = (sin h, 0,
    −cos h)` (verified: a sailing boat's velocity bearing matches it), while the
    orientation quaternion's `rotateVec3((0,0,−1))` — used for the CoM and
    buoyancy/wave-drag point placement — is the X-MIRROR of it (bearing −h).
    With a fore-aft CoM offset this frame mismatch alone leaves a heading-
    dependent yaw/roll torque even after the couple + inertia fixes.

**Attempted fix → REVERTED (the "plausible fix breaks a different invariant"
doctrine).** A joint rework was implemented: (a) body-axis couples for
RightingMoment/HydrodynamicDamping via a `pushBodyAxisTorque` pure-couple helper;
(b) the inertia roll↔pitch relabel; (c) a unified PHYSICAL frame for the CoM and
buoyancy/wave-drag/foil points (`physicalPointWorld` = X-mirror conjugation of
the quaternion rotation). The couple + inertia fixes alone passed the mirror /
soak / sailing tests and reduced RightingMoment's isolated heading divergence
~40 %, BUT did NOT eliminate the dependence (the frame mismatch dominated), and
adding the unified-frame fix **broke port/starboard mirror-symmetry, the 12 kt
capsize-contrast, and the closed-loop sailing/tack tests** (7 failures). The
closed-loop sim STILL capsized at most headings even with the body-axis couples.
Per doctrine the whole rework was reverted; `RightingMoment.ts` and
`HydrodynamicDamping.ts` carry a KNOWN-LIMITATION note. A proper fix must resolve
the engine-wide `fromAxisAngle`/`headingFromQuat` vs `(sin h,…)` X-mirror
convention (touches render/camera/HUD/venues) — out of this stream's scope and
high-risk. The harness remains as the reproducible characterisation + the target
a future fix must drive to zero.

**SPEED (item 2) — measured, NOT improved (blocked by item 1).** Heading-pinned
PD-helm, 11 kt, eased/auto-trim sheet, 40 s per heading:

| wind FROM | TWA | speed (kt) | maxHeel | capsized |
|---|---|---|---|---|
| 90° (bow ≈ N) | 90 | 3.00 | 8° | no |
| 90° (bow ≈ N) | 70 | 1.71 | 8° | no |
| 0 / 204 / 277° | 50–90 | 1–2.5 | 65–180° | **yes** |

The boat only stays upright and sails (slowly) when it happens to point ≈north;
at Newport's westerly headings it capsizes — the item-1 bug, not a trim/polar
issue. The polar target (ILCA ~5–7 kt beam reach) is therefore not met at any
non-northerly heading. No coefficient was tuned to chase a number. Honest
reduction: speed cannot be met until the rotation-invariance bug is fixed.

**AUTOSAIL (item 3) — DONE.** `src/app/sessionHelpers.ts`'s `ScriptedInputProvider`
already had the PD-helm sequence (close-hauled → tack 26 s → broad reach → gybe
56 s); the Session autosail call site now PASSES the helm (`heading`, `yawRate`,
`windFromBearing` from the boat state) so `?autosail=1` runs it closed-loop
instead of the legacy open-loop fallback. `window.__sailing` (`SailingTestHook`)
gained `gybeCount`, `maxHeelDeg` and `capsized`; the loop counts gybes
(idle→gybing) alongside tacks and tracks worst heel + the capsize flag, so a
browser test can assert "did not capsize". Headless verification: the script +
assist fire **tackCount 1, gybeCount 1** over the sequence (maxHeel 68°,
capsized=true at wind-FROM-north over 70 s — consistent with the unfixed item-1
bug; the hook correctly reports it). Two small additive edits outside `src/app`:
`src/main.ts` test-hook initialiser gained the three new fields (keeps the build
compiling). `src/app/Session.ts` edit limited to the autosail call site + the
hook plumbing (re-read right before editing).

**Tests:** `rotationInvariance.test.ts` (6 — 2 invariance-holds for Buoyancy/
FoilLift + 2 bug-characterisations for Righting/Damping + 1 full-sim gross-
divergence characterisation). Golden baseline UNCHANGED from the speed-gap
re-record (the reverted rework would have moved it; it didn't land). Mirror /
stability / sailing / dinghy / assist / app suites all still green.

**UNRESOLVED:** the rotation-invariance bug itself (fix requires the engine-wide
heading-convention unification), and therefore item-2 speed and the real-game
Newport capsize. The characterisation harness is the hand-off.

### Symmetry stream (2026-10-24) — mirror-symmetry bugs fixed + robust assisted tack

Owns `src/physics`, `src/boats`, `src/game/assist`, `tests/unit/{physics,boats,
game/assist}`, and the `ScriptedInputProvider` autosail script in
`src/app/sessionHelpers.ts`. `src/types` untouched. Verification:
`npx tsc --noEmit` 0 errors; `npx eslint src/physics src/boats src/game/assist
src/app/sessionHelpers.ts tests/unit --max-warnings 0` clean;
`npx vitest run tests/unit/{physics,boats,game/assist,app}` → **191 passed / 17
files**. (The one repo-wide vitest failure, `tests/unit/game/camera/photo.test.
ts`, is a concurrent CAMERA agent's `settings.ts` edit — outside this stream;
it passes with that edit stashed.)

**Two real physics bugs found via a generic mirror-symmetry harness + fixed:**
1. `src/physics/forces/FoilLift.ts` (~line 66) — leeway `heading − velHeading`
   was UNWRAPPED. `heading` ∈ [0, 2π) but `velHeading = atan2(…)` ∈ (−π, π], so
   on westerly headings the leeway was ≈2π too large → garbage foil lift/drag.
   The dominant port/starboard asymmetry AND the real-game Newport capsize/
   half-speed cause (Newport sails on headings > π). Fixed with `wrapAngleSigned`.
   Evidence: pre-fix a pose and its exact mirror diverged ~1 m / 0.3 rad over
   20 s; post-fix ~1 cm. Regression: `mirrorSymmetry.test.ts`
   (`FoilLift leeway … heading-wrap invariant`, fails on old code).
2. `src/physics/forces/AeroForce.ts` (`getSailTrim`) — the traveller offset was
   added to the UNSIGNED boom-angle magnitude, so a non-zero traveller widened
   the boom on one tack and narrowed it on the mirror. Made tack-aware
   (`−sideSign·traveller·k`). Regression: `AeroForce mirrors (incl. traveller)`.

**Mirror-symmetry harness** (`tests/unit/physics/mirrorSymmetry.test.ts`, 9
tests): a generic `assertGeneratorMirrors` runs each generator (Buoyancy, Aero,
FoilLift, HydroResistance, RightingMoment, HydrodynamicDamping, WaveDrag) on a
representative heeled/leeway/yaw-rate pose and its exact mirror (position x→−x,
ω pseudovector, quat conjugation, rudder/traveller/crewLateral negated, wind FROM
b→−b) and asserts the net force/torque are mirror images; plus a full-boat 20 s
trajectory mirror check (uniform wind). All pass.

**Robust assisted tack/gybe** (`tests/unit/game/assist/tackRobustness.test.ts`,
18 tests, closed loop against the real sim + a PD "player" helm). Assist rework
in `src/game/assist/`: `_depoweredSheet` now blends toward the LUFF sheet as heel
builds (works close-hauled, not just reaching — the old one did nothing
close-hauled); the tack machine foots off to build speed, then carries the main
sheeted-IN through the eye (a backed cat-rig main pushes the bow across — the
technique that actually crosses from both senses), with a tight heel-cap; new
`luffSheetFor` helper. Outcome (wind FROM north, where ± senses are true
mirrors):

| manoeuvre | 8 kt | 11 kt | 14 kt |
|---|---|---|---|
| tack, both senses | ✓ heel 5° rec 0.85 | ✓ heel 11–12° rec 1.6 | ✓ heel 31° rec 0.64 |
| gybe, both senses | ✓ heel 3° | ✓ heel 9° | ⚠ crosses but heel 113° (documented strong-wind limit) |

All tacks complete in ≤ 12 s, < 45° heel, no capsize, speed recovers > 60 %, and
hand control back. At the real Newport wind FROM 277° (not self-mirror) the
assist keeps heel bounded well under a knock-down and always hands control back
(the headline regression — the real game ended inverted at ~140°).

**Autosail script** (`ScriptedInputProvider`): gained an optional PD-helm path
(engaged when boat heading/yaw + wind bearing are passed) that steers close-
hauled → tacks at 26 s → bears away to a broad reach → gybes at 56 s; the legacy
`frame(t)` open-loop call is unchanged (existing smoke test still valid).

**SPEED (item 3):** the FoilLift leeway fix raised achieved speed on westerly
headings substantially, but a steady PD-helm controller still reaches only
~54 % of the polar on a beam reach (3.6 vs 6.6 kt) and over-heels/stalls trying
to hold a close reach — the pointing/roll-fragility limit documented above (it
needs the anticipating crew, not a steady helm). Honest reduction, not met.



### AssistAndSpeed stream (2026-10-24) — speed gap fixed + SailingAssist (Phase 2 task 2.1 / G.2–G.3)

New dir `src/game/assist/` (the SEAM the session agent codes against) + three
physics fixes in `src/physics` / `src/boats`. Verification:
`npx vitest run tests/unit src/physics src/boats` → **873 passed / 57 files**;
`npx eslint src/physics src/boats src/game/assist tests/unit --max-warnings 0`
clean; `npx tsc --noEmit` 0 errors. Did NOT run `npm run ci`. `src/types` untouched.

**THE SEAM — `src/game/assist/index.ts`:** `createSailingAssist(opts?)` →
`SailingAssist { update(frame, out): Partial<ControlState>; readonly phase:
'idle'|'tacking'|'gybing'; reset() }`, allocation-free (`update` writes only the
overridden controls into the caller's `out` and returns it). `AssistFrame` carries
`{state, trueWindFromBearing, trueWindSpeed, assist, commands, driverControls, dt}`.
Pure helpers `idealSheetFor(awaDeg, windSpeed)` / `targetHikeFor(heel, awaDeg,
windSpeed)` exported for tests/HUD. Levels: 'simulation' = pass-through (writes
nothing, ignores tack/gybe); 'assisted' = auto-trim main to the attached-flow
ideal (player override wins until released ~1.5 s) + heel-depower + monotone
auto-hike to windward (sign keyed to the TACK, not instantaneous heel, so it never
pumps the roll) + scripted tack/gybe; 'arcade' = assisted + anti-stall bear-off
after >2 s in irons + heavier capsize-prevention depower. Tests:
`tests/unit/game/assist/assist.test.ts` (14, pure semantics) +
`closedLoop.test.ts` (6, real `BoatSimulation`). No three.js, no DOM, no shared
module state.

**SPEED-GAP root causes (item 1) — found with a fixed-state force-balance harness:**
1. **Residuary resistance was dimensionally wrong** (`0.5·ρ·S·V²·Cr`), producing
   **~190 N at 5 kt** (≈14% of the 133 kg boat's displacement weight) — physically
   impossible for a planing dinghy and the wall that pinned the closed-loop sim at
   ~2.5 kt. Fixed to the Froude/Delft displacement-weight convention
   **`R_r = C_r·ρ·g·∇`** (Larsson & Eliasson, Delft Systematic Yacht Series) in
   `HydroResistance.ts` AND `PolarSolver.ts`, and recalibrated the dinghy
   `residuaryCurve` to that convention. Total hull resistance at 5 kt is now
   **Rf 39 + Rr 48 ≈ 86 N** (task-cited ILCA band ~40–70; Chalmers Olympic-Laser
   CFD order of magnitude). Added a documented high-Fn (>0.5) V²-growing
   planing/spray tail so the extreme 30–40 kt storm soak stays bounded (the
   displacement-weight form is V-independent and otherwise removed the high-speed
   brake the old form secretly provided — that regression surfaced in the 35 kt
   soak and the tail fixes it).
2. **PolarSolver velocity triangle had the boat-speed sign inverted**
   (`tws·cos(twa) − speed` for the comes-from-ahead component; correct is
   `+ speed`). On a beam reach this made the computed AWA WIDEN past 90° as the
   boat sped up, so the drive term grew without bound and the solver ran away to
   the 2.5·TWS clamp (~30 kt). Fixed → AWA shrinks with speed as it must.

**Before → after:** polar beam reach @12 kt **5.64 → 6.55 kt** (now genuinely
balanced, not drag-capped); @10 kt **6.61 kt**; close-hauled 45° @12 kt 5.5 kt;
upwind VMG optimum **35° → 45°** (textbook — resolves the predecessor's documented
Task-E reduction as a side effect, item 4); time-domain force balance now supports
**5.8 kt** on a 12 kt beam reach (was ~2.5). leeway < 10° on the reach.

**Item 2 (stay up in a breeze):** with the assist's auto-hike + heel-depower the
dinghy holds a **15 kt beam reach for 60 s with no capsize** (heel settles ~15°);
**25 kt cleated no-hike still capsizes at ~6.3 s** (preserved). The righting curve
(form + 75 kg crew at 0.75 m) peaks ~900 N·m at 20° vs a close-reach sail heeling
moment of a few hundred N·m — ample on paper; the limiter is the transient roll
coupling, not the magnitude. A 20 kt CLOSE reach still capsizes under a steady
controller (documented reduction).

**Item 3 (tack/gybe), closed-loop against the real sim:** gybe from a broad reach
in 10 kt completes without capsize and returns to idle ✓; a tack through the wind
onto the opposite tack completes (TWA sign flips, >60% speed recovery, no capsize,
phase→idle) from a close reach in one rotational sense ✓; from the other tack the
frozen model's near-head-to-wind port/starboard asymmetry + the low (~2–4 kt) entry
speed a non-anticipating controller carries mean the bow can stall short of the eye
— the assist is asserted to do so SAFELY (no capsize, always hands control back via
the 12 s safety timeout) ✓; 'simulation' ignores tack commands ✓; arcade bears off
out of irons by itself ✓; a player sheet override is honoured then released ✓.

**One tried-and-REVERTED fix (per the "plausible fix breaks a different invariant"
doctrine):** rotating the sail CoE application point with the hull (heeling arm ∝
cos heel — physically correct and would self-limit close-hauled heel) diverged the
35 kt / 3 m WaveDrag soak to ~1e97. Reverted; the world-vertical CoE is kept with a
code comment recording why.

**Tests/goldens:** `golden.test.ts` baseline RE-RECORDED (x 25.64→28.30, speed
1.59→1.77, pathLength 28.47→30.72) because the correct lower drag legitimately
moves the open-loop trajectory; the negative control (double the residuary curve)
still diverges, so the golden stays binding. `sailing.test.ts`'s two closed-loop
proofs now auto-trim via `idealSheetFor` (beam reach) / run under the real assist
(upwind VMG at a holdable 55° close reach, +windward made good) since the faster
boat stalls the old fixed-sheet controller — the harness was updated to the
corrected physics, expectations not loosened.



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
| **F — Sky, lighting, post** | ✅ **complete (4/4)** | `src/render/{sky,weather,post,night,lighting,atmosphere}/` — see "Stream F" below |
| G — Game systems | 🚧 in progress | **G.1 Input & helm feel done** (`src/game/input/`, `src/input/`). **Sailing assist done** (`src/game/assist/`: auto-trim, auto-hike, completing tack/gybe; wired into `Session`) — see "AssistAndSpeed" and "RealConditions". **Not started:** the anticipating AI crew (G.2–G.3a), race/start/rules (G.4+), replay. |
| H — Audio and UI | 🚧 in progress | **H.3 HUD done** (`src/game/hud/` view-models + `src/ui/hud/` React/Zustand). **H.4 Cameras & photo mode done** (`src/game/camera/` pure models + `src/render/camera/` three driver) — see "Stream H.4" below. Audio + other UI not started. `src/input/` exists (G.1). |
| I — Boat rendering | ✅ complete (2/2) | `src/render/boat/`, `src/render/cloth/` |

Phases 3 and 4 are untouched. **Phase 2 task 2.1 ("first sail") is now wired: `src/app/Session.ts`
assembles Streams D/E/F/I + weather/environment/boats/venues/input/HUD/camera into a playable
session, and `src/main.ts` boots it.** See the "Phase 2 task 2.1 — first sail wiring" section below.
The deployed site will show the game on the next push (the app entry now renders it).

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
## Stream G.1 — Input and helm feel (complete 2026-10-24)

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


## Stream H.3 — HUD (complete 2026-10-24)

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

## Stream H.4 — Cameras and photo mode (complete 2026-10-24)

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

## Phase 2 task 2.1 — first sail WIRING (complete 2026-10-24)

**THE GAME IS PLAYABLE.** `src/app/` now assembles every completed stream into a session that
launches into Newport in real weather (with the offline fallback ladder) and sails the dinghy with
the keyboard. Owned by the Session stream: `src/app/**` + `src/main.ts` + `index.html` (unchanged) +
two small additive edits elsewhere (below).

Files:
- `src/app/Session.ts` — `createSession(opts)` async → `Session{start/pause/resume/dispose}`. Loads
  the weather snapshot (4 s network timeout → offline ladder), builds the venue environment
  (`createVenueEnvironment`, tide aligned to `snapshot.fetchedAt`), generates the terrain mesh
  (`buildVenueTerrain` → `toBufferGeometry` + `buildProceduralMaterial('terrain')`) and the landmarks
  (via the generator registry, concrete material), builds the boat (`createBoatSimulation` + `BoatView`,
  spawned at `venue.spawn` heading up the beat) and its polar (`solvePolar`, for the HUD target), the
  ocean (`createOceanClipmap` + `buildWaterMaterial`, water assigned to every ring), the atmosphere
  (`createAtmosphereSystem` driving sky/clouds/night/shadows + the water sun/sky/gust hookups),
  the post chain (`atmosphere.createPost`), the camera (`createCameraController` + `CameraRig`), input
  (`InputManager` + `ControlsAdapter` + `BindingMap` via `LocalStorageKeyValueStore`), the HUD
  (`createHudStore` + `mountHud` + `createHudPublisher`, `buildHudViewModel` each frame), and the
  120 Hz game loop (`createGameLoop`). The fixed step runs in the mandated order **input → assist →
  sim.setControls → sim.step**; render interpolates (`BoatView.update(alpha)`), updates ocean +
  atmosphere + camera, then `post.render()`. React never touches the render loop (HUD is published
  through the 10 Hz throttle). Per-frame allocation is kept low (scratch objects reused).
- `src/app/sessionHelpers.ts` — pure, headless helpers factored out for testability:
  `sessionTimeFor`, `sampleTrueWind`/`computeApparentWind`/`signedAngleOffBow`/`courseOverGround`,
  `buildHudInput`, `buildCameraFrame`, `runFixedStep` (the ordering contract), `parseLaunchOptions`
  (`?backend/autosail/offline/speed`), `ScriptedInputProvider` (the autosail sequence: sheet in →
  close-hauled → tack at session-time 20 s), `toAssistLevel`.
- `src/main.ts` — real bootstrap: renderer (`?backend=webgl` forces WebGL2) → `createSession` → boot
  overlay removed on the first frame → fatal error UI on failure. Shows the WebGL2 fallback notice
  banner (req 7.13, text from `src/ui/strings.ts`) when the backend is WebGL2, and publishes the
  `window.__sailing` test hook (`frames, boatSpeedKnots, heading, tackCount, errors, backend,
  weatherSource, done`).

Two small additive edits outside `src/app` (both backwards-compatible, no behaviour change for
existing code):
- `src/render/Renderer.ts` — `createRenderer(canvas, onDeviceLost?, forceWebGL=false)` gained the
  optional `forceWebGL` arg for `?backend=webgl`.
- `src/three-env.d.ts` — added the standard three members the minimal ambient decl lacked:
  `Object3D.scale` and `Vector3.setScalar` (purely additive; `src/types/` untouched, file NOT deleted).

### The assist seam — now on the real module

Originally `Session` used a stub (`src/app/assistStub.ts`) while `src/game/assist` was mid-write. That is done: `Session` imports `createSailingAssist` from `@/game/assist` (tack/gybe scripting, auto-trim, auto-hike) and the stub file has been deleted.

### Verification

- `tests/unit/app/` — 26 new tests across `sessionHelpers.test.ts` (21), `assistAndWeather.test.ts`
  (4), `inputDisposal.test.ts` (1), all passing (`npx vitest run tests/unit/app` → 44/44 incl. the
  pre-existing gameloop tests). They assert: fixed-step ordering (input→assist→sim), knots live ONLY
  in the HUD format layer (HudInput stays SI), the offline weather path yields a `climatology`-labelled
  snapshot, and `InputManager.dispose()` releases every listener.
- `npx tsc --noEmit` — zero errors in `src/app`, `src/main.ts`, the two edited files, and
  `tests/unit/app` (the only repo tsc errors are in concurrently-in-flight `tests/unit/boats/*` and
  `tests/unit/game/assist/*` owned by other agents).
- `npx eslint … --max-warnings 0` — clean (exit 0) for all Session-stream files.
- `vite build` — succeeds (222 modules). `node scripts/check-no-assets.mjs` — pass (no mesh/texture/
  audio). `node scripts/check-budget.mjs` — **347.3 kB gzipped, 6.8% of the 5 MB budget** WITH the
  whole game now imported by the app entry (no longer tree-shaken out).
- **Real-browser smoke test (headless Chrome / SwiftShader, WebGL2 backend)** — harness at
  `%TEMP%\sailing-smoke-game` (copied + retargeted from `sailing-smoke-light` to the real app root on
  port 5203, `?backend=webgl&autosail=1&offline=1&speed=8`). Result: `backend=webgl2`,
  `weatherSource=climatology`, 45 frames, `boatSpeedKnots≈1.1`, **tackCount=1**, `done=true`, **zero
  shader/TSL/runtime errors** (only a benign favicon 404). Screenshots at 2/8/16/26 s show sea + pale
  overcast sky + horizon + sun glitter + the boat (heeling 1°→4° as it sails) + the FULL HUD updating
  (wind, speeds in knots, compass HDG swinging 204°→189° through the tack, trim gauges, and the
  **"SOURCE: Seasonal average (offline)"** label — the offline fallback requirement). TAA correctly
  off on WebGL2 (no `TRAANode` weak-map crash). `?backend=webgpu` on headless SwiftShader falls back
  to WebGL2 and runs clean (50 frames, tack fired, 0 errors), as expected.

### Honest reductions / what looks wrong (labelled in code + here)

- **Ocean waves — WIRED end to end (RenderLook, 2026-10-24).** The Session now builds a real
  spectrum-derived `WaveField` from the snapshot sea state (`buildWaveFieldForVenue` → 24 JONSWAP+swell
  components; Hs matches the snapshot, e.g. Newport offline Hs≈0.70 m) and injects it into
  `createVenueEnvironment` via an additive `waveField` option (forwarded to the frozen
  `createEnvironment`, which otherwise used a FLAT STUB — that stub, not the clipmap, was the real
  "flat sea" root cause: `environment.waves.components` was length 0). The clipmap water material
  (`WaterMaterial`) now takes those SAME components plus a shared session-time uniform and displaces
  every ring per-vertex with a Gerstner sum (`buildGerstnerPositionNode`) + an analytic normal
  (`buildGerstnerNormalNode`), both line-for-line the math in `WaveFieldCPU`. Visible surface and
  physics therefore agree BY CONSTRUCTION: `tests/unit/render/waveCoherence.test.ts` measures the
  render-path vs `WaveFieldCPU` height/displacement error at **< 1e-6 m** (requirement 4.12's 5 cm is
  met with ~4 orders of magnitude of margin). Verified in the real browser (WebGL2): the sea shows
  moving swell + chop with a stable, believable horizon, 0 shader errors. The phase clock is the
  physics session time (`waveTimeUniform.value = t` each frame).
- **Black boat — FIXED (RenderLook, 2026-10-24).** Root cause: the scene's only analytic light was the
  ShadowRig's directional sun, scaled by the RELATIVE `sunIlluminance` (≈0 under overcast), with NO
  ambient/hemisphere term and no guaranteed IBL — every PBR material rendered near-black. Added
  `src/render/lighting/SceneLighting.ts` (a hemisphere + ambient fill driven by `LightingState`, lifted
  toward a bright near-white under overcast) and a `SUN_KEY_GAIN` on the ShadowRig sun. The near-white
  sail now reads as lit sailcloth and the hull shows sun-side/shadow-side shading in the real-browser
  run. Water glare was tamed (turbidity-capped Fresnel so Newport reads green-blue turbid per
  art-direction §4.1, glitter scaled to a sun track not a sheen). Camera: default `horizonLock` lowered
  to 0.35 (level horizon), chase framing pulled back/up, and a `?cam=chase|helm|drone|mast` start-camera
  param added (parsed in `main.ts`). helm/drone verified in the browser.
- **Water radial-streak aliasing — FIXED (WaterBoatLook, 2026-10-24).** The second browser run showed
  the sea as dense radial NEEDLE STREAKS converging on the horizon: the Gerstner sum (and especially its
  analytic normal) applied ALL components identically on every clipmap ring, but the far rings have
  vertex spacing up to 64 m (0.5·2^7), so sub-grid chop (λ ≲ a few m) aliased badly and the sub-vertex
  normal detail made needle specular. Fix = per-ring band-limiting: `bandLimitWeight(k, spacing)`
  (smoothstep fade to 0 as λ → 2·spacing, full at λ ≥ 4·spacing), threaded as a `spacing` arg into
  `buildGerstnerPositionNode`/`buildGerstnerNormalNode`; a camera-distance normal flatten toward (0,1,0)
  (`flatStart`/`flatEnd`) and a Toksvig-style distance roughness+glitter widening
  (`buildDistanceRoughnessNode`). `WaterMaterial` gained `vertexSpacing` + `cameraPositionUniform`;
  `Session` builds ONE water material PER ring at that ring's cell size with a shared camera uniform,
  and `syncWaterLighting` fans the atmosphere's sun/sky/gust uniforms across all rings. Near-ring
  coherence proven < 5 cm and band-limit weight monotonicity/zero-below-Nyquist proven in
  `waveCoherence.test.ts` (new tests). Browser-verified: broad resolved swell + soft hazy horizon, no
  streaks.
- **Hull invisible — FIXED (WaterBoatLook, 2026-10-24).** Two compounding causes. (a) The near-white
  gelcoat hull was invisible against the pale overcast sea → `BoatView.pickVisibleHullColor` now uses
  the boat's distinctive `appearance.deckColor` (navy for the DINGHY) when `hullColor` is near-white.
  (b) The boat floated too low: physics settles the keel ~0.25–0.34 m below mean water (measured via a
  temporary debug) — deeper than the ~0.12 m design draft, so the 0.49 m-tall hull was almost awash. The
  deep sink is a `src/physics`/`src/boats` buoyancy-calibration matter OWNED BY ANOTHER STREAM, not
  render. Render-side flotation presentation added (`BoatView.setHeaveOverride`; Session sets the keel
  to `waveHeight(boat) − waterlineHeight` each frame) so the hull sits AT its design waterline on the
  VISIBLE sea with full deck freeboard and still bobs with the waves — labelled rendering presentation,
  physics heave untouched. Browser-verified from chase/drone: navy hull sitting in the water.
- **Flat grey sail — IMPROVED (WaterBoatLook, 2026-10-24).** The generic single-sided `buildSailcloth`
  showed its unlit BACK face to the astern chase camera (flat uniform grey). Replaced with
  `src/render/boat/sailSurfaceMaterial.ts`: two-sided (`DoubleSide`) CREAM cloth, panel seam lines from
  the generator's vertex-colour panel fraction, a backlit scatter glow, matte roughness. Camber + twist
  come from the baked sail geometry (`SailSurfaceGenerator` luffRound/twist). A full pressure-driven PBD
  deform (`src/render/cloth/`) is a richer future wiring — labelled step up from the flat placeholder,
  not presented as the full cloth sim. Browser-verified from drone orbit: cream two-sided sail.
- **Autosail over-heel / capsize — NOT a render defect (owned by physics/assist).** During the scripted
  autosail run the dinghy over-heels and sometimes capsizes in the breeze (HEEL 58–84°). This is the
  documented physics roll-fragility / tack-capsize limit (`src/physics`/`src/game/assist`), unchanged by
  this pass. The hull + sail render correctly through the heel/capsize.
- **Ambient vessels / traffic not placed** (no render view for ambient vessels exists yet — the known
  Phase-2 gap from Stream F). Skipped and logged once.
- **Weather is `climatology` under `?offline=1`** in the test (no network in the harness). The live
  path (`resolveWeather` → Open-Meteo, 4 s timeout → offline ladder) is wired and used when online.



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
- **The deployed site renders the game as of Phase 2 task 2.1.** `src/main.ts` now boots a
  `Session` (`src/app/Session.ts`) that wires Stream D/E/F/I's generation/rendering + the
  weather/environment/boats/venues/input/HUD/camera stacks into a playable first sail. On the
  next push to `main`/`master` the deployed URL will show the game (sea + sky + boat + HUD) rather
  than the bootstrap UI. Verified in headless Chrome / SwiftShader (WebGL2) — see the Phase 2 §2.1
  section below.

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
- **Heading quaternion (ONE frame — HeadingUnify, 2026-10-24):** body axes are forward = `-Z_body`,
  starboard = `+X_body`, up = `+Y_body` (right-handed: `starboard = forward × up`). The orientation for
  bearing `h` is a rotation about `+Y` by **`-h`** (`quatFromHeading(h)`), NOT `+h` — because a bearing
  increases clockwise from above while `+Y` rotation is counter-clockwise. With it
  `rotateVec3(quatFromHeading(h), (0,0,-1)) === (sin h,0,-cos h)`, so the quaternion frame equals the
  physical `(sin h,…)` force-generator frame — there is only ONE frame. `headingFromQuat(q)=atan2(f.x,-f.z)`
  on the real rotated forward; `heelFromQuat` is +=starboard-down; `pitchFromQuat` is +=bow-up;
  `fromYawPitchRoll(h,0,0)===quatFromHeading(h)`. Build body axes with `forwardFromQuat/starboardFromQuat/
  upFromQuat`, never by re-synthesising `(sin h,…)`. `BoatSpec.inertia` diagonal is `{x:pitch, y:yaw,
  z:roll}`. `+rudder` RAISES heading, `+ω_y` LOWERS it → heading-hold helm is `rudder=-(heading-target)·Kp
  + ω_y·Kd`. The old `fromAxisAngle({0,1,0}, +h)` was the X-mirror of all this — the root cause of the
  heading-dependent capsize/half-speed; proven fixed by `tests/unit/physics/rotationInvariance.test.ts`.
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

