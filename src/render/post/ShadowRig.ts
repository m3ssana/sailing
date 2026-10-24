/**
 * ShadowRig — three layer for cascaded shadow maps (Stream F.3).
 *
 * Thin consumer of the PURE `CascadedShadows.ts` model. Owns the three.js
 * directional lights, their shadow cameras, and the cast/receive flags on the
 * boat rig, water, and terrain.
 *
 * ## Shimmer-free snap: light.up must match the model's basis
 *
 * The pure `fitCascade` texel-snaps the cascade centre in a light-space basis
 * built from a discrete world-up (`fit.lightWorldUp`). three independently
 * builds the shadow camera's view from `light.up` via `Object3D.lookAt`
 * (LightShadow.updateMatrices → Matrix4.lookAt). If those two up vectors
 * disagree, the snap grid no longer coincides with the real shadow-map axes and
 * the shimmer the snap was meant to kill comes back. So every frame the rig
 * sets `light.up = fit.lightWorldUp`. For a near-vertical sun the model (and
 * hence the rig) switches both to `(0,0,1)`, avoiding the degeneracy where
 * `(0,1,0)` is parallel to the view axis and three's `Matrix4.lookAt` silently
 * nudges it (which would desynchronise the bases). See `CascadedShadows.ts`
 * `lightBasis` for the full derivation.
 *
 * ## Approach decision — custom N-light cascade, not CSMShadowNode
 *
 * three 0.180 ships `examples/jsm/csm/CSMShadowNode.js`, but it is written
 * against the full (untyped-here) three API surface and expects a live
 * `DirectionalLight.shadow` camera it mutates each frame from a CSMFrustum. To
 * use it we would have to declare a large, fragile slice of that internal API in
 * `three-env.d.ts`, and it still needs a real GPU frustum to behave. Per the
 * brief ("choose the simplest approach that works and document it") this module
 * instead drives ONE `DirectionalLight` per cascade, positioning each light's
 * shadow camera from `fitCascade` in the pure model. This keeps all the stable-
 * cascade maths (sphere fit + texel snap) in the headlessly-tested model and
 * leaves the three layer as plain object wiring — which also means the cascade
 * behaviour is unit-tested without a GPU, unlike the CSM node path.
 *
 * Soft filtering is requested per quality (`PCFSoftShadowMap`-style); since the
 * pinned WebGPU renderer manages the shadow map type internally, we set the
 * per-light `shadow.radius` to a quality-scaled value and document that the
 * actual filter kernel is the renderer's soft default.
 *
 * ## Night behaviour
 *
 * At night (`LightingState.nightFactor → 1`) the sun light's intensity fades to
 * zero. The brief's option is to switch the caster to the moon OR disable it;
 * this module FADES THE SUN OUT and leaves moon shadows to F.4's night system
 * (which already owns moonlight and documented that moonlight shadows are a
 * single optional faint cascade). So ShadowRig simply disables its cascades when
 * `nightFactor` crosses ~0.5 — documented here, not silent.
 *
 * Conventions: world Y-up; `sunDirection`/`LightingState` consumed read-only;
 * linear RGB.
 */

import * as THREE from 'three/webgpu';
import type { SkyState } from '@/types';
import type { LightingState } from '@render/lighting/LightingState';
import type { QualityKnobs } from '@/types';
import {
  computeCascadeSplits,
  fitCascade,
  type CameraSliceParams,
} from './CascadedShadows';

/** Options for the shadow rig. */
export interface ShadowRigOptions {
  /** Cascade count (1..4); defaults to QualityKnobs.shadowCascades. */
  cascades?: 1 | 2 | 3 | 4;
  /** Shadow map resolution per cascade (texels). Default 2048. */
  shadowMapSize?: number;
  /** Camera near distance used for the split schedule. Default 0.5. */
  near?: number;
  /** Camera far distance used for the split schedule. Default 400. */
  far?: number;
  /** PSSM blend lambda. Default 0.75. */
  lambda?: number;
  /** nightFactor above which shadows are disabled. Default 0.5. */
  nightDisableThreshold?: number;
}

/** The built shadow rig. */
export interface ShadowRig {
  /** The group holding the cascade lights; add to the scene. */
  readonly object: THREE.Group;
  /** Per-frame update from sky + lighting + camera. */
  update(sky: SkyState, lighting: LightingState, camera: CameraSliceParams): void;
  /** Number of active cascades. */
  readonly cascadeCount: number;
  /** Dispose GPU resources. */
  dispose(): void;
}

/**
 * Absolute key-light gain applied to the directional sun. `LightingState`
 * illuminance is relative (1.0 = clear zenith sun); a three DirectionalLight
 * needs a larger absolute intensity to act as the key over the ambient fill
 * under ACES tone mapping. Labelled rendering-layer calibration.
 */
const SUN_KEY_GAIN = 3.0;

function clampCascades(n: number): 1 | 2 | 3 | 4 {
  const c = Math.min(4, Math.max(1, Math.round(n)));
  return c as 1 | 2 | 3 | 4;
}

/** Per-cascade soft-shadow radius, wider for nearer cascades (quality-scaled). */
function cascadeSoftRadius(index: number, total: number): number {
  // Nearest cascade gets the widest kernel; falls off for distant ones.
  const t = total <= 1 ? 0 : index / (total - 1);
  return 4 - 3 * t; // 4 texels near → 1 texel far
}

/**
 * Create the cascaded shadow rig.
 *
 * @param knobs   Quality knobs (shadowCascades governs cascade count).
 * @param options Optional overrides.
 */
export function createShadowRig(
  knobs: QualityKnobs,
  options: ShadowRigOptions = {},
): ShadowRig {
  const cascadeCount = clampCascades(options.cascades ?? knobs.shadowCascades);
  const shadowMapSize = options.shadowMapSize ?? 2048;
  const near = options.near ?? 0.5;
  const far = options.far ?? 400;
  const lambda = options.lambda ?? 0.75;
  const nightThreshold = options.nightDisableThreshold ?? 0.5;

  const group = new THREE.Group();
  const lights: THREE.DirectionalLight[] = [];

  for (let i = 0; i < cascadeCount; i++) {
    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.castShadow = true;
    // Configure the shadow camera + soft radius from the model's texel scale.
    const shadow = light.shadow;
    if (shadow) {
      if (shadow.mapSize) {
        shadow.mapSize.width = shadowMapSize;
        shadow.mapSize.height = shadowMapSize;
      }
      shadow.radius = cascadeSoftRadius(i, cascadeCount);
      shadow.bias = -0.0005;
      // The ocean is a large, near-flat receiver seen at grazing angles; a
      // constant depth bias alone leaves shadow acne across it. normalBias
      // offsets the shadow lookup along the receiver's surface normal, the
      // standard cure for planar-receiver acne (three.js LightShadow.normalBias;
      // DirectionalLightShadow docs). Kept small so thin casters (rigging) do
      // not detach their contact shadows (Peter-panning).
      shadow.normalBias = 0.02;
    }
    group.add(light);
    if (light.target) group.add(light.target);
    lights.push(light);
  }

  const splits = computeCascadeSplits(near, far, cascadeCount, lambda);

  return {
    object: group,
    cascadeCount,
    update(sky: SkyState, lighting: LightingState, camera: CameraSliceParams): void {
      // Night: fade the sun out and disable cascades past the threshold.
      const night = lighting.nightFactor >= nightThreshold;
      const dayFade = Math.max(0, 1 - lighting.nightFactor);
      const sunIntensity = lighting.sunIlluminance * dayFade;

      for (let i = 0; i < lights.length; i++) {
        const light = lights[i];
        if (!light) continue;
        if (night || sunIntensity <= 0) {
          light.visible = false;
          light.castShadow = false;
          continue;
        }
        light.visible = true;
        light.castShadow = true;

        // Sun colour + intensity from LightingState. `sunIlluminance` is a
        // RELATIVE 0..1 value; a three DirectionalLight needs a larger absolute
        // intensity to read as a key light over the hemisphere/ambient fill
        // (SceneLighting) under ACES tone mapping. SUN_KEY_GAIN is a labelled
        // rendering-layer calibration (clear-day key ≈ 3.0, overcast tapers with
        // the illuminance). The `sunIntensity <= 0` visibility gate above still
        // uses the un-gained value, so night/full-overcast still disables it.
        light.color.r = lighting.sunColor.r;
        light.color.g = lighting.sunColor.g;
        light.color.b = lighting.sunColor.b;
        light.intensity = sunIntensity * SUN_KEY_GAIN;

        // Fit this cascade's slice using the pure model.
        const sliceNear = splits[i] ?? near;
        const sliceFar = splits[i + 1] ?? far;
        const slice: CameraSliceParams = { ...camera, sliceNear, sliceFar };
        const fit = fitCascade(slice, sky.sunDirection, shadowMapSize);

        // CRITICAL for shimmer-free cascades: three builds the shadow-camera
        // view with `light.up` (Object3D.lookAt → Matrix4.lookAt). The pure
        // model snapped the cascade centre to a texel grid aligned to a basis
        // built from `fit.lightWorldUp`. If `light.up` differs, three's shadow
        // axes rotate relative to the snap grid and shimmer reappears. So set
        // `light.up` to EXACTLY the world-up the model chose (this also handles
        // the near-vertical-sun case, where the default (0,1,0) would be
        // parallel to the view axis and three would silently nudge it). The
        // target's up is irrelevant (targets are not cameras), only the light's.
        light.up.set(fit.lightWorldUp.x, fit.lightWorldUp.y, fit.lightWorldUp.z);

        // Position the directional light + its target from the fit.
        light.position.set(fit.lightPosition.x, fit.lightPosition.y, fit.lightPosition.z);
        if (light.target) {
          light.target.position.set(fit.center.x, fit.center.y, fit.center.z);
        }
        // Configure the ortho shadow camera extents.
        const cam = light.shadow?.camera;
        if (cam) {
          cam.left = -fit.orthoHalfWidth;
          cam.right = fit.orthoHalfWidth;
          cam.top = fit.orthoHalfHeight;
          cam.bottom = -fit.orthoHalfHeight;
          cam.near = fit.orthoNear;
          cam.far = fit.orthoFar;
          if (typeof cam.updateProjectionMatrix === 'function') cam.updateProjectionMatrix();
        }
      }
    },
    dispose(): void {
      for (const light of lights) {
        if (light.dispose) light.dispose();
      }
    },
  };
}

// ─── Rig cast/receive flags ────────────────────────────────────────────────────

/**
 * Mesh-name hints used to classify a node as water or terrain (which should
 * RECEIVE but not CAST shadows). Everything else in a boat rig casts + receives.
 */
const WATER_HINTS = ['water', 'ocean', 'sea'];
const TERRAIN_HINTS = ['terrain', 'land', 'ground', 'coast'];

function nameMatches(name: string, hints: readonly string[]): boolean {
  const n = name.toLowerCase();
  return hints.some((h) => n.includes(h));
}

/**
 * Traverse a BoatView root (or any Object3D hierarchy) and set cast/receive
 * flags appropriately:
 *   - mast, boom, sails, deck, hull → cast + receive
 *   - water → receive only
 *   - terrain / land → receive only
 *   - lights and empties → neither
 *
 * BoatView (src/render/boat/BoatView.ts) exposes `root` → { hullGroup, rigGroup,
 * sailGroup, lightsGroup }, each holding `THREE.Mesh`es (or PointLights under
 * lightsGroup). We classify by object type + name hints rather than by group,
 * so this also works on water/terrain nodes added as siblings for a whole-scene
 * pass.
 */
export function enableRigShadows(root: THREE.Object3D): void {
  traverse(root, (obj) => {
    const asMesh = obj as unknown as {
      isMesh?: boolean;
      geometry?: unknown;
      isLight?: boolean;
      name?: string;
      castShadow?: boolean;
      receiveShadow?: boolean;
    };
    const name = typeof asMesh.name === 'string' ? asMesh.name : '';

    // Lights never cast/receive mesh shadows themselves.
    if (asMesh.isLight === true) {
      asMesh.castShadow = false;
      asMesh.receiveShadow = false;
      return;
    }

    // A mesh is anything carrying geometry.
    const isMesh = asMesh.isMesh === true || asMesh.geometry !== undefined;
    if (!isMesh) return;

    if (nameMatches(name, WATER_HINTS) || nameMatches(name, TERRAIN_HINTS)) {
      asMesh.castShadow = false;
      asMesh.receiveShadow = true;
      return;
    }

    // Rig/hull/sails/deck: cast + receive.
    asMesh.castShadow = true;
    asMesh.receiveShadow = true;
  });
}

/** Depth-first traversal that tolerates the minimal typed Object3D surface. */
function traverse(obj: THREE.Object3D, fn: (o: THREE.Object3D) => void): void {
  fn(obj);
  const children = (obj as unknown as { children?: THREE.Object3D[] }).children;
  if (Array.isArray(children)) {
    for (const child of children) traverse(child, fn);
  }
}
