# Requirements — Live Weather 3D Sailing Simulator

## Overview

A browser-based 3D sailing game built on three.js. The player picks a real sailing venue from a
world map, and the game builds that session's wind, sea state, tide, and sky from **live public
weather data** for that exact location and moment. Physics are force-based (aero + hydro), not
scripted, so trimming sails and steering the right angles is what makes the boat go fast.

Target platform is **desktop with a discrete GPU**, WebGPU-first with a WebGL2 fallback, maximum
visual fidelity, with an adaptive quality system so mid-range machines still hold a playable frame
rate.

**v1 is purely client-side** — no backend, no server, no accounts. And **all content is generated
procedurally in three.js** — no imported 3D models, no image textures, no audio files. Hulls, sails,
rigs, terrain, landmarks, materials, and sound are all synthesized at runtime from parameters.

### Design pillars

1. **Real conditions, real consequences.** The wind you fight is the wind actually blowing there.
2. **Physical, learnable, exploitable.** Same inputs always produce the same forces. Skill is
   reading wind shifts and trimming, not memorizing a track.
3. **Fidelity you feel.** Water, spray, heel, and sound sell speed more than a speedometer does.
4. **Fun in 30 seconds, deep for 30 hours.** Instant sail-away, with racing and progression on top.
5. **Everything is generated.** Content is code and parameters, not art files. One parameter table
   defines a boat's geometry *and* its physics, so the two can never disagree.
6. **Stylized, not photoreal.** Clean readable forms and curated palettes under physically based
   lighting. Fidelity is spent on water, sky, and light — not on micro-detail.

---

## 1. Venue selection

**User story:** As a player, I want to choose from real sailing venues worldwide so that I can sail
somewhere meaningful to me and see what it's like there right now.

### Acceptance criteria

1.1. The game SHALL ship with at least 12 curated venues spanning all major sailing regions,
each defined as data (no code changes to add a venue).

1.2. Each venue definition SHALL include: display name, region, latitude/longitude, timezone,
simplified coastline and depth-contour polylines, procedural terrain parameters, racecourse layouts,
tidal-current model reference, procedural landmark descriptors, and a difficulty rating — all as
numeric/JSON data, with no binary art assets.

1.3. WHEN the venue browser opens THEN the system SHALL display a 3D globe or world map with venue
markers, and each marker SHALL show a live conditions summary (wind speed, direction, gusts, air
temperature, local time) fetched for that venue.

1.4. WHEN live conditions for a venue cannot be fetched THEN the system SHALL show the venue with a
"climatology" badge and use seasonal-average conditions rather than hiding the venue.

1.5. The venue browser SHALL let the player filter and sort by current wind strength so they can
find "somewhere windy right now" in one action.

1.6. WHEN a venue is selected THEN the system SHALL display a pre-launch briefing showing the wind
rose, forecast trend for the next 6 hours, tide state, wave height/period, and a plain-language
condition summary (e.g. "18 kt gusting 24 from the SW, choppy, ebb tide against the wind").

1.7. The initial venue set SHALL include: Newport RI, San Francisco Bay, Sydney Harbour, Auckland
Hauraki Gulf, The Solent, Kiel Bay, Palma Bay, Valencia, Victoria Harbour Hong Kong, Guanabara Bay
Rio, Table Bay Cape Town, and Lake Michigan / Chicago.

1.8. Each venue SHALL be populated with procedurally generated ambient life: moored and anchored
fleets, navigation buoys and harbour furniture, gulls, and one or two venue-signature vessels
(e.g. a Sydney ferry, a Hong Kong Star Ferry, a Solent hovercraft) following plausible routes.

1.9. Ambient vessels SHALL be physically present rather than scenery: they SHALL be solid for
collision purposes and SHALL cast wind shadows, so a ferry passing to windward genuinely disturbs the
player's breeze.

1.10. Venues SHALL support marine wildlife accents — gulls that react to the boat, and occasional
dolphins riding the bow wave — as low-cost atmosphere.

---

## 2. Live weather integration

**User story:** As a player, I want in-game wind and sea state to match the venue's actual current
weather so that sailing there feels like sailing there.

### Acceptance criteria

2.1. The system SHALL source atmospheric conditions from the Open-Meteo Forecast API
(`api.open-meteo.com/v1/forecast`) requiring no API key, using at minimum:
`wind_speed_10m`, `wind_direction_10m`, `wind_gusts_10m`, `temperature_2m`, `pressure_msl`,
`cloud_cover`, `cloud_cover_low/mid/high`, `visibility`, `precipitation`, `weather_code`,
`shortwave_radiation`, `is_day`.

2.2. The system SHALL source sea state from the Open-Meteo Marine API
(`marine-api.open-meteo.com/v1/marine`) using at minimum: `wave_height`, `wave_direction`,
`wave_period`, `wind_wave_height/direction/period`, `swell_wave_height/direction/period`,
`ocean_current_velocity`, `ocean_current_direction`, `sea_level_height_msl`,
`sea_surface_temperature`.

2.3. Forecast requests SHALL use `wind_speed_unit=kn`, `cell_selection=sea` for marine and offshore
points, `timezone=auto`, and request `minutely_15` wind where available so gust structure has
sub-hourly resolution.

2.4. The system SHALL fetch a rolling window (past 1 h through next 12 h) and interpolate to the
session clock, so conditions **evolve during play** — wind builds, veers, and dies as the real
forecast does.

2.5. Weather responses SHALL be cached client-side (IndexedDB) with a TTL of 15 minutes, keyed by
venue and rounded coordinate, and the cache SHALL be served immediately on repeat visits while a
revalidation request runs in the background.

2.6. IF a weather request fails, times out (>5 s), or returns an error object THEN the system SHALL
fall back in order: (a) stale cache, (b) per-venue seasonal climatology table bundled with the
build, (c) a safe default of 12 kt onshore breeze — and SHALL surface which source is in use.

2.7. The system SHALL respect Open-Meteo's non-commercial usage terms, batch venue-browser requests
into a single multi-coordinate call, throttle to at most one refresh per venue per 15 minutes, and
display the required DWD / Open-Meteo attribution in the credits and conditions panel.

2.8. No API key SHALL be embedded in client code. IF a keyed provider is added later THEN requests
SHALL be proxied through a server-side function that holds the key.

2.9. The player SHALL be able to override live conditions with a manual "conditions sandbox"
(wind speed, direction, gust factor, wave height, time of day) for practice and for deterministic
testing, and the HUD SHALL clearly mark the session as simulated rather than live.

---

## 3. Wind model

**User story:** As a sailor, I want wind that shifts, gusts, and bends around land so that reading
the water and playing the shifts is rewarded.

### Acceptance criteria

3.1. The wind field SHALL be a function `wind(position, time) → vector`, sampled by physics, sails,
visuals, and AI from one shared source of truth.

3.2. The base layer SHALL be the interpolated live forecast wind (speed, direction, gust ceiling).

3.3. The system SHALL add an oscillation layer producing realistic phase-shifted direction changes,
with amplitude and period derived from the venue's stability profile and the forecast's gust spread.

3.4. The system SHALL add a travelling-gust layer: coherent puffs and lulls advecting downwind at
roughly the gradient wind speed, whose peak magnitude is bounded by `wind_gusts_10m`, and which are
**visible on the water surface** as darker ruffled patches before they arrive.

3.5. The system SHALL model land effects per venue: wind shadow behind terrain, acceleration through
gaps and around headlands, and a shoreline lift/bend zone. These SHALL be authored as a per-venue
influence map, not hardcoded logic.

3.6. The system SHALL apply a vertical wind gradient so apparent wind at masthead height exceeds
that at deck height.

3.7. Given the same seed and the same weather snapshot, the wind field SHALL be deterministic and
reproducible, so ghost replays and leaderboard runs are verifiable.

---

## 4. Sailing physics

**User story:** As a player, I want the boat to respond to real aerodynamic and hydrodynamic forces
so that trimming and steering skill actually matters.

### Acceptance criteria

4.1. The boat SHALL be simulated as a 6-DOF rigid body (surge, sway, heave, roll, pitch, yaw)
integrated at a fixed timestep of 120 Hz, decoupled from render rate, with interpolated rendering.

4.2. Apparent wind SHALL be computed from true wind minus boat velocity at each force application
point, and driving/heeling force SHALL derive from a sail lift/drag coefficient curve as a function
of angle of attack, including stall past the separation angle.

4.3. Sail trim SHALL be a continuous control. The system SHALL model luffing when over-eased and
stall when over-trimmed, and SHALL show visible telltale and sail-shape feedback for both.

4.4. The hull SHALL generate resistance from at least: frictional drag, residuary/wave-making drag
rising sharply near hull speed, induced drag from side force, and added resistance in waves.

4.5. Keel/foil/rudder SHALL generate lift resisting leeway, with an effective lift coefficient that
depends on speed and leeway angle and that reduces as the foil unloads at low speed.

4.6. Righting moment SHALL come from ballast and/or crew weight, and the system SHALL support
**capsize and recovery** for dinghies and multihulls when heeling moment exceeds righting moment.

4.7. The boat SHALL not sail closer than its polar no-go angle: inside it, drive collapses and the
boat stalls into irons and requires backing the sail or bearing away to recover.

4.8. Tacking and gybing SHALL cost momentum, with loss scaling from turn rate, wave state, and how
well the player times the roll and re-trim.

4.9. Waves SHALL exert real forces: buoyancy sampled at multiple hull points against the animated
water height field, orbital-velocity drag, slamming when the bow re-enters, and surfing acceleration
on the downwave face.

4.10. Tidal and ocean current SHALL translate the boat over the ground and SHALL alter wave shape
where current opposes wind (steeper, shorter seas), reproducing effects such as an ebb-against-
seabreeze chop.

4.11. Foiling boats SHALL model takeoff, ride-height control, and dramatic drag reduction once
airborne, plus crash-down when ride height is lost.

4.12. The CPU wave-height sampler used by physics and the GPU vertex displacement used for rendering
SHALL be driven by the same spectrum and parameters, so the boat visibly sits in the waves it is
reacting to. Deviation between sampled and rendered surface height SHALL stay within 5 cm.

4.13. Collisions SHALL be handled for hull-vs-terrain (grounding), hull-vs-mark, and hull-vs-boat,
with damage/penalty consequences rather than hard stops.

4.14. Physics SHALL be numerically stable across 5–40 kt of wind and 0–5 m wave height, with no
divergence, tunneling, or NaN propagation over a 30-minute session.

4.15. The system SHALL model consequences without modelling gear failure: capsize, grounding, and
collision SHALL carry speed, handling, and penalty consequences, but v1 SHALL NOT simulate torn sails,
broken halyards, rig failure, or man overboard.

---

## 5. Boats and controls

**User story:** As a player, I want distinct boats with genuinely different handling so that trying
a new class feels like learning something new.

### Acceptance criteria

5.1. The game SHALL ship with at least 5 boat classes with distinct hull, rig, and foil parameters:
a single-handed dinghy, a twin-wire skiff, a small keelboat, a foiling catamaran, and an offshore
cruiser-racer.

5.2. Boat parameters SHALL live in data files, and the system SHALL generate and expose a **polar
diagram** (target speed by true wind angle and speed) computed from the physics model, not authored
by hand — so the displayed target is the real target.

5.3. Controls SHALL support keyboard, mouse, and gamepad, with continuous analog steering and trim
on gamepad axes, and SHALL be fully remappable.

5.4. Available controls SHALL include: rudder, mainsheet, jib/headsail sheet, spinnaker set/douse,
traveller or vang, centreboard/daggerboard depth, crew weight fore-aft and athwartships, and hike.

5.4a. **The player is always the helm.** On boats that realistically require more than one person, the
remaining crew SHALL be AI-operated, and the player SHALL direct them through a small command layer
(hike harder / ease out, hoist, douse, move forward, move aft) rather than controlling them directly.
Crew competence SHALL be part of the assist level: Arcade crew anticipates correctly, Simulation crew
responds only to commands and with realistic delay.

5.4b. Crew position and mass SHALL remain physically real regardless of who is controlling it — AI crew
movement SHALL apply the same righting moment as player-controlled movement.

5.5. The system SHALL offer three assist levels — Arcade (auto-trim, no capsize), Assisted
(auto-trim hints, forgiving), Simulation (full manual, full consequences) — affecting only assists
and never the underlying physics constants.

5.6. Camera modes SHALL include cockpit/helm (with head movement tied to heel and slam), chase,
mast-cam, drone/free orbit, and a broadcast/cinematic mode, all with configurable FOV.

5.7. The system SHALL model **helm feel**: rudder force rising with heel, speed, and sail imbalance,
surfaced as gamepad rumble intensity and as progressive steering resistance. Weather helm building as
the boat becomes overpowered SHALL be perceptible through the controls, since it is one of the
strongest real feedback cues that a boat needs de-powering.

5.8. Units SHALL follow sailing convention rather than regional locale: boat and wind speed in **knots**
and distance in **nautical miles** at all times, with wave height in metres and temperature localized.
An imperial toggle SHALL convert wave height and temperature only.

---

## 6. Game modes and engagement

**User story:** As a player, I want goals and progression so that I keep coming back rather than
sailing in circles once.

### Acceptance criteria

6.1. Free Sail SHALL let the player launch into any venue in live conditions with no objectives.

6.2. Fleet Race SHALL run a windward/leeward or coastal course against AI with a start sequence,
line bias, layline geometry, mark rounding validation, and finish ordering.

6.3. AI opponents SHALL sail using the same physics and the same wind field as the player, with
skill tiers expressed as trim accuracy, tactical lookahead, and shift-reading ability — never as
speed multipliers.

6.4. The system SHALL implement core racing rules sufficient for fair play: starboard/port,
windward/leeward, mark-room, and penalty turns, with clear on-screen notification of an infringement.

6.5. Time Trial SHALL run a fixed course in the venue's current live conditions and SHALL record a
replay consisting of the input stream, the **embedded weather snapshot**, the seed, and **periodic state
checkpoints**.

6.5a. Because floating-point results are not bit-identical across CPUs, browsers, and JS engines,
replay playback SHALL NOT rely on input-only re-simulation. The system SHALL write a full state
checkpoint (position, orientation, linear and angular velocity, control state) at a fixed interval of
1 second, and on playback SHALL re-simulate from inputs while correcting toward each checkpoint,
so a replay reproduces on any machine within a visually imperceptible tolerance.

6.5b. Replays SHALL embed their weather snapshot rather than referencing it for refetch, so a replay
remains reproducible indefinitely and cannot be invalidated by conditions changing.

6.5c. Divergence between re-simulation and the next checkpoint SHALL be measured; IF divergence exceeds
a threshold THEN the system SHALL log it in development builds, since sustained growth indicates a
genuine determinism bug rather than float drift.

6.6. The system SHALL provide a **Daily Challenge**: a venue and course selected deterministically
from the UTC date so every player on a given day gets the same challenge, sailed in that day's real
conditions, with a locally stored leaderboard of the player's own attempts. Runs SHALL be shareable
as a compact **replay code** (compressed input stream, checkpoints, and embedded condition snapshot)
that another player can paste to race the ghost. Since v1 has no server, replay codes SHALL be treated
as social sharing rather than as a cheat-proof competitive ranking, and the UI SHALL not imply global
verification.

6.7. Coastal Passage SHALL offer longer point-to-point runs using multi-hour forecast evolution, so
the player must plan around a wind shift or a tide gate.

6.8. Progression SHALL be structured as a **logbook** rather than a narrative campaign. Unlocks SHALL be
earned through **nautical miles sailed plus challenge completions** — not race wins alone — so free
sailing and exploration both count as progress. The logbook SHALL track per-venue and per-boat
statistics (best speed, best VMG, tack efficiency, miles sailed).

6.8a. Customization SHALL cover hull and deck colour, sail number, procedurally patterned sail
graphics, and crew kit colour — all generated, so cosmetics cost no additional payload.

6.9. A Sailing School mode SHALL teach points of sail, trim, tacking, gybing, and starts through
short interactive drills with pass/fail feedback.

6.10. WHEN the player sails inefficiently THEN the coaching layer SHALL surface actionable feedback
(e.g. "you're pinching — bear away 5°", "main is over-trimmed") rather than a bare score.

6.11. First launch SHALL place the player directly on the water in favourable conditions at a gentle
venue, with contextual coaching available but never forced. The tutorial SHALL be discoverable, not
mandatory.

6.12. The HUD SHALL default to moderate density (wind, speed, VMG, compass) and SHALL offer Full,
Moderate, Minimal, and None presets.

---

## 7. Graphics

**User story:** As a player on a capable desktop, I want the ocean and sky to look spectacular so
that the game is worth staring at.

### Acceptance criteria

7.1. Rendering SHALL use three.js `WebGPURenderer` with the WebGPU backend where available and
automatic fallback to its WebGL2 backend otherwise. All shading SHALL be authored in **TSL**
(Three.js Shading Language) so a single shader codebase compiles to both WGSL and GLSL. The pipeline
SHALL be physically based: linear workspace, HDR render targets, ACES filmic tone mapping, correct
sRGB output, and IBL from a procedurally generated sky environment.

7.2. The ocean surface SHALL be spectral (JONSWAP/Pierson-Moskowitz driven), with at least three
cascaded scales, and SHALL derive its significant height, dominant period, and direction from the
live marine data plus locally generated wind wave.

7.3. Water shading SHALL include depth-based absorption and scattering, Fresnel reflection,
screen-space reflections with a sky/cubemap fallback, refraction of submerged geometry, subsurface
scattering in wave crests, and sun glitter from microfacet slope distribution.

7.4. The system SHALL generate dynamic foam from wave-steepness/Jacobian folding, plus wake foam,
bow-wave foam, and breaking-crest whitecaps whose coverage scales with wind speed.

7.5. The system SHALL render spray and mist particles at the bow and on slams, GPU-instanced, with
intensity driven by boat speed and impact force.

7.6. The sky SHALL be a physically based atmosphere (Rayleigh + Mie) with sun position computed from
the venue's real latitude, longitude, and local time, and SHALL support volumetric cloud layers
whose coverage and altitude come from live low/mid/high cloud-cover data.

7.7. The system SHALL render live weather visually: rain and its surface disturbance, reduced
visibility and aerial perspective from live `visibility`, and overcast vs. clear lighting shifts.

7.8. Sails SHALL deform with a cloth-like shape driven by trim and pressure, showing draft position,
twist, telltales, luffing flutter, and correct two-sided translucency against the sun.

7.9. Shadows SHALL use cascaded shadow maps with soft filtering; the rig SHALL cast shadows on deck,
sails, and water.

7.10. Post-processing SHALL include temporal anti-aliasing, bloom on sun glitter, camera-relative
motion blur, optional depth of field for cinematic camera, lens water droplets on the cockpit view,
and film-grade colour grading via per-venue LUTs.

7.11. Terrain and landmarks SHALL be recognizable per venue (Golden Gate Bridge, Sydney Opera House,
Table Mountain, etc.) at a fidelity that reads correctly from the water.

7.12. All rendering features SHALL be individually toggleable through a quality preset system with
at least Low / Medium / High / Ultra presets plus a custom tier.

7.13. The WebGL2 fallback SHALL deliver a visually coherent game, not a broken one. WHEN the WebGPU
backend is unavailable THEN the system SHALL substitute non-compute implementations for every
compute-dependent feature (ocean spectrum, spray, foam accumulation) and SHALL inform the player that
reduced fidelity is in effect.

7.14. All visual content SHALL be generated procedurally at runtime: hull, deck, rig, and sail
geometry from parametric definitions; terrain from coastline polylines plus noise; landmarks from
parametric generators; and every material from TSL procedural shading. The build SHALL contain no
mesh files (glTF/OBJ/FBX) and no raster texture files, other than optional sub-64 KB utility data
such as a blue-noise tile.

7.15. The art direction SHALL be **stylized realism**, defined and enforced as follows:
- Lighting stays **physically based** — HDR, ACES, IBL, energy-conserving materials. Stylization comes
  from form, palette, and contrast, never from abandoning PBR.
- **Forms** are simplified and silhouette-first: clean chamfered geometry, no micro-detail, no grunge,
  wear, or dirt noise. A shape must read correctly at 2 km against sky.
- **Materials** are bold and few: broad regions of confident colour, restrained roughness variation,
  no busy surface noise.
- **Palette** is curated per venue as a defined set of 5–7 colours, enforced through a procedural
  colour grade so no venue can drift off-palette.
- **Fidelity is spent on water, sky, foam, spray, and light.** These keep full effort — subsurface
  scattering, reflections, glitter, volumetrics. Everything else is deliberately simpler.
- **Proportions may be gently heightened** for readability: slightly fuller sails, slightly more
  generous spray, heel visually amplified. Physics remains unexaggerated.
- **No cel outlines or toon ramps.** Separation between silhouettes comes from subtle rim lighting and
  aerial perspective.

7.16. A **photo mode** SHALL be provided: free camera, paused simulation, exposure, focal length and
depth-of-field control, and HUD hidden.

7.17. The system SHALL support **night sailing**, since live local time means some venues are dark. This
SHALL include a true star field and moon position computed from the venue's real coordinates and time,
moonlight illumination, navigation lights on the player's and all other vessels, and lit shorelines.
The system SHALL NOT force an artificial daylight offset, as that would break the live-conditions pillar.

---

## 8. Performance

**User story:** As a player, I want a smooth frame rate so that steering feels responsive and the
boat doesn't stutter through waves.

### Acceptance criteria

8.1. The reference machine is a laptop with an **NVIDIA GeForce RTX 4050 Laptop GPU** (6 GB VRAM,
thermally and power constrained). On that machine the game SHALL sustain:
- 60 FPS at 1920×1080 on the **Ultra** preset,
- 60 FPS at 2560×1440 on the **High** preset,
- 60 FPS at 1920×1080 on **Medium** on recent integrated graphics.

8.1a. Because the reference target is a laptop, the system SHALL detect sustained frame-time drift
indicative of thermal throttling and respond by reducing quality rather than dropping frames, SHALL
offer a user-selectable frame cap (30/60/120/uncapped) to limit power draw, and SHALL keep total GPU
memory use under 4 GB so the game coexists with a browser and other applications.

8.2. Frame time SHALL be budgeted and enforced: ≤4 ms CPU for simulation, ≤2 ms for scene update,
remainder for GPU submission, with a live profiler overlay available in development builds.

8.3. An adaptive quality manager SHALL monitor a rolling frame-time average and automatically scale
render resolution, ocean tessellation, reflection quality, particle counts, and shadow cascades to
hold the target frame rate, with hysteresis to prevent oscillation.

8.4. The ocean SHALL be rendered with a camera-centred LOD scheme (clipmap or quadtree) so vertex
density concentrates near the camera and total triangle count stays bounded regardless of view
distance.

8.5. Repeated geometry (fleet boats, marks, buildings, birds) SHALL be GPU-instanced, and static
scenery SHALL be batched. Draw calls SHALL stay under 1,200 per frame on Ultra.

8.6. Expensive off-screen work — spectrum precomputation, terrain tile generation, replay decoding,
AI tactical planning — SHALL run in Web Workers so it never blocks the render loop.

8.7. Because all content is procedural, the total initial download SHALL stay under **5 MB gzipped**
(code plus JSON definitions), and there SHALL be no runtime asset streaming from the network. Instead,
generated geometry and textures SHALL be built during a load phase that SHALL complete in under 3
seconds on the reference machine, with generation work off the main thread wherever possible and a
progress indicator shown throughout.

8.8. The render loop SHALL allocate no objects per frame in hot paths: vectors, quaternions, and
matrices SHALL be pooled or preallocated, and particle/audio instances SHALL come from object pools.

8.9. Reflection, refraction, and post-process render targets SHALL be resolution-scalable
independently of the main buffer, and SHALL update at reduced cadence where perceptually acceptable.

8.10. WHEN the tab loses focus THEN the system SHALL pause simulation and rendering and release the
weather polling interval.

8.11. The build SHALL code-split so venue generators, boat generators, and the replay viewer load
lazily, and tree-shake unused three.js modules.

8.12. Procedural generation results (geometry buffers, generated textures, spectrum tables, polar
tables) SHALL be cached in memory for the session and, where deterministic and expensive, persisted
to IndexedDB so a second visit to a venue skips regeneration.

8.13. The AI fleet SHALL be capped at **12 boats** and SHALL use **physics level-of-detail**: boats near
the player simulate at the full 120 Hz with the complete force model, while distant boats step at a
reduced rate with a simplified model. Transitions between LOD tiers SHALL be continuous, with no visible
position or speed pop.

8.14. Ambient traffic and wildlife SHALL be budgeted and instanced, and SHALL be the first content
reduced by the adaptive quality manager under load.

---

## 9. Procedural content generation

**User story:** As the developer, I want all content generated from parameters so that the game has no
art pipeline, stays tiny, and cannot drift out of sync between visuals and physics.

### Acceptance criteria

9.1. Hull geometry SHALL be generated by lofting a set of parametric station curves defined in the
boat definition, and the physics parameters that can be derived from geometry — displacement, wetted
surface area, waterplane area, buoyancy sample points, centre of buoyancy — SHALL be **computed from
the generated mesh** rather than authored separately, so the simulated hull is always the rendered
hull.

9.2. Rig geometry (mast, boom, spreaders, standing and running rigging) SHALL be generated as swept
tubes and lines from rig parameters.

9.3. Sail geometry SHALL be generated as a parametric surface from luff/foot/leech lengths, luff
round, and broadseam, producing the cloth simulation grid directly.

9.4. Terrain SHALL be generated from per-venue simplified coastline and depth-contour polylines,
extruded and relieved with layered noise, producing both the render mesh and the collision/depth
field. Where polyline data is derived from an open source such as OpenStreetMap, the venue definition
SHALL carry the required attribution and it SHALL appear in the credits.

9.5. Landmarks SHALL be produced by parametric generators (e.g. a suspension-bridge generator, a
shell-vault generator, a ridge-and-plateau generator) configured per venue, targeting recognizable
silhouettes rather than photographic accuracy.

9.6. All materials SHALL be TSL procedural shading — no sampled image textures. Where a texture is
genuinely required (foam accumulation, spectrum data, environment probe), it SHALL be produced by
rendering or computing into a render target at load or at runtime.

9.7. All audio SHALL be synthesized through the Web Audio graph — noise sources, filters, and
oscillators modulated by simulation state — with no audio files.

9.8. Every generator SHALL be deterministic given its parameters and seed, and SHALL be unit-testable
headlessly (geometry generators asserted on vertex counts, bounds, manifoldness, and computed volume).

9.9. Generators SHALL run in Web Workers and transfer results as `ArrayBuffer`s wherever the output is
plain buffer data, so a venue or boat can be built without stalling the frame loop.

---

## 10. Audio

10.1. The system SHALL provide spatialized audio via the Web Audio API: wind noise in the rig scaling
with apparent wind speed, hull-through-water sound scaling with boat speed, wave slams, sail luffing
flutter, winch and block sounds on trim, and per-venue ambience (gulls, city, surf).

10.2. Audio SHALL be procedurally modulated by simulation state rather than triggered as fixed clips,
so a 25 kt gust audibly differs from 12 kt.

10.3. There SHALL be no music during sailing — wind, water, and rig carry the soundscape. Menus MAY
use subtle procedurally generated ambient pads.

---

## 11. Architecture and code quality

11.1. The codebase SHALL be TypeScript in strict mode with no implicit `any`, built with Vite, and
SHALL import three.js as `three/webgpu` with shading authored via `three/tsl`.

11.2. Rendering, simulation, weather, game rules, and UI SHALL be separated into independent modules
with explicit interfaces; simulation code SHALL have no direct dependency on three.js types.

11.3. The physics, wind, and wave modules SHALL be pure and deterministic given `(state, inputs, seed)`,
and SHALL be unit-testable headlessly without a WebGPU or WebGL context.

11.4. The project SHALL include unit tests for physics, wind, weather mapping, and every procedural
generator; contract tests against recorded Open-Meteo fixtures; and a golden-run regression test
asserting that a fixed input sequence produces the same trajectory within tolerance.

11.5. The project SHALL enforce ESLint + Prettier, run typecheck/lint/test in CI, and fail CI on a
bundle-size budget regression.

11.6. All module interfaces SHALL be defined and frozen before parallel implementation begins, so
independent workstreams can be developed concurrently against stable contracts.

11.7. Rendering, simulation, and generator code SHALL be documented well enough that a new contributor
can add a venue or a boat by following a documented data recipe.

11.8. Development SHALL use **one git branch per workstream** with a pull request per workstream into
`main`. Agents MAY merge autonomously once CI is green; direct pushes to `main` SHALL NOT occur.

11.9. The primary browser targets SHALL be Chrome and Edge (WebGPU backend), with Firefox and older
Safari served by the WebGL2 fallback path.

11.10. The game SHALL be deployed continuously to **GitHub Pages** via GitHub Actions on merge to `main`,
with Vite `base` configured for the repository path, so a live build is always available.

11.11. The project SHALL make **no network requests other than the weather APIs** — no telemetry, no
analytics, no error reporting, no accounts. This SHALL be stated explicitly in the README as a privacy
property.

11.12. The repository SHALL carry an **MIT licence**.

11.13. The UI SHALL be English-only in v1, with all display strings centralized in a single module so
internationalization is a later addition rather than a refactor.

11.14. The UI visual language SHALL be **nautical-instrument inspired** — high contrast, thin strokes,
monospace numerics, restrained colour — rather than generic game UI.

---

## 12. Accessibility

12.1. All UI SHALL be keyboard-navigable with visible focus indicators and screen-reader labels, and
SHALL meet WCAG 2.1 AA contrast in menu text. HUD elements overlaid on the water SHALL offer an
opaque-backdrop option to guarantee contrast.

12.2. The system SHALL provide colourblind-safe palettes for wind/telltale/course indicators, and
SHALL never encode critical information in colour alone.

12.3. The system SHALL offer motion-sickness mitigations: horizon lock, reduced camera roll, reduced
motion blur, and a static-camera option.

12.4. The system SHALL provide subtitles/visual indicators for audio cues, adjustable HUD scale, and
a one-handed control scheme.

---

## Out of scope (v1)

- Any server-side component: no accounts, no global leaderboards, no server-side replay validation
- Real-time multiplayer racing (local ghosts and shareable replay codes only)
- Imported art assets of any kind — no modelled meshes, photographic textures, or recorded audio
- Photorealism as a goal; the target is stylized realism (req 7.15)
- Gear failure, rig failure, torn sails, and man overboard (req 4.15)
- Direct manual control of crew members; the player is always the helm (req 5.4a)
- Narrative campaign; progression is a logbook (req 6.8)
- Video export of replays; photo mode covers the sharing need
- Telemetry, analytics, and crash reporting
- Internationalization beyond English
- Mobile and touch support
- VR
- Crewed multi-person boat handling with individual crew AI
- Commercial use of the weather APIs (would require a paid tier and server proxy)
