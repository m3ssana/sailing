/**
 * Stream F.1 — sky, atmosphere, lighting, and environment-probe public API.
 *
 * - `LightingModel`     : SkyState + weather → frozen `LightingState`.
 * - `AtmosphereModel`   : CPU Rayleigh+Mie sky radiance reference + sun disc.
 * - `SkyDome`           : TSL sky dome mirroring the atmosphere model.
 * - `EnvironmentProbe`  : PMREM IBL probe + pure regeneration policy.
 * - `WaterLightingBridge`: push live lighting into the ocean water uniforms.
 */

export {
  computeLightingState,
  effectiveCloudCover,
  skyTint,
} from './LightingModel';

export {
  skyRadiance,
  sunDiscRadiance,
  rayleighPhase,
  miePhase,
  createAtmosphereParams,
  BETA_RAYLEIGH,
  BETA_MIE,
  H_RAYLEIGH,
  H_MIE,
  MIE_G,
  SUN_ANGULAR_RADIUS,
  SUN_DISC_RENDER_RADIUS,
  type AtmosphereParams,
} from './AtmosphereModel';

export {
  createSkyDome,
  type SkyDome,
  type SkyDomeOptions,
  type SkyDomeUniforms,
} from './SkyDome';

export {
  EnvironmentProbe,
  ProbeRegenPolicy,
  defaultProbeThresholds,
  type ProbeRegenThresholds,
  type EnvironmentProbeOptions,
} from './EnvironmentProbe';

export { applyLightingToWater } from './WaterLightingBridge';
