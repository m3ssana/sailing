/**
 * Stream F.2 — Weather visuals (clouds, rain, visibility).
 *
 * Public surface: pure physically-grounded models (headlessly testable) plus
 * thin three/TSL renderers that mirror them.
 */

// Visibility / aerial perspective
export {
  CONTRAST_THRESHOLD,
  KOSCHMIEDER_CONSTANT,
  MIN_VISIBILITY,
  MAX_VISIBILITY,
  clampVisibility,
  extinction,
  transmittance,
  apparentContrast,
  fogFarDistance,
  aerialPerspective,
  createVisibilityUniforms,
  applyAerialPerspectiveNode,
} from './Visibility';
export type { VisibilityUniforms } from './Visibility';

// Cloud model + renderer
export {
  hash3,
  valueNoise3,
  fbm,
  NOISE_OCTAVES,
  NOISE_CONSTANTS,
  coverageThreshold,
  cloudDensity,
  measureCoverageFraction,
  cloudLayersFromSky,
  haltonJitter,
  reprojectionBlend,
  quarterResSize,
} from './CloudModel';
export type { CloudLayerKind, CloudLayerParams } from './CloudModel';
export { createCloudRenderer } from './CloudRenderer';
export type { CloudRenderer, CloudRendererOptions } from './CloudRenderer';

// Rain
export {
  DEFAULT_RAIN_BUDGET,
  terminalFallSpeed,
  rainParams,
  rainSurfaceDisturbance,
  LensDropletState,
  rainRippleNormalNode,
  lensDropletMaskNode,
  createRainSystem,
} from './Rain';
export type { RainParams, RainSystem, RainSystemOptions } from './Rain';

// Facade
export { createWeatherVisuals } from './WeatherVisuals';
export type { WeatherVisuals, WeatherVisualsOptions } from './WeatherVisuals';
