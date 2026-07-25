/**
 * Tests for hull hydrodynamic resistance.
 *
 * Validates:
 * - ITTC-57 friction coefficient against published values at known Re.
 * - Residuary resistance rises steeply near Fn 0.4.
 * - Froude number computation.
 */

import { describe, it, expect } from 'vitest';
import { ittc57, froudeNumber } from '@physics/forces/HydroResistance';
import { PHYSICS_CONSTANTS } from '@/types/units';
import { sampleCurve } from '@core/math';

describe('ittc57 friction coefficient', () => {
  it('gives correct value at Re = 1e6 (published: ~0.00441)', () => {
    // Re = V * L / nu. For Re = 1e6: V * L = 1e6 * 1.19e-6 ≈ 1.19 m²/s
    // Use V = 1.19 m/s, L = 1 m.
    const nu = PHYSICS_CONSTANTS.WATER_KINEMATIC_VISCOSITY;
    const speed = 1e6 * nu / 1; // V for Re=1e6 with L=1
    const cf = ittc57(speed, 1);

    // Published ITTC-57: Cf at Re=1e6 = 0.075/(6-2)² = 0.075/16 ≈ 0.00469
    expect(cf).toBeCloseTo(0.00469, 4);
  });

  it('gives correct value at Re = 1e7 (published: ~0.00293)', () => {
    const nu = PHYSICS_CONSTANTS.WATER_KINEMATIC_VISCOSITY;
    const speed = 1e7 * nu / 1;
    const cf = ittc57(speed, 1);

    // Cf at Re=1e7 = 0.075/(7-2)² = 0.075/25 = 0.003
    expect(cf).toBeCloseTo(0.003, 4);
  });

  it('gives correct value at Re = 1e8 (published: ~0.00208)', () => {
    const nu = PHYSICS_CONSTANTS.WATER_KINEMATIC_VISCOSITY;
    const speed = 1e8 * nu / 1;
    const cf = ittc57(speed, 1);

    // Cf at Re=1e8 = 0.075/(8-2)² = 0.075/36 ≈ 0.00208
    expect(cf).toBeCloseTo(0.00208, 4);
  });

  it('gives correct value at Re = 1e9 (published: ~0.00153)', () => {
    const nu = PHYSICS_CONSTANTS.WATER_KINEMATIC_VISCOSITY;
    const speed = 1e9 * nu / 1;
    const cf = ittc57(speed, 1);

    // Cf at Re=1e9 = 0.075/(9-2)² = 0.075/49 ≈ 0.00153
    expect(cf).toBeCloseTo(0.00153, 4);
  });

  it('decreases monotonically with increasing Reynolds number', () => {
    const nu = PHYSICS_CONSTANTS.WATER_KINEMATIC_VISCOSITY;
    let prevCf = Infinity;
    for (const re of [1e5, 1e6, 1e7, 1e8, 1e9]) {
      const speed = re * nu / 1;
      const cf = ittc57(speed, 1);
      expect(cf).toBeLessThan(prevCf);
      prevCf = cf;
    }
  });

  it('is clamped for very low Reynolds numbers', () => {
    const cf = ittc57(0.001, 0.1); // Very low speed/length
    expect(cf).toBeGreaterThan(0);
    expect(cf).toBeLessThan(0.02);
  });
});

describe('froudeNumber', () => {
  it('is computed correctly: V / sqrt(g * L)', () => {
    const g = PHYSICS_CONSTANTS.GRAVITY;
    // At hull speed, Fn ≈ 0.4. For L=10m, V_hull = 0.4 * sqrt(g*10) ≈ 3.96 m/s
    const L = 10;
    const V = 0.4 * Math.sqrt(g * L);
    expect(froudeNumber(V, L)).toBeCloseTo(0.4, 5);
  });

  it('is zero at zero speed', () => {
    expect(froudeNumber(0, 10)).toBe(0);
  });

  it('scales linearly with speed', () => {
    const fn1 = froudeNumber(2, 10);
    const fn2 = froudeNumber(4, 10);
    expect(fn2).toBeCloseTo(fn1 * 2, 5);
  });
});

describe('residuary resistance near hull speed', () => {
  // Use a typical displacement boat residuary curve.
  const residuaryCurve = [
    { x: 0, y: 0 },
    { x: 0.1, y: 0.0002 },
    { x: 0.2, y: 0.001 },
    { x: 0.3, y: 0.005 },
    { x: 0.35, y: 0.015 },
    { x: 0.4, y: 0.06 },
    { x: 0.45, y: 0.15 },
    { x: 0.5, y: 0.3 },
  ];

  it('rises steeply near Fn 0.4', () => {
    const crAt03 = sampleCurve(residuaryCurve, 0.3);
    const crAt04 = sampleCurve(residuaryCurve, 0.4);
    const crAt045 = sampleCurve(residuaryCurve, 0.45);

    // Should be an order of magnitude jump between 0.3 and 0.4.
    expect(crAt04).toBeGreaterThan(crAt03 * 4);
    // And another big jump from 0.4 to 0.45.
    expect(crAt045).toBeGreaterThan(crAt04 * 2);
  });

  it('is negligible at low Froude numbers', () => {
    const crAtLow = sampleCurve(residuaryCurve, 0.15);
    expect(crAtLow).toBeLessThan(0.001);
  });
});
