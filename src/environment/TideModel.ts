/**
 * Semidiurnal tide model.
 *
 * Most ocean venues experience two high tides and two low tides per day
 * (the M2 constituent dominates). This model uses the API's sea_level_height_msl
 * as a baseline and applies the venue's amplitude and phase offset.
 *
 * Exposes flood/ebb state and current reversal timing, since a tide gate is a
 * real tactical element — knowing when the current will turn lets a sailor
 * choose which side of the channel to work.
 */

import type { Metres, MetresPerSecond, SessionTime, Vec2 } from '@/types';
import type { TideProfile } from '@/types';

/**
 * M2 tidal period: 12 hours 25 minutes 14 seconds.
 * This is the principal lunar semidiurnal constituent.
 */
const M2_PERIOD_SECONDS = 12 * 3600 + 25 * 60 + 14;
const M2_ANGULAR_FREQUENCY = (2 * Math.PI) / M2_PERIOD_SECONDS;

/**
 * S2 (solar semidiurnal) period: exactly 12 hours.
 * The beat between M2 and S2 produces the spring/neap cycle (~14.8 days).
 * We include it at 46% of M2 amplitude — the average observed ratio.
 */
const S2_PERIOD_SECONDS = 12 * 3600;
const S2_ANGULAR_FREQUENCY = (2 * Math.PI) / S2_PERIOD_SECONDS;
const S2_AMPLITUDE_RATIO = 0.46;

export type TideState = 'flood' | 'ebb' | 'slack_high' | 'slack_low';

export interface TideModel {
  /** Tidal height relative to mean sea level at session time t. */
  height(t: SessionTime): Metres;
  /** Rate of height change (positive = rising). */
  rate(t: SessionTime): MetresPerSecond;
  /** Current state of the tide. */
  state(t: SessionTime): TideState;
  /** Current velocity vector driven by the tide at time t. */
  currentVelocity(t: SessionTime): Vec2;
  /** Time of next high water after t. */
  nextHighWater(t: SessionTime): SessionTime;
  /** Time of next current reversal (slack water) after t. */
  nextReversal(t: SessionTime): SessionTime;
}

export interface TideModelConfig {
  profile: TideProfile;
  /** Base tide height from the marine API at t=0. */
  baseTideHeight: Metres;
  /** UTC offset in seconds for the session start. */
  utcOffsetSeconds: number;
  /** Session start as epoch milliseconds (for absolute phase alignment). */
  sessionStartEpochMs: number;
}

export function createTideModel(config: TideModelConfig): TideModel {
  const { profile, baseTideHeight, sessionStartEpochMs } = config;
  const amplitude = profile.amplitude;
  const phaseOffsetSeconds = profile.phaseOffsetHours * 3600;
  const currentStrength = profile.currentStrength;
  const axisX = profile.currentAxis.x;
  const axisY = profile.currentAxis.y;

  // Absolute phase reference: compute where we are in the M2 cycle at session start.
  // This ensures the tide is coherent with the real-world phase for the venue.
  const epochSeconds = sessionStartEpochMs / 1000;
  const basePhase = epochSeconds * M2_ANGULAR_FREQUENCY + phaseOffsetSeconds * M2_ANGULAR_FREQUENCY;
  const basePhaseS2 = epochSeconds * S2_ANGULAR_FREQUENCY + phaseOffsetSeconds * S2_ANGULAR_FREQUENCY;

  function height(t: SessionTime): Metres {
    const m2 = amplitude * Math.cos(M2_ANGULAR_FREQUENCY * t + basePhase);
    const s2 = amplitude * S2_AMPLITUDE_RATIO * Math.cos(S2_ANGULAR_FREQUENCY * t + basePhaseS2);
    return baseTideHeight + m2 + s2;
  }

  function rate(t: SessionTime): MetresPerSecond {
    // Derivative of height.
    const m2Rate = -amplitude * M2_ANGULAR_FREQUENCY * Math.sin(M2_ANGULAR_FREQUENCY * t + basePhase);
    const s2Rate =
      -amplitude * S2_AMPLITUDE_RATIO * S2_ANGULAR_FREQUENCY *
      Math.sin(S2_ANGULAR_FREQUENCY * t + basePhaseS2);
    return m2Rate + s2Rate;
  }

  function state(t: SessionTime): TideState {
    const h = height(t);
    const r = rate(t);

    if (Math.abs(r) < amplitude * M2_ANGULAR_FREQUENCY * 0.1) {
      // Near slack — determine if high or low based on height relative to base.
      return (h - baseTideHeight) > 0 ? 'slack_high' : 'slack_low';
    }
    return r > 0 ? 'flood' : 'ebb';
  }

  function currentVelocity(t: SessionTime): Vec2 {
    // Tidal current is proportional to the rate of height change (continuity).
    // Maximum current occurs at mid-tide (maximum rate), which is physically
    // correct: the flow must be strongest to move the most water per unit time.
    //
    // Returns a fresh Vec2 each call — safe for callers that store multiple results.
    // This function is O(1) per field per tick (not per-boat), so allocation is acceptable.
    const r = rate(t);
    const maxRate = amplitude * M2_ANGULAR_FREQUENCY * (1 + S2_AMPLITUDE_RATIO);
    const normalizedRate = maxRate > 0 ? r / maxRate : 0;
    const speed = normalizedRate * currentStrength;

    return { x: axisX * speed, y: axisY * speed };
  }

  function nextHighWater(t: SessionTime): SessionTime {
    // Search forward in 10-minute steps, then refine.
    const step = 600;
    let searchT = t;
    let prevRate = rate(searchT);

    for (let i = 0; i < 200; i++) {
      searchT += step;
      const r = rate(searchT);
      // High water: rate crosses zero going negative (was positive, now negative).
      if (prevRate > 0 && r <= 0) {
        // Bisect to refine.
        let lo = searchT - step;
        let hi = searchT;
        for (let j = 0; j < 20; j++) {
          const mid = (lo + hi) / 2;
          if (rate(mid) > 0) lo = mid;
          else hi = mid;
        }
        return (lo + hi) / 2;
      }
      prevRate = r;
    }
    // Fallback: one M2 period ahead.
    return t + M2_PERIOD_SECONDS;
  }

  function nextReversal(t: SessionTime): SessionTime {
    // Current reversal occurs at high and low water (rate = 0).
    const step = 600;
    let searchT = t + 60; // Skip immediate vicinity.
    let prevRate = rate(searchT);

    for (let i = 0; i < 200; i++) {
      searchT += step;
      const r = rate(searchT);
      // Sign change in rate means we crossed a peak or trough.
      if ((prevRate > 0 && r <= 0) || (prevRate < 0 && r >= 0)) {
        let lo = searchT - step;
        let hi = searchT;
        for (let j = 0; j < 20; j++) {
          const mid = (lo + hi) / 2;
          const midR = rate(mid);
          if ((prevRate > 0 && midR > 0) || (prevRate < 0 && midR < 0)) lo = mid;
          else hi = mid;
        }
        return (lo + hi) / 2;
      }
      prevRate = r;
    }
    return t + M2_PERIOD_SECONDS / 2;
  }

  return { height, rate, state, currentVelocity, nextHighWater, nextReversal };
}
