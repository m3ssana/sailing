# Implementation Plan — Live Weather 3D Sailing Simulator

Structured for **parallel agent execution**. The plan is a DAG, not a list:

- **Phase 0** is sequential and blocking. It freezes every module interface so downstream work can fan
  out without stepping on itself. Nothing parallelizes safely until it's done.
- **Phase 1** is nine independent workstreams (A–I) that only touch their own directories and only
  depend on Phase 0's frozen types.
- **Phase 2** integrates them into vertical slices.
- **Phase 3** is content fan-out — the widest parallelism in the project.
- **Phase 4** is polish, performance, and accessibility.

**Ground rules for every agent**
1. Implement only against interfaces frozen in Phase 0. If a contract seems wrong, escalate rather
   than changing it locally — a unilateral change breaks other agents silently.
2. Only write inside your workstream's directories. Cross-workstream edits go through integration.
3. **One git branch per workstream** (`stream/a-weather`, `stream/b-environment`, …), one PR per
   workstream into `main`. Agents may merge autonomously once CI is green. Never push directly to `main`.
   Rebase on `main` before opening the PR. Because streams own disjoint directories, conflicts should be
   limited to lockfiles and the shared type file — and the latter is frozen, so it shouldn't change.
4. Ship tests with the code. A task is not done until its tests pass.
5. Respect the import boundary: `physics/`, `environment/`, `weather/`, `generation/`, `core/` must not
   import three.js. No `.glsl`/`.wgsl` files — shading is TSL in `.ts`.
6. Every visual task conforms to `docs/art-direction.md` (Phase 0.7). It is normative, not advisory.
7. Consult current three.js WebGPU/TSL documentation via Context7 before writing renderer code. The
   WebGPU/TSL API surface moves faster than model training data.

---

## Phase 0 — Foundation and interface freeze (sequential, blocking)

### 0.1 Project scaffold
Vite + TypeScript strict, ESLint + Prettier, Vitest, path aliases. ESLint `no-restricted-imports`
blocking three.js from `core/`, `physics/`, `environment/`, `weather/`, `generation/`, and blocking
`.glsl`/`.wgsl` imports anywhere. GitHub Actions: typecheck, lint, test, bundle budget. Full directory
skeleton per `design.md` §11.
- _Requirements: 11.1, 11.5_
- _Demo: `npm run ci` passes; a three.js import inside `physics/` fails lint._

### 0.2 Freeze the type surface — **the single most important task in the plan**
Author every shared interface with full JSDoc and zero implementation: `WeatherSnapshot`,
`WeatherKeyframe`, `WindField`, `WindSample`, `WaveField`, `WaveSpectrumParams`, `CurrentField`,
`SkyState`, `BoatState`, `ForceGenerator`, `BoatDefinition`, `StationCurve`, `VenueDefinition`,
`LandmarkSpec`, `GeneratedMesh`, `Generator<P>`, `GPUCapabilities`, `QualityKnobs`, `ReplayFrame`,
`CourseDefinition`, `RaceState`, `InputState`, `AudioParams`. Write `docs/interfaces.md` explaining
each contract and its invariants.
- _Requirements: 11.2, 11.6_
- _Demo: `npm run typecheck` passes on a file that imports every type and constructs a stub of each. Every Phase 1 agent can start from this file alone._

### 0.3 Core primitives
`core/math` (Vec3/Quat helpers, `circularLerp`, Catmull-Rom, seeded PRNG, hash), `core/pool`,
`core/events` (typed bus), `core/time` (session clock, time compression), `core/ecs`.
- _Requirements: 8.8, 11.3_
- _Demo: unit tests prove `circularLerp(350°,10°)` crosses 0° and the seeded PRNG is byte-reproducible._

### 0.4 Renderer bootstrap and backend probe
`WebGPURenderer` with WebGPU primary and `forceWebGL` fallback, `await renderer.init()`, device-loss
recovery, `GPUCapabilities` probe, HDR float targets, ACES tonemap, sRGB output.
- _Requirements: 7.1, 7.13, 8.1a_
- _Demo: a TSL-shaded sphere renders identically on WebGPU and on forced WebGL2; the overlay reports the active backend and capability flags._

### 0.5 Game loop and profiler
rAF driver, fixed 120 Hz accumulator, render interpolation, focus-pause, user frame cap.
`FrameProfiler`: CPU sim/scene times, GPU time via timestamp queries where available, draw calls,
triangles, memory trend.
- _Requirements: 4.1, 8.2, 8.10, 8.1a_
- _Demo: sim step count is frame-rate independent; profiler overlay is live; tab blur halts the loop._

### 0.6 Generation harness
`Generator<P>` runner, worker pool with `ArrayBuffer` transfer, IndexedDB result cache, progress
reporting, and the geometry test helpers (volume integration, watertightness, bounds) every generator
agent will use.
- _Requirements: 7.14, 8.6, 8.12, 9.8, 9.9_
- _Demo: a trivial box generator runs in a worker, transfers buffers with zero copy, caches to IndexedDB, and its computed volume matches the analytic value. A build-time check asserts the bundle contains no mesh, texture, or audio files._

### 0.7 Art direction document — **gates all visual work**
Write `docs/art-direction.md` as the normative expansion of `design.md` §8.7: form language, surface
rules, the 12 per-venue palettes with hex values, where fidelity is spent, proportion-heightening limits,
rim-light and aerial-perspective treatment, and UI typography and colour. Include a reference material
sampler scene so agents can check their work against it.
- _Requirements: 7.15, 11.14_
- _Demo: the sampler scene renders every material and every venue palette side by side; two different agents shading a new object independently produce visually consistent results._

### 0.8 Repository setup and continuous deployment
MIT `LICENSE`; README stating the no-telemetry privacy property; centralized string module for future
i18n; GitHub Actions deploying to GitHub Pages on merge to `main` with Vite `base` configured; branch
protection preventing direct pushes to `main`.
- _Requirements: 11.8, 11.10, 11.11, 11.12, 11.13_
- _Demo: a merge to `main` publishes a live playable build at the Pages URL; a direct push to `main` is rejected._

---

## Phase 1 — Parallel workstreams

Nine streams, no cross-dependencies beyond Phase 0. Suggested agent allocation in brackets.

### Stream A — Weather  [3 agents]

**A.1 Open-Meteo providers** — forecast + marine clients with the exact parameter sets from
`design.md` §4.1, 5 s `AbortController` timeout, 2 retries with backoff, error-payload handling,
multi-coordinate batching. _Req 2.1–2.3, 2.7, 2.8_
_Demo: one batched call returns live wind and waves for all 12 venues._

**A.2 Normalization + timeline** — raw JSON → `WeatherSnapshot`; SI conversion; air density from
pressure/temperature; derived `wind.stability`; keyframe timeline with circular direction interpolation,
Catmull-Rom speed, lagged wave build; 1×–60× time compression. _Req 2.1, 2.2, 2.4, 11.4_
_Demo: 12 h of Solent forecast scrubs smoothly; a north-crossing shift interpolates the short way; wave height lags the wind build._

**A.3 Cache, fallback, worker** — IndexedDB with 15-min TTL and stale-while-revalidate, per-venue
throttle, the full fallback ladder with `source` surfaced, bundled climatology tables, all inside
`weather.worker`. _Req 2.5, 2.6, 2.7, 8.6_
_Demo: with the network blocked the game still launches and reports "Climatology (offline)"; restoring the network revalidates in background with no main-thread spike._

### Stream B — Environment simulation  [4 agents]

**B.1 Wind field** — base, oscillation, gust, terrain-influence, and vertical-gradient layers per
`design.md` §5; deterministic seeding; debug visualizer (arrow grid, gust heat map, time series).
_Req 3.1–3.7_
_Demo: coherent puffs advect downwind; oscillation amplitude tracks stability; a test headland casts a wind shadow; two runs with one seed are identical._

**B.2 Wave spectrum + CPU sampler** — `WaveSpectrum` (JONSWAP + swell, directional spreading, three
cascades), `WaveFieldCPU` truncated 24-component Gerstner sharing those parameters, and the < 5 cm
coherence test. **Highest-risk task in the project — do it early.** _Req 4.9, 4.12, 7.2_
_Demo: coherence test passes over 10k random samples; a wireframe grid shows swell plus chop matching live Sydney marine data._

**B.3 Current, tide, wave–current interaction** — `CurrentField` with per-venue spatial pattern,
`TideModel` from `sea_level_height_msl`, steepening where current opposes wind. _Req 2.2, 4.10_
_Demo: SF Bay on a real ebb against the sea breeze yields visibly steeper, shorter waves than slack water at the same wind._

**B.4 Sky state** — solar position from real lat/lon and venue local time; cloud parameters from live
cover. _Req 7.6_
_Demo: sun elevation/azimuth for Newport, Sydney, and Cape Town match a published solar calculator._

### Stream C — Physics  [6 agents]

**C.1 Rigid body + integrator** — 6-DOF state, semi-implicit Euler linear, RK4 angular, force-generator
interface, 120 Hz. _Req 4.1, 11.3_
_Demo: a box dropped on flat water settles at the correct waterline and damps without oscillation._

**C.2 Hydrostatics from mesh** — volume, wetted surface, waterplane, centroids, buoyancy points, and a
heel-swept righting curve, all computed from a `GeneratedMesh`. Consumed by C.3 and C.6. _Req 9.1, 7.2_
_Demo: a generated box hull integrates to its analytic volume; a symmetric hull's centre of buoyancy sits on the centreline._

**C.3 Buoyancy + wave coupling** — multi-point buoyancy against `WaveField`, orbital-velocity drag, slam
detection. _Req 4.9, 4.14_
_Demo: an unpowered hull pitches, rolls, and heaves convincingly in 2 m swell; slams raise impulse events._

**C.4 Aerodynamics** — apparent wind at sail CoE height, `C_L`/`C_D` tables, stall and luffing regimes,
main/headsail slot interaction, and momentum loss through tacks and gybes scaling with turn rate, wave
state, and re-trim timing. _Req 4.2, 4.3, 4.8_
_Demo: drive and heel plotted against trim angle at fixed TWA show a clear optimum with luffing below and stall above; a badly timed tack loses measurably more speed than a well-timed one._

**C.5 Hull resistance + foils** — ITTC friction, residuary curve with hull-speed wall, induced drag,
added resistance in waves; foil lift/drag with immersion-dependent aspect ratio and low-speed stall.
_Req 4.4, 4.5, 4.7_
_Demo: plausible terminal speed; refuses to point inside the no-go angle; stalls into irons when forced._

**C.6 Stability, capsize, foiling, polars** — righting moment from C.2's curve, crew weight as movable
mass, capsize and recovery, foiling takeoff/ride-height/crash-down, and `polar.worker` sweep.
_Req 4.6, 4.11, 5.2, 5.4b_
_Demo: a dinghy capsizes when hiking stops in 25 kt and can be righted; the generated polar has a sensible shape and changing a drag coefficient changes it automatically._

### Stream D — Generation  [9 agents]

**D.1 Common geometry toolkit** — lofting, sweeping, extrusion, revolution, ribbon/tube builders, light
CSG, seeded noise. Everything else in this stream depends on it, so land it first. _Req 9.8_
_Demo: each primitive builder produces watertight, correctly wound geometry with unit tests._

**D.2 Hull lofter** — station-curve resampling, longitudinal interpolation, mirroring, centreline weld,
transom cap, deck and sheerline; emits `GeneratedMesh` plus hydrostatic metadata. _Req 9.1_
_Demo: three different station tables produce a recognizable skiff, keelboat, and catamaran demihull from one generator._

**D.3 Rig builder** — tapered swept mast and boom, spreaders, standing and running rigging. _Req 9.2_
_Demo: a complete rig generates from parameters and scales correctly across boat sizes._

**D.4 Sail surface** — parametric surface from luff/foot/leech plus luff round and broadseam, emitting
the cloth simulation grid directly. _Req 9.3_
_Demo: a generated main and jib have correct dimensions and the grid is directly usable as the PBD mesh._

**D.5 Terrain builder** — coastline polyline rasterization, signed-distance field, relief from noise,
bathymetry from depth contours; emits render mesh, collision heightfield, and depth field. _Req 9.4_
_Demo: a synthetic coastline produces coherent land, beach, and shelving bathymetry; the depth field matches the contours._

**D.6 Landmark generators** — suspension bridge, shell vault, ridge-plateau, skyline, lighthouse,
harbour furniture. Silhouette fidelity is the goal. _Req 9.5_
_Demo: each generator produces a recognizable profile against sky at 2 km._

**D.7 Wind influence field generator** — derive the per-venue 512×512 speed/direction influence field
from coastline and relief via a diffusion/advection approximation. Feeds B.1's terrain layer. _Req 3.5_
_Demo: a generated field for a test headland shows lee shadow, gap acceleration, and shoreline bend without hand painting._

**D.8 Procedural material library (TSL)** — gelcoat with flake and orange peel, anodized alloy, carbon
weave, sailcloth with panel seams, wood decking, wet-surface darkening, terrain colour by
slope/altitude. Conforms to `docs/art-direction.md`. _Req 9.6, 7.15_
_Demo: a material sampler scene renders every material identically on WebGPU and forced WebGL2, and matches the art-direction reference._

**D.9 Ambient world generators** — moored and anchored fleets (reusing D.2's hull lofter at low
resolution), navigation buoys, harbour furniture, signature vessels (ferry, hovercraft, container ship),
gulls and dolphins. _Req 1.8, 1.10, 8.14_
_Demo: a test venue populates with a plausible moored fleet, buoys, and circling gulls, all instanced and inside budget._

### Stream E — Ocean rendering  [5 agents]

**E.1 Clipmap geometry** — 8-ring camera-centred clipmap with grid snapping and per-cascade distance
fade. _Req 8.4_
_Demo: triangle count stays flat at ~65k from bow view to horizon view; no vertex swimming._

**E.2 Spectrum compute (WebGPU)** — TSL compute IFFT over storage buffers, 3 cascades at 256²,
outputting displacement, derivative, and Jacobian. _Req 7.2_
_Demo: the rendered surface matches B.2's CPU wireframe overlay; the runtime coherence assertion holds._

**E.3 Spectrum fallback (WebGL2)** — same butterfly math as TSL ping-pong render-target passes,
2 cascades at 128², plus a 32-component Gerstner vertex path for the Low tier. _Req 7.13_
_Demo: forced-WebGL2 ocean is visually coherent and stays within perceptual tolerance of the WebGPU path._

**E.4 Water shading** — depth absorption, Fresnel, screen-space reflection with sky fallback,
refraction, crest subsurface scattering, GGX sun glitter, per-venue colour and turbidity, gust-texture
surface darkening. _Req 7.3_
_Demo: Palma (clear blue) and Guanabara (murky) from identical camera and sun; crests glow when backlit; an approaching puff is visible on the water._

**E.5 Foam and spray** — Jacobian-folding foam with a persistent decaying accumulation buffer, wake and
bow-wave injection, wind-scaled whitecap coverage; spray via compute `instancedArray` on WebGPU with a
CPU-pool fallback. _Req 7.4, 7.5, 7.13, 8.5_
_Demo: a persistent wake; whitecaps appear near 12 kt and grow with wind; upwind in 20 kt chop throws spray, downwind in the same wind throws far less._

### Stream F — Sky, lighting, post  [4 agents]

**F.1 Atmosphere and probe** — Rayleigh + Mie sky, sun disc, PMREM environment probe regenerated on
threshold change. _Req 7.1, 7.6_
_Demo: a sunrise-to-sunset sweep shows correct sky progression and the water reflects it._

**F.2 Clouds, rain, visibility** — two quarter-res raymarched layers with temporal reprojection driven
by live cover; instanced rain, surface disturbance, lens droplets; aerial perspective from live
`visibility`. _Req 7.6, 7.7, 8.9_
_Demo: overcast Solent renders flat grey, clear Palma scattered cumulus; the next mark vanishes into haze at the reported visibility distance._

**F.3 Shadows and post-processing** — CSM cascades with soft filtering and rig shadows; TSL post chain
with TAA, bloom, motion blur, DoF, procedural LUT grade driven by the venue palette. _Req 7.9, 7.10, 7.15_
_Demo: the mast shadow tracks across the deck through a tack; rigging aliasing is resolved; sun glitter blooms; the grade holds the venue palette._

**F.4 Night** — lunar position and phase from real coordinates and time, procedural star field oriented
by latitude and sidereal time, moonlight with its own glitter track, navigation lights with correct arcs
on all vessels, procedural shore lighting. _Req 7.17_
_Demo: a venue at real local midnight is atmospheric and sailable; nav light arcs are correct from all angles; gust patches are noticeably harder to read than by day._

### Stream G — Game systems  [7 agents]

**G.1 Input and helm feel** — keyboard, mouse, gamepad with analog steering and trim; full remapping;
one-handed scheme; `helmLoad` consumed for gamepad rumble and progressive steering resistance.
_Req 5.3, 5.4, 5.7, 12.4_
_Demo: all controls work on all three devices; bindings persist; the helm visibly and haptically loads up as the boat becomes overpowered and lightens when de-powered._

**G.2 Rules engine** — start sequence, line bias, layline geometry, mark-rounding validation, finish
ordering, right-of-way (starboard/port, windward/leeward, mark-room), penalty turns. _Req 6.2, 6.4_
_Demo: unit tests pass for every right-of-way scenario; a port-tack foul raises a clear notification and penalty._

**G.3 AI fleet and physics LOD** — Helm, Trimmer, and Tactician with `tactics.worker` planning at 4 Hz;
skill tiers as competence, never speed multipliers; the four-tier physics LOD ladder from `design.md` §7.6
with blended transitions. _Req 6.3, 8.6, 8.13_
_Demo: twelve AI boats race using the player's physics and wind field; higher tiers demonstrably play shifts better; a test asserts no AI boat exceeds its polar; LOD promotion produces no position pop._

**G.3a Crew agents and command layer** — AI crew executing hike/ease, hoist, douse, and fore/aft commands
with assist-dependent competence and delay, applying righting moment through the same physics path as
player-moved mass. _Req 5.4a, 5.4b_
_Demo: on the skiff, commanding the crew to hike measurably reduces heel and increases speed; Simulation-level crew responds with realistic delay while Arcade crew anticipates._

**G.4 Replay, ghosts, replay codes** — input stream at 30 Hz plus 1 Hz state checkpoints, embedded weather
snapshot, critically damped correction toward checkpoints on playback, divergence measurement and logging,
compact pasteable replay codes. _Req 3.7, 6.5, 6.5a, 6.5b, 6.5c, 6.6_
_Demo: a replay recorded in Chrome plays back correctly in Firefox with imperceptible correction; a 10-minute race compresses under 30 KB; an injected non-determinism bug produces monotonic divergence growth in the log._

**G.5 Coaching, logbook, progression** — inefficiency detection (pinching, over-trim, bad tack timing,
wrong side of a shift) with actionable text; drills; logbook statistics; unlocks earned via nautical miles
plus challenge completions; procedural cosmetic customization. _Req 6.8, 6.8a, 6.9, 6.10_
_Demo: pinching for 3 s produces "you're pinching — bear away 5°"; the logbook accrues miles from free sailing and unlocks a boat; hull colour and sail number apply without any new assets._

**G.6 Ambient traffic direction** — schedules and routes for signature vessels, moored-fleet placement,
wildlife behaviour, wind-shadow casting from large vessels, all at physics LOD tier 3. _Req 1.8, 1.9, 1.10_
_Demo: a ferry crossing to windward of the player visibly and measurably kills the breeze; ambient vessels are solid to collision._

### Stream H — Audio and UI  [4 agents]

**H.1 Audio synthesis** — Web Audio graph: filtered-noise wind bank tracking apparent wind, rigging
whistle, speed-tracked water noise with bubble grains, enveloped slam bursts, synthesized ambience, and
menu-only ambient pads with no music while sailing. _Req 9.7, 10.1, 10.2, 10.3_
_Demo: 25 kt sounds continuously different from 12 kt with no clip switching; sailing has no music bed._

**H.2 Menus, venue browser, onboarding** — 3D globe with live-conditions markers from the batched fetch,
"find me wind" filter and sort, pre-launch briefing with wind rose, 6-hour trend, tide, and
plain-language summary; first-launch flow that drops straight onto the water at a gentle venue with
optional contextual coaching. Nautical-instrument visual language. _Req 1.3–1.6, 6.11, 11.14_
_Demo: the globe shows live wind at all 12 venues; sorting surfaces the windiest; the briefing reads "18 kt gusting 24 from the SW, choppy, ebb tide against the wind"; a first-time launch reaches the water without a forced tutorial._

**H.3 HUD** — wind indicator, speed and VMG panel, trim gauge, course compass, conditions panel with
data-source label, coaching tips, sandbox "simulated" marking; Full/Moderate/Minimal/None presets;
knots and nautical miles throughout; opaque-backdrop option for contrast. _Req 2.6, 2.9, 5.8, 6.10, 6.12, 12.1_
_Demo: the HUD reads correctly under live, cached, climatology, and sandbox sources, each clearly labelled; all four density presets are usable; speeds read in knots._

**H.4 Cameras and photo mode** — helm with heel/slam head motion, chase, mast-cam, drone, broadcast;
per-mode FOV; horizon lock and reduced-roll options; photo mode with free camera, pause, exposure,
focal length, DoF, and hidden HUD. _Req 5.6, 7.16, 12.3_
_Demo: all five modes cycle while sailing; broadcast auto-frames attractively; horizon lock measurably reduces camera roll; photo mode produces a shareable capture._

### Stream I — Boat rendering  [2 agents]

**I.1 BoatView** — assemble generated hull, deck, and rig buffers into the scene graph with D.8's
procedural materials; per-boat colour and sail-number customization; wetness/spray darkening mask;
navigation lights; render-side interpolation of the 120 Hz physics state. Conforms to
`docs/art-direction.md`. _Req 6.8a, 7.15, 8.5_
_Demo: the dinghy renders from purely generated geometry with correct materials and reads cleanly at both 5 m and 2 km; hull colour and sail number apply live._

**I.2 Sail cloth** — position-based-dynamics cloth on D.4's generated sail grid, constrained at luff,
head, tack, and clew, loaded by the aerodynamic pressure field C.4 already computes; draft position,
twist, telltales, luff flutter, double-sided translucency and backlit scatter. _Req 4.3, 7.8_
_Demo: easing the sheet produces visible luffing exactly when the aero model reports under-attachment; over-trimming visibly flattens and stalls the sail; telltales read correctly on both sides._

---

## Phase 2 — Integration slices (sequential gates)

### 2.1 First sail — the milestone that matters
Wire A + B + C + D.1–D.4 + E + F + G.1 + H.3/H.4 + I into one boat (single-handed dinghy) at one
venue (Newport) in live conditions.
- _Requirements: 1.1, 5.1, 5.3, 5.4, 5.6_
- _Demo: **the game is playable.** Launch into Newport in real weather, sail upwind, tack, bear away, reach, gybe — and it feels like sailing, on a fully procedural boat in a procedural harbour._

### 2.2 Collision and grounding
Rapier adapter for hull-vs-terrain using D.5's heightfield, hull-vs-mark, hull-vs-boat.
- _Requirements: 4.13_
- _Demo: sailing into the shallows grounds and slows the boat rather than passing through terrain._

### 2.3 Physics validation gate
Analytical unit tests, 200k-step soak at 40 kt / 5 m, golden trajectory baselines, computed polars
sanity-checked against published polars for comparable real classes.
- _Requirements: 4.14, 11.3, 11.4_
- _Demo: physics tests run headlessly with no GPU; the soak produces no NaN; a deliberate coefficient change fails the golden test._

### 2.4 Backend parity gate
Every rendering feature verified on WebGPU and forced WebGL2, across the supported browser matrix.
- _Requirements: 7.13, 11.9_
- _Demo: Chrome/Edge run the WebGPU path and Firefox runs the WebGL2 path; both initialize, compile all TSL with no errors, and land within perceptual tolerance; the fallback notice appears only on WebGL2._

### 2.5 Racing slice
G.2 + G.3 + G.3a + G.4 integrated: a full fleet race with start sequence, AI, crew, rules, and replay.
- _Requirements: 6.2, 6.3, 6.4, 6.5_
- _Demo: a complete race against a twelve-boat AI fleet with a real start countdown, validated roundings, and a saved replay that plays back on another browser._

---

## Phase 3 — Content fan-out (widest parallelism)

Content is data plus generator parameters, so these are near-independent. **This is where large agent
counts pay off.**

### 3.1 Venues — 12 tasks, one agent each  [12 agents]
Newport · San Francisco · Sydney · Auckland · Solent · Kiel · Palma · Valencia · Hong Kong · Rio ·
Cape Town · Chicago. Each: coastline and depth-contour polylines with attribution, relief parameters,
landmark specs, water colour and turbidity, wind profile, tide parameters, courses, 12-month
climatology, colour-grade and ambience parameters.
- _Requirements: 1.1, 1.2, 1.7, 7.11, 9.4, 9.5_
- _Demo: each venue is recognizable from the water and needs zero code changes. Chicago/Lake Michigan (no marine API coverage) still produces correct wind-sea from fetch-limited JONSWAP._

### 3.2 Boats — 5 tasks, one agent each  [5 agents]
Single-handed dinghy · twin-wire skiff · small keelboat · foiling catamaran · offshore cruiser-racer.
Each: station table, rig and sail specs, foils, stability, materials, generated polar.
- _Requirements: 5.1, 5.2, 4.11_
- _Demo: five measurably different polars; each class demands different technique; the foiler takes off at a plausible wind speed._

### 3.3 Courses and modes  [4 agents]
Course layouts per venue; Free Sail, Fleet Race, Time Trial, Coastal Passage (multi-hour forecast
evolution and tide gates), Daily Challenge (UTC-date-seeded selection biased to sailable conditions),
Sailing School drills.
- _Requirements: 6.1, 6.2, 6.5, 6.6, 6.7, 6.9_
- _Demo: a Coastal Passage requires planning around a real forecast shift; the same Daily Challenge appears on every client for a given date._

### 3.4 Assist levels
Arcade / Assisted / Simulation affecting only assists and clamps.
- _Requirements: 5.5_
- _Demo: a golden-run test proves the underlying trajectory for identical raw inputs is unchanged across assist levels._

### 3.5 Documentation  [2 agents]
`adding-a-venue`, `adding-a-boat`, `physics-model`, `procedural-generation`, `tsl-conventions`,
`performance-budget`, `interfaces`, `art-direction` (kept current from 0.7), `replay-format`.
- _Requirements: 11.7_
- _Demo: a fresh agent adds a 13th venue following only the docs._

---

## Phase 4 — Performance, quality, accessibility, release

### 4.1 Adaptive quality manager
Knob set from `design.md` §9.5, median-frame-time driver, asymmetric hysteresis, four presets plus
custom, thermal-throttle detection, frame cap, 4 GB VRAM ceiling.
- _Requirements: 7.12, 8.3, 8.1a_
- _Demo: artificial GPU load triggers graceful stepwise downgrade and recovery with no oscillation; simulated throttling reduces quality instead of dropping frames._

### 4.2 Performance hardening
Instancing audit, draw calls under 1,200, zero-allocation hot-path assertion, render-target scaling and
reduced-cadence updates, code splitting, generation under 3 s, 5 MB payload budget.
- _Requirements: 8.1, 8.2, 8.5, 8.7, 8.8, 8.9, 8.11, 8.12_
- _Demo: on the RTX 4050 laptop — 60 FPS at 1080p Ultra and 60 FPS at 1440p High, captured by the frame-time harness. Memory flat over 600 idle frames; gzipped payload under 5 MB._

### 4.3 Accessibility
Keyboard navigation with visible focus, screen-reader labels, AA menu contrast, HUD backdrop option,
colourblind-safe palettes, horizon lock and reduced motion, audio-cue indicators, HUD scaling.
- _Requirements: 12.1–12.4_
- _Demo: the full menu-to-race flow completes keyboard-only; an automated axe scan reports no violations._

### 4.4 Sandbox, attribution, release
Conditions sandbox with unmistakable "simulated" HUD marking; Open-Meteo, DWD, and coastline-data
attribution in credits and conditions panel; final visual and performance baselines.
- _Requirements: 2.7, 2.9, 9.4_
- _Demo: the sandbox reproduces a stored condition set exactly and is clearly labelled; all attributions are visible._

---

## Dependency graph

```
Phase 0  (0.1 → 0.2 → 0.3 ─┬─ 0.4 → 0.5
                            ├─ 0.6
                            ├─ 0.7  art direction  ── gates D.8, E.4, F.*, H.*
                            └─ 0.8  repo + CD)
              │
   ┌──────────┼──────────┬──────────┬──────────┬──────────┬─────────┬─────────┬────────┐
   A          B          C          D          E          F         G         H        I
 weather   environ.   physics   generation   ocean      sky      systems   audio/UI  boat
   │          │          │          │          │          │         │         │        │
   │          │      C.2 ◄── D.2 (hydrostatics need the generated hull)      │        │
   │      B.1 ◄── D.7 (wind terrain layer needs the influence field)         │        │
   │          │          │          │      E.2/E.3 ◄── B.2 (shared spectrum) │        │
   │          │      G.1 ◄── C.5 (helm feel needs rudder moment)             │        │
   │          │      G.6 ◄── D.9 (traffic direction needs ambient generators)│        │
   │          │      I.1 ◄── D.2/D.3/D.8 · I.2 ◄── D.4 + C.4 (cloth needs pressure)   │
   └──────────┴──────────┴──────────┴──────────┴──────────┴─────────┴─────────┴────────┘
                                   │
                      Phase 2  2.1 → 2.2 → 2.3 → 2.4 → 2.5
                                   │
                      Phase 3  (3.1 ∥ 3.2 ∥ 3.3 ∥ 3.4 ∥ 3.5)
                                   │
                      Phase 4  (4.1 → 4.2) ∥ 4.3 → 4.4
```

Seven cross-stream edges exist, all contract-mediated: C.2 consumes `GeneratedMesh` from D.2, B.1 consumes
D.7's influence field, E.2/E.3 consume B.2's `WaveSpectrum` parameters, G.1 consumes C.5's `helmLoad`,
G.6 consumes D.9's ambient generators, I.1 consumes D.2/D.3's buffers and D.8's materials, and I.2 consumes
D.4's sail grid plus C.4's pressure field. Each consumer can be built against a stub of the frozen
interface and integrated later — which is exactly why Phase 0.2 is the gate for everything.

## Agent allocation

| Phase | Parallel agents | Notes |
|---|---|---|
| 0 | 1–2 | Sequential by nature. Interface freeze (0.2) and art direction (0.7) must not be parallelized — they are the two documents everything else conforms to. |
| 1 | 44 | A:3 B:4 C:6 D:9 E:5 F:4 G:7 H:4 I:2 |
| 2 | 2–4 | Integration is inherently serial; use extra agents for the validation gates. |
| 3 | ~23 | 12 venues + 5 boats + 4 modes + 2 docs. The widest fan-out. |
| 4 | 4–6 | Perf hardening benefits from one agent per subsystem audit. |

Peak useful concurrency is 44 in Phase 1 and ~23 in Phase 3. Beyond that, coordination cost exceeds the
benefit — extra capacity is better spent on independent review agents auditing completed workstreams
against their acceptance criteria than on splitting tasks finer.

## Sequencing notes

**Phase 0.2 and 0.7 are the two real gates.** The frozen type surface lets code fan out; the art
direction document lets *visuals* fan out. Skipping either produces work that has to be redone rather
than merged.

**Front-load B.2 (wave spectrum coherence).** It is the highest-risk item in the project. Discovering
that physics and visuals disagree after building the ocean renderer would be expensive to unwind, so the
5 cm coherence gate lands before Stream E's rendering work depends on it.

**Land D.1 and D.2 early within Stream D.** Seven other generation tasks and C.2's hydrostatics depend on
them.

**Treat Phase 4 as a discipline, not a phase.** The frame budget and profiler exist from 0.5
specifically so performance is measured continuously rather than diagnosed at the end.

**Verify both backends continuously.** Parity is a gate at 2.4, but every renderer agent should test on
forced WebGL2 as they go. Retrofitting a fallback is far more expensive than maintaining one.

**Let G.4 do double duty.** Checkpointed replay measures its own divergence, which makes it a continuous
determinism test for the whole physics stack — worth wiring into CI once it exists.
