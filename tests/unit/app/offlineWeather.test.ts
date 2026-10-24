/**
 * Unit tests for the offline weather fallback path (HUD source label must be correct offline).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { requireVenue } from '@venues/index';
import { resolveOffline, clearMemoryCache } from '@weather/index';

describe('offline weather path — source label', () => {
  beforeEach(() => {
    clearMemoryCache();
  });

  it('resolveOffline(newport) yields a usable snapshot labelled climatology (offline)', () => {
    const venue = requireVenue('newport');
    const snap = resolveOffline(venue);
    // Newport ships a 12-month climatology, so the offline ladder lands on it.
    expect(snap.source).toBe('climatology');
    expect(snap.venueId).toBe('newport');
    // A usable snapshot: finite wind speed.
    expect(Number.isFinite(snap.wind.trueSpeed)).toBe(true);
    expect(snap.wind.trueSpeed).toBeGreaterThan(0);
  });
});
