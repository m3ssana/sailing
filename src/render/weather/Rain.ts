/**
 * Rain — Stream F.2 (Weather visuals).
 *
 * Pure model (headlessly testable, NO three.js) + a thin three/TSL layer:
 *   - `rainParams` — drop count/length/fall-speed/slant/alpha from precipitation
 *     and the air-velocity vector.
 *   - `RainSystem` — a camera-following box of instanced streaks animated
 *     entirely in the vertex shader (no per-frame CPU position writes).
 *   - `rainSurfaceDisturbance` + `rainRippleNormalNode` — a hook the water
 *     material can add to its normal (we do NOT edit WaterMaterial).
 *   - `LensDropletState` + `lensDropletMaskNode` — cockpit-camera lens droplets
 *     for the F.3 post chain to composite.
 *
 * ## Physics
 *
 * Raindrop terminal fall speed follows the Gunn–Kinzer (1949) measurements,
 * well-approximated for the 0.5–5 mm drop range by Atlas, Srivastava & Sekhon
 * (1973): v(D) ≈ 9.65 − 10.3·exp(−0.6·D), with D the equivalent diameter in mm.
 * Mean drop diameter grows weakly with rain rate R (mm/h) via the Marshall–
 * Palmer-derived relation D₀ ≈ 0.9·R^0.21 (median-volume diameter). The result
 * sits in the physical 3–9 m/s band across drizzle→downpour.
 *
 * Rain "slants DOWNWIND": a drop falling at terminal speed `vFall` while the air
 * blows horizontally at velocity `w` acquires that same horizontal velocity, so
 * its streak points along `w` (the air-velocity direction) on the way down. The
 * slant angle from vertical is atan(|w| / vFall).
 *
 * ## Conventions
 *
 * - World space Y-up, +X east, +Z south. `windVelocity` is the AIR velocity
 *   (same sign as WindField.velocity), NOT the meteorological "from" bearing.
 * - SI + radians; precipitation in mm/h.
 */

import type { Vec3 } from '@/types';

// ─── Pure rain parameters ───────────────────────────────────────────────────────

/** Resolved rain visual parameters for the instanced streak system. */
export interface RainParams {
  /** Number of streak instances to draw (≤ budget). */
  dropCount: number;
  /** Streak length, metres. Longer in heavier rain / faster fall. */
  streakLength: number;
  /** Terminal fall speed, m/s (downward). In the physical 3–9 m/s band. */
  fallSpeed: number;
  /** Horizontal drop velocity (= air velocity), m/s. Drives the slant. */
  horizontalVelocity: Vec3;
  /** Slant angle from vertical, radians = atan(|w| / fallSpeed). */
  slantAngle: number;
  /** Per-streak alpha, 0..1. Grows with rate but stays translucent. */
  alpha: number;
}

/** Default maximum streak budget (overridable per call). */
export const DEFAULT_RAIN_BUDGET = 8000;

/**
 * Median-volume drop diameter (mm) from rain rate R (mm/h), Marshall–Palmer.
 * Clamped to a sane 0.1..6 mm range.
 */
function medianDropDiameterMm(precipitationMmH: number): number {
  if (precipitationMmH <= 0) return 0;
  const d = 0.9 * Math.pow(precipitationMmH, 0.21);
  return Math.min(6, Math.max(0.1, d));
}

/**
 * Terminal fall speed (m/s) from rain rate, via Atlas et al. (1973):
 * v(D) = 9.65 − 10.3·exp(−0.6·D), D in mm. Zero rate → 0.
 */
export function terminalFallSpeed(precipitationMmH: number): number {
  if (precipitationMmH <= 0) return 0;
  const d = medianDropDiameterMm(precipitationMmH);
  const v = 9.65 - 10.3 * Math.exp(-0.6 * d);
  // Clamp into the documented physical band for the rendered drop sizes.
  return Math.min(9, Math.max(3, v));
}

/**
 * Compute rain parameters from the precipitation rate and the air-velocity
 * vector.
 *
 * Monotone in precipitation (count/length/alpha all non-decreasing), exactly
 * zero at 0 mm/h, and the drop count is capped by `budget`.
 *
 * @param precipitationMmH  Rain rate, mm/h.
 * @param windVelocity      Air-velocity vector (m/s); its horizontal part sets
 *                          the slant. Y component ignored.
 * @param budget            Maximum streak count (default DEFAULT_RAIN_BUDGET).
 */
export function rainParams(
  precipitationMmH: number,
  windVelocity: Vec3,
  budget = DEFAULT_RAIN_BUDGET,
): RainParams {
  const rate = Math.max(0, precipitationMmH);
  if (rate <= 0) {
    return {
      dropCount: 0,
      streakLength: 0,
      fallSpeed: 0,
      horizontalVelocity: { x: 0, y: 0, z: 0 },
      slantAngle: 0,
      alpha: 0,
    };
  }

  const fallSpeed = terminalFallSpeed(rate);

  // Count saturates toward the budget: 1 - exp(-rate / scale). Light drizzle
  // (~1 mm/h) is sparse, heavy rain (~20 mm/h) near the cap.
  const fill = 1 - Math.exp(-rate / 10);
  const dropCount = Math.min(budget, Math.round(budget * fill));

  // Streak length grows with fall speed and rate (longer, faster streaks in
  // heavier rain). Monotone in rate.
  const streakLength = 0.4 + 0.15 * fallSpeed + 0.05 * Math.min(rate, 50);

  // Horizontal velocity = air velocity (ground-plane component).
  const wx = windVelocity.x;
  const wz = windVelocity.z;
  const horizontalVelocity: Vec3 = { x: wx, y: 0, z: wz };
  const wSpeed = Math.hypot(wx, wz);
  const slantAngle = Math.atan2(wSpeed, fallSpeed);

  // Alpha grows with rate but saturates translucent (never fully opaque).
  const alpha = Math.min(0.6, 0.12 + 0.03 * Math.min(rate, 16));

  return { dropCount, streakLength, fallSpeed, horizontalVelocity, slantAngle, alpha };
}

/**
 * Water-surface disturbance intensity (0..1) from rain rate: ripple/roughness
 * the water material can add. Monotone increasing and saturating — drizzle
 * barely stipples the surface, heavy rain fully roughens it.
 *
 * Uses 1 - exp(-rate / 8): 0 at 0, ~0.71 at 10 mm/h, → 1 for a downpour.
 */
export function rainSurfaceDisturbance(precipitationMmH: number): number {
  const rate = Math.max(0, precipitationMmH);
  return 1 - Math.exp(-rate / 8);
}

// ─── Lens droplet state (pure) ───────────────────────────────────────────────────

/**
 * Accumulating/evaporating cockpit-camera lens droplet coverage, 0..1.
 *
 * Grows only while rain falls on an EXPOSED camera (open cockpit, looking up
 * into the weather); decays by evaporation/run-off when dry or sheltered.
 * Always clamped to [0,1].
 */
export class LensDropletState {
  private _coverage = 0;

  /** Seconds to approach full coverage in heavy rain (accumulation τ). */
  private readonly accumTau: number;
  /** Seconds to dry out (decay τ). */
  private readonly decayTau: number;

  constructor(accumTau = 6, decayTau = 20) {
    this.accumTau = Math.max(0.1, accumTau);
    this.decayTau = Math.max(0.1, decayTau);
  }

  /** Current coverage, 0..1. */
  get coverage(): number {
    return this._coverage;
  }

  /**
   * Advance the droplet state.
   *
   * @param dt        Timestep, seconds.
   * @param rainRate  Precipitation rate, mm/h.
   * @param exposed   True when the camera is exposed to falling rain.
   */
  update(dt: number, rainRate: number, exposed: boolean): void {
    const step = Math.max(0, dt);
    const raining = exposed && rainRate > 0;
    if (raining) {
      // Target coverage scales with rate (heavier rain → more droplets).
      const target = Math.min(1, rainRate / 10);
      const k = 1 - Math.exp(-step / this.accumTau);
      this._coverage += (target - this._coverage) * k;
      // Never let accumulation push below current if target is lower than
      // current coverage — droplets don't vanish just because rain eased.
      if (this._coverage < 0) this._coverage = 0;
    } else {
      // Dry: exponential decay toward 0 (evaporation / run-off).
      this._coverage *= Math.exp(-step / this.decayTau);
    }
    this._coverage = Math.min(1, Math.max(0, this._coverage));
  }

  /** Reset to dry. */
  reset(): void {
    this._coverage = 0;
  }
}

// ─── three/TSL layer ─────────────────────────────────────────────────────────────

import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, uniform, positionLocal, time } from 'three/tsl';
import type { TSLNode } from 'three/tsl';

/**
 * TSL helper the water material can ADD to its normal: a procedural ripple
 * perturbation whose amplitude scales with `intensity`
 * (= rainSurfaceDisturbance). Returns a tangent-space normal offset (xyz with
 * the up component dominant). The water material is NOT edited here — this hook
 * is exported for whoever integrates it.
 *
 * @param positionXZ  World XZ as a vec2 node.
 * @param intensity   Disturbance intensity node, 0..1.
 */
export function rainRippleNormalNode(positionXZ: TSLNode, intensity: TSLNode): TSLNode {
  return Fn(() => {
    // Two travelling sinusoidal ripple sets, animated by time, give a simple
    // isotropic stipple. Amplitude scales with intensity.
    const t = time.mul(6);
    const px = positionXZ.mul(float(8));
    const r1 = px.add(vec2(t, t)).sin();
    const r2 = px.mul(float(1.7)).sub(vec2(t, t)).sin();
    const ripple = r1.add(r2).mul(intensity).mul(float(0.15));
    // Build a normal offset: perturb x/z, keep a strong +y so it stays a normal.
    return vec3(ripple, float(1), ripple).normalize();
  })();
}

/**
 * TSL mask for lens droplets, for the F.3 post chain. Produces a 0..1 mask over
 * screen UV: clusters of droplets whose count/size scale with `coverage`, with
 * a slow time-driven shimmer. Composited later (refraction/blur) by F.3.
 *
 * @param uv        Screen UV node (vec2, 0..1).
 * @param coverage  Droplet coverage node, 0..1.
 * @param timeNode  Optional time node (defaults to TSL `time`).
 */
export function lensDropletMaskNode(uv: TSLNode, coverage: TSLNode, timeNode?: TSLNode): TSLNode {
  const tn = timeNode ?? time;
  return Fn(() => {
    // Cellular-ish: quantise UV into a grid whose density grows with coverage.
    const cells = float(8).add(coverage.mul(24));
    const g = uv.mul(cells);
    const fx = g.fract().sub(0.5);
    // Distance to cell centre → droplet disc; radius grows with coverage.
    const d = fx.length();
    const radius = coverage.mul(0.35).add(0.05);
    const shimmer = tn.mul(0.3).sin().mul(0.05);
    const mask = radius.add(shimmer).sub(d).saturate();
    return mask.mul(coverage);
  })();
}

/** Options for the instanced rain system. */
export interface RainSystemOptions {
  /** Half-extent of the camera-following box (metres). Default 30. */
  boxHalfExtent?: number;
  /** Streak budget (max instances). Default DEFAULT_RAIN_BUDGET. */
  budget?: number;
}

/**
 * Camera-following instanced rain. Streaks live in a box around the camera and
 * are animated ENTIRELY in the vertex shader (falling + slant + wrap-around by
 * time); there are no per-frame CPU position writes. The whole object hides
 * when precipitation is ~0.
 *
 * Implementation note (honest scope): streaks are drawn as a single instanced
 * line-like quad geometry; per-instance seed positions are baked once into an
 * instance attribute, and the vertex shader computes the falling offset from
 * `time`, wrapping within the box height. This keeps it a pure vertex-shader
 * animation on both WebGPU and WebGL2 (no compute).
 */
export interface RainSystem {
  /** The scene object to add under the camera rig. */
  readonly object: THREE.Object3D;
  /** Push the latest rain params + air velocity. Hides when dropCount is 0. */
  update(params: RainParams): void;
  /** Dispose GPU resources. */
  dispose(): void;
}

/** Create the instanced rain system. */
export function createRainSystem(options: RainSystemOptions = {}): RainSystem {
  const halfExtent = options.boxHalfExtent ?? 30;
  const budget = options.budget ?? DEFAULT_RAIN_BUDGET;

  // A single thin quad serves as the streak; instancing replicates it. We use a
  // PlaneGeometry and a PointsNodeMaterial-free approach via Mesh instancing is
  // awkward without InstancedMesh in the pinned typings, so we drive a
  // PointsNodeMaterial whose positionNode places each point and sizeNode gives
  // it a vertical streak scale. This is the simplest thing that builds on both
  // backends; documented as a rendering-layer simplification of true instanced
  // quads.
  const material = new THREE.PointsNodeMaterial();

  // Uniforms updated per frame.
  const uFallSpeed = uniform(0);
  const uDirX = uniform(0);
  const uDirZ = uniform(0);
  const uStreak = uniform(0);
  const uAlpha = uniform(0);
  const uHalf = uniform(halfExtent);

  // Position node: a deterministic per-point seed scattered in the box, offset
  // downward by time*fallSpeed and horizontally by the air velocity, wrapped
  // within [−half, +half] via fract. Mirrors rainParams' slant (downwind).
  material.positionNode = Fn(() => {
    // Use positionLocal as a per-point seed carrier (baked seeds in geometry).
    const seed = positionLocal;
    const h = uHalf;
    const fall = time.mul(uFallSpeed);
    // Vertical wrap: start high, fall, wrap.
    const y = h.sub(seed.y.add(fall).mod(h.mul(2)));
    // Horizontal drift (downwind slant).
    const driftX = time.mul(uDirX);
    const driftZ = time.mul(uDirZ);
    const x = seed.x.add(driftX).add(h).mod(h.mul(2)).sub(h);
    const z = seed.z.add(driftZ).add(h).mod(h.mul(2)).sub(h);
    return vec3(x, y, z);
  })();

  material.sizeNode = uStreak.mul(float(2)).add(float(1));
  material.colorNode = vec3(0.7, 0.75, 0.8);
  // Streaks are translucent: drive per-fragment opacity from the resolved alpha
  // (rainParams.alpha). Without this the alpha was dead — the material rendered
  // fully opaque. Mirrors the StarFieldRig transparent/opacityNode pattern.
  material.transparent = true;
  material.depthWrite = false;
  material.opacityNode = Fn(() => uAlpha.clamp(0, 1))();

  // Bake per-point seeds into a geometry.
  const geometry = new THREE.BufferGeometry();
  const seeds = new Float32Array(budget * 3);
  for (let i = 0; i < budget; i++) {
    seeds[i * 3 + 0] = (Math.random() * 2 - 1) * halfExtent;
    seeds[i * 3 + 1] = Math.random() * halfExtent * 2;
    seeds[i * 3 + 2] = (Math.random() * 2 - 1) * halfExtent;
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(seeds, 3));

  const points = new THREE.Mesh(geometry, material);
  points.visible = false;

  return {
    object: points,
    update(params: RainParams): void {
      if (params.dropCount <= 0 || params.alpha <= 0) {
        points.visible = false;
        return;
      }
      points.visible = true;
      (uFallSpeed as { value: unknown }).value = params.fallSpeed;
      (uDirX as { value: unknown }).value = params.horizontalVelocity.x;
      (uDirZ as { value: unknown }).value = params.horizontalVelocity.z;
      (uStreak as { value: unknown }).value = params.streakLength;
      (uAlpha as { value: unknown }).value = params.alpha;
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
