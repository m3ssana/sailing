/**
 * Water material — Stream E.4 (Ocean Rendering).
 *
 * Full physically-based ocean water shading with:
 * - Depth-dependent absorption (colorShallow → colorDeep blend)
 * - Fresnel reflectivity (Schlick approximation, IOR 1.333 water)
 * - Sky-fallback reflection (procedural sky colour from reflected view direction)
 * - Refraction approximation (depth-absorption coloured transmission)
 * - Crest subsurface scattering (backlit glow on thin wave crests)
 * - GGX sun glitter (specular NDF for sparkly highlights)
 * - Per-venue colour and turbidity (driven by WaterAppearance)
 * - Gust-texture surface darkening (uniform hook for wind gust field)
 *
 * ## Design decisions
 *
 * - This is a DEDICATED builder, NOT routed through the generic
 *   `buildProceduralMaterial` dispatcher in src/render/materials/index.ts.
 *   Reasoning: ocean water needs sun direction, wave normal, camera-relative
 *   data, and gust intensity inputs that `MaterialParams` doesn't carry.
 *   The placeholder `buildWater` in src/render/materials/water.ts remains
 *   for the `MaterialParams.kind='water'` contract (used by generic surfaces
 *   that happen to be wet-looking, e.g. dock surfaces). This module supersedes
 *   it for the actual ocean surface.
 *
 * - Wave normals follow the established T_z × T_x convention (see
 *   src/environment/waves/WaveFieldCPU.ts). Flat water yields (0, 1, 0).
 *
 * ## Scope reductions (documented)
 *
 * - **Screen-space reflection**: TSL's SSR (`SSRNode`) is a post-processing
 *   pass requiring scene color/depth/normal render targets composed externally.
 *   It cannot be embedded in a material's fragment shader. This material
 *   implements a sky-fallback reflection (procedural sky gradient from the
 *   reflected view direction, tinted by venue sky colour). Full SSR integration
 *   is a documented future step when the post-processing pipeline (Stream F) is
 *   built — this material's reflection output is designed to be blended with an
 *   SSR pass cleanly.
 *
 * - **Refraction**: True screen-space refraction requires a background render
 *   target that isn't wired at this stage. Approximated via depth-absorption
 *   colouring on the transmission component (light attenuated by water depth
 *   colour). A future integration step can supply a background texture uniform
 *   for UV-distorted sampling.
 *
 * - **Depth signal**: Full scene depth buffer integration depends on renderer
 *   plumbing not yet built. Water depth at each fragment is approximated using
 *   a depth uniform (venue max depth) combined with distance-from-camera
 *   attenuation. When a depth buffer is available, it can replace this via the
 *   `waterDepth` uniform.
 */

import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec3,
  mix,
  uniform,
  normalWorld,
  positionWorld,
  cameraPosition,
} from 'three/tsl';
import type { TSLNode } from 'three/tsl';
import type { WaterAppearance, WaveComponent } from '@/types';
import {
  buildGerstnerPositionNode,
  buildGerstnerNormalNode,
  buildDistanceRoughnessNode,
} from './SpectrumFallback';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Index of refraction for water. */
const IOR_WATER = 1.333;

/** Schlick F0 for air-to-water interface: ((n1-n2)/(n1+n2))^2 */
const F0_WATER = ((1.0 - IOR_WATER) / (1.0 + IOR_WATER)) ** 2;

/** Default gust intensity (no darkening). */
const DEFAULT_GUST_INTENSITY = 0.0;

// ─── Parameters for the builder ───────────────────────────────────────────────

export interface WaterMaterialParams {
  /** Per-venue water optical properties. */
  appearance: WaterAppearance;

  /** Sun direction as a unit vector pointing FROM the scene TOWARDS the sun. */
  sunDirection: { x: number; y: number; z: number };

  /** Sun colour (linear RGB, pre-multiplied by intensity). */
  sunColor?: { r: number; g: number; b: number };

  /** Sky zenith colour for reflection fallback. */
  skyColor?: { r: number; g: number; b: number };

  /** Sky horizon colour for reflection fallback. */
  skyHorizonColor?: { r: number; g: number; b: number };

  /**
   * Gust intensity uniform value, 0 (no gust) .. 1 (full gust darkening).
   * The actual gust FIELD comes from environment/wind's gust layer — this is
   * just the shader-side hook. Default: 0.0.
   *
   * Future integration: replace this scalar with a texture sampler for
   * spatially-varying gust coverage (WindField.sampleGustGridInto output).
   */
  gustIntensity?: number;

  /**
   * Approximate water depth at the surface, metres. Used for absorption
   * calculations when a per-fragment depth buffer isn't available.
   * Default: appearance.extinctionDepth.
   */
  waterDepth?: number;

  /**
   * Wave height at this fragment, normalised 0..1 (0 = trough, 1 = crest).
   * Used for subsurface scattering. Default: 0.5 (mid-level).
   * In practice, updated per-frame from WaveField data or vertex displacement.
   */
  waveHeight?: number;

  /**
   * The wave component table (the SAME `WaveField.components` the physics
   * samples). When supplied, the material gains a vertex `positionNode` that
   * displaces the surface by a Gerstner sum over these components, and an
   * analytic `normalNode` for the displaced surface — so the visible sea moves
   * with, and shades/glitters consistently with, the physics wave field
   * (requirement 4.12). When omitted, the surface stays flat (back-compatible).
   */
  waveComponents?: readonly WaveComponent[];

  /**
   * The shared session-time uniform (seconds) that drives the wave phase. MUST
   * be the same clock the physics `WaveField` is evaluated at, or the visible
   * surface and the boat will drift out of phase. Required iff `waveComponents`
   * is supplied; ignored otherwise.
   */
  waveTimeUniform?: TSLNode & { value: unknown };

  /**
   * Local vertex spacing (world metres between adjacent vertices) of the ocean
   * ring this material is assigned to. Enables PER-RING BAND-LIMITING: wave
   * components whose wavelength is too short to be resolved at this spacing are
   * faded out of both the displacement and the normal, which removes the radial
   * aliasing streaks the coarse far rings produced. On the near ring
   * (spacing ≈ 0.5 m) every real component is kept, so the boat still sits in
   * the full-resolution sea (req 4.12 coherence preserved). Omit (or 0) to keep
   * every component — the original, un-band-limited behaviour.
   */
  vertexSpacing?: number;

  /**
   * Shared camera world-position uniform (a `three/tsl` `uniform(Vector3)`).
   * When supplied alongside `waveComponents`, the surface normal is faded toward
   * flat (0,1,0) with distance and the specular roughness is widened Toksvig-
   * style with distance, so the far sea reads as a smooth sky-reflecting haze
   * band at the horizon instead of a field of aliased glints. The caller MUST
   * update `.value` to the camera position each frame.
   */
  cameraPositionUniform?: TSLNode & { value: unknown };
}

/**
 * Result of buildWaterMaterial — the material plus its live uniforms for
 * per-frame updates (sun direction, gust intensity, wave state, etc.).
 */
export interface WaterMaterialResult {
  material: THREE.MeshStandardNodeMaterial;
  uniforms: {
    sunDirection: TSLNode & { value: unknown };
    sunColor: TSLNode & { value: unknown };
    skyColor: TSLNode & { value: unknown };
    skyHorizonColor: TSLNode & { value: unknown };
    gustIntensity: TSLNode & { value: unknown };
    waterDepth: TSLNode & { value: unknown };
    waveHeight: TSLNode & { value: unknown };
    colorShallow: TSLNode & { value: unknown };
    colorDeep: TSLNode & { value: unknown };
    turbidity: TSLNode & { value: unknown };
    extinctionDepth: TSLNode & { value: unknown };
  };
}

// ─── Builder ──────────────────────────────────────────────────────────────────

/**
 * Build the ocean water material from venue-specific WaterAppearance and
 * environmental parameters.
 *
 * The returned material is a MeshStandardNodeMaterial with full TSL node
 * graphs for colour, roughness, metalness, and emissive (used for SSS glow
 * and sun glitter). Uniforms are exposed for per-frame updates.
 */
export function buildWaterMaterial(params: WaterMaterialParams): WaterMaterialResult {
  const { appearance } = params;

  // ─── Wave displacement + normal (shared physics component table) ──────────
  // When the caller passes the environment's wave components + the shared
  // session-time uniform, the surface is displaced per-vertex by the SAME
  // Gerstner sum the CPU WaveField uses, and lit with its analytic normal. This
  // is what makes the visible sea agree with the physics within 5 cm (req 4.12).
  const waveComponents = params.waveComponents;
  const waveTimeUniform = params.waveTimeUniform;
  const vertexSpacing = params.vertexSpacing ?? 0;
  const cameraPositionUniform = params.cameraPositionUniform;
  const hasWaves =
    waveComponents !== undefined &&
    waveComponents.length > 0 &&
    waveTimeUniform !== undefined;
  const wavePositionNode: TSLNode | undefined =
    hasWaves && waveComponents !== undefined && waveTimeUniform !== undefined
      ? buildGerstnerPositionNode(waveComponents, waveTimeUniform, vertexSpacing)
      : undefined;
  const waveNormalNode: TSLNode | undefined =
    hasWaves && waveComponents !== undefined && waveTimeUniform !== undefined
      ? buildGerstnerNormalNode(waveComponents, waveTimeUniform, {
          spacing: vertexSpacing,
          ...(cameraPositionUniform !== undefined
            ? { cameraPosition: cameraPositionUniform }
            : {}),
        })
      : undefined;
  // A distance-based roughness-widening term (0 near → 1 far) for a Toksvig-
  // style broadening of the specular lobe at range, so far glitter is not a
  // field of sub-pixel needles. Only when a camera uniform is supplied.
  const distanceRoughnessNode: TSLNode | undefined =
    hasWaves && cameraPositionUniform !== undefined
      ? buildDistanceRoughnessNode(cameraPositionUniform)
      : undefined;
  // The normal the shading math should use: the wave normal when displaced,
  // else the geometry's (flat) world normal.
  const surfaceNormal: TSLNode = waveNormalNode ?? normalWorld;

  // ─── Uniforms ─────────────────────────────────────────────────────────────

  const uSunDirection = uniform(
    new THREE.Vector3(params.sunDirection.x, params.sunDirection.y, params.sunDirection.z),
  );
  const uSunColor = uniform(
    new THREE.Color(
      params.sunColor?.r ?? 1.0,
      params.sunColor?.g ?? 0.95,
      params.sunColor?.b ?? 0.85,
    ),
  );
  const uSkyColor = uniform(
    new THREE.Color(
      params.skyColor?.r ?? 0.4,
      params.skyColor?.g ?? 0.6,
      params.skyColor?.b ?? 0.9,
    ),
  );
  const uSkyHorizonColor = uniform(
    new THREE.Color(
      params.skyHorizonColor?.r ?? 0.7,
      params.skyHorizonColor?.g ?? 0.8,
      params.skyHorizonColor?.b ?? 0.9,
    ),
  );
  const uGustIntensity = uniform(params.gustIntensity ?? DEFAULT_GUST_INTENSITY);
  const uWaterDepth = uniform(params.waterDepth ?? appearance.extinctionDepth);
  const uWaveHeight = uniform(params.waveHeight ?? 0.5);

  // Per-venue appearance uniforms
  const uColorShallow = uniform(
    new THREE.Color(appearance.colorShallow.r, appearance.colorShallow.g, appearance.colorShallow.b),
  );
  const uColorDeep = uniform(
    new THREE.Color(appearance.colorDeep.r, appearance.colorDeep.g, appearance.colorDeep.b),
  );
  const uTurbidity = uniform(appearance.turbidity);
  const uExtinctionDepth = uniform(appearance.extinctionDepth);

  // ─── Fresnel (Schlick approximation) ──────────────────────────────────────

  const fresnelNode: TSLNode = Fn(() => {
    const viewDir = cameraPosition.sub(positionWorld).normalize();
    const nDotV = surfaceNormal.dot(viewDir).saturate();
    // Schlick: F0 + (1 - F0) * (1 - cos θ)^5
    const f0 = float(F0_WATER);
    const oneMinusNdotV = float(1.0).sub(nDotV);
    return f0.add(float(1.0).sub(f0).mul(oneMinusNdotV.pow(5.0)));
  })();

  // ─── Sky-fallback reflection ──────────────────────────────────────────────
  // Reflects the view direction against the surface normal to sample a
  // procedural sky gradient. When SSR post-processing is integrated (Stream F),
  // this provides the fallback for off-screen or grazing-angle regions.

  const reflectionColorNode: TSLNode = Fn(() => {
    const viewDir = cameraPosition.sub(positionWorld).normalize();
    // Reflect view direction: R = 2(N·V)N - V
    const nDotV = surfaceNormal.dot(viewDir);
    const reflected = surfaceNormal.mul(nDotV.mul(2.0)).sub(viewDir);
    // Sample sky gradient based on reflected Y component (elevation)
    // Higher = zenith color, lower = horizon color
    const skyBlend = reflected.dot(vec3(0.0, 1.0, 0.0)).saturate();
    return mix(uSkyHorizonColor, uSkyColor, skyBlend);
  })();

  // ─── Depth absorption ─────────────────────────────────────────────────────
  // Blend from shallow to deep colour based on water depth, modulated by
  // turbidity and extinction depth. Higher turbidity → faster absorption.

  const absorptionColorNode: TSLNode = Fn(() => {
    // Depth factor: how deep into the water column (0 = surface, 1 = extinction)
    const depthRatio = uWaterDepth.div(uExtinctionDepth).clamp(0.0, 1.0);
    // Turbidity accelerates absorption — at turbidity 1.0, absorption is instant
    const absorptionFactor = depthRatio.mul(float(1.0).add(uTurbidity.mul(2.0))).clamp(0.0, 1.0);
    return mix(uColorShallow, uColorDeep, absorptionFactor);
  })();

  // ─── Crest subsurface scattering ──────────────────────────────────────────
  // Thin wave crests glow when backlit. Uses wave height (crest proximity) and
  // a light-transmission term: light passes through thin water at wave peaks.

  const sssNode: TSLNode = Fn(() => {
    const viewDir = cameraPosition.sub(positionWorld).normalize();
    // Half-vector proxy for back-lighting: how much sun is behind the surface
    // relative to the viewer. Negative N·L means sun is behind the surface.
    const nDotL = surfaceNormal.dot(uSunDirection);
    // Transmission term: strongest when sun is behind surface (nDotL < 0)
    const transmission = float(0.0).sub(nDotL).clamp(0.0, 1.0);
    // View-dependent: strongest at grazing angles looking toward the sun
    const viewDotSun = viewDir.dot(uSunDirection).saturate();
    // Wave height: crests (waveHeight → 1) scatter more, troughs don't
    const crestFactor = uWaveHeight.mul(uWaveHeight); // quadratic for sharper falloff
    // Combine: SSS strongest when backlit, at crests, viewing toward sun
    // Turbidity reduces SSS — murky water scatters light diffusely, not through
    const clarity = float(1.0).sub(uTurbidity.mul(0.7));
    const sssIntensity = transmission.mul(viewDotSun).mul(crestFactor).mul(clarity).mul(0.6);
    // SSS colour: warm green-cyan tinted by the shallow water colour
    return uColorShallow.mul(uSunColor).mul(sssIntensity);
  })();

  // ─── GGX sun glitter ──────────────────────────────────────────────────────
  // Standard GGX NDF evaluated per-fragment for sparkly sun specular.
  // Roughness is very low (0.02–0.05 per art-direction.md §3.2) for tiny
  // glitter highlights rather than a single soft blob.

  const sunGlitterNode: TSLNode = Fn(() => {
    const viewDir = cameraPosition.sub(positionWorld).normalize();
    // Half vector between view and light
    const halfDir = viewDir.add(uSunDirection).normalize();
    const nDotH = surfaceNormal.dot(halfDir).saturate();
    const nDotL = surfaceNormal.dot(uSunDirection).saturate();
    const nDotV = surfaceNormal.dot(viewDir).saturate();

    // GGX NDF: α² / (π * ((N·H)²*(α²-1)+1)²)
    // Roughness for glitter. On a FLAT plane a very tight α collapses the
    // highlight to one over-concentrated blob (the defect seen in the first
    // run); the wave normal now scatters it into a glittering path, and a
    // slightly wider α (0.08) spreads each sparkle so the patch reads as a sun
    // track rather than a single hotspot. Still within art-direction's sharp-
    // specular intent. At range we widen α further (Toksvig) so far glints are
    // a soft sheen, not aliased needles.
    const alpha =
      distanceRoughnessNode !== undefined
        ? float(0.08).add(distanceRoughnessNode.mul(0.4))
        : float(0.08);
    const alpha2 = alpha.mul(alpha);
    const nDotH2 = nDotH.mul(nDotH);
    const denom = nDotH2.mul(alpha2.sub(1.0)).add(1.0);
    const D = alpha2.div(denom.mul(denom).mul(3.14159));

    // Simplified visibility term (Smith-GGX geometric attenuation)
    const k = alpha.mul(0.5);
    const vis = nDotL.div(nDotL.mul(float(1.0).sub(k)).add(k))
      .mul(nDotV.div(nDotV.mul(float(1.0).sub(k)).add(k)));

    // Fresnel for specular (at highlight angle)
    const f0 = float(F0_WATER);
    const specFresnel = f0.add(float(1.0).sub(f0).mul(float(1.0).sub(nDotH).pow(5.0)));

    // Sun glitter intensity. Scaled down (0.35) so the broadened specular reads
    // as a sparkling sun track rather than a broad silvery sheen washing the sea.
    return uSunColor.mul(D.mul(vis).mul(specFresnel).mul(nDotL)).mul(0.35);
  })();

  // ─── Gust-texture surface darkening ───────────────────────────────────────
  // Wind gusts locally darken the water surface (real sailors read approaching
  // puffs this way). Art-direction.md §6.1 notes gust-patch darkness is not
  // a physical quantity — artistic licence is permitted.

  const gustDarkeningNode: TSLNode = Fn(() => {
    // Darken by up to 30% at full gust intensity
    return float(1.0).sub(uGustIntensity.mul(0.3));
  })();

  // ─── Compose final colour ─────────────────────────────────────────────────
  // Combine all components: absorption, reflection, SSS, glitter, gust

  const finalColorNode: TSLNode = Fn(() => {
    const fresnel = fresnelNode;
    const reflectionColor = reflectionColorNode;
    const absorption = absorptionColorNode;
    const sss = sssNode;
    const glitter = sunGlitterNode;
    const gustDarken = gustDarkeningNode;

    // Base: blend between refracted/absorbed colour and reflected sky based on
    // Fresnel. Turbid water (high turbidity) is NOT a clean mirror even at
    // grazing angles — suspended matter scatters light back, so we CAP the
    // reflectance by (1 − 0.55·turbidity). This keeps the green-blue body colour
    // present across the whole surface (Newport is "green-blue turbid",
    // art-direction §4.1) instead of the blown-out white sky sheen a full
    // Fresnel gives when reflecting a bright overcast sky.
    const reflectCap = float(1.0).sub(uTurbidity.mul(0.55));
    const effFresnel = fresnel.mul(reflectCap);
    const baseColor = mix(absorption, reflectionColor, effFresnel);

    // Add subsurface scattering (additive — crests glow)
    const withSSS = baseColor.add(sss);

    // Add sun glitter (additive specular)
    const withGlitter = withSSS.add(glitter);

    // Apply gust darkening (multiplicative)
    return withGlitter.mul(gustDarken);
  })();

  // ─── Assemble material ────────────────────────────────────────────────────

  const material = new THREE.MeshStandardNodeMaterial();

  material.colorNode = finalColorNode;

  // Water roughness per art-direction.md §3.2: 0.0–0.05
  // Use a very low base roughness; the GGX glitter provides the perceptual
  // roughness variation from wind-disturbed normals. At range we widen the
  // roughness (Toksvig-style) so the far sea's unresolved sub-pixel ripples read
  // as a broad, soft sky sheen rather than a field of aliased specular needles.
  if (distanceRoughnessNode !== undefined) {
    material.roughnessNode = float(0.02).add(distanceRoughnessNode.mul(0.33));
  } else {
    material.roughnessNode = float(0.02);
  }

  // Water is non-metallic
  material.metalnessNode = float(0.0);

  // Wave displacement (vertex) + analytic surface normal, when the component
  // table was supplied. Both evaluate the SAME Gerstner sum as the physics
  // WaveField at the shared session time, so the visible sea moves with the
  // boat (req 4.12). Omitted → flat surface + geometry normal (back-compatible).
  if (wavePositionNode !== undefined) {
    material.positionNode = wavePositionNode;
  }
  if (waveNormalNode !== undefined) {
    material.normalNode = waveNormalNode;
  }

  return {
    material,
    uniforms: {
      sunDirection: uSunDirection,
      sunColor: uSunColor,
      skyColor: uSkyColor,
      skyHorizonColor: uSkyHorizonColor,
      gustIntensity: uGustIntensity,
      waterDepth: uWaterDepth,
      waveHeight: uWaveHeight,
      colorShallow: uColorShallow,
      colorDeep: uColorDeep,
      turbidity: uTurbidity,
      extinctionDepth: uExtinctionDepth,
    },
  };
}
