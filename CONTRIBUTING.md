# Contributing

## Branch convention

One branch per workstream, named `stream/<letter>-<name>`:

```
stream/a-weather
stream/b-environment
stream/c-physics
stream/d-generation
stream/e-ocean
stream/f-sky
stream/g-systems
stream/h-audio-ui
stream/i-boat-render
```

## Workflow

1. Create your branch from `main`.
2. Work only within your workstream's directories.
3. Open one PR per workstream into `main`.
4. Agents may merge autonomously once CI is green.
5. **Never push directly to `main`.**

## Frozen interfaces

The shared type surface in `src/types/` is frozen. If a type seems wrong or insufficient, **escalate** — open an issue or flag it in your PR description. Do not edit `src/types/` unilaterally; a change there silently breaks every other workstream.

## Import boundary

These directories must not import three.js:

- `src/core/`
- `src/physics/`
- `src/environment/`
- `src/weather/`
- `src/generation/`
- `src/game/`

Only `src/render/` may import three.js. This is enforced by ESLint and is what makes the physics and generators headlessly testable.

All shading is TSL (three/tsl) in `.ts` files. No `.glsl`, `.wgsl`, `.vert`, or `.frag` files are permitted.

## Before merging

```bash
npm run ci
```

This runs: typecheck → lint → test → build → no-assets check → bundle budget check. All must pass.
