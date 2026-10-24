/**
 * HUD publisher throttle tests. The render loop pushes view models at frame rate;
 * the publisher must forward at most one per interval (leading edge immediately,
 * trailing latest), so React updates at ~10 Hz regardless of the 120 Hz sim.
 *
 * Uses vi fake timers to control both the clock (`Date.now`) and `setTimeout`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHudStore, createHudPublisher } from '@/ui/hud/hudStore';
import { createHudViewModel } from '@game/hud';
import type { HudViewModel } from '@game/hud';

/** A tagged view model so we can tell which frame landed in the store. */
function vmWithSog(sog: number): HudViewModel {
  const vm = createHudViewModel();
  vm.speed.sog.mps = sog;
  return vm;
}

describe('createHudPublisher throttle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Use Date.now (fake-timer controlled) as the clock; identity snapshot so we
  // can compare the exact objects we published.
  const makePublisher = (store: ReturnType<typeof createHudStore>) =>
    createHudPublisher(store, { intervalMs: 100, now: () => Date.now(), snapshot: (vm) => vm });

  it('emits the first publish immediately (leading edge)', () => {
    const store = createHudStore();
    const pub = makePublisher(store);
    pub.publish(vmWithSog(1));
    expect(store.getState().vm?.speed.sog.mps).toBe(1);
  });

  it('drops intra-interval publishes and emits the latest on the trailing edge', () => {
    const store = createHudStore();
    const pub = makePublisher(store);

    pub.publish(vmWithSog(1)); // leading → store = 1
    expect(store.getState().vm?.speed.sog.mps).toBe(1);

    // Several more within the same 100 ms window: all coalesced.
    vi.setSystemTime(10);
    pub.publish(vmWithSog(2));
    vi.setSystemTime(20);
    pub.publish(vmWithSog(3));
    vi.setSystemTime(30);
    pub.publish(vmWithSog(4));
    // Still showing the leading frame until the window elapses.
    expect(store.getState().vm?.speed.sog.mps).toBe(1);

    // Advance past the interval: the trailing timer fires with the LATEST (4).
    vi.advanceTimersByTime(100);
    expect(store.getState().vm?.speed.sog.mps).toBe(4);
  });

  it('a publish after the interval elapses emits immediately again', () => {
    const store = createHudStore();
    const pub = makePublisher(store);
    pub.publish(vmWithSog(1));
    vi.setSystemTime(150); // > 100 ms since last emit
    pub.publish(vmWithSog(9));
    expect(store.getState().vm?.speed.sog.mps).toBe(9);
  });

  it('bounds store updates to roughly the UI rate under a flood', () => {
    const store = createHudStore();
    let emits = 0;
    const unsub = store.subscribe(() => {
      emits++;
    });
    const pub = makePublisher(store);

    // Simulate 1 second of 120 Hz publishing: 120 frames, 1000/120 ms apart.
    const frames = 120;
    for (let i = 0; i < frames; i++) {
      vi.setSystemTime(Math.round((i * 1000) / frames));
      pub.publish(vmWithSog(i));
      // Let any trailing timer due by now fire.
      vi.advanceTimersByTime(0);
    }
    // Flush the final trailing frame.
    vi.advanceTimersByTime(100);
    unsub();

    // At 10 Hz over ~1 s we expect on the order of 10 emits, far fewer than 120.
    expect(emits).toBeLessThanOrEqual(15);
    expect(emits).toBeGreaterThanOrEqual(8);
  });

  it('flush forces the pending frame through immediately', () => {
    const store = createHudStore();
    const pub = makePublisher(store);
    pub.publish(vmWithSog(1)); // leading
    vi.setSystemTime(10);
    pub.publish(vmWithSog(2)); // pending
    expect(store.getState().vm?.speed.sog.mps).toBe(1);
    pub.flush();
    expect(store.getState().vm?.speed.sog.mps).toBe(2);
  });

  it('dispose cancels the trailing timer without emitting', () => {
    const store = createHudStore();
    const pub = makePublisher(store);
    pub.publish(vmWithSog(1));
    vi.setSystemTime(10);
    pub.publish(vmWithSog(2)); // pending, timer scheduled
    pub.dispose();
    vi.advanceTimersByTime(1000);
    // Still the leading frame; the pending one was discarded.
    expect(store.getState().vm?.speed.sog.mps).toBe(1);
  });

  it('default snapshot deep-clones so the store frame is decoupled from the reused out object', () => {
    const store = createHudStore();
    // No snapshot override → structuredClone default.
    const pub = createHudPublisher(store, { intervalMs: 100, now: () => Date.now() });
    const out = createHudViewModel();
    out.speed.sog.mps = 7;
    pub.publish(out);
    const stored = store.getState().vm;
    expect(stored?.speed.sog.mps).toBe(7);
    // Mutating the reused out object must not change the stored frame.
    out.speed.sog.mps = 99;
    expect(store.getState().vm?.speed.sog.mps).toBe(7);
  });
});
