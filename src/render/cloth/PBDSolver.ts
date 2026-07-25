/**
 * Position-Based Dynamics (PBD) cloth solver.
 *
 * A Verlet-integration PBD solver operating on a grid of particles connected by
 * distance constraints. Particles can be pinned (immovable) or free. External
 * forces (gravity, aerodynamic pressure) are applied as accelerations each step.
 *
 * ## Update cadence
 *
 * The solver runs at a reduced rate (30 Hz) rather than the physics engine's
 * 120 Hz. This is deliberate: cloth animation is a RENDERING approximation, not
 * a load-bearing physics sim, and 30 Hz is perceptually smooth for fabric motion
 * while being 4× cheaper than full-rate. Each step uses a fixed dt of 1/30 s.
 *
 * ## Import boundary
 *
 * This module uses ONLY plain arrays and the project's Vec3 type — no three.js.
 * It is testable headlessly (Vitest, no GPU). The renderer-facing SailCloth.ts
 * module uploads the resulting positions to a BufferGeometry each frame.
 *
 * ## Constraint solver
 *
 * Uses Gauss-Seidel iteration: for each constraint, project both particles toward
 * satisfaction. Pinned particles are excluded from projection. 4 iterations per
 * step is a good quality/cost tradeoff for visual cloth.
 */

import type { Vec3 } from '@/types';

/** A single PBD particle (vertex in the cloth grid). */
export interface PBDParticle {
  /** Current position. */
  pos: Vec3;
  /** Previous position (for Verlet integration). */
  prev: Vec3;
  /** Accumulated acceleration this step (reset each step). */
  acc: Vec3;
  /** Inverse mass. 0 = pinned (infinite mass). */
  invMass: number;
}

/** A distance constraint between two particles. */
export interface DistanceConstraint {
  /** Index of particle A. */
  a: number;
  /** Index of particle B. */
  b: number;
  /** Rest length (distance at which constraint is satisfied). */
  restLength: number;
  /** Stiffness 0..1. 1 = rigid. */
  stiffness: number;
}

/** Configuration for the PBD solver. */
export interface PBDConfig {
  /** Number of constraint-satisfaction iterations per step. */
  iterations: number;
  /** Damping factor applied to velocity each step (0..1). 1 = no damping. */
  damping: number;
  /** Fixed timestep in seconds. */
  dt: number;
}

/** Default configuration: 4 iterations, gentle damping, 30 Hz. */
export const DEFAULT_PBD_CONFIG: PBDConfig = {
  iterations: 4,
  damping: 0.98,
  dt: 1 / 30,
};

/**
 * Create a PBD particle at a given position.
 * @param x X coordinate.
 * @param y Y coordinate.
 * @param z Z coordinate.
 * @param pinned Whether this particle is immovable.
 */
export function createParticle(x: number, y: number, z: number, pinned: boolean): PBDParticle {
  return {
    pos: { x, y, z },
    prev: { x, y, z },
    acc: { x: 0, y: 0, z: 0 },
    invMass: pinned ? 0 : 1,
  };
}

/**
 * Create a distance constraint between two particles.
 */
export function createDistanceConstraint(
  a: number,
  b: number,
  restLength: number,
  stiffness: number = 0.9,
): DistanceConstraint {
  return { a, b, restLength, stiffness };
}

/**
 * Compute the rest length between two positions.
 */
export function computeRestLength(posA: Vec3, posB: Vec3): number {
  const dx = posB.x - posA.x;
  const dy = posB.y - posA.y;
  const dz = posB.z - posA.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Apply acceleration to a particle (additive — call multiple times per step for
 * multiple forces).
 */
export function applyAcceleration(particle: PBDParticle, ax: number, ay: number, az: number): void {
  particle.acc.x += ax;
  particle.acc.y += ay;
  particle.acc.z += az;
}

/**
 * Perform one PBD simulation step:
 * 1. Verlet integration (position update from velocity + acceleration).
 * 2. Constraint satisfaction (iterative projection).
 * 3. Velocity damping.
 * 4. Reset accelerations for the next step.
 */
export function stepPBD(
  particles: PBDParticle[],
  constraints: DistanceConstraint[],
  config: PBDConfig,
): void {
  const { dt, damping, iterations } = config;
  const dtSq = dt * dt;

  // --- 1. Verlet integration ---
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    if (p === undefined || p.invMass === 0) continue;

    // Verlet: newPos = 2 * pos - prev + acc * dt^2
    const nx = 2 * p.pos.x - p.prev.x + p.acc.x * dtSq;
    const ny = 2 * p.pos.y - p.prev.y + p.acc.y * dtSq;
    const nz = 2 * p.pos.z - p.prev.z + p.acc.z * dtSq;

    p.prev.x = p.pos.x;
    p.prev.y = p.pos.y;
    p.prev.z = p.pos.z;

    p.pos.x = nx;
    p.pos.y = ny;
    p.pos.z = nz;
  }

  // --- 2. Constraint satisfaction (Gauss-Seidel) ---
  for (let iter = 0; iter < iterations; iter++) {
    for (let c = 0; c < constraints.length; c++) {
      const constraint = constraints[c];
      if (constraint === undefined) continue;

      const pA = particles[constraint.a];
      const pB = particles[constraint.b];
      if (pA === undefined || pB === undefined) continue;

      solveDistanceConstraint(pA, pB, constraint.restLength, constraint.stiffness);
    }
  }

  // --- 3. Velocity damping ---
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    if (p === undefined || p.invMass === 0) continue;

    // Velocity = pos - prev. Apply damping by moving prev closer to pos.
    const vx = (p.pos.x - p.prev.x) * damping;
    const vy = (p.pos.y - p.prev.y) * damping;
    const vz = (p.pos.z - p.prev.z) * damping;
    p.prev.x = p.pos.x - vx;
    p.prev.y = p.pos.y - vy;
    p.prev.z = p.pos.z - vz;
  }

  // --- 4. Reset accelerations ---
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    if (p === undefined) continue;
    p.acc.x = 0;
    p.acc.y = 0;
    p.acc.z = 0;
  }
}

/**
 * Solve a single distance constraint between two particles.
 * Projects each particle proportionally to its inverse mass.
 */
export function solveDistanceConstraint(
  pA: PBDParticle,
  pB: PBDParticle,
  restLength: number,
  stiffness: number,
): void {
  const dx = pB.pos.x - pA.pos.x;
  const dy = pB.pos.y - pA.pos.y;
  const dz = pB.pos.z - pA.pos.z;
  const distSq = dx * dx + dy * dy + dz * dz;
  const dist = Math.sqrt(distSq);

  if (dist < 1e-10) return; // Degenerate — particles coincident

  const diff = (dist - restLength) / dist;
  const totalInvMass = pA.invMass + pB.invMass;
  if (totalInvMass < 1e-10) return; // Both pinned

  const correction = diff * stiffness;
  const wA = pA.invMass / totalInvMass;
  const wB = pB.invMass / totalInvMass;

  pA.pos.x += dx * correction * wA;
  pA.pos.y += dy * correction * wA;
  pA.pos.z += dz * correction * wA;
  pB.pos.x -= dx * correction * wB;
  pB.pos.y -= dy * correction * wB;
  pB.pos.z -= dz * correction * wB;
}
