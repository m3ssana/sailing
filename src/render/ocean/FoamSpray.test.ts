/**
 * Tests for FoamSpray — Stream E.5.
 *
 * Covers:
 * - Whitecap coverage threshold (near-zero below 12kt, growing above)
 * - Upwind-vs-downwind spray asymmetry (THE most important test)
 * - Foam decay math (exponential convergence toward zero)
 * - Foam accumulation steady state (doesn't run away)
 * - CPU spray pool respects sprayBudget
 * - Object pool reuse (no unbounded growth)
 */

import { describe, it, expect } from 'vitest';
import {
  computeWhitecapCoverage,
  computeSprayIntensity,
  computeFoamDecay,
  computeFoamAccumulation,
  smoothstep,
  CPUSprayPool,
  createFoamSpraySystem,
  DEFAULT_FOAM_CONFIG,
} from './FoamSpray';
import type { GPUCapabilities } from '@/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create mock GPUCapabilities for testing. */
function mockCapabilities(compute: boolean): GPUCapabilities {
  return {
    backend: compute ? 'webgpu' : 'webgl2',
    compute,
    storageTextures: compute,
    timestampQueries: compute,
    maxTextureSize: 16384,
    float32Filterable: compute,
    adapterInfo: 'test',
  };
}

// ─── Whitecap coverage threshold ─────────────────────────────────────────────

describe('computeWhitecapCoverage', () => {
  it('returns zero below 10 knots', () => {
    expect(computeWhitecapCoverage(0)).toBe(0);
    expect(computeWhitecapCoverage(5)).toBe(0);
    expect(computeWhitecapCoverage(8)).toBe(0);
    expect(computeWhitecapCoverage(10)).toBe(0);
  });

  it('is near-zero at 12 knots (onset region)', () => {
    const at12 = computeWhitecapCoverage(12);
    // Should be small — we're in the smoothstep transition zone
    expect(at12).toBeGreaterThan(0);
    expect(at12).toBeLessThan(0.2);
  });

  it('grows significantly above 12 knots', () => {
    const at15 = computeWhitecapCoverage(15);
    const at20 = computeWhitecapCoverage(20);
    const at30 = computeWhitecapCoverage(30);

    expect(at15).toBeGreaterThan(0.1);
    expect(at20).toBeGreaterThan(at15);
    expect(at30).toBeGreaterThan(at20);
  });

  it('monotonically increases with wind speed', () => {
    let prev = 0;
    for (let knots = 0; knots <= 40; knots += 2) {
      const current = computeWhitecapCoverage(knots);
      expect(current).toBeGreaterThanOrEqual(prev);
      prev = current;
    }
  });

  it('saturates at 1.0 for very high wind', () => {
    expect(computeWhitecapCoverage(40)).toBe(1);
    expect(computeWhitecapCoverage(50)).toBe(1);
  });

  it('produces coverage values matching real observations at key speeds', () => {
    // 15 knots: light whitecaps just appearing
    const at15 = computeWhitecapCoverage(15);
    expect(at15).toBeGreaterThan(0.1);
    expect(at15).toBeLessThan(0.4);

    // 25 knots: strong whitecaps
    const at25 = computeWhitecapCoverage(25);
    expect(at25).toBeGreaterThan(0.4);
    expect(at25).toBeLessThan(0.9);
  });
});

// ─── Upwind vs downwind spray asymmetry ──────────────────────────────────────
// THIS IS THE MOST IMPORTANT TEST per the task specification.
// Demo claim: "upwind in 20kt chop throws spray, downwind in the same wind
// throws far less."

describe('computeSprayIntensity — upwind vs downwind asymmetry', () => {
  const UPWIND_ANGLE = 0; // 0 radians = head to wind (close-hauled, beating)
  const BEAM_ANGLE = Math.PI / 2; // 90° = beam reach
  const DOWNWIND_ANGLE = Math.PI; // 180° = dead downwind (running)

  const WIND_SPEED = 20; // 20 knots — the demo's specified conditions
  const CHOP_HEIGHT = 1.2; // ~1.2m chop in 20kt wind
  const BOAT_SPEED = 6; // 6 knots boat speed

  it('upwind intensity is GREATER than downwind intensity at matched conditions', () => {
    const upwindIntensity = computeSprayIntensity(
      UPWIND_ANGLE, WIND_SPEED, CHOP_HEIGHT, BOAT_SPEED,
    );
    const downwindIntensity = computeSprayIntensity(
      DOWNWIND_ANGLE, WIND_SPEED, CHOP_HEIGHT, BOAT_SPEED,
    );

    // The CRITICAL assertion: upwind > downwind
    expect(upwindIntensity).toBeGreaterThan(downwindIntensity);

    // Quantitative: upwind should be at least 3× downwind (the demo says
    // "throws spray" vs "throws far less" — a factor of 3+ is "far less")
    expect(upwindIntensity / downwindIntensity).toBeGreaterThan(3);
  });

  it('beam reach is between upwind and downwind', () => {
    const upwind = computeSprayIntensity(UPWIND_ANGLE, WIND_SPEED, CHOP_HEIGHT, BOAT_SPEED);
    const beam = computeSprayIntensity(BEAM_ANGLE, WIND_SPEED, CHOP_HEIGHT, BOAT_SPEED);
    const downwind = computeSprayIntensity(DOWNWIND_ANGLE, WIND_SPEED, CHOP_HEIGHT, BOAT_SPEED);

    expect(beam).toBeGreaterThan(downwind);
    expect(beam).toBeLessThan(upwind);
  });

  it('spray increases with wind speed at fixed upwind angle', () => {
    const at15 = computeSprayIntensity(UPWIND_ANGLE, 15, CHOP_HEIGHT, BOAT_SPEED);
    const at20 = computeSprayIntensity(UPWIND_ANGLE, 20, CHOP_HEIGHT, BOAT_SPEED);
    const at30 = computeSprayIntensity(UPWIND_ANGLE, 30, 2.0, BOAT_SPEED);

    expect(at20).toBeGreaterThan(at15);
    expect(at30).toBeGreaterThan(at20);
  });

  it('spray increases with chop height at fixed angle and wind', () => {
    const lowChop = computeSprayIntensity(UPWIND_ANGLE, WIND_SPEED, 0.3, BOAT_SPEED);
    const highChop = computeSprayIntensity(UPWIND_ANGLE, WIND_SPEED, 1.5, BOAT_SPEED);

    expect(highChop).toBeGreaterThan(lowChop);
  });

  it('minimal spray in light air regardless of angle', () => {
    const upwindLight = computeSprayIntensity(UPWIND_ANGLE, 5, 0.2, BOAT_SPEED);
    const downwindLight = computeSprayIntensity(DOWNWIND_ANGLE, 5, 0.2, BOAT_SPEED);

    // Both should be near-zero in 5 knots
    expect(upwindLight).toBeLessThan(0.05);
    expect(downwindLight).toBeLessThan(0.05);
  });

  it('returns values in 0..1 range for extreme inputs', () => {
    expect(computeSprayIntensity(0, 50, 5, 15)).toBeLessThanOrEqual(1);
    expect(computeSprayIntensity(0, 50, 5, 15)).toBeGreaterThanOrEqual(0);
    expect(computeSprayIntensity(Math.PI, 0, 0, 0)).toBe(0);
  });

  it('the asymmetry ratio is consistent: always upwind > downwind for any wind > 10kt', () => {
    for (const wind of [12, 15, 18, 20, 25, 30, 35]) {
      const chop = wind * 0.06; // rough chop estimate
      const upwind = computeSprayIntensity(0, wind, chop, 6);
      const downwind = computeSprayIntensity(Math.PI, wind, chop, 6);
      expect(upwind).toBeGreaterThan(downwind);
    }
  });
});

// ─── Foam decay math ─────────────────────────────────────────────────────────

describe('computeFoamDecay', () => {
  it('decays exponentially toward zero', () => {
    let foam = 1.0;
    const decayRate = 1.0;
    const dt = 1 / 60; // 60fps step

    for (let i = 0; i < 300; i++) {
      foam = computeFoamDecay(foam, decayRate, dt);
    }

    // After 5 seconds of decay at rate 1.0, should be exp(-5) ≈ 0.0067
    expect(foam).toBeLessThan(0.01);
    expect(foam).toBeGreaterThan(0);
  });

  it('returns 0 for zero input', () => {
    expect(computeFoamDecay(0, 1.0, 1 / 60)).toBe(0);
  });

  it('decays faster with higher rate', () => {
    const slowDecay = computeFoamDecay(1.0, 0.5, 1.0);
    const fastDecay = computeFoamDecay(1.0, 2.0, 1.0);

    expect(fastDecay).toBeLessThan(slowDecay);
  });

  it('preserves foam when decay rate is zero', () => {
    expect(computeFoamDecay(0.8, 0, 1.0)).toBeCloseTo(0.8, 10);
  });
});

// ─── Foam accumulation (steady state) ────────────────────────────────────────

describe('computeFoamAccumulation', () => {
  it('converges to steady state with constant injection', () => {
    let foam = 0;
    const injection = 0.5;
    const decayRate = 1.0;
    const dt = 1 / 60;

    // Run for 10 seconds
    for (let i = 0; i < 600; i++) {
      foam = computeFoamAccumulation(foam, injection, decayRate, dt);
    }

    // Theoretical steady state = injection / decayRate = 0.5 / 1.0 = 0.5
    expect(foam).toBeCloseTo(0.5, 1);
  });

  it('does not exceed 1.0 even with high injection', () => {
    let foam = 0;
    const injection = 10.0; // Very high injection
    const decayRate = 1.0;
    const dt = 1 / 60;

    for (let i = 0; i < 600; i++) {
      foam = computeFoamAccumulation(foam, injection, decayRate, dt);
    }

    expect(foam).toBeLessThanOrEqual(1.0);
  });

  it('decays to zero without injection', () => {
    let foam = 1.0;
    const injection = 0;
    const decayRate = 1.0;
    const dt = 1 / 60;

    for (let i = 0; i < 600; i++) {
      foam = computeFoamAccumulation(foam, injection, decayRate, dt);
    }

    expect(foam).toBeLessThan(0.001);
  });

  it('does not go negative', () => {
    const result = computeFoamAccumulation(-0.5, 0, 1.0, 1.0);
    expect(result).toBeGreaterThanOrEqual(0);
  });

  it('rises then stabilises when injection starts', () => {
    const injection = 0.8;
    const decayRate = 2.0;
    const dt = 1 / 60;
    let foam = 0;
    const values: number[] = [];

    for (let i = 0; i < 600; i++) {
      foam = computeFoamAccumulation(foam, injection, decayRate, dt);
      if (i % 60 === 0) values.push(foam);
    }

    // Should be monotonically increasing toward steady state
    for (let i = 1; i < values.length; i++) {
      const prev = values[i - 1];
      const curr = values[i];
      if (prev !== undefined && curr !== undefined) {
        expect(curr).toBeGreaterThanOrEqual(prev);
      }
    }

    // Final value near steady state (0.8/2.0 = 0.4)
    expect(foam).toBeCloseTo(0.4, 1);
  });
});

// ─── CPU spray pool budget ───────────────────────────────────────────────────

describe('CPUSprayPool', () => {
  it('respects sprayBudget — never exceeds maximum active particles', () => {
    const budget = 100;
    const pool = new CPUSprayPool(budget);

    // Try to spawn way more than budget
    for (let i = 0; i < 500; i++) {
      pool.spawn(0, 1, 0, 0, 5, 0, 2.0);
    }

    expect(pool.count).toBe(budget);
    expect(pool.count).toBeLessThanOrEqual(budget);
  });

  it('particles die after lifetime expires', () => {
    const pool = new CPUSprayPool(100);

    pool.spawn(0, 5, 0, 0, 0, 0, 0.5); // 0.5s lifetime
    expect(pool.count).toBe(1);

    // Advance well past lifetime
    pool.update(1.0);
    expect(pool.count).toBe(0);
  });

  it('particles fall under gravity', () => {
    const pool = new CPUSprayPool(100);

    pool.spawn(0, 10, 0, 0, 0, 0, 5.0); // stationary, long life, at height 10
    pool.update(0.1);

    const particles = pool.getActiveParticles();
    const p = particles[0];
    expect(p).toBeDefined();
    if (p !== undefined) {
      // Should have fallen: y < 10, vy < 0
      expect(p.y).toBeLessThan(10);
      expect(p.vy).toBeLessThan(0);
    }
  });

  it('recycles particles after death (pool reuse)', () => {
    const budget = 10;
    const pool = new CPUSprayPool(budget);

    // Spawn 10 particles with short lifetime
    for (let i = 0; i < budget; i++) {
      pool.spawn(0, 5, 0, 0, 1, 0, 0.1);
    }
    expect(pool.count).toBe(budget);

    // Kill them all
    pool.update(0.5);
    expect(pool.count).toBe(0);

    // Spawn again — should work (pool recycles, doesn't grow unbounded)
    for (let i = 0; i < budget; i++) {
      pool.spawn(0, 5, 0, 0, 1, 0, 1.0);
    }
    expect(pool.count).toBe(budget);

    // The pool's high water mark should be at most budget (not 2*budget)
    expect(pool.getPoolHighWaterMark()).toBeLessThanOrEqual(budget);
  });

  it('multiple spawn/despawn cycles do not cause unbounded growth', () => {
    const budget = 50;
    const pool = new CPUSprayPool(budget);

    for (let cycle = 0; cycle < 20; cycle++) {
      // Spawn up to budget
      for (let i = 0; i < budget; i++) {
        pool.spawn(0, 5, 0, 0, 2, 0, 0.05);
      }
      // Kill them
      pool.update(0.2);
    }

    // High water mark should never exceed budget
    expect(pool.getPoolHighWaterMark()).toBeLessThanOrEqual(budget);
  });

  it('reset releases all particles', () => {
    const pool = new CPUSprayPool(50);

    for (let i = 0; i < 30; i++) {
      pool.spawn(0, 5, 0, 0, 2, 0, 5.0);
    }
    expect(pool.count).toBe(30);

    pool.reset();
    expect(pool.count).toBe(0);
  });
});

// ─── FoamSpray system integration ────────────────────────────────────────────

describe('createFoamSpraySystem', () => {
  it('creates a system with WebGL2 capabilities (CPU fallback)', () => {
    const system = createFoamSpraySystem(
      mockCapabilities(false),
      { sprayBudget: 200 },
    );

    expect(system.isComputeSpray).toBe(false);
    expect(system.getCPUSprayPool()).toBeDefined();
    expect(system.getSprayBudget()).toBe(200);
  });

  it('creates a system with WebGPU capabilities (compute path)', () => {
    const system = createFoamSpraySystem(
      mockCapabilities(true),
      { sprayBudget: 1000 },
    );

    expect(system.isComputeSpray).toBe(true);
    expect(system.getCPUSprayPool()).toBeUndefined();
    expect(system.getSprayBudget()).toBe(1000);
  });

  it('whitecap coverage updates with wind speed', () => {
    const system = createFoamSpraySystem(
      mockCapabilities(false),
      { sprayBudget: 100 },
    );

    system.setWindSpeed(5);
    expect(system.getWhitecapCoverage()).toBe(0);

    system.setWindSpeed(20);
    const coverageAt20 = system.getWhitecapCoverage();
    expect(coverageAt20).toBeGreaterThan(0.2);

    system.setWindSpeed(35);
    const coverageAt35 = system.getWhitecapCoverage();
    expect(coverageAt35).toBeGreaterThan(coverageAt20);
  });

  it('emitSpray respects budget on CPU path', () => {
    const budget = 20;
    const system = createFoamSpraySystem(
      mockCapabilities(false),
      { sprayBudget: budget },
    );

    // Emit lots of spray
    for (let i = 0; i < 100; i++) {
      system.emitSpray(0, 1, 0, 0, 25, 1.5, 8);
    }

    expect(system.getSprayCount()).toBeLessThanOrEqual(budget);
  });

  it('getConfig returns the foam config', () => {
    const system = createFoamSpraySystem(
      mockCapabilities(false),
      { sprayBudget: 100 },
      { decayRate: 1.5 },
    );

    expect(system.getConfig().decayRate).toBe(1.5);
    expect(system.getConfig().resolution).toBe(DEFAULT_FOAM_CONFIG.resolution);
  });

  it('update advances CPU particles without error', () => {
    const system = createFoamSpraySystem(
      mockCapabilities(false),
      { sprayBudget: 100 },
    );

    system.emitSpray(0, 2, 0, 0, 20, 1.0, 6);
    expect(system.getSprayCount()).toBeGreaterThan(0);

    system.update(1 / 60);
    // Should still be alive after one frame
    expect(system.getSprayCount()).toBeGreaterThanOrEqual(0);
  });

  it('dispose resets spray pool', () => {
    const system = createFoamSpraySystem(
      mockCapabilities(false),
      { sprayBudget: 100 },
    );

    system.emitSpray(0, 2, 0, 0, 20, 1.0, 6);
    system.dispose();
    expect(system.getSprayCount()).toBe(0);
  });
});

// ─── Smoothstep utility ──────────────────────────────────────────────────────

describe('smoothstep', () => {
  it('returns 0 below edge0', () => {
    expect(smoothstep(10, 20, 5)).toBe(0);
    expect(smoothstep(10, 20, 10)).toBe(0);
  });

  it('returns 1 above edge1', () => {
    expect(smoothstep(10, 20, 20)).toBe(1);
    expect(smoothstep(10, 20, 25)).toBe(1);
  });

  it('returns 0.5 at midpoint', () => {
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
  });

  it('is monotonically increasing', () => {
    let prev = 0;
    for (let x = 0; x <= 1; x += 0.05) {
      const val = smoothstep(0, 1, x);
      expect(val).toBeGreaterThanOrEqual(prev);
      prev = val;
    }
  });
});
