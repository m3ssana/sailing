/**
 * Frame profiler — tracks per-frame timings and computes rolling statistics
 * that drive the adaptive quality manager.
 *
 * Key design choice: `medianFrameTime` is a TRUE MEDIAN, not a mean. A single
 * GC spike of 200 ms must not trigger a quality downgrade — the median is
 * unaffected while the mean would jump by ~1.5 ms. This is the difference
 * between a stable game and one that constantly oscillates quality.
 *
 * Thermal throttle detection (requirement 8.1a): if the median frame time
 * drifts upward over a long window (240 frames / ~4 s) while draw calls and
 * triangle counts remain flat, we're seeing the GPU clock dropping under
 * thermal load, not an increase in scene complexity. The quality manager should
 * respond by stepping down proactively rather than waiting for dropped frames.
 */

import type { FrameCap, FrameTimings, PerformanceStats } from '@/types';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Number of frames in the rolling sample window. */
const WINDOW_SIZE = 120;

/** Long window for thermal drift detection (frames). */
const THERMAL_WINDOW_SIZE = 240;

/** Minimum drift ratio to trigger thermal throttle suspicion.
 *  0.15 = median rose by 15% while scene complexity didn't change. */
const THERMAL_DRIFT_THRESHOLD = 0.15;

// ---------------------------------------------------------------------------
// Profiler implementation
// ---------------------------------------------------------------------------

export interface FrameProfiler {
  /** Record a single frame's timings. Called once per frame from the loop. */
  record(timings: FrameTimings): void;
  /** Get the current rolling performance statistics. */
  getStats(): PerformanceStats;
  /** Get the most recently recorded frame timings. */
  getLastTimings(): FrameTimings;
  /** Set the target frame cap for budget calculations. */
  setFrameCap(cap: FrameCap): void;
}

/**
 * Create a frame profiler with a rolling window of `WINDOW_SIZE` frames.
 *
 * @param initialFrameCap — the user's frame rate target.
 */
export function createFrameProfiler(initialFrameCap: FrameCap = 60): FrameProfiler {
  // Circular buffer of frame times for median/p95 calculation.
  const frameTimes: number[] = new Array<number>(WINDOW_SIZE).fill(16.67);
  // Sorted copy used for percentile computation — avoids allocating per frame.
  const sorted: number[] = new Array<number>(WINDOW_SIZE).fill(16.67);
  let writeIndex = 0;
  let sampleCount = 0;

  // Longer buffer for thermal drift detection.
  const thermalHistory: number[] = new Array<number>(THERMAL_WINDOW_SIZE).fill(16.67);
  const thermalDrawCalls: number[] = new Array<number>(THERMAL_WINDOW_SIZE).fill(0);
  const thermalTriangles: number[] = new Array<number>(THERMAL_WINDOW_SIZE).fill(0);
  let thermalWriteIndex = 0;

  let frameCap: FrameCap = initialFrameCap;
  let framesOverBudget = 0;
  let framesUnderBudget = 0;
  let lastTimings: FrameTimings = {
    frame: 16.67,
    simulation: 0,
    sceneUpdate: 0,
    render: 0,
    gpu: -1,
    steps: 0,
    drawCalls: 0,
    triangles: 0,
  };

  /** Target frame time derived from the frame cap. */
  function targetMs(): number {
    if (frameCap === 0) return 1000 / 60; // Uncapped uses 60 Hz as budget reference
    return 1000 / frameCap;
  }

  /** Compute the median of the sorted array (in-place sort of a copy). */
  function computeMedian(): number {
    const count = Math.min(sampleCount, WINDOW_SIZE);
    if (count === 0) return 16.67;

    // Copy only the valid portion and sort.
    for (let i = 0; i < count; i++) {
      const val = frameTimes[i];
      sorted[i] = val !== undefined ? val : 16.67;
    }
    sorted.slice(0, count).sort((a, b) => a - b);
    // In-place sort of a subarray isn't clean — use a full sort on the sorted array
    // and ignore positions beyond count.
    const sub = sorted.slice(0, count);
    sub.sort((a, b) => a - b);

    const mid = Math.floor(count / 2);
    if (count % 2 === 0) {
      const a = sub[mid - 1];
      const b = sub[mid];
      return ((a !== undefined ? a : 16.67) + (b !== undefined ? b : 16.67)) / 2;
    }
    const v = sub[mid];
    return v !== undefined ? v : 16.67;
  }

  /** Compute the 95th percentile. */
  function computeP95(): number {
    const count = Math.min(sampleCount, WINDOW_SIZE);
    if (count === 0) return 16.67;

    const sub = frameTimes.slice(0, count);
    sub.sort((a, b) => {
      const av = a !== undefined ? a : 0;
      const bv = b !== undefined ? b : 0;
      return av - bv;
    });

    const idx = Math.min(Math.ceil(count * 0.95) - 1, count - 1);
    const v = sub[idx];
    return v !== undefined ? v : 16.67;
  }

  /** Detect thermal throttling: median rising while complexity is flat. */
  function detectThermalThrottle(): boolean {
    if (sampleCount < THERMAL_WINDOW_SIZE) return false;

    // Compare first-quarter median to last-quarter median of the thermal window.
    const quarter = Math.floor(THERMAL_WINDOW_SIZE / 4);
    const firstSlice: number[] = [];
    const lastSlice: number[] = [];

    for (let i = 0; i < quarter; i++) {
      const earlyIdx = (thermalWriteIndex + i) % THERMAL_WINDOW_SIZE;
      const lateIdx = (thermalWriteIndex + THERMAL_WINDOW_SIZE - quarter + i) % THERMAL_WINDOW_SIZE;
      const ev = thermalHistory[earlyIdx];
      const lv = thermalHistory[lateIdx];
      firstSlice.push(ev !== undefined ? ev : 16.67);
      lastSlice.push(lv !== undefined ? lv : 16.67);
    }

    firstSlice.sort((a, b) => a - b);
    lastSlice.sort((a, b) => a - b);

    const earlyMedian = firstSlice[Math.floor(firstSlice.length / 2)] ?? 16.67;
    const lateMedian = lastSlice[Math.floor(lastSlice.length / 2)] ?? 16.67;

    // Frame time drifted up?
    if (earlyMedian <= 0) return false;
    const drift = (lateMedian - earlyMedian) / earlyMedian;
    if (drift < THERMAL_DRIFT_THRESHOLD) return false;

    // Check that scene complexity stayed flat (draw calls and triangles).
    let earlyDC = 0;
    let lateDC = 0;
    let earlyTri = 0;
    let lateTri = 0;
    for (let i = 0; i < quarter; i++) {
      const earlyIdx = (thermalWriteIndex + i) % THERMAL_WINDOW_SIZE;
      const lateIdx = (thermalWriteIndex + THERMAL_WINDOW_SIZE - quarter + i) % THERMAL_WINDOW_SIZE;
      earlyDC += thermalDrawCalls[earlyIdx] ?? 0;
      lateDC += thermalDrawCalls[lateIdx] ?? 0;
      earlyTri += thermalTriangles[earlyIdx] ?? 0;
      lateTri += thermalTriangles[lateIdx] ?? 0;
    }

    // Complexity is "flat" if it didn't rise by more than 10%.
    const dcRise = earlyDC > 0 ? (lateDC - earlyDC) / earlyDC : 0;
    const triRise = earlyTri > 0 ? (lateTri - earlyTri) / earlyTri : 0;

    return dcRise < 0.1 && triRise < 0.1;
  }

  return {
    record(timings: FrameTimings): void {
      lastTimings = timings;

      // Write into the rolling circular buffer.
      frameTimes[writeIndex % WINDOW_SIZE] = timings.frame;
      writeIndex = (writeIndex + 1) % WINDOW_SIZE;
      sampleCount++;

      // Write into the thermal history buffer.
      thermalHistory[thermalWriteIndex] = timings.frame;
      thermalDrawCalls[thermalWriteIndex] = timings.drawCalls;
      thermalTriangles[thermalWriteIndex] = timings.triangles;
      thermalWriteIndex = (thermalWriteIndex + 1) % THERMAL_WINDOW_SIZE;

      // Update over/under budget counters.
      const target = targetMs();
      if (timings.frame > target * 1.1) {
        framesOverBudget++;
        framesUnderBudget = 0;
      } else if (timings.frame < target * 0.7) {
        framesUnderBudget++;
        framesOverBudget = 0;
      } else {
        // Within acceptable range — reset both.
        framesOverBudget = 0;
        framesUnderBudget = 0;
      }
    },

    getStats(): PerformanceStats {
      return {
        medianFrameTime: computeMedian(),
        p95FrameTime: computeP95(),
        targetFrameTime: targetMs(),
        framesOverBudget,
        framesUnderBudget,
        thermalThrottleSuspected: detectThermalThrottle(),
      };
    },

    getLastTimings(): FrameTimings {
      return lastTimings;
    },

    setFrameCap(cap: FrameCap): void {
      frameCap = cap;
    },
  };
}
