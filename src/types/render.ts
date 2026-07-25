/**
 * Render-layer contracts — GPU capabilities and quality control.
 *
 * FROZEN CONTRACT — see docs/interfaces.md.
 *
 * These types are deliberately free of three.js references so that non-render
 * layers (the quality manager's inputs, the profiler's outputs, the settings
 * store) can reason about rendering without importing the engine.
 */

/** Which three.js backend is active. */
export type RenderBackend = 'webgpu' | 'webgl2';

/**
 * Probed once at startup and injected into every render subsystem, so no
 * subsystem sniffs the backend itself (design.md §2.2).
 */
export interface GPUCapabilities {
  backend: RenderBackend;
  /**
   * True when TSL compute shaders are available. False on WebGL2, which is why
   * the ocean spectrum, foam and spray each need a non-compute fallback.
   */
  compute: boolean;
  /** True when storage textures can be written from compute. */
  storageTextures: boolean;
  /** True when GPU timestamp queries are available for profiling. */
  timestampQueries: boolean;
  maxTextureSize: number;
  /** True when float32 textures support linear filtering. */
  float32Filterable: boolean;
  /** Reported device or adapter description, for diagnostics. */
  adapterInfo: string;
}

/** Named quality presets (requirement 7.12). */
export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra' | 'custom';

/**
 * Individually scalable quality knobs. The adaptive manager steps these one at
 * a time, cheapest-impact first (design.md §9.5).
 */
export interface QualityKnobs {
  /** Render resolution multiplier, 0.6 .. 1.0. */
  renderScale: number;
  /** Ocean spectrum cascades. Fewer means less wave detail. */
  oceanCascades: 1 | 2 | 3;
  /** Spectrum texture resolution per cascade. */
  oceanResolution: 128 | 256;
  /** Clipmap rings. Fewer means a nearer water horizon. */
  oceanGridRings: number;
  /** Reflection render-target scale. 0 disables SSR and falls back to sky only. */
  reflectionScale: number;
  /** Frames between reflection updates. */
  reflectionCadence: 1 | 2 | 3;
  /** Shadow cascade count. */
  shadowCascades: 1 | 2 | 3 | 4;
  /** Volumetric cloud raymarch steps. 0 switches to billboard clouds. */
  cloudMarchSteps: number;
  /** Maximum live spray particles. */
  sprayBudget: number;
  /** Maximum ambient vessels and birds. First thing reduced under load. */
  ambientBudget: number;
  taa: boolean;
  motionBlur: boolean;
  depthOfField: boolean;
  bloom: boolean;
}

/** Per-frame timing, from the profiler (requirement 8.2). */
export interface FrameTimings {
  /** Wall-clock frame time, ms. */
  frame: number;
  /** Time in fixed-step simulation this frame, ms. Budget: 4 ms. */
  simulation: number;
  /** Time updating the scene graph from simulation state, ms. Budget: 2 ms. */
  sceneUpdate: number;
  /** Time issuing draw calls, ms. */
  render: number;
  /** GPU time where timestamp queries are available, ms. Otherwise -1. */
  gpu: number;
  /** Number of fixed steps executed this frame. */
  steps: number;
  drawCalls: number;
  triangles: number;
}

/** Rolling performance statistics that drive adaptive quality. */
export interface PerformanceStats {
  /** Median frame time over the sample window, ms. Median, not mean, so a
   *  single GC spike cannot trigger a quality downgrade. */
  medianFrameTime: number;
  /** 95th-percentile frame time, ms. */
  p95FrameTime: number;
  /** Target frame time implied by the frame cap, ms. */
  targetFrameTime: number;
  /** Consecutive frames over budget. */
  framesOverBudget: number;
  /** Consecutive frames comfortably under budget. */
  framesUnderBudget: number;
  /**
   * True when frame time has drifted upward with unchanged scene complexity,
   * which on a laptop indicates thermal throttling (requirement 8.1a).
   */
  thermalThrottleSuspected: boolean;
}

/** User-selectable frame cap. */
export type FrameCap = 30 | 60 | 120 | 0;
