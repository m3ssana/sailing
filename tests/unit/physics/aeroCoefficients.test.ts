/**
 * Tests for aerodynamic coefficient tables.
 *
 * Validates the physical behaviour that makes sail trim a skill:
 * - C_L rises to a peak then decays post-stall.
 * - Drive vs trim shows a clear optimum.
 * - THE KEY ASYMMETRY: over-trimming keeps heel high while drive falls.
 * - Luffing (over-eased) collapses force entirely.
 */

import { describe, it, expect } from 'vitest';
import {
  sailLiftCoefficient,
  sailDragCoefficient,
  attachmentFactor,
  isLuffing,
  foilLiftCoefficient,
  foilDragCoefficient,
} from '@physics/coefficients/aeroCoefficients';

describe('sailLiftCoefficient', () => {
  const camber = 0.10; // Typical sail camber

  it('rises approximately linearly in the attached region', () => {
    const cl5 = sailLiftCoefficient(0.09, camber); // ~5°
    const cl10 = sailLiftCoefficient(0.17, camber); // ~10°
    const cl15 = sailLiftCoefficient(0.26, camber); // ~15°

    expect(cl5).toBeGreaterThan(0);
    expect(cl10).toBeGreaterThan(cl5);
    expect(cl15).toBeGreaterThan(cl10);
  });

  it('peaks between 1.0 and 1.7 for a cambered sail', () => {
    // Scan for the maximum.
    let maxCL = 0;
    for (let alpha = 0.05; alpha < 0.6; alpha += 0.01) {
      const cl = sailLiftCoefficient(alpha, camber);
      if (cl > maxCL) maxCL = cl;
    }
    expect(maxCL).toBeGreaterThan(1.0);
    expect(maxCL).toBeLessThan(1.7);
  });

  it('decays after the peak (post-stall)', () => {
    let maxCL = 0;
    let peakAlpha = 0;
    for (let alpha = 0.05; alpha < 0.6; alpha += 0.01) {
      const cl = sailLiftCoefficient(alpha, camber);
      if (cl > maxCL) {
        maxCL = cl;
        peakAlpha = alpha;
      }
    }

    // Past the peak, C_L should decay.
    const clPostStall = sailLiftCoefficient(peakAlpha + 0.15, camber);
    expect(clPostStall).toBeLessThan(maxCL);
  });

  it('collapses below luffing threshold (over-eased)', () => {
    const clLuffing = sailLiftCoefficient(0.02, camber); // Well below attachment
    const clAttached = sailLiftCoefficient(0.15, camber); // In the linear region
    // Force should be dramatically less when luffing.
    expect(clLuffing).toBeLessThan(clAttached * 0.3);
  });

  it('is near zero at alpha = 0', () => {
    const cl = sailLiftCoefficient(0, camber);
    expect(Math.abs(cl)).toBeLessThan(0.05);
  });

  it('higher camber produces higher peak C_L', () => {
    const clLowCamber = sailLiftCoefficient(0.25, 0.05);
    const clHighCamber = sailLiftCoefficient(0.25, 0.14);
    expect(clHighCamber).toBeGreaterThan(clLowCamber);
  });
});

describe('sailDragCoefficient', () => {
  const camber = 0.10;
  const ar = 4.0;
  const parasitic = 0.015;

  it('is small at low alpha (attached flow)', () => {
    const cd = sailDragCoefficient(0.12, camber, ar, parasitic);
    expect(cd).toBeLessThan(0.15);
    expect(cd).toBeGreaterThan(parasitic); // At least parasitic + induced
  });

  it('rises steeply post-stall', () => {
    const cdOptimal = sailDragCoefficient(0.15, camber, ar, parasitic);
    const cdStalled = sailDragCoefficient(0.45, camber, ar, parasitic);
    expect(cdStalled).toBeGreaterThan(cdOptimal * 3);
  });

  it('includes induced drag proportional to C_L^2', () => {
    // Higher AR should have less induced drag.
    const cdLowAR = sailDragCoefficient(0.15, camber, 3, parasitic);
    const cdHighAR = sailDragCoefficient(0.15, camber, 8, parasitic);
    expect(cdHighAR).toBeLessThan(cdLowAR);
  });
});

describe('THE KEY ASYMMETRY: over-trim vs over-ease', () => {
  const camber = 0.10;
  const ar = 4.0;
  const parasitic = 0.015;
  const awa = 0.7; // ~40° apparent wind angle (close hauled)
  const aws = 8.0; // 8 m/s apparent wind
  const sailArea = 20; // m²
  const airDensity = 1.225;

  function computeDriveAndHeel(alpha: number) {
    const cl = sailLiftCoefficient(alpha, camber);
    const cd = sailDragCoefficient(alpha, camber, ar, parasitic);
    const q = 0.5 * airDensity * sailArea * aws * aws;
    const lift = q * Math.abs(cl);
    const drag = q * cd;
    // Drive = lift * sin(AWA) - drag * cos(AWA)
    const drive = lift * Math.sin(awa) - drag * Math.cos(awa);
    // Side force (produces heel) = lift * cos(AWA) + drag * sin(AWA)
    const side = lift * Math.cos(awa) + drag * Math.sin(awa);
    return { drive, side };
  }

  it('has a clear optimal trim with maximum drive', () => {
    // Scan for optimal alpha.
    let bestDrive = -Infinity;
    let bestAlpha = 0;
    for (let alpha = 0.06; alpha < 0.5; alpha += 0.01) {
      const { drive } = computeDriveAndHeel(alpha);
      if (drive > bestDrive) {
        bestDrive = drive;
        bestAlpha = alpha;
      }
    }
    expect(bestDrive).toBeGreaterThan(0);
    expect(bestAlpha).toBeGreaterThan(0.08);
    expect(bestAlpha).toBeLessThan(0.35);
  });

  it('over-trimmed: heel stays high while drive falls', () => {
    // Find optimal.
    let bestDrive = -Infinity;
    let bestAlpha = 0;
    for (let alpha = 0.06; alpha < 0.5; alpha += 0.01) {
      const { drive } = computeDriveAndHeel(alpha);
      if (drive > bestDrive) {
        bestDrive = drive;
        bestAlpha = alpha;
      }
    }

    const optimal = computeDriveAndHeel(bestAlpha);
    const overTrimmed = computeDriveAndHeel(bestAlpha + 0.15); // Past stall

    // Drive falls significantly.
    expect(overTrimmed.drive).toBeLessThan(optimal.drive * 0.8);
    // Heel (side force) stays HIGH — this is the deceptive part.
    expect(overTrimmed.side).toBeGreaterThan(optimal.side * 0.7);
  });

  it('over-eased (luffing): both drive AND heel collapse', () => {
    // Find optimal.
    let bestDrive = -Infinity;
    let bestAlpha = 0;
    for (let alpha = 0.06; alpha < 0.5; alpha += 0.01) {
      const { drive } = computeDriveAndHeel(alpha);
      if (drive > bestDrive) {
        bestDrive = drive;
        bestAlpha = alpha;
      }
    }

    const optimal = computeDriveAndHeel(bestAlpha);
    const overEased = computeDriveAndHeel(0.02); // Below luffing threshold

    // BOTH drive AND side force collapse.
    expect(overEased.drive).toBeLessThan(optimal.drive * 0.2);
    expect(overEased.side).toBeLessThan(optimal.side * 0.2);
  });
});

describe('attachmentFactor and isLuffing', () => {
  it('is 1 in the fully attached range', () => {
    expect(attachmentFactor(0.15)).toBeCloseTo(1, 1);
  });

  it('drops below 1 when luffing', () => {
    expect(attachmentFactor(0.02)).toBeLessThan(0.5);
  });

  it('drops below 1 post-stall', () => {
    expect(attachmentFactor(0.5)).toBeLessThan(0.8);
  });

  it('isLuffing is true below threshold', () => {
    expect(isLuffing(0.02)).toBe(true);
    expect(isLuffing(0.15)).toBe(false);
  });
});

describe('foilLiftCoefficient', () => {
  const thickness = 0.10;

  it('is zero at zero alpha (symmetric section)', () => {
    const cl = foilLiftCoefficient(0, thickness);
    expect(cl).toBe(0);
  });

  it('produces lift proportional to leeway at moderate alpha', () => {
    const cl3 = foilLiftCoefficient(0.05, thickness);
    const cl6 = foilLiftCoefficient(0.10, thickness);
    // Should be roughly linear.
    expect(cl6).toBeCloseTo(cl3 * 2, 0);
  });

  it('stalls at high alpha', () => {
    const clPeak = foilLiftCoefficient(0.18, thickness);
    const clStalled = foilLiftCoefficient(0.35, thickness);
    expect(Math.abs(clStalled)).toBeLessThan(Math.abs(clPeak));
  });

  it('is sign-preserving (negative alpha gives negative lift)', () => {
    const clPos = foilLiftCoefficient(0.1, thickness);
    const clNeg = foilLiftCoefficient(-0.1, thickness);
    expect(clNeg).toBeCloseTo(-clPos, 5);
  });
});

describe('foilDragCoefficient', () => {
  const thickness = 0.10;
  const ar = 5.0;

  it('is small at zero alpha', () => {
    const cd = foilDragCoefficient(0, thickness, ar);
    expect(cd).toBeLessThan(0.02);
  });

  it('increases with alpha due to induced drag', () => {
    const cd0 = foilDragCoefficient(0, thickness, ar);
    const cd10 = foilDragCoefficient(0.1, thickness, ar);
    expect(cd10).toBeGreaterThan(cd0);
  });
});
