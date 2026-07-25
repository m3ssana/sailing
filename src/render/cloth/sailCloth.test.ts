/**
 * Tests for the sail cloth simulation — I.2.
 *
 * Tests the PBD constraint math, pressure-field derivation, and telltale logic
 * in isolation (headless, no GPU).
 */

import { describe, it, expect } from 'vitest';
import {
  createParticle,
  createDistanceConstraint,
  computeRestLength,
  applyAcceleration,
  stepPBD,
  solveDistanceConstraint,
  DEFAULT_PBD_CONFIG,
} from './PBDSolver';
import type { PBDParticle, DistanceConstraint } from './PBDSolver';
import { computePressureField, isStalled } from './PressureField';
import type { SailAeroState } from '@physics/forces/AeroForce';
import { computeTelltaleOrientation } from './Telltales';

// --- PBD Solver Tests ---

describe('PBDSolver', () => {
  describe('createParticle', () => {
    it('creates a free particle with correct position', () => {
      const p = createParticle(1, 2, 3, false);
      expect(p.pos).toEqual({ x: 1, y: 2, z: 3 });
      expect(p.prev).toEqual({ x: 1, y: 2, z: 3 });
      expect(p.invMass).toBe(1);
    });

    it('creates a pinned particle with zero inverse mass', () => {
      const p = createParticle(0, 0, 0, true);
      expect(p.invMass).toBe(0);
    });
  });

  describe('computeRestLength', () => {
    it('computes Euclidean distance between two points', () => {
      const a = { x: 0, y: 0, z: 0 };
      const b = { x: 3, y: 4, z: 0 };
      expect(computeRestLength(a, b)).toBeCloseTo(5, 10);
    });

    it('returns zero for coincident points', () => {
      const a = { x: 1, y: 2, z: 3 };
      expect(computeRestLength(a, a)).toBe(0);
    });
  });

  describe('solveDistanceConstraint', () => {
    it('projects particles toward rest length', () => {
      // Two free particles at distance 2, rest length 1.
      const pA = createParticle(0, 0, 0, false);
      const pB = createParticle(2, 0, 0, false);
      solveDistanceConstraint(pA, pB, 1, 1.0);
      // After one solve: they should be closer to distance 1.
      const dist = computeRestLength(pA.pos, pB.pos);
      expect(dist).toBeCloseTo(1, 5);
    });

    it('does not move pinned particles', () => {
      const pA = createParticle(0, 0, 0, true); // pinned
      const pB = createParticle(2, 0, 0, false);
      solveDistanceConstraint(pA, pB, 1, 1.0);
      // A should not move
      expect(pA.pos).toEqual({ x: 0, y: 0, z: 0 });
      // B should move fully to satisfy constraint
      const dist = computeRestLength(pA.pos, pB.pos);
      expect(dist).toBeCloseTo(1, 5);
    });

    it('does nothing when both particles are pinned', () => {
      const pA = createParticle(0, 0, 0, true);
      const pB = createParticle(2, 0, 0, true);
      solveDistanceConstraint(pA, pB, 1, 1.0);
      expect(pA.pos).toEqual({ x: 0, y: 0, z: 0 });
      expect(pB.pos).toEqual({ x: 2, y: 0, z: 0 });
    });

    it('handles stiffness less than 1 (partial correction)', () => {
      const pA = createParticle(0, 0, 0, false);
      const pB = createParticle(2, 0, 0, false);
      solveDistanceConstraint(pA, pB, 1, 0.5);
      // Should correct only 50% of the error
      const dist = computeRestLength(pA.pos, pB.pos);
      // Error was 1 (distance 2, rest 1). After 0.5 stiffness: distance ≈ 1.5
      expect(dist).toBeCloseTo(1.5, 5);
    });
  });

  describe('stepPBD — convergence', () => {
    it('distance constraints converge over multiple iterations', () => {
      // Create a 3×3 grid with pinned top row, check that after many steps
      // the free particles settle toward a stable state.
      const rows = 3;
      const cols = 3;
      const particles: PBDParticle[] = [];
      const constraints: DistanceConstraint[] = [];

      // Build grid
      for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
          const pinned = i === rows - 1; // Top row pinned
          particles.push(createParticle(j, i, 0, pinned));
        }
      }

      // Horizontal constraints
      for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols - 1; j++) {
          const idx = i * cols + j;
          constraints.push(createDistanceConstraint(idx, idx + 1, 1.0, 0.9));
        }
      }
      // Vertical constraints
      for (let i = 0; i < rows - 1; i++) {
        for (let j = 0; j < cols; j++) {
          const idx = i * cols + j;
          constraints.push(createDistanceConstraint(idx, idx + cols, 1.0, 0.9));
        }
      }

      // Run many steps with gravity
      const config = { ...DEFAULT_PBD_CONFIG, iterations: 8 };
      for (let step = 0; step < 100; step++) {
        for (const p of particles) {
          if (p.invMass > 0) {
            applyAcceleration(p, 0, -9.8, 0);
          }
        }
        stepPBD(particles, constraints, config);
      }

      // After convergence, check that constraints are approximately satisfied.
      let maxError = 0;
      for (const c of constraints) {
        const pA = particles[c.a];
        const pB = particles[c.b];
        if (pA === undefined || pB === undefined) continue;
        const dist = computeRestLength(pA.pos, pB.pos);
        const error = Math.abs(dist - c.restLength);
        maxError = Math.max(maxError, error);
      }
      // Constraints should be well-satisfied (error < 10% of rest length)
      expect(maxError).toBeLessThan(0.1);
    });

    it('pinned particles remain stationary through simulation', () => {
      const pinned = createParticle(5, 10, 0, true);
      const free = createParticle(5, 9, 0, false);
      const particles = [pinned, free];
      const constraints = [createDistanceConstraint(0, 1, 1.0, 0.9)];

      applyAcceleration(free, 0, -9.8, 0);
      stepPBD(particles, constraints, DEFAULT_PBD_CONFIG);

      expect(pinned.pos).toEqual({ x: 5, y: 10, z: 0 });
    });
  });
});

// --- Pressure Field Tests ---

describe('PressureField', () => {
  function makeSailState(overrides: Partial<SailAeroState> = {}): SailAeroState {
    return {
      sailId: 'test-main',
      attachment: 1.0,
      luffing: false,
      alpha: 0.15,
      cl: 1.2,
      cd: 0.1,
      driveForce: 500,
      sideForce: 200,
      heelingMoment: 1000,
      ...overrides,
    };
  }

  describe('fully attached flow', () => {
    it('produces higher pressure near luff than leech', () => {
      const state = makeSailState({ attachment: 1.0, luffing: false });
      const field = computePressureField(state, 8, 6, 10, 0);

      // Compare luff column (j=0) to leech column (j=6) at mid-height (i=4)
      const cols = 7;
      const luffPressure = field.pressures[4 * cols + 0] ?? 0;
      const leechPressure = field.pressures[4 * cols + 6] ?? 0;

      expect(Math.abs(luffPressure)).toBeGreaterThan(Math.abs(leechPressure));
    });

    it('pressure sign matches alpha sign', () => {
      const statePos = makeSailState({ alpha: 0.15 });
      const stateNeg = makeSailState({ alpha: -0.15 });

      const fieldPos = computePressureField(statePos, 4, 4, 10, 0);
      const fieldNeg = computePressureField(stateNeg, 4, 4, 10, 0);

      // Mid-grid vertex
      const midIdx = 2 * 5 + 2; // row 2, col 2 of a 5×5 grid
      const pPos = fieldPos.pressures[midIdx] ?? 0;
      const pNeg = fieldNeg.pressures[midIdx] ?? 0;

      expect(pPos).toBeGreaterThan(0);
      expect(pNeg).toBeLessThan(0);
    });

    it('scales with attachment factor', () => {
      const fullAttach = makeSailState({ attachment: 1.0 });
      const halfAttach = makeSailState({ attachment: 0.5, luffing: false });

      const fieldFull = computePressureField(fullAttach, 4, 4, 10, 0);
      const fieldHalf = computePressureField(halfAttach, 4, 4, 10, 0);

      const midIdx = 2 * 5 + 2;
      const pFull = Math.abs(fieldFull.pressures[midIdx] ?? 0);
      const pHalf = Math.abs(fieldHalf.pressures[midIdx] ?? 0);

      // Half attachment should produce less pressure
      expect(pHalf).toBeLessThan(pFull);
    });
  });

  describe('luffing regime', () => {
    it('produces near-zero mean pressure when luffing', () => {
      const state = makeSailState({
        attachment: 0.05,
        luffing: true,
        alpha: 0.02,
        driveForce: 10,
        sideForce: 5,
      });
      const field = computePressureField(state, 8, 6, 10, 0);

      // Mean pressure should be very small
      let sum = 0;
      for (let i = 0; i < field.pressures.length; i++) {
        sum += field.pressures[i] ?? 0;
      }
      const mean = sum / field.pressures.length;
      // Near zero (flutter oscillates around zero)
      expect(Math.abs(mean)).toBeLessThan(5);
    });

    it('flutter varies with time (not static)', () => {
      const state = makeSailState({
        attachment: 0.05,
        luffing: true,
        alpha: 0.02,
        driveForce: 10,
        sideForce: 5,
      });

      const field1 = computePressureField(state, 4, 4, 10, 0.0);
      const field2 = computePressureField(state, 4, 4, 10, 0.1);

      // At least some vertices should have different pressure at different times
      let hasDiff = false;
      for (let i = 0; i < field1.pressures.length; i++) {
        const p1 = field1.pressures[i] ?? 0;
        const p2 = field2.pressures[i] ?? 0;
        if (Math.abs(p1 - p2) > 0.001) {
          hasDiff = true;
          break;
        }
      }
      expect(hasDiff).toBe(true);
    });
  });

  describe('stalled (over-trimmed) regime', () => {
    it('produces flatter pressure distribution than attached flow', () => {
      const attached = makeSailState({ attachment: 1.0, luffing: false });
      const stalled = makeSailState({ attachment: 0.4, luffing: false, alpha: 0.45 });

      const fieldAttached = computePressureField(attached, 8, 6, 10, 0);
      const fieldStalled = computePressureField(stalled, 8, 6, 10, 0);

      // Compare ratio of pressure at 20% girth (near luff) to 70% girth (near leech).
      // Avoid the exact leech edge (u=1) where (1-u)^p = 0 for any p > 0.
      const cols = 7;
      const row = 4;
      const nearLuffCol = 1; // u ≈ 0.17
      const nearLeechCol = 5; // u ≈ 0.83
      const luffAtt = Math.abs(fieldAttached.pressures[row * cols + nearLuffCol] ?? 0);
      const leechAtt = Math.abs(fieldAttached.pressures[row * cols + nearLeechCol] ?? 0);
      const luffStall = Math.abs(fieldStalled.pressures[row * cols + nearLuffCol] ?? 0);
      const leechStall = Math.abs(fieldStalled.pressures[row * cols + nearLeechCol] ?? 0);

      // Both should have non-zero leech values at interior points
      expect(leechAtt).toBeGreaterThan(0);
      expect(leechStall).toBeGreaterThan(0);

      const ratioAttached = luffAtt / leechAtt;
      const ratioStalled = luffStall / leechStall;

      // Stalled should have a lower ratio (more uniform distribution)
      expect(ratioStalled).toBeLessThan(ratioAttached);
    });
  });

  describe('isStalled', () => {
    it('returns true for over-trimmed (not luffing, attachment < 1)', () => {
      const state = makeSailState({ luffing: false, attachment: 0.6 });
      expect(isStalled(state)).toBe(true);
    });

    it('returns false for luffing', () => {
      const state = makeSailState({ luffing: true, attachment: 0.3 });
      expect(isStalled(state)).toBe(false);
    });

    it('returns false for fully attached', () => {
      const state = makeSailState({ luffing: false, attachment: 1.0 });
      expect(isStalled(state)).toBe(false);
    });
  });
});

// --- Telltale Tests ---

describe('Telltales', () => {
  function makeSailState(overrides: Partial<SailAeroState> = {}): SailAeroState {
    return {
      sailId: 'test-main',
      attachment: 1.0,
      luffing: false,
      alpha: 0.15,
      cl: 1.2,
      cd: 0.1,
      driveForce: 500,
      sideForce: 200,
      heelingMoment: 1000,
      ...overrides,
    };
  }

  describe('fully attached flow', () => {
    it('both sides stream aft (liftAmount ≈ 0)', () => {
      const state = makeSailState({ attachment: 1.0, luffing: false });
      const windward = computeTelltaleOrientation('windward', state);
      const leeward = computeTelltaleOrientation('leeward', state);

      expect(windward.liftAmount).toBeCloseTo(0, 5);
      expect(leeward.liftAmount).toBeCloseTo(0, 5);
    });

    it('streaming direction has positive X (toward leech)', () => {
      const state = makeSailState({ attachment: 1.0, luffing: false });
      const windward = computeTelltaleOrientation('windward', state);
      expect(windward.direction.x).toBeGreaterThan(0.9);
    });
  });

  describe('luffing (under-trimmed)', () => {
    it('windward telltale lifts significantly', () => {
      const state = makeSailState({ attachment: 0.1, luffing: true, alpha: 0.02 });
      const windward = computeTelltaleOrientation('windward', state);
      expect(windward.liftAmount).toBeGreaterThan(0.5);
    });

    it('leeward telltale mostly streams', () => {
      const state = makeSailState({ attachment: 0.1, luffing: true, alpha: 0.02 });
      const leeward = computeTelltaleOrientation('leeward', state);
      expect(leeward.liftAmount).toBeLessThan(0.3);
    });

    it('windward and leeward orientations differ during luffing', () => {
      const state = makeSailState({ attachment: 0.1, luffing: true, alpha: 0.02 });
      const windward = computeTelltaleOrientation('windward', state);
      const leeward = computeTelltaleOrientation('leeward', state);

      // They should have different lift amounts
      expect(Math.abs(windward.liftAmount - leeward.liftAmount)).toBeGreaterThan(0.3);
    });
  });

  describe('stalled (over-trimmed)', () => {
    it('leeward telltale lifts during stall', () => {
      const state = makeSailState({ attachment: 0.4, luffing: false, alpha: 0.45 });
      const leeward = computeTelltaleOrientation('leeward', state);
      expect(leeward.liftAmount).toBeGreaterThan(0.3);
    });

    it('windward telltale mostly streams during stall', () => {
      const state = makeSailState({ attachment: 0.4, luffing: false, alpha: 0.45 });
      const windward = computeTelltaleOrientation('windward', state);
      expect(windward.liftAmount).toBeLessThan(0.2);
    });

    it('orientations differ between windward and leeward during stall', () => {
      const state = makeSailState({ attachment: 0.4, luffing: false, alpha: 0.45 });
      const windward = computeTelltaleOrientation('windward', state);
      const leeward = computeTelltaleOrientation('leeward', state);

      expect(Math.abs(windward.liftAmount - leeward.liftAmount)).toBeGreaterThan(0.2);
    });
  });

  describe('side determination from alpha sign', () => {
    it('alpha > 0: windward is normal side, leeward is opposite', () => {
      const statePos = makeSailState({ attachment: 0.1, luffing: true, alpha: 0.05 });
      const windwardPos = computeTelltaleOrientation('windward', statePos);

      const stateNeg = makeSailState({ attachment: 0.1, luffing: true, alpha: -0.05 });
      const windwardNeg = computeTelltaleOrientation('windward', stateNeg);

      // Both should lift, but the Z direction of the lift should differ
      // (one lifts toward +Z, the other toward -Z)
      expect(windwardPos.direction.z).not.toBeCloseTo(windwardNeg.direction.z, 1);
    });
  });

  describe('symmetry for zero alpha', () => {
    it('telltales are well-defined at alpha = 0 (no NaN)', () => {
      const state = makeSailState({ alpha: 0, attachment: 0.5, luffing: true });
      const windward = computeTelltaleOrientation('windward', state);
      const leeward = computeTelltaleOrientation('leeward', state);

      expect(Number.isFinite(windward.direction.x)).toBe(true);
      expect(Number.isFinite(windward.direction.z)).toBe(true);
      expect(Number.isFinite(leeward.direction.x)).toBe(true);
      expect(Number.isFinite(leeward.direction.z)).toBe(true);
    });
  });
});
