/**
 * Game loop — rAF driver with a fixed-step physics accumulator at 120 Hz.
 *
 * The architecture separates simulation rate from render rate so that:
 * - Physics is deterministic regardless of display refresh (30/60/120/144 Hz).
 * - The renderer can interpolate between physics states for smooth motion.
 * - A long stall (tab switch, GC) can't cause a death spiral of catch-up steps.
 *
 * The accumulator logic is extracted as a pure function (`stepAccumulator`) so
 * it is testable headlessly without requestAnimationFrame.
 */

import type { FrameCap, SessionTime } from '@/types';
import type { SessionClock } from '@core/time/SessionClock';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Fixed simulation timestep: 120 Hz → ~8.333 ms. */
export const FIXED_TIMESTEP = 1 / 120;

/** Maximum simulation steps per frame to prevent a death spiral after a stall.
 *  At 120 Hz this corresponds to ~83 ms of wall time — 5 frames at 60 Hz. */
const MAX_STEPS_PER_FRAME = 10;

// ---------------------------------------------------------------------------
// Accumulator (pure, testable)
// ---------------------------------------------------------------------------

export interface AccumulatorState {
  /** Leftover time not yet consumed by a fixed step (seconds). */
  accumulator: number;
  /** Number of fixed steps executed in the last frame. */
  stepsThisFrame: number;
}

export interface AccumulatorResult {
  /** Updated accumulator after consuming steps. */
  accumulator: number;
  /** Number of fixed steps executed. */
  steps: number;
  /** Interpolation alpha in [0, 1) for the render layer. */
  alpha: number;
}

/**
 * Pure accumulator logic — advances the accumulator by `dt`, executes fixed
 * steps, clamps to prevent death spirals, and returns the interpolation alpha.
 *
 * Exported for headless unit testing.
 */
export function stepAccumulator(
  accumulator: number,
  dt: number,
  fixedDt: number,
  maxSteps: number,
): AccumulatorResult {
  accumulator += dt;

  let steps = 0;
  while (accumulator >= fixedDt && steps < maxSteps) {
    accumulator -= fixedDt;
    steps++;
  }

  // If we hit the max-steps clamp, discard the excess accumulator to prevent
  // perpetual catch-up (the "death spiral"). The simulation simply skips that
  // time, which is preferable to falling further behind every frame.
  if (steps >= maxSteps && accumulator > fixedDt) {
    accumulator = 0;
  }

  // Alpha is the leftover fraction — how far between the last physics state
  // and the next one we are. The render layer uses this to interpolate
  // transforms for smooth sub-step motion.
  const alpha = accumulator / fixedDt;

  return { accumulator, steps, alpha };
}

// ---------------------------------------------------------------------------
// Frame cap
// ---------------------------------------------------------------------------

/** Convert a FrameCap to the minimum inter-frame interval in ms. 0 = uncapped. */
function frameBudgetMs(cap: FrameCap): number {
  if (cap === 0) return 0;
  return 1000 / cap;
}

// ---------------------------------------------------------------------------
// Game loop
// ---------------------------------------------------------------------------

export interface GameLoopCallbacks {
  /** Called once per fixed simulation step with the fixed dt (seconds). */
  fixedUpdate(dt: number, sessionTime: SessionTime): void;
  /** Called once per frame with the interpolation alpha for smooth rendering. */
  render(alpha: number): void;
}

export interface GameLoopHandle {
  /** Start the loop. Idempotent — calling start on a running loop is a no-op. */
  start(): void;
  /** Stop the loop. Can be restarted. */
  stop(): void;
  /** Set the user frame cap. Takes effect on the next frame. */
  setFrameCap(cap: FrameCap): void;
  /** Whether the loop is currently running. */
  isRunning(): boolean;
}

/**
 * Create a game loop that drives a fixed-step simulation and variable-rate
 * rendering.
 *
 * @param clock — the SessionClock that converts wall time to session time.
 * @param callbacks — fixedUpdate and render callbacks.
 * @param initialFrameCap — user frame cap (default: 0 = uncapped).
 */
export function createGameLoop(
  clock: SessionClock,
  callbacks: GameLoopCallbacks,
  initialFrameCap: FrameCap = 0,
): GameLoopHandle {
  let running = false;
  let rafId = 0;
  let lastTimestamp = -1;
  let accumulator = 0;
  let frameCap: FrameCap = initialFrameCap;
  let lastRenderedTimestamp = 0;

  // Pause on tab visibility change (requirement 8.10).
  const handleVisibility = (): void => {
    if (document.hidden) {
      clock.pause();
    } else {
      clock.resume();
      // Reset the timestamp so the first frame back doesn't see the entire
      // hidden duration as a single delta.
      lastTimestamp = -1;
    }
  };

  function frame(timestamp: number): void {
    if (!running) return;
    rafId = requestAnimationFrame(frame);

    // First frame: just record the timestamp, don't simulate.
    if (lastTimestamp < 0) {
      lastTimestamp = timestamp;
      lastRenderedTimestamp = timestamp;
      return;
    }

    // Frame cap: skip this rAF callback if insufficient time has passed.
    const budget = frameBudgetMs(frameCap);
    if (budget > 0 && timestamp - lastRenderedTimestamp < budget * 0.95) {
      return;
    }
    lastRenderedTimestamp = timestamp;

    // Wall-clock delta in seconds. Clamp to [0, 0.25] to prevent huge deltas
    // from tab switches — the SessionClock also clamps, but we don't want to
    // feed an enormous value into the accumulator either.
    const wallDt = Math.min((timestamp - lastTimestamp) / 1000, 0.25);
    lastTimestamp = timestamp;

    // Advance the session clock and get the elapsed session time.
    clock.tick(wallDt);

    // If paused, still render (for HUD updates) but don't simulate.
    if (clock.isPaused()) {
      callbacks.render(0);
      return;
    }

    // Run the fixed-step accumulator.
    const result = stepAccumulator(accumulator, wallDt, FIXED_TIMESTEP, MAX_STEPS_PER_FRAME);
    accumulator = result.accumulator;

    // Execute fixed steps.
    for (let i = 0; i < result.steps; i++) {
      callbacks.fixedUpdate(FIXED_TIMESTEP, clock.elapsed());
    }

    // Render with interpolation alpha.
    callbacks.render(result.alpha);
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      lastTimestamp = -1;
      accumulator = 0;
      document.addEventListener('visibilitychange', handleVisibility);
      rafId = requestAnimationFrame(frame);
    },

    stop(): void {
      if (!running) return;
      running = false;
      cancelAnimationFrame(rafId);
      document.removeEventListener('visibilitychange', handleVisibility);
    },

    setFrameCap(cap: FrameCap): void {
      frameCap = cap;
    },

    isRunning(): boolean {
      return running;
    },
  };
}
