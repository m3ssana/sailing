# Interfaces — the frozen contract

Everything in `src/types/` was frozen in Phase 0.2. Every workstream implements against these types
and nothing else, so that ~44 agents can work concurrently without coordinating on shapes.

**If a contract looks wrong, escalate rather than editing it.** A unilateral change compiles fine in
your workstream and silently breaks others. The contract test at `tests/unit/types/contracts.test.ts`
constructs a stub of every type; if it stops compiling, a contract moved.

---

## Conventions that prevent whole classes of bug

### Units are SI internally, always

Radians, metres, m/s, newtons, kilograms, seconds, pascals. Knots and nautical miles exist **only**
in the UI layer. This is not stylistic: a unit conversion leaking into a force calculation is one of
the most common and hardest-to-find simulator bugs, because the result stays plausible.

`UNITS` conversions are derived from the nautical-mile definition (1852 m) rather than written as
decimals, so each pair is an exact reciprocal. The original hand-written constants were off by 4e-6
per round trip — the contract test caught it.

### Direction conventions are named, never assumed

Three different conventions coexist because the weather API uses two of them:

| Field | Convention |
|---|---|
| `windDirection`, `trueDirection` | Meteorological — the bearing wind blows **FROM**. 270° is a westerly. |
| `waveDirection`, `dominantDirection` | Also **FROM** (matches the marine API). |
| `currentDirection` | The direction the current flows **TOWARDS** (also matches the API). |
| `heading` | The boat's bow bearing, clockwise from true north. |

The current/wind asymmetry is inherited from Open-Meteo. Rather than normalizing it and risking a
silent sign flip at the boundary, it is preserved and documented at every point of use.

### World space is Y-up, right-handed, metres

`+X` is east and `+Z` is **south**, so a compass bearing θ maps to `(sin θ, 0, -cos θ)`. Venue-local
coordinates have their origin at the venue centre.

---

## The contracts and why they are shaped this way

### `WeatherSnapshot` (weather.ts)

Fully normalized, JSON-serializable, and free of class instances — because it is **embedded verbatim
into replays** (requirement 6.5b). Raw provider JSON never escapes `src/weather/normalize.ts`.

Two fields are computed rather than fetched:

- `air.density` from live pressure and temperature. A cold high-pressure day genuinely delivers more
  drive at the same wind speed, and players who notice deserve to be right.
- `wind.stability` from gust spread blended with the air/sea temperature delta. Drives oscillation
  amplitude and gust sharpness — the difference between a smooth sea breeze and a shifty offshore.

### `WindField` / `WaveField` (environment.ts)

**One field object, sampled by everything.** Physics, AI, rendering and audio all call the same
`WindField.sample()`. This is what makes the gust you see on the water the gust that hits your sails.

`sampleGustGridInto()` is allocation-free by contract: the caller owns the buffer. Sampling a grid
every frame for the water shader would otherwise be a guaranteed GC source.

`WaveField.components` is exposed deliberately. The renderer must mirror the CPU sampler's exact
components to satisfy the 5 cm coherence requirement (4.12) — the hardest constraint in the project.

### `ForceGenerator` (physics.ts)

Each physical effect is an independent generator producing `AppliedForce[]`. Adding an appendage means
adding a generator, never editing the integrator. `evaluate()` must not allocate: push into the
provided array using pooled vectors.

### `Hydrostatics` (physics.ts) — the important one

Every field here is **computed from generated hull geometry**, not authored. Displacement, wetted
surface, waterplane area, buoyancy points, centre of buoyancy and the righting curve all fall out of
integrating the mesh that gets rendered.

This closes the classic simulator failure where a hull looks like one boat and behaves like another.
Change a station curve and visuals and physics move together, because there is only one source.

### `GeneratedMesh` (generation.ts)

Plain typed arrays, always indexed, with a `meta` record for derived scalars. No three.js types, so
generators run in workers, transfer without copying, and unit-test with no GPU.

Generators are pure and deterministic in `(params, seed)` — byte-identical output for identical
input. That is what makes results cacheable in IndexedDB and testable.

### `VenueDefinition` / `BoatDefinition` (content.ts)

Note what is **absent**: no mesh paths, no texture paths, no audio paths. `hull.stations` is the
single source for both the rendered hull and its hydrostatics. Adding a venue or boat is JSON only.

### `GPUCapabilities` (render.ts)

Probed once at startup and injected into every render subsystem, so no subsystem sniffs the backend
itself. `compute` is `false` on WebGL2, which is why the ocean spectrum, foam and spray each need a
designed non-compute fallback (design.md §2.2).

### `Replay` (game.ts)

Inputs at 30 Hz **plus** full state checkpoints at 1 Hz. Input-only replay assumes bit-identical
floats, which does not survive different CPUs, browsers or engine versions — `Math.sin`, `Math.pow`
and FMA contraction all vary, and a 120 Hz integrator amplifies one ULP into a visibly different
track within a minute.

Playback re-simulates and corrects toward each checkpoint with a critically damped blend rather than
snapping. `REPLAY_FORMAT.CONTROL_ORDER` must stay in sync with `ControlState`'s keys or replays decode
into the wrong controls — the contract test asserts this.

### `PerformanceStats` (render.ts)

`medianFrameTime`, not mean. A single GC spike must not trigger a quality downgrade, and the median
is what makes the adaptive manager stable. `thermalThrottleSuspected` exists because the reference
machine is a laptop that will throttle under sustained load.

---

## The import boundary

`src/core/`, `src/physics/`, `src/environment/`, `src/weather/`, `src/generation/` and `src/game/`
**must not import three.js**. Enforced by ESLint `no-restricted-imports` in `eslint.config.js`, not
by convention, because a boundary maintained by good intentions erodes.

The boundary is what buys:

- headless physics tests with no GPU or DOM
- golden-run trajectory regression
- deterministic replay
- generators that run in workers

`src/render/` is the only place `three` may be imported. It reads simulation state and never mutates
it. There are no `.glsl` or `.wgsl` files anywhere — all shading is TSL in `.ts`, so one source
compiles to both WGSL and GLSL.
