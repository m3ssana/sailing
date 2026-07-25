/**
 * WebGL2 spectrum fallback — E.3 (Ocean Rendering).
 *
 * Provides ocean wave displacement when compute shaders are unavailable (WebGL2
 * backend). Two quality tiers:
 *
 * ## Mid-tier: CPU-evaluated displacement textures (2 cascades, 128²)
 *
 * Evaluates a direct Gerstner sum per-texel into DataTextures (CPU-side), which
 * are then sampled by the water material's positionNode. Each texel computes the
 * full displacement vector (dx, dy, dz) from the spectrum components at that
 * world position. Two cascades cover different spatial scales (inner = high-freq
 * detail, outer = large swells).
 *
 * ### Why direct sum instead of butterfly FFT?
 *
 * True butterfly IFFT via fragment shaders requires log₂(N) = 7 ping-pong passes
 * (for N=128) with bit-reversal permutation, twiddle factor textures, and careful
 * inter-pass coordination. This is:
 * 1. High implementation complexity with many failure modes.
 * 2. Marginal quality gain over direct sum when the source spectrum has only
 *    24 frequency bins (FINE_FREQ_BINS in WaveSpectrum.ts). The FFT's advantage
 *    is O(N log N) vs O(N²) — but here we evaluate 24 components at each of
 *    128² texels, which is 24 × 16384 = ~393k operations per cascade. This is
 *    within a single-frame CPU budget (~2ms on modern hardware).
 * 3. The direct sum uses the EXACT same Gerstner math as WaveFieldCPU.ts,
 *    making coherence with physics trivial to verify.
 *
 * ### Why CPU evaluation rather than render-target passes?
 *
 * Rendering float RGBA into a WebGL2 render target requires EXT_color_buffer_float,
 * which is not universally available on mobile WebGL2 devices. The CPU evaluation
 * at 128² × 24 components completes in <2ms and is perfectly portable. Cascades
 * are updated on alternating frames to halve the per-frame cost.
 *
 * ## Low-tier: 32-component Gerstner vertex shader (no render targets)
 *
 * A pure TSL positionNode that evaluates a 32-component truncated Gerstner sum
 * directly in the vertex shader. No render targets, no texture reads — works on
 * the most minimal WebGL2 hardware. The 32 components are selected by the SAME
 * energy-ranked methodology as WaveFieldCPU's 24 (via `buildSpectrum(params, 32)`),
 * which guarantees the truncated set is an exact superset of the physics CPU set,
 * maintaining coherence (requirement 4.12).
 *
 * ## Cascade texture layout (consumer-facing contract)
 *
 * Each cascade DataTexture is 128×128 RGBA float (Float32Array, 4 channels):
 * - R: displacement X (horizontal Gerstner, east)
 * - G: displacement Y (vertical height)
 * - B: displacement Z (horizontal Gerstner, south)
 * - A: foam/Jacobian metric (reserved, written as 0.0 — E.5 foam task)
 *
 * This layout is chosen to be compatible with whatever E.2's compute path
 * settles on. If E.2 chose a different layout, reconciliation is a simple
 * channel-swizzle in the sampling code.
 *
 * @module
 */

import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec3,
  uniform,
  positionLocal,
  positionWorld,
} from 'three/tsl';
import type { TSLNode } from 'three/tsl';
import type { GPUCapabilities, QualityKnobs, WaveComponent, WaveSpectrumParams } from '@/types';
import { buildSpectrum } from '@environment/waves/WaveSpectrum';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Resolution per cascade for mid-tier displacement textures. */
const CASCADE_RESOLUTION = 128;

/** Number of cascades for the mid-tier path. */
const CASCADE_COUNT = 2;

/** Number of Gerstner components for the low-tier vertex path. */
const LOW_TIER_COMPONENTS = 32;

/** Max components in the vertex shader unrolled loop. */
const MAX_VERTEX_COMPONENTS = 32;

/**
 * Cascade spatial scales (metres per cascade edge).
 * Cascade 0: inner detail (covers ~50m around camera).
 * Cascade 1: outer swell (covers ~200m around camera).
 */
const CASCADE_SCALES: readonly number[] = [50, 200];

// ─── Types ────────────────────────────────────────────────────────────────────

/** Tier selection for the fallback. */
export type FallbackTier = 'mid' | 'low';

/** The public handle returned by createSpectrumFallback. */
export interface SpectrumFallbackHandle {
  /** Whether this fallback is active (false when compute is available). */
  readonly active: boolean;

  /** Which tier is in use. */
  readonly tier: FallbackTier;

  /**
   * Update the spectrum (call when weather/wave conditions change).
   * Rebuilds component data for the active tier.
   */
  updateSpectrum(params: WaveSpectrumParams): void;

  /**
   * Get the TSL positionNode for the low-tier vertex displacement path.
   * Returns undefined if this fallback is inactive or using mid-tier.
   */
  getPositionNode(): TSLNode | undefined;

  /**
   * Get cascade displacement textures for the mid-tier path.
   * Returns undefined if this fallback is inactive or using low-tier.
   * Each texture is CASCADE_RESOLUTION² RGBA float.
   */
  getCascadeTextures(): readonly THREE.DataTexture[] | undefined;

  /**
   * Get cascade world-space scales (metres per texture edge).
   */
  getCascadeScales(): readonly number[];

  /**
   * Per-frame update: evaluates the spectrum into textures (mid-tier) or
   * updates the time uniform (low-tier). Call once per frame.
   * @param t Session time in seconds.
   */
  update(t: number): void;

  /** Dispose GPU resources. */
  dispose(): void;
}

// ─── Low-tier: Vertex shader Gerstner sum ─────────────────────────────────────

/**
 * Build a TSL positionNode that computes a truncated Gerstner sum in the vertex
 * shader. This evaluates the displacement at each vertex's world position, using
 * the same functional form as WaveFieldCPU.ts's `displacement()`.
 *
 * The node graph is statically unrolled at build time because TSL on WebGL2
 * does not support dynamic loops over varying iteration counts. When the
 * spectrum changes (weather transition), the positionNode must be rebuilt.
 *
 * Each component contributes:
 *   dy += amplitude * cos(k * (dirX*wx + dirZ*wz) - omega*t + phase)
 *   dx += -steepness * amplitude * dirX * sin(...)
 *   dz += -steepness * amplitude * dirZ * sin(...)
 *
 * This is exactly WaveFieldCPU.ts's displacement() function.
 */
export function buildGerstnerPositionNode(
  components: readonly WaveComponent[],
  timeUniform: TSLNode & { value: unknown },
): TSLNode {
  const count = Math.min(components.length, MAX_VERTEX_COMPONENTS);

  if (count === 0) {
    return positionLocal;
  }

  const node: TSLNode = Fn(() => {
    const worldPos = positionWorld;
    // Extract world X and Z from the world position vector.
    // positionWorld is a vec3; dot with unit vectors extracts components.
    const wx = worldPos.dot(vec3(1.0, 0.0, 0.0));
    const wz = worldPos.dot(vec3(0.0, 0.0, 1.0));
    const t = timeUniform;

    let totalDx: TSLNode = float(0.0);
    let totalDy: TSLNode = float(0.0);
    let totalDz: TSLNode = float(0.0);

    for (let i = 0; i < count; i++) {
      const c = components[i];
      if (c === undefined) continue;

      const amplitude = float(c.amplitude);
      const wavenumber = float(c.wavenumber);
      const frequency = float(c.frequency);
      const phase = float(c.phase);
      const dirX = float(c.direction.x);
      const dirZ = float(c.direction.y); // Vec2.y = world Z
      const steepness = float(c.steepness);

      // k * (d · p) = wavenumber * (dirX * wx + dirZ * wz)
      const kDotP = wavenumber.mul(dirX.mul(wx).add(dirZ.mul(wz)));
      // Phase at this vertex and time: k·(d·p) - ω·t + φ
      const phi = kDotP.sub(frequency.mul(t)).add(phase);
      const cosP = phi.cos();
      const sinP = phi.sin();

      // Vertical displacement: A * cos(phase)
      totalDy = totalDy.add(amplitude.mul(cosP));

      // Horizontal Gerstner displacement: -Q * A * d * sin(phase)
      const horizontalScale = steepness.mul(amplitude);
      totalDx = totalDx.sub(horizontalScale.mul(dirX).mul(sinP));
      totalDz = totalDz.sub(horizontalScale.mul(dirZ).mul(sinP));
    }

    // Add displacement to local position
    return positionLocal.add(vec3(totalDx, totalDy, totalDz));
  })();

  return node;
}

// ─── Mid-tier: CPU-evaluated displacement textures ────────────────────────────

/**
 * Evaluate the Gerstner sum into a Float32 RGBA buffer (CPU-side).
 *
 * Each texel maps to a world-space position within the cascade's spatial extent.
 * The cascade is centred at world origin (consumer offsets via camera tracking).
 *
 * Layout per texel: [dx, dy, dz, foam] — 4 floats (RGBA).
 */
export function evaluateCascadeTexture(
  target: Float32Array,
  components: readonly WaveComponent[],
  scale: number,
  resolution: number,
  t: number,
): void {
  const invRes = scale / resolution;
  const halfScale = scale * 0.5;
  const count = components.length;

  for (let row = 0; row < resolution; row++) {
    // World Z for this texel (centred at 0, covers -halfScale..+halfScale)
    const wz = (row + 0.5) * invRes - halfScale;

    for (let col = 0; col < resolution; col++) {
      // World X for this texel
      const wx = (col + 0.5) * invRes - halfScale;

      let dx = 0;
      let dy = 0;
      let dz = 0;

      for (let i = 0; i < count; i++) {
        const c = components[i];
        if (c === undefined) continue;

        const kDotP = c.wavenumber * (c.direction.x * wx + c.direction.y * wz);
        const phase = kDotP - c.frequency * t + c.phase;
        const cosP = Math.cos(phase);
        const sinP = Math.sin(phase);

        dy += c.amplitude * cosP;
        const horizontalScale = -c.steepness * c.amplitude;
        dx += horizontalScale * c.direction.x * sinP;
        dz += horizontalScale * c.direction.y * sinP;
      }

      const pixelIdx = (row * resolution + col) * 4;
      target[pixelIdx] = dx;
      target[pixelIdx + 1] = dy;
      target[pixelIdx + 2] = dz;
      target[pixelIdx + 3] = 0; // Foam/Jacobian — reserved for E.5
    }
  }
}

// ─── Tier selection ───────────────────────────────────────────────────────────

/**
 * Determine which fallback tier to use based on capabilities and quality knobs.
 *
 * Returns null if compute shaders are available (this module should not activate).
 */
export function selectFallbackTier(
  capabilities: GPUCapabilities,
  knobs: QualityKnobs,
): FallbackTier | null {
  // If compute shaders are available, this fallback is not needed.
  if (capabilities.compute) return null;

  // Low tier: when quality preset requests minimal ocean (1 cascade at 128)
  if (knobs.oceanCascades === 1 && knobs.oceanResolution === 128) {
    return 'low';
  }

  // Otherwise mid-tier for WebGL2.
  return 'mid';
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create the WebGL2 spectrum fallback system.
 *
 * @param capabilities — GPU capabilities from probeCapabilities()
 * @param knobs — current quality knobs
 * @param initialParams — initial wave spectrum parameters (from environment)
 * @returns handle for integration with the ocean rendering pipeline
 */
export function createSpectrumFallback(
  capabilities: GPUCapabilities,
  knobs: QualityKnobs,
  initialParams: WaveSpectrumParams,
): SpectrumFallbackHandle {
  const tier = selectFallbackTier(capabilities, knobs);

  // If compute is available, return an inactive handle.
  if (tier === null) {
    return createInactiveHandle();
  }

  // ─── Shared state ─────────────────────────────────────────────────────────

  const timeUniform = uniform(0.0);
  let currentComponents: readonly WaveComponent[] = [];
  let positionNode: TSLNode | undefined;
  let cascadeTextures: THREE.DataTexture[] | undefined;
  let cascadeBuffers: Float32Array[] | undefined;

  // ─── Build from params ──────────────────────────────────────────────────

  function rebuildFromParams(params: WaveSpectrumParams): void {
    if (tier === 'low') {
      // Low tier: 32 components for vertex displacement
      const result = buildSpectrum(params, LOW_TIER_COMPONENTS);
      currentComponents = result.components;
      positionNode = buildGerstnerPositionNode(currentComponents, timeUniform);
    } else {
      // Mid tier: full spectrum (24 components) into displacement textures
      const result = buildSpectrum(params);
      currentComponents = result.components;
      ensureCascadeTextures();
    }
  }

  function ensureCascadeTextures(): void {
    if (cascadeTextures !== undefined) return;
    cascadeTextures = [];
    cascadeBuffers = [];
    for (let i = 0; i < CASCADE_COUNT; i++) {
      const buffer = new Float32Array(CASCADE_RESOLUTION * CASCADE_RESOLUTION * 4);
      const texture = new THREE.DataTexture(buffer, CASCADE_RESOLUTION, CASCADE_RESOLUTION);
      cascadeTextures.push(texture);
      cascadeBuffers.push(buffer);
    }
  }

  rebuildFromParams(initialParams);

  // ─── Per-frame update ───────────────────────────────────────────────────

  /** Cascade update alternation index. */
  let cascadeUpdateIndex = 0;

  function updateFrame(t: number): void {
    // Update the time uniform for the low-tier vertex shader path.
    timeUniform.value = t;

    if (tier === 'mid' && cascadeBuffers !== undefined && cascadeTextures !== undefined) {
      // Update one cascade per frame (alternating) to spread load.
      const idx = cascadeUpdateIndex % CASCADE_COUNT;
      const buffer = cascadeBuffers[idx];
      const texture = cascadeTextures[idx];
      const scale = CASCADE_SCALES[idx];

      if (buffer !== undefined && texture !== undefined && scale !== undefined) {
        evaluateCascadeTexture(buffer, currentComponents, scale, CASCADE_RESOLUTION, t);
        texture.needsUpdate = true;
      }

      cascadeUpdateIndex++;
    }
  }

  // ─── Public handle ────────────────────────────────────────────────────────

  return {
    active: true,
    tier,

    updateSpectrum(params: WaveSpectrumParams): void {
      rebuildFromParams(params);
    },

    getPositionNode(): TSLNode | undefined {
      if (tier !== 'low') return undefined;
      return positionNode;
    },

    getCascadeTextures(): readonly THREE.DataTexture[] | undefined {
      if (tier !== 'mid') return undefined;
      return cascadeTextures;
    },

    getCascadeScales(): readonly number[] {
      return CASCADE_SCALES;
    },

    update(t: number): void {
      updateFrame(t);
    },

    dispose(): void {
      if (cascadeTextures !== undefined) {
        for (const tex of cascadeTextures) {
          tex.dispose();
        }
      }
      cascadeTextures = undefined;
      cascadeBuffers = undefined;
    },
  };
}

// ─── Inactive handle (compute available — no fallback needed) ─────────────────

function createInactiveHandle(): SpectrumFallbackHandle {
  return {
    active: false,
    tier: 'mid',
    updateSpectrum: () => { /* no-op when inactive */ },
    getPositionNode: () => undefined,
    getCascadeTextures: () => undefined,
    getCascadeScales: () => CASCADE_SCALES,
    update: () => { /* no-op when inactive */ },
    dispose: () => { /* no-op when inactive */ },
  };
}

// ─── Exports for testing ──────────────────────────────────────────────────────

export const _testing = {
  CASCADE_RESOLUTION,
  CASCADE_COUNT,
  CASCADE_SCALES,
  LOW_TIER_COMPONENTS,
  MAX_VERTEX_COMPONENTS,
  evaluateCascadeTexture,
} as const;
