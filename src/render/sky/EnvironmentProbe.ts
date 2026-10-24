/**
 * EnvironmentProbe — PMREM image-based-lighting probe for the procedural sky
 * (Stream F.1). The regeneration *policy* is pure (no three.js, unit-testable);
 * the `EnvironmentProbe` wrapper around `THREE.PMREMGenerator` is a thin shell.
 *
 * Regenerating a PMREM cube every frame is wasteful — the sky changes slowly.
 * `ProbeRegenPolicy` decides when a refresh is actually warranted, following
 * the art-direction guidance (docs/art-direction.md §IBL: regenerate when sun
 * elevation changes > ~2° or cloud cover shifts > 10%). We use slightly tighter
 * thresholds plus a minimum interval so a fast time-compression sweep stays
 * smooth without thrashing the GPU.
 *
 * PMREM works on both WebGPU and WebGL2 backends, so no compute fallback is
 * needed here.
 *
 * Conventions: Linear RGB; radians; Y-up.
 */

import * as THREE from 'three/webgpu';
import type { SkyState } from '@/types';
import type { LightingState } from '@render/lighting/LightingState';

const DEG = Math.PI / 180;

/** Thresholds controlling when the probe regenerates. All in SI/radians. */
export interface ProbeRegenThresholds {
  /** Minimum sun-elevation change to trigger a regen, radians. Default 1.5°. */
  elevationDelta: number;
  /** Minimum sun-azimuth change to trigger a regen, radians. Default 3°. */
  azimuthDelta: number;
  /** Minimum effective-cover change to trigger a regen, 0..1. Default 0.1. */
  coverDelta: number;
  /** Minimum nightFactor change to trigger a regen, 0..1. Default 0.1. */
  nightDelta: number;
  /** Minimum seconds between regenerations (unless forced). Default 5 s. */
  minInterval: number;
  /**
   * Azimuth changes only matter when the sun is above this elevation — when the
   * sun is well below the horizon its azimuth is irrelevant to the sky look.
   * Default -6° (civil twilight).
   */
  azimuthRelevantAbove: number;
}

export function defaultProbeThresholds(): ProbeRegenThresholds {
  return {
    elevationDelta: 1.5 * DEG,
    azimuthDelta: 3 * DEG,
    coverDelta: 0.1,
    nightDelta: 0.1,
    minInterval: 5,
    azimuthRelevantAbove: -6 * DEG,
  };
}

interface ProbeSample {
  elevation: number;
  azimuth: number;
  cover: number;
  night: number;
  time: number;
}

/**
 * Pure decision object: tracks the last state a probe was generated for and
 * answers whether a fresh capture is warranted. No three.js, fully testable.
 */
export class ProbeRegenPolicy {
  private readonly t: ProbeRegenThresholds;
  private last: ProbeSample | null = null;

  constructor(thresholds: Partial<ProbeRegenThresholds> = {}) {
    this.t = { ...defaultProbeThresholds(), ...thresholds };
  }

  /** Forget history so the next `shouldRegenerate` returns true. */
  reset(): void {
    this.last = null;
  }

  /**
   * @param sky       Current sky state (sun geometry + cloud fractions).
   * @param lighting  Derived lighting (uses `overcast` and `nightFactor`).
   * @param nowSeconds Monotonic session time, seconds.
   * @param force     If true, regenerate regardless of thresholds/interval and
   *                  record the new baseline.
   */
  shouldRegenerate(
    sky: SkyState,
    lighting: LightingState,
    nowSeconds: number,
    force = false,
  ): boolean {
    const sample: ProbeSample = {
      elevation: sky.sunElevation,
      azimuth: sky.sunAzimuth,
      cover: lighting.overcast,
      night: lighting.nightFactor,
      time: nowSeconds,
    };

    // First call always regenerates.
    if (this.last === null) {
      this.last = sample;
      return true;
    }

    if (force) {
      this.last = sample;
      return true;
    }

    const prev = this.last;

    // Never more often than minInterval (except forced, handled above).
    if (nowSeconds - prev.time < this.t.minInterval) {
      return false;
    }

    const dElev = Math.abs(sample.elevation - prev.elevation);
    const dCover = Math.abs(sample.cover - prev.cover);
    const dNight = Math.abs(sample.night - prev.night);

    // Azimuth only matters when the sun is above the relevance elevation.
    let azimuthTriggered = false;
    if (sample.elevation > this.t.azimuthRelevantAbove) {
      const dAz = angularDelta(sample.azimuth, prev.azimuth);
      azimuthTriggered = dAz >= this.t.azimuthDelta;
    }

    const triggered =
      dElev >= this.t.elevationDelta ||
      azimuthTriggered ||
      dCover >= this.t.coverDelta ||
      dNight >= this.t.nightDelta;

    if (triggered) {
      this.last = sample;
      return true;
    }
    return false;
  }
}

/** Shortest-arc absolute difference between two angles, radians (0..pi). */
function angularDelta(a: number, b: number): number {
  const TWO_PI = Math.PI * 2;
  let d = Math.abs(a - b) % TWO_PI;
  if (d > Math.PI) d = TWO_PI - d;
  return d;
}

// ─── Three.js wrapper (thin) ───────────────────────────────────────────────────

export interface EnvironmentProbeOptions {
  /** Override any regen thresholds. */
  thresholds?: Partial<ProbeRegenThresholds>;
  /** PMREM blur sigma passed to `fromScene`. Default 0 (sharp). */
  sigma?: number;
  /**
   * Factory for the PMREM generator. Defaults to `new THREE.PMREMGenerator`.
   * Injectable so tests can supply a GPU-free fake (ESM module exports cannot
   * be spied on in place).
   */
  pmremFactory?: (renderer: THREE.WebGPURenderer) => THREE.PMREMGenerator;
}

/**
 * Wraps a `THREE.PMREMGenerator`. Call `update` each frame with the current sky
 * scene; it regenerates the prefiltered environment texture only when the policy
 * says so, and applies the result as `targetScene.environment`.
 */
export class EnvironmentProbe {
  readonly policy: ProbeRegenPolicy;
  private readonly sigma: number;
  private readonly pmremFactory: (renderer: THREE.WebGPURenderer) => THREE.PMREMGenerator;
  private pmrem: THREE.PMREMGenerator | null = null;
  private rt: THREE.RenderTarget | null = null;

  constructor(opts: EnvironmentProbeOptions = {}) {
    this.policy = new ProbeRegenPolicy(opts.thresholds ?? {});
    this.sigma = opts.sigma ?? 0;
    this.pmremFactory = opts.pmremFactory ?? ((r) => new THREE.PMREMGenerator(r));
  }

  /** The current prefiltered environment texture, or null before first update. */
  get texture(): THREE.Texture | null {
    return this.rt?.texture ?? null;
  }

  /**
   * Regenerate the environment if warranted and apply it to `targetScene`.
   *
   * @param renderer   An initialised WebGPURenderer (`await renderer.init()`).
   * @param skyScene   The scene containing the sky dome to capture.
   * @param sky        Current sky state.
   * @param lighting   Current lighting state.
   * @param nowSeconds Session time, seconds.
   * @param targetScene Scene whose `.environment` should receive the texture.
   *                    Defaults to `skyScene`.
   * @param force      Force a regen this frame.
   * @returns true if the probe regenerated this call.
   */
  update(
    renderer: THREE.WebGPURenderer,
    skyScene: THREE.Scene,
    sky: SkyState,
    lighting: LightingState,
    nowSeconds: number,
    targetScene?: THREE.Scene,
    force = false,
  ): boolean {
    if (!this.policy.shouldRegenerate(sky, lighting, nowSeconds, force)) {
      return false;
    }
    if (this.pmrem === null) {
      this.pmrem = this.pmremFactory(renderer);
    }
    // Dispose the previous target before replacing it (PMREM allocates a new
    // render target each call).
    const old = this.rt;
    this.rt = this.pmrem.fromScene(skyScene, this.sigma);
    old?.dispose();

    const dst = targetScene ?? skyScene;
    dst.environment = this.rt.texture;
    return true;
  }

  dispose(): void {
    this.rt?.dispose();
    this.rt = null;
    this.pmrem?.dispose();
    this.pmrem = null;
  }
}
