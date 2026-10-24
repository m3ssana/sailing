/**
 * Stream F.3 — Shadows and post-processing. Public barrel.
 *
 * Pure models (no three.js): CascadedShadows, ColorGrade, TAA, and the
 * `postChainConfig` policy. Thin three/TSL layers: ShadowRig, the grade node,
 * and the PostProcessing chain.
 */

// Cascaded shadow model (pure)
export {
  computeCascadeSplits,
  fitCascade,
  shadowProjectToPlane,
  frustumSliceCorners,
  boundingSphere,
  lightBasis,
  toLightSpace,
  bearingToDirection,
  type CameraSliceParams,
  type CascadeFit,
} from './CascadedShadows';

// Shadow rig (three layer)
export {
  createShadowRig,
  enableRigShadows,
  type ShadowRig,
  type ShadowRigOptions,
} from './ShadowRig';

// Colour grade (pure + TSL mirror)
export {
  applyColorGrade,
  paletteHold,
  luminance,
  okChroma,
  okHue,
  angularDelta,
  angularDistance,
  linearToOKLab,
  okLabToLinear,
  srgbHexToLinear,
  srgbChannelToLinear,
  gradeNode,
  createGradeUniforms,
  type GradeUniforms,
} from './ColorGrade';

// TAA (pure model)
export {
  halton,
  taaJitter,
  taaBlend,
  neighbourhoodClamp,
  neighbourhoodBounds,
  type Jitter,
  type Sample3,
} from './TAA';

// Post chain (pure config + three layer)
export {
  postChainConfig,
  postChainStages,
  createPostChain,
  buildPostOutputNode,
  LENS_DROPLET_EPSILON,
  type PostChainConfig,
  type PostChainOpts,
  type PostChainCreateOpts,
  type PostChain,
  type PostStage,
  type PostOutputResult,
  type ScenePassLike,
  type BloomConfig,
  type MotionBlurConfig,
  type DoFConfig,
  type TAAConfig,
  type LensDropletConfig,
  type GradeConfig,
} from './PostChain';
