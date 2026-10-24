import { describe, it, expect } from 'vitest';
import {
  SteeringFilter,
  DEFAULT_STEERING,
  applyDeadzoneCurve,
  authorityFactor,
  rumbleFromHelmLoad,
} from '@game/input';

const DT = 1 / 120;

/** Hold a keyboard steer input for `seconds` and return the final rudder. */
function holdKeyboard(dir: number, seconds: number, helmLoad = 0): number {
  const f = new SteeringFilter();
  const steps = Math.round(seconds / DT);
  let v = 0;
  for (let i = 0; i < steps; i++) v = f.update(dir, false, helmLoad, DT);
  return v;
}

describe('SteeringFilter — keyboard ramp', () => {
  it('reaches full lock after approximately the ramp time', () => {
    // rampRate = 1/0.6 → full lock from centre in ~0.6 s.
    const atRamp = holdKeyboard(1, 1 / DEFAULT_STEERING.rampRate);
    expect(atRamp).toBeCloseTo(1, 5);
  });

  it('does not overshoot full lock when held longer', () => {
    const v = holdKeyboard(1, 2.0);
    expect(v).toBeLessThanOrEqual(1);
    expect(v).toBeCloseTo(1, 6);
  });

  it('ramps gradually, not as a step', () => {
    const f = new SteeringFilter();
    const afterOneFrame = f.update(1, false, 0, DT);
    expect(afterOneFrame).toBeGreaterThan(0);
    expect(afterOneFrame).toBeLessThan(0.1); // one 1/120 s frame is a small step
  });

  it('auto-centres back to zero when released', () => {
    const f = new SteeringFilter();
    // Ramp to lock.
    for (let i = 0; i < 200; i++) f.update(1, false, 0, DT);
    expect(f.value).toBeCloseTo(1, 5);
    // Release and let it recentre (centerRate = 1/0.45).
    const steps = Math.round((1 / DEFAULT_STEERING.centerRate) / DT);
    let v = f.value;
    for (let i = 0; i < steps; i++) v = f.update(0, false, 0, DT);
    expect(v).toBeCloseTo(0, 5);
  });

  it('steers symmetrically to port', () => {
    const v = holdKeyboard(-1, 1.0);
    expect(v).toBeCloseTo(-1, 6);
  });
});

describe('applyDeadzoneCurve', () => {
  it('kills input inside the deadzone', () => {
    expect(applyDeadzoneCurve(0.1, 0.12, 2.2)).toBe(0);
    expect(applyDeadzoneCurve(-0.05, 0.12, 2.2)).toBe(0);
  });

  it('reaches full output at the rail', () => {
    expect(applyDeadzoneCurve(1, 0.12, 2.2)).toBeCloseTo(1, 6);
    expect(applyDeadzoneCurve(-1, 0.12, 2.2)).toBeCloseTo(-1, 6);
  });

  it('is monotone increasing above the deadzone', () => {
    let prev = -Infinity;
    for (let x = 0.13; x <= 1; x += 0.05) {
      const y = applyDeadzoneCurve(x, 0.12, 2.2);
      expect(y).toBeGreaterThan(prev);
      prev = y;
    }
  });

  it('softens small deflections (curve exponent > 1)', () => {
    // Just past the deadzone, output should be much smaller than linear.
    const y = applyDeadzoneCurve(0.3, 0.12, 2.2);
    const linear = (0.3 - 0.12) / (1 - 0.12);
    expect(y).toBeLessThan(linear);
  });

  it('preserves sign', () => {
    expect(applyDeadzoneCurve(0.5, 0.12, 2.2)).toBeGreaterThan(0);
    expect(applyDeadzoneCurve(-0.5, 0.12, 2.2)).toBeLessThan(0);
  });
});

describe('SteeringFilter — progressive resistance (helmLoad)', () => {
  it('authorityFactor is monotone non-increasing in helmLoad', () => {
    let prev = Infinity;
    for (let h = 0; h <= 1.0001; h += 0.1) {
      const a = authorityFactor(h, 0.6);
      expect(a).toBeLessThanOrEqual(prev + 1e-12);
      prev = a;
    }
  });

  it('reachable analog authority decreases monotonically with helmLoad', () => {
    // Hold the stick hard over for a fixed long time at various loads; the
    // settled rudder magnitude must shrink as load rises.
    const settled = (helmLoad: number): number => {
      const f = new SteeringFilter();
      let v = 0;
      for (let i = 0; i < 600; i++) v = f.update(1, true, helmLoad, DT);
      return v;
    };
    let prev = Infinity;
    for (let h = 0; h <= 1.0001; h += 0.2) {
      const v = settled(h);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      expect(v).toBeGreaterThanOrEqual(0);
      prev = v;
    }
  });

  it('keeps rudder within [-1,1] at all loads and intents', () => {
    const f = new SteeringFilter();
    for (const load of [0, 0.3, 0.7, 1]) {
      for (const intent of [-1, -0.5, 0, 0.5, 1]) {
        for (let i = 0; i < 300; i++) {
          const v = f.update(intent, true, load, DT);
          expect(v).toBeGreaterThanOrEqual(-1);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('never locks the helm solid (authority > 0 at full load)', () => {
    const f = new SteeringFilter();
    let v = 0;
    for (let i = 0; i < 600; i++) v = f.update(1, true, 1, DT);
    expect(v).toBeGreaterThan(0);
  });
});

describe('rumbleFromHelmLoad', () => {
  it('is zero when helmLoad is zero (de-powered)', () => {
    const r = rumbleFromHelmLoad(0, 10, 1);
    expect(r.weak).toBe(0);
    expect(r.strong).toBe(0);
  });

  it('is monotone non-decreasing in helmLoad (strong motor)', () => {
    let prev = -Infinity;
    for (let h = 0; h <= 1.0001; h += 0.1) {
      const r = rumbleFromHelmLoad(h, 5);
      expect(r.strong).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = r.strong;
    }
  });

  it('is monotone non-decreasing in helmLoad (weak motor)', () => {
    let prev = -Infinity;
    for (let h = 0; h <= 1.0001; h += 0.1) {
      const r = rumbleFromHelmLoad(h, 5);
      expect(r.weak).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = r.weak;
    }
  });

  it('saturates at 1', () => {
    const r = rumbleFromHelmLoad(1, 100, 1);
    expect(r.weak).toBeLessThanOrEqual(1);
    expect(r.strong).toBeLessThanOrEqual(1);
  });

  it('slam increases the strong motor but cannot raise it from a de-powered helm', () => {
    const withSlam = rumbleFromHelmLoad(0.5, 5, 1);
    const noSlam = rumbleFromHelmLoad(0.5, 5, 0);
    expect(withSlam.strong).toBeGreaterThan(noSlam.strong);
    // At zero load, slam is gated to silence.
    expect(rumbleFromHelmLoad(0, 5, 1).strong).toBe(0);
  });

  it('speed adds weak-motor buzz under load', () => {
    const fast = rumbleFromHelmLoad(0.5, 20);
    const slow = rumbleFromHelmLoad(0.5, 0);
    expect(fast.weak).toBeGreaterThan(slow.weak);
  });
});
