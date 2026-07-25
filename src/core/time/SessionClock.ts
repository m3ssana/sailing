/**
 * Session clock: converts wall-clock deltas into session time.
 *
 * Session time is what every simulation system samples against — weather
 * evolution, wave phase, race countdown. It advances at `timeCompression × dt`,
 * pauses when the game is paused, and clamps extreme deltas so a tab-switch or
 * breakpoint doesn't cause a 30-second physics explosion on resume.
 *
 * The default compression of 8× means one hour of real weather unfolds in ~7.5
 * minutes of play, which is the design target for a race duration (design.md §4).
 */

import type { SessionTime } from '@/types';

export interface SessionClock {
  /** Advance the clock by a wall-clock delta (seconds). Returns the new session time. */
  tick(wallDeltaSeconds: number): SessionTime;
  /** Total elapsed session time (seconds). */
  elapsed(): SessionTime;
  /** Current time compression factor. */
  timeCompression(): number;
  /** Set time compression (clamped to 1..60). */
  setTimeCompression(factor: number): void;
  /** Pause the clock. Subsequent ticks advance by zero. */
  pause(): void;
  /** Resume the clock. */
  resume(): void;
  /** Whether the clock is currently paused. */
  isPaused(): boolean;
}

/**
 * Maximum wall-clock delta accepted per tick (seconds). Anything larger is
 * clamped. 0.25 s = 4 frames at 16 ms. A tab hidden for 10 s would otherwise
 * inject 80 s of session time at 8× compression, causing wave phase to jump
 * visibly and physics to accumulate enormous energy.
 */
const MAX_WALL_DELTA = 0.25;

const MIN_COMPRESSION = 1;
const MAX_COMPRESSION = 60;
const DEFAULT_COMPRESSION = 8;

export function createSessionClock(initialCompression = DEFAULT_COMPRESSION): SessionClock {
  let total: SessionTime = 0;
  let compression = Math.max(MIN_COMPRESSION, Math.min(MAX_COMPRESSION, initialCompression));
  let paused = false;

  return {
    tick(wallDeltaSeconds: number): SessionTime {
      if (paused) return total;
      // Clamp negative deltas (possible if the browser's performance timer
      // wraps or drifts on sleep) and huge deltas from tab switches.
      const clamped = Math.max(0, Math.min(wallDeltaSeconds, MAX_WALL_DELTA));
      total += clamped * compression;
      return total;
    },

    elapsed(): SessionTime {
      return total;
    },

    timeCompression(): number {
      return compression;
    },

    setTimeCompression(factor: number): void {
      compression = Math.max(MIN_COMPRESSION, Math.min(MAX_COMPRESSION, factor));
    },

    pause(): void {
      paused = true;
    },

    resume(): void {
      paused = false;
    },

    isPaused(): boolean {
      return paused;
    },
  };
}
