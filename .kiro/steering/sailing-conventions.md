# Sailing simulator — steering rules

Read `.kiro/specs/sailing-game/STATUS.md` before any multi-file task. It is the
authoritative resume point — current stream status, known follow-ups, and
hard-won debugging knowledge live there, not in this file.

## Non-negotiable conventions

- **Winding:** counter-clockwise viewed from *outside* a solid → positive signed
  volume from `computeVolume`. Check the sign, not just the magnitude — an
  inverted-winding bug can produce a correct-looking magnitude with the wrong sign.
- **Wave normals:** the upward normal for a Y-up parametric surface is `T_z × T_x`,
  never `T_x × T_z`. The wrong order silently yields `(0, -1, 0)` on flat water.
- **Direction conventions:** wind and wave directions are the bearing they come
  FROM; current direction is where it flows TOWARDS. This asymmetry is inherited
  from Open-Meteo and is deliberate, not a bug.
- **World space:** Y-up, right-handed, +X east, +Z south. Bearing θ → `(sin θ, 0, -cos θ)`.
- **Units:** SI and radians internally, always. Knots and nautical miles exist only
  in the UI layer.
- **Import boundary:** `core/`, `physics/`, `environment/`, `weather/`, `generation/`,
  and `game/` must never import three.js. Only `render/` may. This is ESLint-enforced
  — if a task seems to require three.js in one of those layers, the design is wrong,
  not the rule (see the D.8 materials placement precedent: TSL/materials code moved
  to `src/render/materials/` rather than `src/generation/materials/` for exactly
  this reason).
- **Three.js imports:** `three` must be imported as `three/webgpu`, and TSL from
  `three/tsl`. Neither ships type declarations in the pinned version — `src/three-env.d.ts`
  supplies them. Never delete this file.
- `await renderer.init()` before any render or compute call.
- Compute shaders are WebGPU-only. Every compute-dependent feature needs a designed
  WebGL2 fallback (already true for ocean spectrum, foam, spray — follow the same
  pattern for any new one).
- `noUncheckedIndexedAccess` is on and non-null assertions (`!`) are ESLint-banned.
  Array indexing yields `T | undefined`; handle it explicitly, don't cast it away.
- Do not add a `@types` path alias — it collides with the `node_modules/@types`
  convention. Use `@/types`.

## Verification discipline

- A task is not done until `npm run typecheck && npm run lint && npm run test`
  passes with zero errors and zero warnings.
- Run the full `npm run ci` (adds build, no-assets, and budget checks) before
  considering any stream or batch complete, not just the fast subset.
- Fix code to match tests, not tests to match code — with one narrow exception:
  a test expectation that is demonstrably wrong. That exception requires citing a
  concrete reference for the correction (a spec, a physical law, a published
  algorithm), the same way the solar-noon and `circularLerp` test corrections were
  justified in this project's history. "The test is inconvenient" is not a citation.
- If a fix works around a failing test rather than addressing its root cause, treat
  that as a signal to look harder before committing to the workaround — this
  project has already reverted at least one plausible-looking fix (chine-hull
  faceted normals) after discovering it broke a different invariant
  (index-shared watertightness) that a narrower test didn't cover.
- Prefer a documented, honest reduction in scope over a fix that silently produces
  a wrong answer. A rendering-layer approximation is fine as long as it's labeled
  as one, not presented as if it were the real physics or the real algorithm.

## Concurrency for subagent batches

- Cap concurrent subagents at 2–3 per batch. This project has repeatedly confirmed
  that 5–6+ concurrent agents hit service throttling that corrupts mid-write files
  (the tell is half-implemented code with unused imports). This ceiling is
  empirical, not a guess — do not raise it on a hunch that more agents finish
  faster, even under explicit pressure to do so.
- Verify the full suite between batches, not just at the end. Catching a bad batch
  immediately is cheaper than diagnosing which of several batches introduced a
  regression after the fact.
- Give every subagent the full convention block above, plus the specific frozen
  types and toolkit files relevant to its task. Agents that get this produce code
  that integrates on the first attempt; omitting it costs a repair round.

## Independent verification

- For anything touching physics conventions, hydrostatics, or the frozen
  `src/types/` surface, prefer an independent audit pass (a fresh subagent with no
  access to the implementing agent's self-report) over trusting a completion
  summary at face value. This project's own audit found a real, previously-reported
  bug (hull length ~15% short of stated `loa`) that the implementing agent's tests
  did not catch, because the tests checked volume plausibility but never checked
  the hull's actual longitudinal extent against its stated `loa`.

## Keep tracking docs fresh

- After any task, batch, or stream is completed (or its status meaningfully
  changes — blocked, partially done, reverted), update
  `.kiro/specs/sailing-game/STATUS.md` in the same turn, before moving on. Do not
  defer this to "later" or to a separate cleanup pass.
- Specifically update: the "Last commit" / CI status header, the Phase 1 stream
  table (status column), the current test count and bundle size in the "Current
  state" table, and any "known follow-ups" section relevant to what changed.
- Treat a stale STATUS.md as a bug, not a formality — this file is the resume
  point a fresh session or a different agent relies on. A status table that
  contradicts the detailed notes below it (e.g. a stream marked "not started"
  while a completion writeup for it exists further down the file) is actively
  misleading and worse than no status at all.
- If work is committed and pushed, record the actual commit hash in STATUS.md's
  header rather than leaving a placeholder like "uncommitted" or "pending" once
  it no longer is.
- When superseding an older note (a plan, a recommendation, a "next steps"
  section), delete or rewrite it rather than appending a newer note beside it
  with a stale one still present — a reader should not have to figure out which
  of two contradictory sections is current.
- The same freshness rule applies to any other persistent tracking file the
  project uses (e.g. a CHANGELOG, a task list surfaced via the task-tracking
  tool) — if a task's completion should be reflected there, update it before
  ending the turn, not on a future pass.
