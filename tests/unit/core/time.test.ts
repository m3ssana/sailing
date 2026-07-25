import { describe, it, expect } from 'vitest';
import { createSessionClock } from '@core/time';

describe('SessionClock', () => {
  it('advances by wall delta × compression', () => {
    const clock = createSessionClock(8);
    const t = clock.tick(0.016); // ~1 frame at 60fps
    expect(t).toBeCloseTo(0.128, 6);
    expect(clock.elapsed()).toBeCloseTo(0.128, 6);
  });

  it('defaults to compression 8', () => {
    const clock = createSessionClock();
    expect(clock.timeCompression()).toBe(8);
  });

  it('accumulates session time across multiple ticks', () => {
    const clock = createSessionClock(1);
    // Use small deltas that won't hit the 0.25s max clamp
    clock.tick(0.1);
    clock.tick(0.1);
    clock.tick(0.1);
    expect(clock.elapsed()).toBeCloseTo(0.3, 6);
  });

  it('does not advance when paused', () => {
    const clock = createSessionClock(1);
    clock.tick(0.1);
    clock.pause();
    clock.tick(0.1);
    clock.tick(0.1);
    expect(clock.elapsed()).toBeCloseTo(0.1, 6);
    expect(clock.isPaused()).toBe(true);
  });

  it('resumes correctly', () => {
    const clock = createSessionClock(2);
    clock.tick(0.1); // elapsed = 0.1*2 = 0.2
    clock.pause();
    clock.tick(5.0); // paused, no advance
    clock.resume();
    clock.tick(0.1); // elapsed += 0.1*2 = 0.2
    expect(clock.elapsed()).toBeCloseTo(0.4, 6); // 0.2 + 0.2
    expect(clock.isPaused()).toBe(false);
  });

  it('clamps large deltas (tab switch)', () => {
    const clock = createSessionClock(8);
    // A 10-second tab switch should be clamped to 0.25s
    const t = clock.tick(10.0);
    expect(t).toBeCloseTo(0.25 * 8, 6); // 2.0
  });

  it('clamps negative deltas to zero', () => {
    const clock = createSessionClock(1);
    clock.tick(0.1); // elapsed = 0.1
    clock.tick(-5.0); // clamped to 0, no change
    expect(clock.elapsed()).toBeCloseTo(0.1, 6);
  });

  it('setTimeCompression clamps to 1..60', () => {
    const clock = createSessionClock(8);
    clock.setTimeCompression(0);
    expect(clock.timeCompression()).toBe(1);
    clock.setTimeCompression(100);
    expect(clock.timeCompression()).toBe(60);
    clock.setTimeCompression(30);
    expect(clock.timeCompression()).toBe(30);
  });

  it('uses updated compression immediately', () => {
    const clock = createSessionClock(1);
    clock.tick(0.1); // elapsed = 0.1
    clock.setTimeCompression(10);
    clock.tick(0.1); // elapsed += 0.1*10 = 1.0
    expect(clock.elapsed()).toBeCloseTo(1.1, 6); // 0.1 + 1.0
  });
});
