/**
 * NightSystem — Stream F.4 facade.
 *
 * Bundles the moon disc, star field, and shore lights behind one `update`/
 * `dispose`. Nav-light rigs are created PER VESSEL (each boat/ambient vessel
 * owns its own rig via `createNavLightRig(...).attachToVessel(...)`), so they
 * are not owned by this facade — but the facade exposes the shared pure helpers
 * (`computeMoonlight`, `starVisibility`, `effectiveGustIntensity`) a caller
 * needs to drive them and the water's gust uniform.
 *
 * The facade consumes `SkyState` + `LightingState` (produced elsewhere — F.1's
 * `computeLightingState`) and never produces them.
 */

import * as THREE from 'three/webgpu';
import {
  computeMoonlight,
  moonGlitterParams,
  type Moonlight,
  type MoonlightSkyInput,
  type MoonGlitterParams,
} from './Moonlight';
import { createMoonDisc, type MoonDisc } from './MoonDisc';
import {
  generateStarCatalog,
  starVisibility,
  type CatalogStar,
} from './StarField';
import { createStarField, type StarFieldRig } from './StarFieldRig';
import {
  generateShoreLights,
  type ShoreAnchor,
  type ShoreLight,
} from './ShoreLights';
import { createShoreLights, type ShoreLightsRig } from './ShoreLightsRig';
import { effectiveGustIntensity } from './GustVisibility';
import type { LightingState } from '../lighting/LightingState';
import type { Vec3 } from '@/types';

/**
 * Per-frame sky input for the night system. Extends the moonlight sky input
 * with the sidereal time (for star-field rotation) and the sun direction (for
 * moon-disc phase/limb orientation).
 */
export type NightSkyInput = MoonlightSkyInput & {
  /** Local apparent sidereal time, radians (`SkyState.siderealTime`). */
  siderealTime: number;
  /** Unit vector FROM the scene TOWARDS the sun (`SkyState.sunDirection`). */
  sunDirection: Vec3;
};

export interface NightSystemOptions {
  /** Deterministic seed for the star catalogue and shore lights. */
  seed: number;
  /** Number of stars to generate. Default 2000. */
  starCount?: number;
  /** Observer latitude, radians (+N). Default 0. */
  latitude?: number;
  /** Shore-light placement anchors (from reachable generation data). Default none. */
  shoreAnchors?: readonly ShoreAnchor[];
  /** Urban density 0..1 for shore lights (AmbienceParams.urban). Default 0. */
  urban?: number;
}

/** Per-frame context for `update`. */
export interface NightUpdateContext {
  /** Raw daytime gust intensity 0..1 (from the wind gust field), if driving water. */
  rawGustIntensity?: number;
}

export interface NightSystem {
  /** The scene-graph group holding moon disc, stars, and shore lights. */
  readonly object: THREE.Object3D;
  /** The current computed moonlight (after the last `update`). */
  readonly moonlight: Moonlight;
  /** The current moon glitter params (after the last `update`). */
  readonly moonGlitter: MoonGlitterParams;
  /** The current star visibility 0..1 (after the last `update`). */
  readonly starVisibility: number;
  /**
   * The gust intensity to write into WaterMaterial's `gustIntensity` uniform
   * this frame, if `ctx.rawGustIntensity` was supplied. Undefined otherwise.
   */
  readonly effectiveGustIntensity: number | undefined;
  /** Advance the night subsystems. */
  update(sky: NightSkyInput, lighting: LightingState, ctx?: NightUpdateContext): void;
  dispose(): void;
}

/**
 * Create the night system facade.
 */
export function createNightSystem(opts: NightSystemOptions): NightSystem {
  const seed = opts.seed;
  const starCount = opts.starCount ?? 2000;
  const latitude = opts.latitude ?? 0;

  const root = new THREE.Group();

  // Moon disc.
  const moonDisc: MoonDisc = createMoonDisc();
  root.add(moonDisc.object);

  // Star field.
  const catalog: CatalogStar[] = generateStarCatalog(seed, starCount);
  const starRig: StarFieldRig = createStarField(catalog, { latitude });
  root.add(starRig.object);

  // Shore lights (optional).
  let shoreRig: ShoreLightsRig | undefined;
  if (opts.shoreAnchors && opts.shoreAnchors.length > 0) {
    const lights: ShoreLight[] = generateShoreLights(seed, opts.shoreAnchors, {
      density: opts.urban ?? 0,
    });
    shoreRig = createShoreLights(lights);
    root.add(shoreRig.object);
  }

  const moonlight: Moonlight = { moonColor: { r: 0, g: 0, b: 0 }, moonIlluminance: 0 };
  let glitter: MoonGlitterParams = { intensity: 0, roughness: 0.08 };
  let starVis = 0;
  let effGust: number | undefined;

  return {
    object: root,
    get moonlight(): Moonlight {
      return moonlight;
    },
    get moonGlitter(): MoonGlitterParams {
      return glitter;
    },
    get starVisibility(): number {
      return starVis;
    },
    get effectiveGustIntensity(): number | undefined {
      return effGust;
    },
    update(
      sky: NightSkyInput,
      lighting: LightingState,
      ctx?: NightUpdateContext,
    ): void {
      computeMoonlight(sky, lighting, moonlight);
      glitter = moonGlitterParams(moonlight);

      moonDisc.update(sky, lighting, sky.sunDirection);

      starVis = starVisibility(lighting, moonlight.moonIlluminance);
      starRig.update(sky.siderealTime, latitude, starVis);

      shoreRig?.update(lighting.nightFactor);

      effGust =
        ctx?.rawGustIntensity === undefined
          ? undefined
          : effectiveGustIntensity(ctx.rawGustIntensity, lighting, moonlight.moonIlluminance);
    },
    dispose(): void {
      moonDisc.dispose();
      starRig.dispose();
      shoreRig?.dispose();
    },
  };
}
