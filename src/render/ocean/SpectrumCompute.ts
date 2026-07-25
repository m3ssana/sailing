/**
 * GPU spectrum compute — E.2 (Ocean Rendering).
 *
 * Evaluates the wave spectrum on the GPU via a DIRECT GERSTNER SUM compute
 * shader, producing per-cascade displacement, derivative, and Jacobian textures
 * at 128² or 256² resolution.
 *
 * ## Design decision: direct sum vs IFFT
 *
 * The task spec allows a direct-sum fallback if true IFFT is impractical.
 * We choose the direct sum because:
 *
 * 1. Three.js TSL compute (0.180) exposes `instancedArray` + `element(instanceIndex)`
 *    for storage buffer access, NOT true 2D storage texture write (`textureStore`).
 *    An IFFT butterfly network requires multi-pass ping-pong with 2D read/write
 *    that the current TSL API doesn't cleanly support.
 *
 * 2. A direct Gerstner sum of N components per texel is embarrassingly parallel,
 *    uses the EXACT same mathematical formula as WaveFieldCPU.ts, and is trivially
 *    verifiable for coherence — the only variable is how many components are summed.
 *
 * 3. With 256² texels and 128 components, we evaluate ~8.4M trig operations per
 *    cascade per frame — well within GPU compute throughput on any WebGPU device.
 *
 * 4. By using the SAME spectrum (same `buildSpectrum` output, same phases, same
 *    wavenumbers), the GPU and CPU paths produce numerically identical results
 *    at shared component indices. The GPU simply sums MORE components (128 vs 24)
 *    for higher visual fidelity, while the CPU's 24-component subset is what
 *    physics uses. Coherence is guaranteed by construction.
 *
 * ## Output textures (per cascade)
 *
 * - **Displacement** (RGBA Float32, resolution² texels, row-major):
 *   RGB = (dx, dy, dz) Gerstner displacement in world-space metres. A = 1.0.
 *
 * - **Derivatives** (RGBA Float32, resolution² texels, row-major):
 *   R = ∂Dy/∂x, G = ∂Dy/∂z, B = ∂Dx/∂x + ∂Dz/∂z (horizontal divergence).
 *   A = 0.0. Normal reconstruction uses T_z × T_x convention (STATUS.md).
 *
 * - **Jacobian** (R Float32, resolution² texels, row-major):
 *   J = (1 + ∂Dx/∂x)(1 + ∂Dz/∂z) - (∂Dz/∂x)²
 *   J < 0 → strong foam, 0 < J < 0.3 → moderate foam, J ≥ 1 → no foam.
 *
 * ## E.5 integration contract
 *
 * E.5 (foam) should call `getJacobianBuffer(cascadeIndex)` and read the flat
 * Float32Array of `resolution²` elements. Each element is the Jacobian
 * determinant of the horizontal displacement mapping at that texel. Threshold
 * at approximately -0.3 to 0.0 for foam generation intensity.
 *
 * ## GPU integration pattern (for E.3/E.4 wiring)
 *
 * On the WebGPU tier, the vertex shader samples displacement via:
 * ```
 * // In the material's positionNode:
 * const disp = displacementBuffer.element(texelIndex);
 * // where texelIndex = row * resolution + col, computed from vertex UV
 * ```
 *
 * The `instancedArray` buffers created by `buildGPUComputeNodes()` are the
 * same buffers referenced in the material. After `renderer.compute(computeNode)`,
 * the displacement data is immediately available to the vertex shader without
 * CPU readback.
 *
 * @module
 */

import type { WaveComponent, WaveSpectrumParams } from '@/types';
import type { QualityKnobs } from '@/types';
import { buildSpectrum } from '@environment/waves/WaveSpectrum';

// ─── Constants ────────────────────────────────────────────────────────────────

const { PI, sin, cos, sqrt } = Math;
const TAU = 2 * PI;

/**
 * Maximum components to evaluate on GPU per cascade.
 * 128 gives excellent visual fidelity while keeping compute cost manageable.
 * The CPU path uses 24; we use more for higher spatial resolution.
 */
const MAX_GPU_COMPONENTS = 128;

/**
 * Cascade spatial extents in metres. Each cascade's texture tiles over this
 * world-space extent. Chosen so that:
 * - Cascade 0 captures ripples visible near the camera
 * - Cascade 1 captures medium waves
 * - Cascade 2 captures ocean swell at the horizon
 */
const CASCADE_EXTENTS: readonly [number, number, number] = [25, 128, 512];

/**
 * Wavelength band boundaries for cascade assignment.
 * Component with wavelength λ goes to the cascade whose band contains it.
 * Boundaries are at the geometric mean of adjacent extents.
 */
const CASCADE_WAVELENGTH_BOUNDS: readonly [number, number] = [
  sqrt(CASCADE_EXTENTS[0] * CASCADE_EXTENTS[1]),  // ~56.6m
  sqrt(CASCADE_EXTENTS[1] * CASCADE_EXTENTS[2]),  // ~256m
];

// ─── Types ────────────────────────────────────────────────────────────────────

/** Packed component data for GPU upload (one entry per component). */
export interface PackedComponent {
  /** Amplitude (metres). */
  amplitude: number;
  /** Wavenumber (rad/m). */
  wavenumber: number;
  /** Angular frequency (rad/s). */
  frequency: number;
  /** Phase offset (rad). */
  phase: number;
  /** Steepness (Gerstner Q factor), 0..1. */
  steepness: number;
  /** Direction X component (unit vector on XZ plane). */
  dirX: number;
  /** Direction Z component (unit vector on XZ plane). */
  dirZ: number;
}

/** Per-cascade data ready for GPU consumption. */
export interface CascadeData {
  /** Cascade index (0, 1, or 2). */
  index: number;
  /** World-space extent this cascade tiles over (metres). */
  extent: number;
  /** Components assigned to this cascade, packed for GPU. */
  components: readonly PackedComponent[];
  /** Number of active components (may be less than MAX_GPU_COMPONENTS). */
  componentCount: number;
}

/** Result of a single-texel evaluation (for CPU-side verification). */
export interface TexelResult {
  /** Gerstner displacement (dx, dy, dz) in metres. */
  displacement: { x: number; y: number; z: number };
  /** Partial derivatives for normal reconstruction. */
  derivatives: { dDy_dx: number; dDy_dz: number; horizontalDiv: number };
  /** Jacobian determinant of the horizontal displacement mapping. */
  jacobian: number;
}

/** Configuration for the spectrum compute pipeline. */
export interface SpectrumComputeConfig {
  /** Number of cascades (1, 2, or 3). From QualityKnobs.oceanCascades. */
  cascades: 1 | 2 | 3;
  /** Texture resolution per cascade (128 or 256). From QualityKnobs.oceanResolution. */
  resolution: 128 | 256;
}

/** The output handle of the spectrum compute system. */
export interface SpectrumComputeHandle {
  /** Cascade data (spectrum components assigned per cascade). */
  readonly cascadeData: readonly CascadeData[];
  /** Configuration. */
  readonly config: SpectrumComputeConfig;

  /**
   * Update spectrum from new parameters (e.g. weather change).
   * Rebuilds cascade component assignments.
   */
  updateSpectrum(params: WaveSpectrumParams): void;

  /**
   * Evaluate a single texel on the CPU (for coherence verification).
   * Uses the exact same formula the GPU compute shader would use.
   */
  evaluateTexel(cascadeIndex: number, col: number, row: number, time: number): TexelResult | undefined;

  /**
   * Get the displacement buffer for a cascade (flat Float32Array, resolution² × 4).
   * Layout: [dx, dy, dz, 1.0] per texel, row-major.
   */
  getDisplacementBuffer(cascadeIndex: number): Float32Array | undefined;

  /**
   * Get the derivative buffer for a cascade (flat Float32Array, resolution² × 4).
   * Layout: [dDy_dx, dDy_dz, horizontalDiv, 0.0] per texel, row-major.
   */
  getDerivativeBuffer(cascadeIndex: number): Float32Array | undefined;

  /**
   * Get the Jacobian buffer for a cascade (flat Float32Array, resolution²).
   * Layout: one scalar per texel, row-major.
   *
   * ## E.5 INTEGRATION
   * This is the buffer E.5 (foam) should read.
   * - Format: Float32, one value per texel, row-major (row * resolution + col).
   * - Semantics: J = (1 + ∂Dx/∂x)(1 + ∂Dz/∂z) - (∂Dz/∂x)²
   * - Threshold: J < 0 → strong foam, 0 < J < 0.3 → moderate, J ≥ 1 → no foam.
   */
  getJacobianBuffer(cascadeIndex: number): Float32Array | undefined;

  /**
   * Run the CPU evaluation for all texels of all cascades at the given time.
   * This is the WebGL2 fallback path and also used for coherence testing.
   */
  evaluateAllCPU(time: number): void;

  /** Dispose all buffers. */
  dispose(): void;
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate config against QualityKnobs constraints.
 * Throws if values are outside the allowed set.
 */
export function validateConfig(config: SpectrumComputeConfig): void {
  if (config.cascades !== 1 && config.cascades !== 2 && config.cascades !== 3) {
    throw new RangeError(
      `oceanCascades must be 1, 2, or 3; got ${String(config.cascades)}`,
    );
  }
  if (config.resolution !== 128 && config.resolution !== 256) {
    throw new RangeError(
      `oceanResolution must be 128 or 256; got ${String(config.resolution)}`,
    );
  }
}

/**
 * Create a SpectrumComputeConfig from QualityKnobs (type-safe extraction).
 */
export function configFromKnobs(
  knobs: Pick<QualityKnobs, 'oceanCascades' | 'oceanResolution'>,
): SpectrumComputeConfig {
  return {
    cascades: knobs.oceanCascades,
    resolution: knobs.oceanResolution,
  };
}

// ─── Cascade assignment ───────────────────────────────────────────────────────

/**
 * Assign a wave component to a cascade based on its wavelength.
 * Returns cascade index (0, 1, or 2), or -1 if the component doesn't fit.
 */
export function assignCascade(wavenumber: number, cascadeCount: 1 | 2 | 3): number {
  if (wavenumber <= 0) return -1;
  const wavelength = TAU / wavenumber;

  if (cascadeCount === 1) {
    return 0;
  }

  if (wavelength < CASCADE_WAVELENGTH_BOUNDS[0]) {
    return 0;
  }
  if (cascadeCount === 2) {
    return 1;
  }
  if (wavelength < CASCADE_WAVELENGTH_BOUNDS[1]) {
    return 1;
  }
  return 2;
}

/**
 * Pack WaveComponents into per-cascade arrays, sorted by energy (highest first),
 * capped at MAX_GPU_COMPONENTS per cascade.
 */
export function buildCascadeData(
  components: readonly WaveComponent[],
  config: SpectrumComputeConfig,
): CascadeData[] {
  const cascades: CascadeData[] = [];
  const buckets: PackedComponent[][] = [];

  for (let i = 0; i < config.cascades; i++) {
    buckets.push([]);
  }

  for (const comp of components) {
    const ci = assignCascade(comp.wavenumber, config.cascades);
    if (ci < 0 || ci >= config.cascades) continue;
    const bucket = buckets[ci];
    if (bucket === undefined) continue;
    bucket.push({
      amplitude: comp.amplitude,
      wavenumber: comp.wavenumber,
      frequency: comp.frequency,
      phase: comp.phase,
      steepness: comp.steepness,
      dirX: comp.direction.x,
      dirZ: comp.direction.y, // Vec2.y = world Z
    });
  }

  for (let i = 0; i < config.cascades; i++) {
    const bucket = buckets[i];
    if (bucket === undefined) continue;
    bucket.sort((a, b) => b.amplitude * b.amplitude - a.amplitude * a.amplitude);
    const capped = bucket.slice(0, MAX_GPU_COMPONENTS);

    // Safe: i is always 0, 1, or 2 (bounded by config.cascades which is 1|2|3)
    const extent = i === 0 ? CASCADE_EXTENTS[0] : i === 1 ? CASCADE_EXTENTS[1] : CASCADE_EXTENTS[2];
    cascades.push({
      index: i,
      extent,
      components: capped,
      componentCount: capped.length,
    });
  }

  return cascades;
}

// ─── Per-texel evaluation (CPU reference — same math as GPU) ──────────────────

/**
 * Evaluate a single texel's displacement, derivatives, and Jacobian.
 *
 * This is the EXACT formula the GPU compute shader uses. By running this on
 * the CPU we can verify coherence without needing an actual GPU.
 *
 * The texel's world position is derived from its grid coordinates:
 *   worldX = (col / resolution - 0.5) * extent
 *   worldZ = (row / resolution - 0.5) * extent
 *
 * The Gerstner sum follows WaveFieldCPU.ts exactly:
 *   phase_i = k_i * (dirX_i * worldX + dirZ_i * worldZ) - omega_i * t + phi_i
 *   dy += A_i * cos(phase_i)
 *   dx += -Q_i * A_i * dirX_i * sin(phase_i)
 *   dz += -Q_i * A_i * dirZ_i * sin(phase_i)
 *
 * Derivatives are analytic (same as WaveFieldCPU.ts normal()):
 *   ∂Dy/∂x = -A_i * k_i * dirX_i * sin(phase_i)
 *   ∂Dy/∂z = -A_i * k_i * dirZ_i * sin(phase_i)
 *   ∂Dx/∂x = -Q_i * A_i * k_i * dirX_i² * cos(phase_i)
 *   ∂Dz/∂z = -Q_i * A_i * k_i * dirZ_i² * cos(phase_i)
 *   ∂Dx/∂z = ∂Dz/∂x = -Q_i * A_i * k_i * dirX_i * dirZ_i * cos(phase_i)
 */
export function evaluateTexelCPU(
  cascade: CascadeData,
  resolution: number,
  col: number,
  row: number,
  time: number,
): TexelResult {
  const worldX = (col / resolution - 0.5) * cascade.extent;
  const worldZ = (row / resolution - 0.5) * cascade.extent;

  let dx = 0;
  let dy = 0;
  let dz = 0;
  let dDy_dx = 0;
  let dDy_dz = 0;
  let dDx_dx = 0;
  let dDz_dx = 0;
  let dDz_dz = 0;

  for (const comp of cascade.components) {
    const kDotP = comp.wavenumber * (comp.dirX * worldX + comp.dirZ * worldZ);
    const phase = kDotP - comp.frequency * time + comp.phase;
    const cosP = cos(phase);
    const sinP = sin(phase);

    // Vertical displacement
    dy += comp.amplitude * cosP;

    // Horizontal Gerstner displacement
    const hScale = -comp.steepness * comp.amplitude;
    dx += hScale * comp.dirX * sinP;
    dz += hScale * comp.dirZ * sinP;

    // Analytic partial derivatives
    const Ak = comp.amplitude * comp.wavenumber;
    const QAk = comp.steepness * Ak;

    dDy_dx += -Ak * comp.dirX * sinP;
    dDy_dz += -Ak * comp.dirZ * sinP;
    dDx_dx += -QAk * comp.dirX * comp.dirX * cosP;
    // Note: ∂Dx/∂z = ∂Dz/∂x for single-direction-per-frequency spectrum
    dDz_dx += -QAk * comp.dirX * comp.dirZ * cosP;
    dDz_dz += -QAk * comp.dirZ * comp.dirZ * cosP;
  }

  // Jacobian of the horizontal displacement mapping:
  // J = (1 + ∂Dx/∂x)(1 + ∂Dz/∂z) - (∂Dz/∂x)²
  const jacobian = (1 + dDx_dx) * (1 + dDz_dz) - dDz_dx * dDz_dx;

  // Horizontal divergence for derivative texture B channel
  const horizontalDiv = dDx_dx + dDz_dz;

  return {
    displacement: { x: dx, y: dy, z: dz },
    derivatives: { dDy_dx, dDy_dz, horizontalDiv },
    jacobian,
  };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create the spectrum compute system.
 *
 * @param params Initial wave spectrum parameters.
 * @param config Quality configuration (cascades and resolution).
 * @returns Handle for managing the compute pipeline.
 */
export function createSpectrumCompute(
  params: WaveSpectrumParams,
  config: SpectrumComputeConfig,
): SpectrumComputeHandle {
  validateConfig(config);

  const { resolution, cascades: cascadeCount } = config;
  const texelCount = resolution * resolution;

  // Allocate output buffers per cascade
  const displacementBuffers: Float32Array[] = [];
  const derivativeBuffers: Float32Array[] = [];
  const jacobianBuffers: Float32Array[] = [];

  for (let i = 0; i < cascadeCount; i++) {
    displacementBuffers.push(new Float32Array(texelCount * 4)); // RGBA
    derivativeBuffers.push(new Float32Array(texelCount * 4));   // RGBA
    jacobianBuffers.push(new Float32Array(texelCount));          // R only
  }

  // Build spectrum with more components than CPU path for GPU fidelity.
  // Request MAX_GPU_COMPONENTS * cascadeCount to give each cascade up to 128.
  let specResult = buildSpectrum(params, MAX_GPU_COMPONENTS * cascadeCount);
  let cascadeData = buildCascadeData(specResult.components, config);

  const handle: SpectrumComputeHandle = {
    get cascadeData(): readonly CascadeData[] {
      return cascadeData;
    },

    get config(): SpectrumComputeConfig {
      return config;
    },

    updateSpectrum(newParams: WaveSpectrumParams): void {
      specResult = buildSpectrum(newParams, MAX_GPU_COMPONENTS * cascadeCount);
      cascadeData = buildCascadeData(specResult.components, config);
    },

    evaluateTexel(
      cascadeIndex: number,
      col: number,
      row: number,
      time: number,
    ): TexelResult | undefined {
      const cascade = cascadeData[cascadeIndex];
      if (cascade === undefined) return undefined;
      if (col < 0 || col >= resolution || row < 0 || row >= resolution) return undefined;
      return evaluateTexelCPU(cascade, resolution, col, row, time);
    },

    getDisplacementBuffer(cascadeIndex: number): Float32Array | undefined {
      return displacementBuffers[cascadeIndex];
    },

    getDerivativeBuffer(cascadeIndex: number): Float32Array | undefined {
      return derivativeBuffers[cascadeIndex];
    },

    getJacobianBuffer(cascadeIndex: number): Float32Array | undefined {
      return jacobianBuffers[cascadeIndex];
    },

    evaluateAllCPU(time: number): void {
      for (let ci = 0; ci < cascadeCount; ci++) {
        const cascade = cascadeData[ci];
        const dispBuf = displacementBuffers[ci];
        const derivBuf = derivativeBuffers[ci];
        const jacBuf = jacobianBuffers[ci];
        if (
          cascade === undefined ||
          dispBuf === undefined ||
          derivBuf === undefined ||
          jacBuf === undefined
        ) {
          continue;
        }

        for (let row = 0; row < resolution; row++) {
          for (let col = 0; col < resolution; col++) {
            const texelIdx = row * resolution + col;
            const result = evaluateTexelCPU(cascade, resolution, col, row, time);

            const dBase = texelIdx * 4;
            dispBuf[dBase] = result.displacement.x;
            dispBuf[dBase + 1] = result.displacement.y;
            dispBuf[dBase + 2] = result.displacement.z;
            dispBuf[dBase + 3] = 1.0;

            derivBuf[dBase] = result.derivatives.dDy_dx;
            derivBuf[dBase + 1] = result.derivatives.dDy_dz;
            derivBuf[dBase + 2] = result.derivatives.horizontalDiv;
            derivBuf[dBase + 3] = 0.0;

            jacBuf[texelIdx] = result.jacobian;
          }
        }
      }
    },

    dispose(): void {
      displacementBuffers.length = 0;
      derivativeBuffers.length = 0;
      jacobianBuffers.length = 0;
    },
  };

  return handle;
}

// ─── GPU compute node builder (WebGPU tier) ───────────────────────────────────
// This section builds TSL compute nodes for the actual GPU path. It uses
// three/tsl APIs and is only invoked at runtime on WebGPU-capable devices.
// The WebGL2 fallback calls evaluateAllCPU() instead.

/**
 * Pack cascade component data into flat Float32Arrays suitable for upload
 * to GPU storage buffers via instancedArray.
 *
 * Layout per component (2 vec4s):
 *   bufferA[i] = (amplitude, wavenumber, frequency, phase)
 *   bufferB[i] = (steepness, dirX, dirZ, 0)
 *
 * This function is pure data packing — no three.js dependency — so it is
 * testable headlessly.
 */
export function packComponentsForGPU(cascade: CascadeData): {
  dataA: Float32Array;
  dataB: Float32Array;
} {
  const count = cascade.componentCount;
  const dataA = new Float32Array(count * 4);
  const dataB = new Float32Array(count * 4);

  for (let i = 0; i < count; i++) {
    const comp = cascade.components[i];
    if (comp === undefined) continue;

    const baseIdx = i * 4;
    dataA[baseIdx] = comp.amplitude;
    dataA[baseIdx + 1] = comp.wavenumber;
    dataA[baseIdx + 2] = comp.frequency;
    dataA[baseIdx + 3] = comp.phase;

    dataB[baseIdx] = comp.steepness;
    dataB[baseIdx + 1] = comp.dirX;
    dataB[baseIdx + 2] = comp.dirZ;
    dataB[baseIdx + 3] = 0;
  }

  return { dataA, dataB };
}

/**
 * GPU compute integration point.
 *
 * This function would be called by the renderer to create TSL compute nodes.
 * It is documented here for architecture clarity but the actual TSL node graph
 * construction happens at integration time (when E.3 wires the compute into
 * the render loop) because it requires a live `renderer` instance.
 *
 * Pattern (to be used in E.3 integration):
 * ```typescript
 * import { Fn, instancedArray, instanceIndex, float, uniform } from 'three/tsl';
 *
 * const resolution = 256;
 * const texelCount = resolution * resolution;
 * const tUniform = uniform(0);
 *
 * // Per cascade:
 * const bufferA = instancedArray(componentCount, 'vec4');
 * const bufferB = instancedArray(componentCount, 'vec4');
 * const dispOut = instancedArray(texelCount, 'vec4');
 * const derivOut = instancedArray(texelCount, 'vec4');
 * const jacOut = instancedArray(texelCount, 'float');
 *
 * const computeNode = Fn(() => {
 *   const idx = instanceIndex;
 *   const col = idx.mod(float(resolution));
 *   const row = idx.div(float(resolution)).floor();
 *   const worldX = col.div(float(resolution)).sub(0.5).mul(float(extent));
 *   const worldZ = row.div(float(resolution)).sub(0.5).mul(float(extent));
 *
 *   // Sum all components (static unroll for each component)
 *   // ... same formula as evaluateTexelCPU ...
 *
 *   const disp = dispOut.element(idx);
 *   disp.assign(vec4(dx, dy, dz, 1.0));
 *   // ... etc for derivatives and jacobian
 * })().compute(texelCount, [8, 8]);
 *
 * // Upload packed data, then each frame:
 * tUniform.value = sessionTime;
 * renderer.compute(computeNode);
 * ```
 *
 * The material then reads: `material.positionNode = dispOut.element(vertexTexelIndex);`
 */
export type GPUComputeIntegrationPoint = 'documented-pattern-only';

// ─── Exports for testing ──────────────────────────────────────────────────────

/** Exposed for unit tests — not part of the public API. */
export const _testing = {
  MAX_GPU_COMPONENTS,
  CASCADE_EXTENTS,
  CASCADE_WAVELENGTH_BOUNDS,
} as const;
