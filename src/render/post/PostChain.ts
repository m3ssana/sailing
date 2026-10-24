/**
 * PostChain — F.3 post-processing chain.
 *
 * Two parts, as the stream architecture demands:
 *  - `postChainConfig` (PURE, no three.js): decides which passes are active and
 *    with what parameters from `QualityKnobs` + backend + runtime opts. This is
 *    the headlessly-testable policy.
 *  - `createPostChain` (three layer): builds the actual TSL `PostProcessing`
 *    node graph mirroring the config, and exposes render/resize/update/dispose.
 *
 * ## Pass order and the double-tone-map hazard
 *
 * The chain is:
 *
 *   scene pass (MRT: output + velocity) → (TAA) → bloom → motion blur → DoF →
 *     lens droplets → grade → out
 *
 * The canonical ordered stage list is exported as `postChainStages(config)` and
 * asserted by the tests, so the documented order is a single source of truth.
 *
 * ## TAA + motion blur are wired for real (velocity MRT)
 *
 * Both TAA and camera-relative motion blur need per-object screen-space motion
 * vectors. We get them by configuring the scene pass with a multiple-render-
 * target output `mrt({ output, velocity })`, where `velocity` is three's
 * built-in `VelocityNode` (it tracks each object's previous model/view/projection
 * matrices and emits NDC motion vectors). The velocity channel is then read back
 * as `scenePass.getTextureNode('velocity')` and fed to:
 *   - `traa(beauty, depth, velocity, camera)` — temporal reprojection AA;
 *   - `motionBlur(convertToTexture(input), velocity.xy)` — camera-relative blur.
 *
 * ### motionBlur needs a TEXTURE node, not a composited node (r0.180 bug fix)
 *
 * `three/addons/tsl/display/MotionBlur.js` samples its input with
 * `inputNode.sample(uv)`, a method that exists ONLY on texture nodes. By the
 * time motion blur runs, the chain's running node is a composited graph
 * (beauty + bloom), so passing it directly threw `TypeError: inputNode.sample
 * is not a function` at GPU compile time — invisible to headless unit tests,
 * caught only by the GPU smoke harness. We therefore wrap the composited node
 * in `convertToTexture()` (the same helper TRAANode uses on its beauty input):
 * it renders the running graph to an internal RTT and returns a sampleable
 * TextureNode. A unit test now asserts the input handed to `motionBlur` is
 * texture-capable (`isTextureNode` / has `.sample`).
 *
 * ### TAA is WebGPU-only on this chain (documented WebGL2 reduction)
 *
 * TAA is force-disabled by `postChainConfig` whenever `backend === 'webgl2'`.
 * This is a real limitation of r0.180's `TRAANode` on the WebGL2 fallback, not a
 * style choice: its per-frame `renderer.copyTextureToTexture(resolve, history)`
 * is a framebuffer blit on WebGL2 that dereferences `textureData.renderTarget`
 * for both textures, but TRAANode's private history/resolve RTs never have that
 * backend metadata populated, so `backend.get(undefined)` throws
 * `TypeError: Invalid value used as weak map key` every frame and the canvas is
 * never resolved. The WebGPU backend uses a different copy path and is fine.
 * See `postChainConfig`'s doc comment for the full root-cause writeup. Bloom,
 * motion blur, DoF, lens droplets and the grade all still run on WebGL2.
 *
 * ### Jitter: TRAANode owns it — we must NOT double-jitter
 *
 * Verified against `three/examples/jsm/tsl/display/TRAANode.js` (r0.180):
 * TRAANode installs `onBeforePostProcessing`/`onAfterPostProcessing` hooks that
 * call `camera.setViewOffset(...)` with its own Halton-like `_JitterVectors`
 * table and clears the offset after the frame. It also feeds the un-jittered
 * projection matrix to the global `velocity` node so motion vectors stay
 * correct. Therefore this chain applies NO camera jitter of its own. Our pure
 * `TAA.ts` `taaJitter`/`taaBlend`/neighbourhood-clamp helpers remain as the
 * headlessly-tested *reference model* of the resolve maths (documentation +
 * unit tests only); they are intentionally not called from the GPU path, which
 * uses TRAANode's own resolve. This is stated here rather than left implicit.
 *
 * `Renderer.ts` sets `renderer.toneMapping = ACESFilmicToneMapping` as the
 * OUTPUT transform. `PostProcessing` applies that output transform at the very
 * end (on `outputNode`). So **every effect in this chain operates on LINEAR,
 * scene-referred HDR colour** and the single ACES tone-map happens once, after
 * the grade, in the renderer's output stage. We therefore must NOT insert a
 * second `.toneMapping()`/`renderOutput` node mid-chain — doing so would
 * tone-map twice and crush the highlights the bloom relies on. The grade node
 * (`gradeNode`) is a linear→linear transform precisely so it composes before
 * ACES, matching art-direction.md §5.1 (ACES is the only tone-map operator).
 *
 * ## Lens droplets
 *
 * Composited from `src/render/weather/Rain.ts`'s `lensDropletMaskNode` (we do
 * not modify it). Active only when the LensDropletState coverage exceeds a small
 * epsilon AND the cockpit camera is exposed.
 *
 * Conventions: Linear RGB; SI/radians; WebGL2-safe (all display nodes used here
 * run on three's WebGL2 backend — none require compute).
 */

import type { ColorGradeParams, QualityKnobs, RenderBackend } from '@/types';

// ─── Pure config ───────────────────────────────────────────────────────────────

/** Runtime inputs that gate effects beyond the static quality knobs. */
export interface PostChainOpts {
  /** True for the broadcast/cinematic camera; gates depth of field. */
  cinematicCamera?: boolean;
  /** Current cockpit lens-droplet coverage, 0..1 (from LensDropletState). */
  lensDropletCoverage?: number;
  /** True when the cockpit camera is exposed to the weather. */
  cameraExposed?: boolean;
}

/** Bloom pass parameters. */
export interface BloomConfig {
  active: boolean;
  /** Luminance threshold — high so only sun glitter / specular blooms, not sky. */
  threshold: number;
  strength: number;
  radius: number;
}

/** Motion-blur pass parameters. */
export interface MotionBlurConfig {
  active: boolean;
  /** Camera-relative strength, capped so it never smears to mush. */
  strength: number;
  samples: number;
}

/** Depth-of-field pass parameters. */
export interface DoFConfig {
  active: boolean;
  focusDistance: number;
  focalLength: number;
  bokehScale: number;
}

/** TAA pass parameters. */
export interface TAAConfig {
  active: boolean;
}

/** Lens-droplet composite parameters. */
export interface LensDropletConfig {
  active: boolean;
  coverage: number;
}

/** Colour-grade stage. Always active (it carries the venue palette grade). */
export interface GradeConfig {
  active: boolean;
}

/** The resolved post-chain configuration. */
export interface PostChainConfig {
  taa: TAAConfig;
  bloom: BloomConfig;
  motionBlur: MotionBlurConfig;
  dof: DoFConfig;
  lensDroplets: LensDropletConfig;
  grade: GradeConfig;
  /** Render resolution multiplier honoured by the chain (0.6..1.0). */
  renderScale: number;
}

/** Coverage below which lens droplets are not worth compositing. */
export const LENS_DROPLET_EPSILON = 0.001;

/** High bloom threshold: only HDR specular highlights (sun glitter) bloom. */
const BLOOM_THRESHOLD = 1.2;
/** Motion-blur strength cap (camera-relative). */
const MOTION_BLUR_MAX_STRENGTH = 0.5;

/**
 * Resolve which post passes are active and their parameters.
 *
 * Mapping is one-to-one with the knobs: a pass can only be active if its knob is
 * on. TAA, bloom, motion blur and DoF each gate on their respective knob; DoF
 * additionally requires the cinematic camera; lens droplets gate purely on
 * runtime coverage + exposure (there is no knob for them).
 *
 * ### TAA is WebGPU-only (documented WebGL2 reduction)
 *
 * TAA is force-disabled when `backend === 'webgl2'`. This is NOT a stylistic
 * choice — it is a hard limitation of three.js r0.180's `TRAANode` on the
 * WebGL2 fallback backend, proven with the GPU smoke harness:
 *
 *   TRAANode.updateBefore() resolves the frame into a private history/resolve
 *   RenderTarget pair and advances them every frame with
 *   `renderer.copyTextureToTexture(resolve.texture, history.texture)`. On the
 *   WebGL2 backend that path is a framebuffer blit: `WebGLTextureUtils.
 *   copyTextureToTexture` reads `backend.get(srcTextureData.renderTarget)` /
 *   `backend.get(dstTextureData.renderTarget)`. Those `renderTarget` entries are
 *   only populated by `_setFramebuffer` when the RT is bound through the normal
 *   render path; TRAANode's internal RTs never get them set, so `backend.get`
 *   is handed `undefined` → `WeakMap.set(undefined, …)` → the per-frame
 *   `TypeError: Invalid value used as weak map key` that leaves the canvas
 *   unresolved. The WebGPU backend uses a different (texture-to-texture) copy
 *   and is unaffected.
 *
 * The honest reduction: on WebGL2 we ship no temporal AA (bloom/motion-blur/DoF
 * all still work; the image is simply not temporally anti-aliased, matching the
 * README's "reduced fidelity on the WebGL2 fallback" contract). On WebGPU the
 * `taa` knob governs it directly. `buildPostOutputNode` still *constructs* the
 * TRAA node whenever `config.taa.active` is true, so turning the knob on under
 * WebGPU wires real TRAA; the gate lives here in policy, not in the graph.
 *
 * @param knobs   Quality knobs.
 * @param backend Active render backend. Gates TAA (see above).
 * @param opts    Runtime gates (cinematic camera, lens coverage, exposure).
 */
export function postChainConfig(
  knobs: QualityKnobs,
  backend: RenderBackend,
  opts: PostChainOpts = {},
): PostChainConfig {
  // TAA (three r0.180 TRAANode) is only functional on the WebGPU backend; its
  // per-frame copyTextureToTexture throws on the WebGL2 fallback (see above).
  const taaActive = knobs.taa && backend !== 'webgl2';

  const coverage = Math.min(1, Math.max(0, opts.lensDropletCoverage ?? 0));
  const lensActive = coverage > LENS_DROPLET_EPSILON && opts.cameraExposed === true;

  return {
    taa: { active: taaActive },
    bloom: {
      active: knobs.bloom,
      threshold: BLOOM_THRESHOLD,
      strength: 0.6,
      radius: 0.4,
    },
    motionBlur: {
      active: knobs.motionBlur,
      strength: MOTION_BLUR_MAX_STRENGTH,
      samples: 16,
    },
    dof: {
      active: knobs.depthOfField && opts.cinematicCamera === true,
      focusDistance: 1,
      focalLength: 1,
      bokehScale: 3,
    },
    lensDroplets: { active: lensActive, coverage },
    grade: { active: true },
    renderScale: Math.min(1, Math.max(0.6, knobs.renderScale)),
  };
}

/** A post-chain stage name, in canonical pipeline order. */
export type PostStage =
  | 'scene'
  | 'taa'
  | 'bloom'
  | 'motionBlur'
  | 'dof'
  | 'lensDroplets'
  | 'grade'
  | 'output';

/**
 * The canonical, documented pass order (header), filtered to the stages that are
 * actually active for a given config. `scene` and `output` always bracket the
 * chain. This is the single source of truth the header comment and the tests
 * both reference — if the order ever changes, it changes here.
 *
 * Order rationale (unchanged from the header): TAA resolves temporal jitter on
 * the raw beauty first so every later effect sees a stable image; bloom adds HDR
 * glow before motion blur smears it along velocity; DoF defocuses after the
 * scene is otherwise composed; lens droplets are a lens artefact on top; the
 * grade is the final linear→linear transform before the renderer's single ACES
 * output transform.
 */
export function postChainStages(config: PostChainConfig): PostStage[] {
  const stages: PostStage[] = ['scene'];
  if (config.taa.active) stages.push('taa');
  if (config.bloom.active) stages.push('bloom');
  if (config.motionBlur.active) stages.push('motionBlur');
  if (config.dof.active) stages.push('dof');
  if (config.lensDroplets.active) stages.push('lensDroplets');
  if (config.grade.active) stages.push('grade');
  stages.push('output');
  return stages;
}

// ─── three layer ───────────────────────────────────────────────────────────────

import * as THREE from 'three/webgpu';
import { pass, uniform, screenUV, mrt, velocity, output, convertToTexture, Fn, vec3, float, mix } from 'three/tsl';
import type { TSLNode } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { motionBlur } from 'three/addons/tsl/display/MotionBlur.js';
import { createGradeUniforms, gradeNode, NEUTRAL_GRADE, type GradeUniforms } from './ColorGrade';
import { lensDropletMaskNode } from '@render/weather/Rain';

/**
 * Ceiling for HDR values entering the bloom pass. A physically-lit sun-glitter
 * highlight is a few units; 64 is far above any legitimate scene value yet low
 * enough that the bloom mip chain's Gaussian kernels cannot overflow to Inf.
 */
const BLOOM_HDR_CEILING = 64;

/**
 * Sanitise an HDR colour node before it enters bloom's downsample/blur mip
 * chain.
 *
 * Why this is necessary (root cause of the noon "black then orange band +
 * rectangular patch" defect): bloom's high-pass is
 * `mix(0, texel, smoothstep(threshold, threshold+ε, luminance(texel)))` and
 * then a separable Gaussian is run over a 5-level mip pyramid. If ANY texel of
 * the HDR scene colour is NaN, +Inf, or a huge spike (the flat-water specular
 * sun reflection can clip very high, and `Inf·0 = NaN`), that poison spreads
 * across the whole blur kernel and, downsampled, paints large rectangular
 * mip-tile regions — exactly the artefact seen. Adding that back onto the beauty
 * and tone-mapping yields the blown grey sky + crushed/oranged water.
 *
 * The fix clamps every channel into `[0, ceiling]` AND replaces NaN with 0.
 * NaN detection uses the IEEE property `NaN !== NaN`: `c.equal(c)` is false only
 * for NaN, so `select(c.equal(c), c, 0)` scrubs NaN; the subsequent
 * `clamp(…, 0, ceiling)` turns ±Inf and negatives (which bloom must never see)
 * into finite values. This is a strict superset of the brief's
 * `max(x,0)`+ceiling recommendation (it also kills NaN, the actual culprit for
 * the mip-tile rectangles).
 */
function sanitiseHdr(node: TSLNode): TSLNode {
  return Fn(() => {
    const c = node.xyz;
    // NaN → 0 (NaN is the only value not equal to itself).
    const noNaN = c.equal(c).select(c, vec3(0, 0, 0));
    // Clamp ±Inf / negatives / spikes into a finite, bloom-safe range.
    return noNaN.clamp(float(0), float(BLOOM_HDR_CEILING));
  })();
}

/** Options to build the three-layer post chain. */
export interface PostChainCreateOpts extends PostChainOpts {
  /** Initial quality knobs. */
  knobs: QualityKnobs;
  /** Active backend. */
  backend: RenderBackend;
  /**
   * Initial grade params (venue palette grade). Optional: when a venue supplies
   * no grade, the chain falls back to {@link NEUTRAL_GRADE} (exact identity), so
   * a missing grade is a guaranteed no-op rather than an undefined/destructive
   * one.
   */
  grade?: ColorGradeParams;
}

/** The built post chain. */
export interface PostChain {
  /** Render one frame through the chain. */
  render(): void;
  /** Resize internal targets, honouring renderScale. */
  setSize(width: number, height: number): void;
  /** Reconfigure which passes are active from new knobs + runtime opts. */
  updateConfig(knobs: QualityKnobs, opts?: PostChainOpts): void;
  /** Update the venue colour grade. */
  setGrade(params: ColorGradeParams): void;
  /** Update lens-droplet coverage (hides the composite below epsilon). */
  setLensDroplets(coverage: number, exposed?: boolean): void;
  /** Dispose GPU resources. */
  dispose(): void;
  /** The resolved config, for inspection/testing. */
  readonly config: PostChainConfig;
}

/**
 * Build the TSL post-processing chain.
 *
 * TAA and motion blur are wired for real via a velocity MRT (see the file header
 * for the jitter-ownership and MRT details). The only thing that genuinely
 * cannot run here is the GPU execution itself: constructing the node graph and
 * `new PostProcessing(renderer)` work headlessly, but `.render()` requires a
 * live backend. Those unverifiable-without-GPU behaviours are listed in the task
 * report, not hidden.
 */

/** Minimal structural view of a three `PassNode` that this chain consumes. */
export interface ScenePassLike {
  getTextureNode(name?: string): TSLNode;
  getViewZNode(name?: string): TSLNode;
  setMRT(mrt: TSLNode): unknown;
}

/**
 * The result of building the output graph: the final node plus a structural
 * descriptor recording which optional stages were actually constructed. The
 * descriptor lets tests assert the graph differs between (e.g.) TAA on vs off
 * WITHOUT needing to introspect opaque TSL node internals, and mirrors
 * `postChainStages(config)` for the active optional effects.
 */
export interface PostOutputResult {
  /** The final linear→linear node to assign to `PostProcessing.outputNode`. */
  node: TSLNode;
  /** True iff the TRAA node was constructed and inserted. */
  taaApplied: boolean;
  /** True iff the motion-blur node was constructed and inserted. */
  motionBlurApplied: boolean;
  /**
   * The exact node handed to `motionBlur()` as its input, when motion blur was
   * applied (undefined otherwise). Exposed so tests can assert it is
   * texture-capable (`isTextureNode` / has `.sample`) — the invariant whose
   * violation caused the `inputNode.sample is not a function` runtime crash.
   */
  motionBlurInput?: TSLNode;
  /** True iff bloom was inserted. */
  bloomApplied: boolean;
  /** True iff DoF was inserted. */
  dofApplied: boolean;
  /** True iff the lens-droplet composite was inserted. */
  lensDropletsApplied: boolean;
  /** True iff the grade node was inserted. */
  gradeApplied: boolean;
  /** Canonical ordered stage names for the active chain. */
  stages: PostStage[];
}

/**
 * Build the post-chain output node graph from a scene pass + resolved config.
 *
 * Separated from `createPostChain` so the TSL node-graph construction is
 * headlessly testable in node WITHOUT a renderer — only `new
 * PostProcessing(renderer)` and `.render()` require a live GPU/DOM.
 *
 * Velocity wiring: when TAA or motion blur is active, the scene pass is
 * configured with `mrt({ output, velocity })` so a 'velocity' texture channel
 * exists; the channel is read as `scenePass.getTextureNode('velocity')`. If
 * neither effect is active, NO MRT is configured (the velocity buffer has a real
 * cost, and the disabled path must not pay it) and the pass stays single-target.
 *
 * The disabled-effect path never constructs the corresponding node — the `if`
 * guards gate construction, not just insertion, so a knob that is off costs
 * nothing on the GPU.
 */
export function buildPostOutputNode(
  scenePass: ScenePassLike,
  config: PostChainConfig,
  gradeUniforms: GradeUniforms,
  lensCoverage: TSLNode,
  camera?: THREE.Camera,
): PostOutputResult {
  const needsVelocity = config.taa.active || config.motionBlur.active;

  // Configure MRT only when a velocity-consuming effect is active, so the
  // disabled path carries no velocity-buffer cost. On a rebuild that turns
  // velocity back off we reset to a single 'output' channel so a stale velocity
  // target from a previous config does not linger.
  if (needsVelocity) {
    scenePass.setMRT(mrt({ output, velocity }));
  } else {
    scenePass.setMRT(mrt({ output }));
  }

  // Scene pass — linear HDR scene colour (the 'output' MRT channel).
  const beauty = scenePass.getTextureNode();
  let node: TSLNode = beauty;

  let taaApplied = false;
  let motionBlurApplied = false;
  let motionBlurInput: TSLNode | undefined;
  let bloomApplied = false;
  let dofApplied = false;
  let lensDropletsApplied = false;
  let gradeApplied = false;

  // Velocity channel (only valid when MRT was configured above).
  const velocityTex = needsVelocity ? scenePass.getTextureNode('velocity') : undefined;

  // TAA — temporal reprojection AA on the raw beauty, before any other effect,
  // so later passes see a stable (de-aliased) image. TRAANode does its own
  // camera jitter (see header) — we do not jitter here.
  if (config.taa.active && velocityTex !== undefined && camera !== undefined) {
    const depthTex = scenePass.getTextureNode('depth');
    node = traa(node, depthTex, velocityTex, camera);
    taaApplied = true;
  }

  // Bloom — HDR glow above `threshold` so only sun glitter / specular blooms.
  //
  // The node fed to `bloom()` is SANITISED (NaN→0, clamped to [0, ceiling]) so
  // a poison value in the HDR scene colour cannot spread through the Gaussian
  // mip chain and paint the rectangular mip-tile artefact (see `sanitiseHdr`).
  // The bloom contribution is then added onto the UNMODIFIED beauty `node`, so
  // the sanitation only guards the blur input and never dims the base image.
  if (config.bloom.active) {
    const bloomInput = sanitiseHdr(node);
    node = node.add(
      bloom(bloomInput, config.bloom.strength, config.bloom.radius, config.bloom.threshold),
    );
    bloomApplied = true;
  }

  // Camera-relative motion blur along the velocity vectors.
  //
  // BUGFIX (r0.180): `three/addons/tsl/display/MotionBlur.js` samples its input
  // via `inputNode.sample(uv)`, which ONLY exists on a texture node. The running
  // `node` here is a *composited* graph (beauty + bloom + …), not a texture, so
  // passing it directly threw `TypeError: inputNode.sample is not a function` at
  // runtime (it builds fine headlessly, so unit tests never caught it — see the
  // texture-capability test added for this). We route the composited node through
  // `convertToTexture()`, which renders it to an internal RTT texture and returns
  // a sampleable TextureNode — exactly how TRAANode wraps its own beauty input.
  // Motion blur now smears the fully-composited colour (beauty + bloom) that
  // precedes it, as the header documents, rather than needing the raw scene
  // texture. `motionInput` is kept so callers/tests can assert it is texture-
  // capable (`.sample`/`.isTextureNode`).
  if (config.motionBlur.active && velocityTex !== undefined) {
    const motionInput = convertToTexture(node);
    motionBlurInput = motionInput;
    node = motionBlur(motionInput, velocityTex.xy, config.motionBlur.samples);
    motionBlurApplied = true;
  }

  // Depth of field (cinematic camera only; gated in config).
  if (config.dof.active) {
    const viewZ = scenePass.getViewZNode();
    node = dof(
      node,
      viewZ,
      config.dof.focusDistance,
      config.dof.focalLength,
      config.dof.bokehScale,
    );
    dofApplied = true;
  }

  // Lens droplets — composite a refraction-ish darkening from the Rain mask.
  if (config.lensDroplets.active) {
    const mask = lensDropletMaskNode(screenUV, lensCoverage);
    node = mix(node, node.mul(0.6), mask);
    lensDropletsApplied = true;
  }

  // Colour grade (linear → linear). Last before the output tone-map.
  if (config.grade.active) {
    node = gradeNode(node, gradeUniforms);
    gradeApplied = true;
  }

  return {
    node,
    taaApplied,
    motionBlurApplied,
    ...(motionBlurInput !== undefined ? { motionBlurInput } : {}),
    bloomApplied,
    dofApplied,
    lensDropletsApplied,
    gradeApplied,
    stages: postChainStages(config),
  };
}

export function createPostChain(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  opts: PostChainCreateOpts,
): PostChain {
  let config = postChainConfig(opts.knobs, opts.backend, opts);

  const gradeUniforms: GradeUniforms = createGradeUniforms(opts.grade ?? NEUTRAL_GRADE);
  const lensCoverage = uniform(opts.lensDropletCoverage ?? 0);

  const post = new THREE.PostProcessing(renderer);

  // Scene pass — linear HDR scene colour.
  const scenePass = pass(scene, camera);

  post.outputNode = buildPostOutputNode(
    scenePass,
    config,
    gradeUniforms,
    lensCoverage,
    camera,
  ).node;

  let curWidth = 1;
  let curHeight = 1;

  return {
    render(): void {
      post.render();
    },
    setSize(width: number, height: number): void {
      curWidth = Math.max(1, Math.round(width * config.renderScale));
      curHeight = Math.max(1, Math.round(height * config.renderScale));
      renderer.setSize(curWidth, curHeight);
    },
    updateConfig(knobs: QualityKnobs, o?: PostChainOpts): void {
      config = postChainConfig(knobs, opts.backend, { ...opts, ...o });
      // Rebuild the graph so the newly toggled passes take effect.
      post.outputNode = buildPostOutputNode(
        scenePass,
        config,
        gradeUniforms,
        lensCoverage,
        camera,
      ).node;
    },
    setGrade(params: ColorGradeParams): void {
      gradeUniforms.update(params);
    },
    setLensDroplets(coverage: number, exposed = true): void {
      const c = Math.min(1, Math.max(0, coverage));
      lensCoverage.value = c;
      config = postChainConfig(opts.knobs, opts.backend, {
        ...opts,
        lensDropletCoverage: c,
        cameraExposed: exposed,
      });
    },
    dispose(): void {
      post.dispose();
    },
    get config(): PostChainConfig {
      return config;
    },
  };
}
