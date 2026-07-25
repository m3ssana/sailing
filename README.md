# Sailing

A stylized 3D sailing simulator where wind, waves, and sky match the real current weather at real venues worldwide.

> **Status: early development.** The foundation is in place — types, math, build tooling, CI/CD — but the simulator is not yet playable. See the [spec](.kiro/specs/sailing-game/) for the full design intent.

## What is this?

Pick a real sailing venue from a world map — Newport, San Francisco Bay, Sydney Harbour, the Solent, and more — and the game fetches live weather for that location and moment. Wind speed, direction, gusts, wave height, swell, tidal current, cloud cover, and visibility all come from public forecast data and drive the simulation in real time. The conditions evolve during play as the real forecast does.

Physics are force-based (aerodynamic lift/drag on sails, hydrodynamic resistance on hull and foils, multi-point buoyancy against the wave field) integrated at 120 Hz. Trimming sails and reading wind shifts is what makes the boat go fast — not scripted animations.

## Live weather

The game sources atmospheric and marine conditions from the [Open-Meteo](https://open-meteo.com/) public forecast and marine APIs. No API key is needed. Conditions are cached locally with a 15-minute TTL and a stale-while-revalidate strategy. If the network is unavailable, the game falls back through stale cache → bundled seasonal climatology → a safe 12-knot default, and always tells you which source is active.

## Tech stack

- **Renderer:** three.js `WebGPURenderer` — WebGPU backend where available, automatic WebGL2 fallback otherwise.
- **Shading:** TSL (Three.js Shading Language) exclusively — one shader codebase compiles to both WGSL and GLSL. No `.glsl`/`.wgsl` files.
- **Language:** TypeScript in strict mode (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- **Build:** Vite, with bundle-size budget enforcement.
- **State:** Zustand + React (UI overlay only; React never touches the render loop).
- **Tests:** Vitest.

## Fully procedural content

There are no mesh files, no image textures, and no audio files in this repository. Every hull, sail, rig, terrain, landmark, material, and sound is generated at runtime from parameters. This is why the entire game fits under 5 MB gzipped — and why the physics and the visuals can never disagree, since both derive from the same source data.

The `scripts/check-no-assets.mjs` build step enforces this: the build fails if any mesh, texture, or audio file is found.

## Privacy

- **No backend.** The game is entirely client-side.
- **No accounts.** Nothing to sign up for.
- **No telemetry.** No analytics, no error reporting, no tracking.
- **No network requests other than weather.** The only outbound calls are to `api.open-meteo.com` and `marine-api.open-meteo.com` to fetch forecast and marine data.

Your sailing, your data, your machine. Period.

## Attribution

Weather data is provided by [Open-Meteo](https://open-meteo.com/) and [DWD (Deutscher Wetterdienst)](https://www.dwd.de/). Open-Meteo is free for non-commercial use under the [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) license, which requires attribution.

## Browser support

| Browser | Backend | Notes |
|---------|---------|-------|
| Chrome / Edge (recent) | WebGPU | Full fidelity — compute shaders, storage textures, all effects. |
| Firefox / Safari | WebGL2 fallback | Visually coherent but reduced: fewer ocean cascades, CPU spray, no compute. A notice is shown. |

## Development

### Prerequisites

- Node.js ≥ 20

### Quickstart

```bash
npm install
npm run dev       # Start Vite dev server with HMR
npm run ci        # Run the full CI pipeline locally: typecheck → lint → test → build → no-assets → budget
```

### Other scripts

| Script | Description |
|--------|-------------|
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint with zero warnings allowed |
| `npm run test` | Vitest (run once) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run build` | Production build |
| `npm run no-assets` | Assert no mesh/texture/audio files in the build |
| `npm run budget` | Assert bundle size is within budget |

## Project layout

```
src/
├─ core/          Math, pools, events, time — engine-agnostic utilities
├─ types/         Frozen shared type surface (do not edit)
├─ weather/       Open-Meteo clients, normalization, cache, fallback
├─ environment/   Wind field, wave field, current, tide, sky state
├─ physics/       Rigid body, force generators, hydrostatics, polars
├─ generation/    Procedural hull, rig, sail, terrain, landmark generators
├─ render/        three.js scene graph, TSL shaders, ocean, sky, post-fx
├─ game/          Race rules, AI, replay, progression, coaching
├─ boats/         Boat definitions (JSON + factory)
├─ venues/        Venue definitions (JSON + coastlines + courses)
├─ audio/         Web Audio synthesis
├─ input/         Keyboard, mouse, gamepad, bindings
└─ ui/            React overlay — menus, HUD, venue browser
tests/            Unit tests, fixtures, golden-run baselines
docs/             Architecture, adding-a-venue, adding-a-boat, etc.
scripts/          Build-time checks (no-assets, budget)
```

**Import boundary:** `core/`, `physics/`, `environment/`, `weather/`, `generation/`, and `game/` must not import three.js. Only `render/` may. This is enforced by ESLint and is what makes the physics headlessly testable.

## Spec and docs

- Full specification: [`.kiro/specs/sailing-game/`](.kiro/specs/sailing-game/)
- Architecture and contributor docs: [`docs/`](docs/)

## License

[MIT](LICENSE)
