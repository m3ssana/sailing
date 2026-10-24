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
  mix,
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

// ─── Per-ring band-limiting (anti-aliasing) ───────────────────────────────────

/**
 * Lower edge of the band-limit ramp, as a MULTIPLE of the local vertex spacing.
 * A sinusoid needs ≥2 samples per wavelength to be representable at all
 * (Nyquist), but a Gerstner component sampled at barely-Nyquist still aliases
 * badly and produces the needle/moiré streaks the first browser run showed. We
 * start fading a component's amplitude to zero once its wavelength drops below
 * `BAND_LIMIT_HI × spacing` and have it fully gone by `BAND_LIMIT_LO × spacing`.
 */
export const BAND_LIMIT_LO = 2.0;
/** Upper edge of the ramp: components with λ ≥ this × spacing are fully kept. */
export const BAND_LIMIT_HI = 4.0;

/**
 * Smooth Hermite step, matching GLSL/WGSL `smoothstep(edge0, edge1, x)`.
 * Returns 0 for x ≤ edge0, 1 for x ≥ edge1, with a smooth S-curve between.
 */
function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Band-limit weight for a single wave component at a given local vertex spacing.
 *
 * Returns a weight in [0, 1] that is:
 *  - **1** when the component's wavelength is comfortably resolvable at this
 *    spacing (λ ≥ BAND_LIMIT_HI × spacing) — e.g. every component on the near
 *    (0.5 m) ring where the boat sits, so physics↔render coherence is untouched;
 *  - **0** when the wavelength is below the Nyquist-ish floor
 *    (λ ≤ BAND_LIMIT_LO × spacing) — the sub-grid chop that aliases into streaks
 *    on the coarse far rings;
 *  - a smooth ramp between.
 *
 * `wavenumber` is k = 2π/λ (rad/m); spacing is world units between vertices.
 * Monotone **non-decreasing** in λ and monotone **non-increasing** in spacing,
 * which the unit tests assert.
 */
export function bandLimitWeight(wavenumber: number, spacing: number): number {
  if (!(spacing > 0) || !(wavenumber > 0)) return 1;
  const wavelength = (2 * Math.PI) / wavenumber;
  return smoothstep(BAND_LIMIT_LO * spacing, BAND_LIMIT_HI * spacing, wavelength);
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
 *
 * ### Per-ring band-limiting (`spacing`)
 *
 * When `spacing` (world units between adjacent vertices on THIS ocean ring) is
 * supplied, each component's amplitude is multiplied by {@link bandLimitWeight}
 * so components whose wavelength is too short to be resolved at this spacing are
 * faded out — killing the radial aliasing streaks the coarse far rings produced.
 * On the near ring (spacing 0.5 m) every real component weighs ≈1, so the boat
 * still sits in the full-resolution sea (req 4.12 coherence preserved). Omit
 * `spacing` (or pass ≤0) to keep every component (the original behaviour, used
 * by the coherence test's CPU path).
 */
export function buildGerstnerPositionNode(
  components: readonly WaveComponent[],
  timeUniform: TSLNode & { value: unknown },
  spacing = 0,
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

      // Band-limit weight baked in at build time (constant per ring).
      const w = spacing > 0 ? bandLimitWeight(c.wavenumber, spacing) : 1;
      if (w <= 0) continue; // fully below this ring's resolution — skip entirely

      const amplitude = float(c.amplitude * w);
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

/**
 * Build a TSL normalNode for the Gerstner-displaced surface, analytic and
 * exactly matching `WaveFieldCPU.ts`'s `normal()` (so the lit/glittering
 * surface the player sees agrees with the physics normals). Uses the
 * `T_z × T_x` cross-product order mandated by the project convention (the
 * upward normal for a Y-up parametric surface; `T_x × T_z` would yield
 * `(0, −1, 0)` on flat water).
 *
 * Statically unrolled at build time for the same reason as the position node
 * (WebGL2 TSL has no dynamic loops over a varying count). Rebuild when the
 * spectrum changes.
 *
 * ### Per-ring band-limiting + far-field flattening (`opts`)
 *
 * Normals carry FINER detail than positions — a sub-vertex ripple that barely
 * perturbs height tilts the normal sharply, which is exactly what produced the
 * needle-specular streaks in the first run. Two defences, both opt-in via
 * `opts`:
 *  - `spacing`: each component's normal contribution is weighted by
 *    {@link bandLimitWeight}, so only components resolvable at this ring's
 *    vertex spacing tilt the normal (matching the position node). Near ring →
 *    all components → coherent with physics; far rings → only the long swell.
 *  - `cameraPosition` + `flatStart`/`flatEnd`: beyond `flatStart` metres from
 *    the camera the perturbed normal is blended toward the flat up-normal
 *    `(0,1,0)`, fully flat by `flatEnd`, so the distant sea reads as a smooth
 *    sky-reflecting haze band at the horizon rather than a field of aliased
 *    glints. This is a documented rendering-layer approximation (it does not
 *    affect physics — the boat is always in the near field).
 *
 * Omit `opts` to keep the exact analytic normal with every component (the
 * original behaviour, used by the coherence path).
 */
export interface GerstnerNormalOptions {
  /** Local vertex spacing of this ring (world units). Enables band-limiting. */
  spacing?: number;
  /**
   * Camera world position uniform. Enables the distance-based flatten toward
   * the horizon. When omitted, the normal is not distance-faded.
   */
  cameraPosition?: TSLNode;
  /** Distance (m) at which the normal begins fading toward flat. Default 120. */
  flatStart?: number;
  /** Distance (m) by which the normal is fully flat. Default 600. */
  flatEnd?: number;
}

export function buildGerstnerNormalNode(
  components: readonly WaveComponent[],
  timeUniform: TSLNode & { value: unknown },
  opts: GerstnerNormalOptions = {},
): TSLNode {
  const count = Math.min(components.length, MAX_VERTEX_COMPONENTS);

  if (count === 0) {
    return vec3(0.0, 1.0, 0.0);
  }

  const spacing = opts.spacing ?? 0;
  const flatStart = opts.flatStart ?? 120;
  const flatEnd = opts.flatEnd ?? 600;
  const camPos = opts.cameraPosition;

  const node: TSLNode = Fn(() => {
    const worldPos = positionWorld;
    const wx = worldPos.dot(vec3(1.0, 0.0, 0.0));
    const wz = worldPos.dot(vec3(0.0, 0.0, 1.0));
    const t = timeUniform;

    // Accumulate the Gerstner displacement partial derivatives.
    let dDy_dx: TSLNode = float(0.0);
    let dDy_dz: TSLNode = float(0.0);
    let dDx_dx: TSLNode = float(0.0);
    let dDx_dz: TSLNode = float(0.0);
    let dDz_dx: TSLNode = float(0.0);
    let dDz_dz: TSLNode = float(0.0);

    for (let i = 0; i < count; i++) {
      const c = components[i];
      if (c === undefined) continue;

      const w = spacing > 0 ? bandLimitWeight(c.wavenumber, spacing) : 1;
      if (w <= 0) continue;

      const ki = float(c.wavenumber);
      const dxi = float(c.direction.x);
      const dzi = float(c.direction.y); // Vec2.y = world Z
      const ai = float(c.amplitude * w);
      const qi = float(c.steepness);

      const kDotP = ki.mul(dxi.mul(wx).add(dzi.mul(wz)));
      const phi = kDotP.sub(float(c.frequency).mul(t)).add(float(c.phase));
      const cosP = phi.cos();
      const sinP = phi.sin();
      const Ak = ai.mul(ki);
      const QAk = qi.mul(Ak);

      dDy_dx = dDy_dx.sub(Ak.mul(dxi).mul(sinP));
      dDy_dz = dDy_dz.sub(Ak.mul(dzi).mul(sinP));
      dDx_dx = dDx_dx.sub(QAk.mul(dxi).mul(dxi).mul(cosP));
      dDx_dz = dDx_dz.sub(QAk.mul(dxi).mul(dzi).mul(cosP));
      dDz_dx = dDz_dx.sub(QAk.mul(dxi).mul(dzi).mul(cosP));
      dDz_dz = dDz_dz.sub(QAk.mul(dzi).mul(dzi).mul(cosP));
    }

    // Tangents: T_x = (1 + dDx_dx, dDy_dx, dDz_dx), T_z = (dDx_dz, dDy_dz, 1 + dDz_dz)
    const txx = float(1.0).add(dDx_dx);
    const txy = dDy_dx;
    const txz = dDz_dx;
    const tzx = dDx_dz;
    const tzy = dDy_dz;
    const tzz = float(1.0).add(dDz_dz);

    // Normal = T_z × T_x (flat water → (0,1,0)).
    const nx = tzy.mul(txz).sub(tzz.mul(txy));
    const ny = tzz.mul(txx).sub(tzx.mul(txz));
    const nz = tzx.mul(txy).sub(tzy.mul(txx));

    let normal: TSLNode = vec3(nx, ny, nz).normalize();

    // Distance-based flatten toward the up-normal so the far sea reads as a
    // smooth, sky-reflecting horizon band (kills far-field needle specular).
    if (camPos !== undefined) {
      const dx = worldPos.x.sub(camPos.x);
      const dz = worldPos.z.sub(camPos.z);
      const dist = dx.mul(dx).add(dz.mul(dz)).sqrt();
      // 0 near (keep detail) → 1 far (flat).
      const flat = dist.sub(flatStart).div(float(Math.max(1, flatEnd - flatStart))).clamp(0, 1);
      normal = mix(normal, vec3(0.0, 1.0, 0.0), flat).normalize();
    }

    return normal;
  })();

  return node;
}

/**
 * Build a scalar TSL node in [0,1] estimating how much sub-pixel normal
 * variance the far sea carries, for a Toksvig-style roughness widening in the
 * water material: 0 in the near field (crisp glitter), → 1 at the horizon
 * (broaden the specular lobe so it is not a field of aliased needles). Driven
 * by the same `flatStart`/`flatEnd` distance band as the normal flatten so the
 * two stay consistent.
 */
export function buildDistanceRoughnessNode(
  cameraPosition: TSLNode,
  flatStart = 120,
  flatEnd = 600,
): TSLNode {
  return Fn(() => {
    const worldPos = positionWorld;
    const dx = worldPos.x.sub(cameraPosition.x);
    const dz = worldPos.z.sub(cameraPosition.z);
    const dist = dx.mul(dx).add(dz.mul(dz)).sqrt();
    return dist.sub(flatStart).div(float(Math.max(1, flatEnd - flatStart))).clamp(0, 1);
  })();
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
  bandLimitWeight,
  BAND_LIMIT_LO,
  BAND_LIMIT_HI,
} as const;
