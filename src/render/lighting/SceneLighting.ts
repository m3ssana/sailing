/**
 * SceneLighting — the ambient / sky fill the scene was missing.
 *
 * ## Why this exists (the "black boat" root cause)
 *
 * The scene's ONLY analytic light was the `ShadowRig`'s directional sun, whose
 * intensity is `LightingState.sunIlluminance` — a RELATIVE value in 0..1 that
 * collapses toward 0 under overcast (`directCloud = 1 − overcast^2.5`) and at a
 * low sun. With no ambient/hemisphere term and no guaranteed IBL (the
 * `EnvironmentProbe` only refreshes on the first frame / every ≥5 s and captures
 * the whole scene, not an isolated sky), every PBR `MeshStandardNodeMaterial`
 * rendered at or near BLACK — exactly the flat-black hull and sail silhouette
 * seen in the first real-browser run. Backlit faces (the chase camera looks
 * toward the low sun) got nothing at all.
 *
 * The fix is the standard PBR outdoor setup: a `HemisphereLight` (sky colour
 * above, a darker water/ground bounce below) plus a small constant `AmbientLight`
 * floor, both driven every frame from the same pure `LightingState` the sky dome
 * and shadow rig already read. This guarantees a lit, readable boat and sea in
 * every weather/time condition, independent of whether the IBL probe has run.
 *
 * ## Relationship to the sun and the IBL probe
 *
 * This is a FILL, not a replacement for the sun. The `ShadowRig` keeps providing
 * the directional key light + shadows; this module only guarantees the floor of
 * diffuse illumination. If a future IBL path drives `scene.environment` with a
 * real prefiltered sky, this fill can be dialled down — but it must never reach
 * zero, or the black-boat regression returns on overcast days.
 *
 * ## Intensities are tuned for the relative-illuminance convention
 *
 * `LightingState` illuminance is relative (1.0 = clear zenith sun), and the
 * renderer applies ACES tone mapping on output. The multipliers below were
 * chosen so an overcast Newport scene (ambientIlluminance ≈ 0.25, sun ≈ 0.1–0.3)
 * reads as a believably-lit grey day rather than either black or blown out. They
 * are a labelled rendering-layer calibration, not a photometric quantity.
 *
 * Conventions: linear RGB; world Y-up; consumes `LightingState` read-only.
 */

import * as THREE from 'three/webgpu';
import type { LightingState } from '@render/lighting/LightingState';

/** Sky→ground hemisphere fill strength (× ambientIlluminance). */
const HEMISPHERE_GAIN = 3.2;

/** Flat ambient floor strength (× ambientIlluminance), keeps shadows readable. */
const AMBIENT_GAIN = 0.6;

/**
 * Minimum combined fill so a heavily-overcast / twilight scene never crushes to
 * black. Applied to the hemisphere light as an intensity floor.
 */
const HEMISPHERE_FLOOR = 0.5;

/** How much darker the downward (ground/water bounce) colour is vs the sky. */
const GROUND_BOUNCE = 0.35;

export interface SceneLighting {
  /** Group holding the fill lights. Add to the scene. */
  readonly object: THREE.Group;
  /** Update the fill from the current lighting state. Call once per frame. */
  update(lighting: LightingState): void;
  /** Dispose GPU resources. */
  dispose(): void;
}

/**
 * Create the ambient + hemisphere scene fill.
 *
 * @param groundColor Optional linear-RGB tint for the downward bounce (e.g. the
 *   venue's deep-water colour). Defaults to a neutral cool grey. The live sky
 *   colour always modulates it, so this only biases the hue.
 */
export function createSceneLighting(groundColor?: {
  r: number;
  g: number;
  b: number;
}): SceneLighting {
  const group = new THREE.Group();
  group.name = 'sceneLightingFill';

  const hemisphere = new THREE.HemisphereLight(0xffffff, 0x404048, 1);
  const ambient = new THREE.AmbientLight(0xffffff, 0.2);

  group.add(hemisphere);
  group.add(ambient);

  // The downward bounce hue (biased by the venue ground colour if supplied).
  const groundBias = groundColor ?? { r: 0.25, g: 0.28, b: 0.3 };

  return {
    object: group,

    update(lighting: LightingState): void {
      const amb = lighting.ambientIlluminance;

      // Sky (upward) colour tracks the zenith but is lifted toward a bright
      // near-white under overcast — a fully clouded sky is a large, bright, flat
      // area source, so diffuse-lit surfaces (e.g. a white sail) must read white,
      // not the dim, cool zenith value. Lift scales with overcast.
      const sky = lighting.zenithColor;
      const whiten = 0.45 + 0.4 * lighting.overcast; // 0.45 clear → 0.85 overcast
      const skyLift = 1.0 + 1.2 * lighting.overcast; // brighten the flat sky
      const skyCol = hemisphere.color;
      skyCol.r = (sky.r * (1 - whiten) + whiten) * skyLift;
      skyCol.g = (sky.g * (1 - whiten) + whiten) * skyLift;
      skyCol.b = (sky.b * (1 - whiten) + whiten) * skyLift;

      const grd = hemisphere.groundColor;
      grd.r = (lighting.horizonColor.r * 0.5 + groundBias.r * 0.5) * GROUND_BOUNCE;
      grd.g = (lighting.horizonColor.g * 0.5 + groundBias.g * 0.5) * GROUND_BOUNCE;
      grd.b = (lighting.horizonColor.b * 0.5 + groundBias.b * 0.5) * GROUND_BOUNCE;

      hemisphere.intensity = Math.max(HEMISPHERE_FLOOR, amb * HEMISPHERE_GAIN);

      // A small neutral ambient floor so deep shadows never read pure black.
      const ambCol = ambient.color;
      ambCol.r = lighting.ambientColor.r;
      ambCol.g = lighting.ambientColor.g;
      ambCol.b = lighting.ambientColor.b;
      ambient.intensity = Math.max(0.05, amb * AMBIENT_GAIN);
    },

    dispose(): void {
      if (hemisphere.dispose) hemisphere.dispose();
      if (ambient.dispose) ambient.dispose();
      group.removeFromParent();
    },
  };
}
