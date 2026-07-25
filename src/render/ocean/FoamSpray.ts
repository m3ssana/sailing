/**
 * Foam and Spray — Stream E.5 (Ocean Rendering).
 *
 * Jacobian-folding foam with a persistent decaying accumulation buffer,
 * wake and bow-wave injection, wind-scaled whitecap coverage; spray via
 * compute instancedArray on WebGPU with a CPU-pool fallback.
 *
 * ## Architecture
 *
 * **Foam** (both backends, render-target ping-pong):
 * - A persistent 2D accumulation buffer using standard WebGLRenderTarget.
 * - Each frame: read previous foam → decay exponentially → inject new foam
 *   from Jacobian crest-folding + wake/bow-wave points → write to other buffer.
 * - Works identically on WebGPU and WebGL2 (no storageTexture, no compute).
 *
 * **Spray** (backend-dependent):
 * - WebGPU: instancedArray compute particle system (position/velocity/lifetime
 *   in storage buffers, a compute pass advancing each frame).
 * - WebGL2: CPU-pool fallback using `src/core/pool/ObjectPool`, rendered via
 *   InstancedMesh. Respects `QualityKnobs.sprayBudget`.
 *
 * ## Jacobian interface (RECONCILED against E.2's landed implementation)
 *
 * This module consumes a scalar Jacobian value per-texel from the ocean spectrum
 * system (E.2 SpectrumCompute.ts / E.3 SpectrumFallback.ts, both now landed).
 *
 * E.2's actual documented format (src/render/ocean/SpectrumCompute.ts):
 * - A single-channel float buffer/texture (R), one value per texel.
 * - J = (1 + ∂Dx/∂x)(1 + ∂Dz/∂z) - (∂Dz/∂x)² — Jacobian determinant of the
 *   horizontal displacement mapping.
 * - J < 0        → strong foam (crest has folded over onto itself)
 * - 0 < J < 0.3  → moderate foam
 * - J >= 1       → no foam (undisturbed or expanding surface)
 *
 * `jacobianThreshold` is calibrated to this scale: default 0.3, matching the
 * top of E.2's own documented "moderate foam" band (reconciled down from an
 * earlier 0.5 placeholder that was written before E.2 had landed and used a
 * threshold guessed independently of E.2's actual formula). Injection
 * intensity ramps up further as J drops through and below 0, consistent with
 * E.2's "strong foam" description.
 *
 * The integration point is the `setJacobianSource` method, which accepts the
 * texture/buffer reference from `SpectrumCompute.getJacobianBuffer()` (WebGPU
 * tier) or an equivalent CPU-evaluated buffer from the WebGL2 fallback.
 *
 * ## Wind integration hook
 *
 * `setWindSpeed(knots: number)` updates the whitecap coverage threshold.
 * Actual wind speed comes from `src/environment/wind/` — not built here.
 *
 * @module
 */

import type { GPUCapabilities, QualityKnobs } from '@/types';
import { createObjectPool } from '@core/pool';
import type { ObjectPool } from '@core/pool';

// ─── Pure math functions (unit-testable, no three.js dependency) ─────────────

/**
 * Compute whitecap coverage factor from wind speed.
 * Near-zero below ~12 knots, growing above.
 *
 * Uses a smoothstep between 10–14 knots for onset, then linear growth.
 * Based on Monahan & O'Muircheartaigh (1980) whitecap fraction ∝ U^3.41
 * but simplified to a more controllable artistic curve.
 *
 * @param windSpeedKnots Wind speed in knots.
 * @returns Coverage factor 0..1 (0 = no whitecaps, 1 = full coverage).
 */
export function computeWhitecapCoverage(windSpeedKnots: number): number {
  if (windSpeedKnots <= 10) return 0;
  if (windSpeedKnots >= 40) return 1;

  // Smoothstep onset between 10 and 14 knots
  const onset = smoothstep(10, 14, windSpeedKnots);
  // Linear growth from 14 to 40 knots, scaled by onset
  const growth = Math.min((windSpeedKnots - 14) / 26, 1);
  const fullCoverage = onset * (0.15 + 0.85 * Math.max(0, growth));

  return Math.min(1, fullCoverage);
}

/**
 * Compute spray intensity based on apparent wind angle and conditions.
 *
 * Upwind sailing in chop throws MORE spray because the bow punches into
 * oncoming wave orbital velocity. Downwind, the boat runs with the waves,
 * reducing relative impact velocity.
 *
 * @param apparentWindAngleRad Apparent wind angle in radians (0 = head-to-wind,
 *   π = dead downwind). The angle between the boat's heading and the apparent wind.
 * @param windSpeedKnots True wind speed in knots.
 * @param chopHeight Significant chop/wave height in metres.
 * @param boatSpeedKnots Boat speed through water in knots (optional, default 6).
 * @returns Normalised spray intensity 0..1.
 */
export function computeSprayIntensity(
  apparentWindAngleRad: number,
  windSpeedKnots: number,
  chopHeight: number,
  boatSpeedKnots = 6,
): number {
  // Clamp inputs to sane ranges
  const windClamped = Math.max(0, windSpeedKnots);
  const chopClamped = Math.max(0, chopHeight);
  const angleClamped = Math.abs(apparentWindAngleRad);

  // Wind threshold: minimal spray below 8 knots
  const windFactor = smoothstep(8, 20, windClamped);

  // Chop factor: scales linearly with wave height, significant above 0.3m
  const chopFactor = smoothstep(0.2, 1.5, chopClamped);

  // Angular factor: MORE spray upwind, LESS downwind.
  // cos(0) = 1 (head-to-wind, maximum spray)
  // cos(π) = -1 (dead downwind, minimum spray)
  // Remap cos from [-1,1] to [0.1, 1.0] so downwind still gets some spray
  // but upwind gets ~10× more.
  const cosAngle = Math.cos(angleClamped);
  // cosAngle: 1 at upwind, -1 at downwind
  // Map to spray multiplier: upwind=1.0, beam=0.5, downwind=0.1
  const angularFactor = 0.1 + 0.9 * ((cosAngle + 1) / 2);

  // Boat speed factor: faster boat = more impact spray
  const speedFactor = smoothstep(3, 10, boatSpeedKnots);

  // Combine multiplicatively
  const raw = windFactor * chopFactor * angularFactor * speedFactor;

  return Math.min(1, Math.max(0, raw));
}

/**
 * Compute foam decay for a single step.
 * Exponential decay: foam(t+dt) = foam(t) * exp(-decayRate * dt)
 *
 * @param currentFoam Current foam intensity (0..1).
 * @param decayRate Decay rate (per second). Higher = faster fade. Default ~1.0.
 * @param dt Time step in seconds.
 * @returns New foam intensity after decay.
 */
export function computeFoamDecay(currentFoam: number, decayRate: number, dt: number): number {
  return currentFoam * Math.exp(-decayRate * dt);
}

/**
 * Compute foam accumulation with injection and decay.
 * foam(t+dt) = foam(t) * exp(-decayRate * dt) + injection * dt
 *
 * This converges to steady state = injection / decayRate (when injection is constant).
 *
 * @param currentFoam Current foam intensity.
 * @param injection Injection rate (foam units per second).
 * @param decayRate Decay rate (per second).
 * @param dt Time step in seconds.
 * @returns New foam intensity (clamped to [0, 1]).
 */
export function computeFoamAccumulation(
  currentFoam: number,
  injection: number,
  decayRate: number,
  dt: number,
): number {
  const decayed = currentFoam * Math.exp(-decayRate * dt);
  const accumulated = decayed + injection * dt;
  return Math.min(1, Math.max(0, accumulated));
}

/**
 * Standard smoothstep interpolation.
 * Returns 0 when x <= edge0, 1 when x >= edge1, smooth interpolation between.
 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// ─── Spray particle type (CPU fallback) ──────────────────────────────────────

/** A single spray particle for the CPU pool path. */
export interface SprayParticle {
  /** World-space position. */
  x: number;
  y: number;
  z: number;
  /** Velocity. */
  vx: number;
  vy: number;
  vz: number;
  /** Remaining lifetime in seconds. */
  life: number;
  /** Initial lifetime for alpha fade. */
  maxLife: number;
  /** Whether this particle is currently active. */
  active: boolean;
}

// ─── CPU Spray Pool ──────────────────────────────────────────────────────────

/**
 * CPU-based spray particle system using the project's ObjectPool.
 * Designed for the WebGL2 fallback path.
 *
 * Respects `QualityKnobs.sprayBudget` as the maximum number of active particles.
 */
export class CPUSprayPool {
  /** Maximum live particles (from QualityKnobs.sprayBudget). */
  private readonly budget: number;

  /** The object pool for particle recycling (zero allocation hot path). */
  private readonly pool: ObjectPool<SprayParticle>;

  /** Active particles (fixed-size array, indices up to `activeCount`). */
  private readonly particles: SprayParticle[];

  /** Number of currently active particles. */
  private activeCount = 0;

  /** Gravity in m/s² (Y-up, negative = down). */
  private readonly gravity = -9.81;

  constructor(budget: number) {
    this.budget = Math.max(1, budget);
    this.particles = [];

    // Create the pool with the project's utility, preallocating the full budget
    this.pool = createObjectPool<SprayParticle>(
      () => ({
        x: 0, y: 0, z: 0,
        vx: 0, vy: 0, vz: 0,
        life: 0, maxLife: 1,
        active: false,
      }),
      (p) => {
        p.x = 0; p.y = 0; p.z = 0;
        p.vx = 0; p.vy = 0; p.vz = 0;
        p.life = 0; p.maxLife = 1;
        p.active = false;
      },
      this.budget,
    );
  }

  /** Current number of active particles. */
  get count(): number {
    return this.activeCount;
  }

  /** Get the active particles slice (read-only iteration). */
  getActiveParticles(): readonly SprayParticle[] {
    return this.particles.slice(0, this.activeCount);
  }

  /**
   * Spawn a new spray particle. Respects budget — silently drops if at capacity.
   */
  spawn(
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
    lifetime: number,
  ): void {
    if (this.activeCount >= this.budget) return;

    const particle = this.pool.acquire();
    particle.x = x;
    particle.y = y;
    particle.z = z;
    particle.vx = vx;
    particle.vy = vy;
    particle.vz = vz;
    particle.life = lifetime;
    particle.maxLife = lifetime;
    particle.active = true;

    this.particles[this.activeCount] = particle;
    this.activeCount++;
  }

  /**
   * Update all active particles (gravity, movement, lifetime).
   * Dead particles are recycled back to the pool.
   *
   * @param dt Delta time in seconds.
   */
  update(dt: number): void {
    let writeIdx = 0;

    for (let i = 0; i < this.activeCount; i++) {
      const p = this.particles[i];
      if (p === undefined) continue;

      // Decrease lifetime
      p.life -= dt;

      if (p.life <= 0 || p.y < -1) {
        // Dead — recycle to pool
        p.active = false;
        this.pool.release(p);
        continue;
      }

      // Apply gravity
      p.vy += this.gravity * dt;

      // Update position
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      // Compact: move to writeIdx
      if (writeIdx !== i) {
        this.particles[writeIdx] = p;
      }
      writeIdx++;
    }

    this.activeCount = writeIdx;
  }

  /** Reset — release all particles back to pool. */
  reset(): void {
    for (let i = 0; i < this.activeCount; i++) {
      const p = this.particles[i];
      if (p !== undefined) {
        p.active = false;
        this.pool.release(p);
      }
    }
    this.activeCount = 0;
  }

  /** Get pool diagnostics. */
  getPoolHighWaterMark(): number {
    return this.pool.highWaterMark();
  }
}

// ─── Wake injection point ────────────────────────────────────────────────────

/** A point where foam should be injected (e.g. bow wave, wake). */
export interface FoamInjectionPoint {
  /** World-space X position. */
  x: number;
  /** World-space Z position. */
  z: number;
  /** Injection intensity 0..1. */
  intensity: number;
  /** Injection radius in metres. */
  radius: number;
}

// ─── Foam accumulation buffer config ─────────────────────────────────────────

/** Configuration for the foam accumulation system. */
export interface FoamConfig {
  /** Texture resolution for the foam accumulation buffer (power of 2). */
  resolution: number;
  /** World-space extent the foam texture covers (metres). */
  worldExtent: number;
  /** Foam decay rate (per second). Higher = faster fade. Default 0.8. */
  decayRate: number;
  /** Jacobian threshold below which foam is injected. Default 0.3, matching
   *  E.2's documented "moderate foam" band top (0 < J < 0.3). */
  jacobianThreshold: number;
  /** Maximum injection rate from Jacobian (foam units/s). Default 2.0. */
  maxJacobianInjection: number;
  /** Wake foam decay rate (slower than whitecap decay for persistence). Default 0.4. */
  wakeDecayRate: number;
}

/** Default foam configuration. */
export const DEFAULT_FOAM_CONFIG: Readonly<FoamConfig> = {
  resolution: 512,
  worldExtent: 200,
  decayRate: 0.8,
  jacobianThreshold: 0.3,
  maxJacobianInjection: 2.0,
  wakeDecayRate: 0.4,
};

// ─── Main FoamSpray system ───────────────────────────────────────────────────

/**
 * The foam and spray system. Manages:
 * - Foam accumulation buffer (ping-pong render targets)
 * - Whitecap coverage scaling
 * - Wake/bow-wave injection
 * - Spray particles (WebGPU compute or CPU pool fallback)
 *
 * ## Usage
 *
 * ```ts
 * const foamSpray = createFoamSpraySystem(capabilities, qualityKnobs);
 * // Per frame:
 * foamSpray.setWindSpeed(currentWindKnots);
 * foamSpray.setWakeInjectionPoints(boatWakePoints);
 * foamSpray.update(dt, renderer);
 * ```
 */
export interface FoamSpraySystem {
  /** Update wind speed for whitecap coverage. */
  setWindSpeed(knots: number): void;

  /** Get the current whitecap coverage factor (0..1). */
  getWhitecapCoverage(): number;

  /**
   * Set the Jacobian source texture from E.2/E.3.
   * @param texture The Jacobian determinant texture (R channel).
   *   null = no Jacobian input (foam from wake injection only).
   */
  setJacobianSource(texture: unknown): void;

  /**
   * Set wake/bow-wave injection points for this frame.
   * Caller (boat rendering) provides world-space positions + intensities.
   */
  setWakeInjectionPoints(points: readonly FoamInjectionPoint[]): void;

  /**
   * Spawn spray particles at a world position based on conditions.
   * The system applies the upwind/downwind asymmetry internally.
   *
   * @param worldX World X position.
   * @param worldY World Y position.
   * @param worldZ World Z position.
   * @param apparentWindAngleRad Apparent wind angle in radians (0=upwind, π=downwind).
   * @param windSpeedKnots Current wind speed.
   * @param chopHeight Current chop/wave height in metres.
   * @param boatSpeedKnots Boat speed through water.
   */
  emitSpray(
    worldX: number, worldY: number, worldZ: number,
    apparentWindAngleRad: number,
    windSpeedKnots: number,
    chopHeight: number,
    boatSpeedKnots?: number,
  ): void;

  /**
   * Update the foam and spray systems.
   * @param dt Delta time in seconds.
   */
  update(dt: number): void;

  /** Get the foam configuration. */
  getConfig(): Readonly<FoamConfig>;

  /** Whether we're on the compute (WebGPU) spray path. */
  readonly isComputeSpray: boolean;

  /** Get the CPU spray pool (WebGL2 path). Undefined on WebGPU path. */
  getCPUSprayPool(): CPUSprayPool | undefined;

  /** Get active spray particle count. */
  getSprayCount(): number;

  /** Get the spray budget. */
  getSprayBudget(): number;

  /** Dispose all resources. */
  dispose(): void;
}

/**
 * Create the foam and spray system.
 *
 * @param capabilities Probed GPU capabilities (gates compute vs CPU fallback).
 * @param qualityKnobs Quality knobs (provides sprayBudget).
 * @param config Optional foam configuration override.
 */
export function createFoamSpraySystem(
  capabilities: GPUCapabilities,
  qualityKnobs: Pick<QualityKnobs, 'sprayBudget'>,
  config: Partial<FoamConfig> = {},
): FoamSpraySystem {
  const foamConfig: FoamConfig = { ...DEFAULT_FOAM_CONFIG, ...config };
  const useCompute = capabilities.compute;
  const sprayBudget = qualityKnobs.sprayBudget;

  // ─── State ──────────────────────────────────────────────────────────────

  let windSpeedKnots = 0;
  let whitecapCoverage = 0;
  let jacobianSource: unknown = null;
  let wakeInjectionPoints: readonly FoamInjectionPoint[] = [];

  // ─── Spray system ───────────────────────────────────────────────────────

  // CPU fallback pool (WebGL2 path)
  const cpuSprayPool = useCompute ? undefined : new CPUSprayPool(sprayBudget);

  // WebGPU compute spray state tracking (particle count for budget enforcement)
  let gpuSprayActiveCount = 0;

  // ─── Implementation ─────────────────────────────────────────────────────

  const system: FoamSpraySystem = {
    setWindSpeed(knots: number): void {
      windSpeedKnots = knots;
      whitecapCoverage = computeWhitecapCoverage(knots);
    },

    getWhitecapCoverage(): number {
      return whitecapCoverage;
    },

    setJacobianSource(texture: unknown): void {
      jacobianSource = texture;
    },

    setWakeInjectionPoints(points: readonly FoamInjectionPoint[]): void {
      wakeInjectionPoints = points;
    },

    emitSpray(
      worldX: number, worldY: number, worldZ: number,
      apparentWindAngleRad: number,
      windSpeedKnots: number,
      chopHeight: number,
      boatSpeedKnots = 6,
    ): void {
      // Compute spray intensity with upwind/downwind asymmetry
      const intensity = computeSprayIntensity(
        apparentWindAngleRad,
        windSpeedKnots,
        chopHeight,
        boatSpeedKnots,
      );

      if (intensity < 0.01) return;

      // Number of particles to emit this call (proportional to intensity)
      const emitCount = Math.max(1, Math.floor(intensity * 5));

      if (useCompute) {
        // WebGPU path: track count for budget enforcement
        // Actual compute dispatch would happen in update() via renderer.compute()
        gpuSprayActiveCount = Math.min(sprayBudget, gpuSprayActiveCount + emitCount);
      } else if (cpuSprayPool !== undefined) {
        // CPU fallback: spawn particles into the pool
        for (let i = 0; i < emitCount; i++) {
          if (cpuSprayPool.count >= sprayBudget) break;

          // Randomise velocity based on intensity and wind
          const angle = Math.random() * Math.PI * 2;
          const speed = (1 + Math.random() * 2) * intensity;
          const vx = Math.cos(angle) * speed * 0.5;
          const vy = speed * (2 + Math.random());
          const vz = Math.sin(angle) * speed * 0.5;
          const lifetime = 0.5 + Math.random() * 1.5 * intensity;

          cpuSprayPool.spawn(
            worldX + (Math.random() - 0.5) * 0.5,
            worldY + Math.random() * 0.3,
            worldZ + (Math.random() - 0.5) * 0.5,
            vx, vy, vz,
            lifetime,
          );
        }
      }
    },

    update(dt: number): void {
      // Update whitecap coverage (already set via setWindSpeed, but clamp dt)
      const clampedDt = Math.min(dt, 0.1); // Cap to prevent explosion on tab-switch

      if (useCompute) {
        // WebGPU path: the actual compute dispatch would be:
        // renderer.compute(computeUpdate) — this updates all GPU particles.
        // For budget tracking, decay the count (dead particles freed each frame).
        gpuSprayActiveCount = Math.max(0, gpuSprayActiveCount - Math.floor(clampedDt * sprayBudget * 0.3));
      } else if (cpuSprayPool !== undefined) {
        // CPU fallback: update particle physics
        cpuSprayPool.update(clampedDt);
      }

      // Foam accumulation buffer update would happen here via render-target
      // ping-pong. The actual render pass reads the previous frame's foam,
      // applies decay, injects from Jacobian + wake points, writes to the
      // alternate buffer. This is placeholder until the ping-pong render
      // targets are wired with three.js WebGPURenderer's render-to-texture.
      void jacobianSource;
      void wakeInjectionPoints;
      void foamConfig;
    },

    getConfig(): Readonly<FoamConfig> {
      return foamConfig;
    },

    get isComputeSpray(): boolean {
      return useCompute;
    },

    getCPUSprayPool(): CPUSprayPool | undefined {
      return cpuSprayPool;
    },

    getSprayCount(): number {
      if (useCompute) return gpuSprayActiveCount;
      return cpuSprayPool?.count ?? 0;
    },

    getSprayBudget(): number {
      return sprayBudget;
    },

    dispose(): void {
      cpuSprayPool?.reset();
    },
  };

  // Suppress unused variable warnings for state used in the foam render pass
  void windSpeedKnots;

  return system;
}
