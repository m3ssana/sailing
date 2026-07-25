/**
 * Unit tests for the game loop fixed-step accumulator and frame profiler.
 *
 * These test the pure logic paths headlessly — no browser, no rAF, no DOM.
 * The accumulator is the core of frame-rate independence: given the same total
 * elapsed time, the same number of simulation steps must execute regardless of
 * how that time is distributed across frames.
 */

import { describe, it, expect } from 'vitest';
import { stepAccumulator, FIXED_TIMESTEP } from '@/app/GameLoop';
import { createFrameProfiler } from '@render/quality/FrameProfiler';

// ---------------------------------------------------------------------------
// stepAccumulator — fixed-step logic
// ---------------------------------------------------------------------------

describe('stepAccumulator', () => {
  const dt = FIXED_TIMESTEP; // 1/120 ≈ 0.008333 s
  const maxSteps = 10;

  it('produces zero steps when dt < FIXED_TIMESTEP', () => {
    const result = stepAccumulator(0, dt * 0.5, dt, maxSteps);
    expect(result.steps).toBe(0);
    expect(result.accumulator).toBeCloseTo(dt * 0.5);
  });

  it('produces exactly one step when dt == FIXED_TIMESTEP', () => {
    const result = stepAccumulator(0, dt, dt, maxSteps);
    expect(result.steps).toBe(1);
    expect(result.accumulator).toBeCloseTo(0);
  });

  it('produces two steps when dt == 2 * FIXED_TIMESTEP', () => {
    const result = stepAccumulator(0, dt * 2, dt, maxSteps);
    expect(result.steps).toBe(2);
    expect(result.accumulator).toBeCloseTo(0);
  });

  it('is frame-rate independent: 10 frames at 16.6ms and 20 frames at 8.3ms yield same step count', () => {
    // Simulate 10 frames at ~60 Hz (16.667 ms each) → total = 166.67 ms
    let accum = 0;
    let totalSteps60Hz = 0;
    for (let i = 0; i < 10; i++) {
      const result = stepAccumulator(accum, 1 / 60, dt, maxSteps);
      accum = result.accumulator;
      totalSteps60Hz += result.steps;
    }

    // Simulate 20 frames at ~120 Hz (8.333 ms each) → same total = 166.67 ms
    let accum2 = 0;
    let totalSteps120Hz = 0;
    for (let i = 0; i < 20; i++) {
      const result = stepAccumulator(accum2, 1 / 120, dt, maxSteps);
      accum2 = result.accumulator;
      totalSteps120Hz += result.steps;
    }

    // Both should produce the same number of physics steps (total time / dt).
    expect(totalSteps60Hz).toBe(totalSteps120Hz);
    expect(totalSteps60Hz).toBe(20); // 166.67 ms / 8.333 ms = 20 steps
  });

  it('clamps to maxSteps after a long stall', () => {
    // A 500 ms stall would need 60 steps at 120 Hz, but the clamp is 10.
    const result = stepAccumulator(0, 0.5, dt, maxSteps);
    expect(result.steps).toBe(maxSteps);
  });

  it('discards excess accumulator after max-steps clamp to prevent perpetual catch-up', () => {
    const result = stepAccumulator(0, 0.5, dt, maxSteps);
    // After the clamp, leftover accumulator is reset to prevent death spiral.
    expect(result.accumulator).toBeLessThanOrEqual(dt);
  });

  it('alpha stays in [0, 1)', () => {
    // Run many random-ish deltas and assert alpha is always in range.
    let accum = 0;
    for (let i = 1; i <= 200; i++) {
      const frameDt = (i % 7 + 5) / 1000; // 5–11 ms
      const result = stepAccumulator(accum, frameDt, dt, maxSteps);
      accum = result.accumulator;
      expect(result.alpha).toBeGreaterThanOrEqual(0);
      expect(result.alpha).toBeLessThan(1);
    }
  });

  it('accumulates sub-step remainder correctly across frames', () => {
    // Feed 3 deltas of 5 ms (below the 8.333 ms step). Should accumulate
    // and eventually produce a step.
    let accum = 0;
    let totalSteps = 0;
    for (let i = 0; i < 3; i++) {
      const result = stepAccumulator(accum, 0.005, dt, maxSteps);
      accum = result.accumulator;
      totalSteps += result.steps;
    }
    // 15 ms total / 8.333 ms per step = 1 step with 6.667 ms leftover
    expect(totalSteps).toBe(1);
    expect(accum).toBeCloseTo(0.015 - dt);
  });

  it('handles zero dt gracefully', () => {
    const result = stepAccumulator(0, 0, dt, maxSteps);
    expect(result.steps).toBe(0);
    expect(result.alpha).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FrameProfiler — median vs mean, thermal detection
// ---------------------------------------------------------------------------

describe('FrameProfiler', () => {
  function makeTimings(frame: number, drawCalls = 100, triangles = 50000) {
    return {
      frame,
      simulation: 2,
      sceneUpdate: 1,
      render: frame - 3,
      gpu: -1,
      steps: 1,
      drawCalls,
      triangles,
    };
  }

  it('computes a true median, not a mean', () => {
    const profiler = createFrameProfiler(60);

    // Feed 119 frames at exactly 16 ms.
    for (let i = 0; i < 119; i++) {
      profiler.record(makeTimings(16));
    }

    // Inject one massive outlier (200 ms GC spike).
    profiler.record(makeTimings(200));

    const stats = profiler.getStats();

    // The median should be 16 ms (unaffected by the outlier).
    expect(stats.medianFrameTime).toBeCloseTo(16, 0);

    // The mean would be (119*16 + 200) / 120 ≈ 17.53 — noticeably higher.
    const mean = (119 * 16 + 200) / 120;
    expect(mean).toBeGreaterThan(17);
    // The median is lower than the mean, proving it is the median.
    expect(stats.medianFrameTime).toBeLessThan(mean);
  });

  it('p95 captures high-percentile frames', () => {
    const profiler = createFrameProfiler(60);

    // 110 normal frames + 10 slow frames (>5% of 120).
    // Sorted: positions 0–109 are 16, positions 110–119 are 33.
    // p95 index = ceil(120 * 0.95) - 1 = 113 → which is 33.
    for (let i = 0; i < 110; i++) {
      profiler.record(makeTimings(16));
    }
    for (let i = 0; i < 10; i++) {
      profiler.record(makeTimings(33));
    }

    const stats = profiler.getStats();
    // p95 index = ceil(120 * 0.95) - 1 = 113. Sorted array has indices
    // 0-109 = 16, 110-119 = 33. So index 113 = 33.
    expect(stats.p95FrameTime).toBe(33);
  });

  it('tracks framesOverBudget counter', () => {
    const profiler = createFrameProfiler(60); // target = 16.67 ms

    // 5 frames over budget (>110% of target).
    for (let i = 0; i < 5; i++) {
      profiler.record(makeTimings(20)); // 20 > 16.67*1.1 = 18.33
    }

    const stats = profiler.getStats();
    expect(stats.framesOverBudget).toBe(5);
  });

  it('resets framesOverBudget when a good frame arrives', () => {
    const profiler = createFrameProfiler(60);

    for (let i = 0; i < 5; i++) {
      profiler.record(makeTimings(20));
    }
    // One frame within budget resets the counter.
    profiler.record(makeTimings(15));

    const stats = profiler.getStats();
    expect(stats.framesOverBudget).toBe(0);
  });

  it('tracks framesUnderBudget counter', () => {
    const profiler = createFrameProfiler(60); // target = 16.67 ms, 70% = 11.67

    // Frames well under budget.
    for (let i = 0; i < 10; i++) {
      profiler.record(makeTimings(8)); // 8 < 11.67
    }

    const stats = profiler.getStats();
    expect(stats.framesUnderBudget).toBe(10);
  });

  it('does not suspect thermal throttle when insufficient data', () => {
    const profiler = createFrameProfiler(60);

    // Only 10 frames — not enough for the thermal window (240).
    for (let i = 0; i < 10; i++) {
      profiler.record(makeTimings(16));
    }

    const stats = profiler.getStats();
    expect(stats.thermalThrottleSuspected).toBe(false);
  });

  it('suspects thermal throttle when frame time drifts up with flat complexity', () => {
    const profiler = createFrameProfiler(60);

    // First half: stable 16 ms with 100 draw calls.
    for (let i = 0; i < 120; i++) {
      profiler.record(makeTimings(16, 100, 50000));
    }
    // Second half: drifted up to 20 ms (25% increase) with same draw calls.
    for (let i = 0; i < 120; i++) {
      profiler.record(makeTimings(20, 100, 50000));
    }

    const stats = profiler.getStats();
    expect(stats.thermalThrottleSuspected).toBe(true);
  });

  it('does NOT suspect thermal throttle when complexity also increased', () => {
    const profiler = createFrameProfiler(60);

    // First half: 16 ms, 100 draws.
    for (let i = 0; i < 120; i++) {
      profiler.record(makeTimings(16, 100, 50000));
    }
    // Second half: 20 ms, but draw calls doubled — this is load, not throttle.
    for (let i = 0; i < 120; i++) {
      profiler.record(makeTimings(20, 200, 100000));
    }

    const stats = profiler.getStats();
    expect(stats.thermalThrottleSuspected).toBe(false);
  });

  it('setFrameCap updates the target frame time', () => {
    const profiler = createFrameProfiler(60);
    profiler.setFrameCap(30);

    // At 30 fps target = 33.33 ms. A frame of 20 ms is under 70% = 23.33.
    profiler.record(makeTimings(20));

    const stats = profiler.getStats();
    expect(stats.targetFrameTime).toBeCloseTo(33.33, 1);
  });
});
