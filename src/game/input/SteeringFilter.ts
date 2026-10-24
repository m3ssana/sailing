/**
 * SteeringFilter — turns a steering INTENT (keyboard hold, or analog stick
 * position) into a rudder value in [-1,1] with the right feel:
 *
 *  - Keyboard: holding a steer key ramps the rudder toward the lock at a bounded
 *    rate (RAMP_RATE), and releasing ramps it back toward centre at a separate
 *    auto-centring rate (CENTER_RATE). This gives a smooth, non-twitchy approach
 *    to full lock rather than a step input.
 *  - Analog stick: a deadzone kills jitter near centre, then a response curve
 *    (exponent CURVE_EXP) softens small deflections for fine control near centre
 *    while still reaching full lock at the rail.
 *  - Progressive resistance (requirement 5.7): as `helmLoad` (0..1, the frozen
 *    normalisation from computeHelmLoad) rises, the available rudder rate and the
 *    reachable authority are BOTH attenuated. An overpowered boat's helm
 *    stiffens and resists being pushed to full lock, exactly as weather helm
 *    feels on the water; de-powering (helmLoad→0) restores full authority.
 *
 * Pure and allocation-free: the filter holds its own scalar state and `update`
 * returns a number, allocating nothing.
 */

import { clamp, saturate } from '@core/math';

/** Tunables for the steering feel. */
export interface SteeringConfig {
  /** Keyboard ramp rate toward the held target, units/second. */
  rampRate: number;
  /** Auto-centring rate when no steer input is held, units/second. */
  centerRate: number;
  /** Analog stick deadzone, 0..1. */
  deadzone: number;
  /** Response-curve exponent (>1 softens near centre). */
  curveExp: number;
  /**
   * How hard helmLoad attenuates authority. At helmLoad=1 the reachable rudder
   * magnitude is scaled by (1 - authorityLoss) and the rate by (1 - rateLoss).
   * Both in [0,1); kept below 1 so the helm never locks solid.
   */
  authorityLoss: number;
  rateLoss: number;
}

export const DEFAULT_STEERING: SteeringConfig = {
  // Full lock from centre in ~0.6 s of held input.
  rampRate: 1 / 0.6,
  // Recentre a touch faster than it ramps — the boat wants to track straight.
  centerRate: 1 / 0.45,
  deadzone: 0.12,
  curveExp: 2.2,
  authorityLoss: 0.6,
  rateLoss: 0.7,
};

/**
 * Apply deadzone + odd-symmetric response curve to a raw analog axis in [-1,1].
 * Below the deadzone the output is exactly 0; above it the remaining travel is
 * remapped to [0,1] and raised to `curveExp`, preserving sign.
 */
export function applyDeadzoneCurve(raw: number, deadzone: number, curveExp: number): number {
  const a = Math.abs(raw);
  if (a <= deadzone) return 0;
  const t = (a - deadzone) / (1 - deadzone);
  const shaped = Math.pow(saturate(t), curveExp);
  return raw < 0 ? -shaped : shaped;
}

/**
 * Authority attenuation factor in (0,1] for a given helmLoad: 1 at zero load,
 * falling to (1 - loss) at full load. Monotone non-increasing in helmLoad.
 */
export function authorityFactor(helmLoad: number, loss: number): number {
  return 1 - loss * saturate(helmLoad);
}

export class SteeringFilter {
  private _rudder = 0;
  private readonly cfg: SteeringConfig;

  constructor(cfg: SteeringConfig = DEFAULT_STEERING) {
    this.cfg = cfg;
  }

  /** Current filtered rudder, [-1,1]. */
  get value(): number {
    return this._rudder;
  }

  /** Force the rudder to a value (e.g. on reset), clamped to [-1,1]. */
  set(value: number): void {
    this._rudder = clamp(value, -1, 1);
  }

  /**
   * Advance one frame.
   *
   * @param steerIntent  Desired steering in [-1,1]. For keyboard this is the
   *   discretised hold (−1 left held, +1 right held, 0 none); for analog this is
   *   the raw stick axis (deadzone/curve applied internally).
   * @param isAnalog     True when `steerIntent` is a continuous stick axis.
   * @param helmLoad     Frozen normalised helm load, 0..1.
   * @param dt           Frame time, seconds.
   * @returns the new rudder value in [-1,1].
   */
  update(steerIntent: number, isAnalog: boolean, helmLoad: number, dt: number): number {
    const load = saturate(helmLoad);
    // Reachable authority shrinks with load; rate stiffens with load.
    const authority = authorityFactor(load, this.cfg.authorityLoss);
    const rateScale = authorityFactor(load, this.cfg.rateLoss);

    if (isAnalog) {
      // Analog: the stick commands a target directly through deadzone+curve,
      // scaled by the currently-reachable authority, approached at the ramp rate
      // (also load-attenuated) so a stiff helm can't be slammed to the rail.
      const target =
        applyDeadzoneCurve(steerIntent, this.cfg.deadzone, this.cfg.curveExp) * authority;
      const maxStep = this.cfg.rampRate * rateScale * dt;
      this._rudder = approach(this._rudder, target, maxStep);
    } else {
      // Keyboard: ramp toward ±authority while held, auto-centre when not.
      if (steerIntent === 0) {
        const maxStep = this.cfg.centerRate * dt; // centring is not load-limited
        this._rudder = approach(this._rudder, 0, maxStep);
      } else {
        const dir = steerIntent > 0 ? 1 : -1;
        const target = dir * authority;
        const maxStep = this.cfg.rampRate * rateScale * dt;
        this._rudder = approach(this._rudder, target, maxStep);
      }
    }

    this._rudder = clamp(this._rudder, -1, 1);
    return this._rudder;
  }
}

/** Move `current` toward `target` by at most `maxStep`. */
function approach(current: number, target: number, maxStep: number): number {
  const diff = target - current;
  if (Math.abs(diff) <= maxStep) return target;
  return current + Math.sign(diff) * maxStep;
}

/**
 * Derive dual-rumble intensities from helm load (requirement 5.7).
 *
 * The strong (low-frequency) motor carries the sustained weather-helm load; the
 * weak (high-frequency) motor carries speed-dependent buzz plus any slam
 * transient. Both are 0 when the helm is de-powered (helmLoad≈0), monotone
 * non-decreasing in helmLoad, and saturate at 1.
 *
 * `speed` (m/s) adds a small high-frequency component so a fast boat hums even
 * at moderate load; `slam` (0..1, optional) is a transient bump (wave slam) on
 * the strong motor. Neither can raise rumble above 0 when helmLoad is 0 — load
 * gates the whole output so a de-powered, drifting boat is silent.
 */
export function rumbleFromHelmLoad(
  helmLoad: number,
  speed: number,
  slam = 0,
): { weak: number; strong: number } {
  const load = saturate(helmLoad);
  if (load <= 0) return { weak: 0, strong: 0 };

  // Saturating curve: sqrt rises fast at low load then flattens, so the helm
  // "comes alive" early and tops out smoothly rather than clipping hard.
  const loadCurve = Math.sqrt(load);

  // Strong motor: sustained load + gated slam transient.
  const strong = saturate(loadCurve + load * saturate(slam) * 0.5);

  // Weak motor: load-gated speed buzz. Reference speed ~10 m/s ≈ 20 kt.
  const speedBuzz = saturate(Math.abs(speed) / 10) * 0.6;
  const weak = saturate(load * (0.4 + speedBuzz));

  return { weak, strong };
}
