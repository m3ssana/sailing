/**
 * Weather visuals facade — Stream F.2.
 *
 * Bundles the cloud renderer, rain system and visibility uniforms behind a
 * single `update()` so the scene owner wires weather in one place. Pure models
 * live in CloudModel / Rain / Visibility; this is only the glue.
 */

import * as THREE from 'three/webgpu';
import type { QualityKnobs, SkyConditions, SkyState, Vec3 } from '@/types';
import type { LightingState } from '@render/lighting/LightingState';
import { createCloudRenderer, type CloudRenderer } from './CloudRenderer';
import { createRainSystem, rainParams, type RainSystem } from './Rain';
import { createVisibilityUniforms, type VisibilityUniforms } from './Visibility';

/** Options forwarded to the sub-systems. */
export interface WeatherVisualsOptions {
  /** Dome radius for clouds, metres. */
  domeRadius?: number;
  /** Camera-box half-extent for rain, metres. */
  rainBoxHalfExtent?: number;
  /** Rain streak budget. */
  rainBudget?: number;
}

/** The bundled weather visuals. */
export interface WeatherVisuals {
  /** Group holding the cloud dome + rain box; add under the camera rig. */
  readonly object: THREE.Object3D;
  readonly clouds: CloudRenderer;
  readonly rain: RainSystem;
  readonly visibility: VisibilityUniforms;
  /**
   * Single per-frame update.
   * @param sky         Live SkyState (cloud cover, sun direction).
   * @param conditions  Live SkyConditions (visibility, precipitation).
   * @param lighting    Shared LightingState.
   * @param wind        Air-velocity vector (m/s) for cloud drift & rain slant.
   * @param dt          Delta time, seconds (reserved for future stateful fx).
   * @param cameraPos   Camera world position.
   * @param knobs       Quality knobs (cloudMarchSteps).
   */
  update(
    sky: SkyState,
    conditions: SkyConditions,
    lighting: LightingState,
    wind: Vec3,
    dt: number,
    cameraPos: Vec3,
    knobs: Pick<QualityKnobs, 'cloudMarchSteps'>,
  ): void;
  dispose(): void;
}

/** Create the weather-visuals bundle. */
export function createWeatherVisuals(options: WeatherVisualsOptions = {}): WeatherVisuals {
  const group = new THREE.Group();

  const clouds = createCloudRenderer(
    options.domeRadius !== undefined ? { domeRadius: options.domeRadius } : {},
  );
  const rain = createRainSystem({
    ...(options.rainBoxHalfExtent !== undefined
      ? { boxHalfExtent: options.rainBoxHalfExtent }
      : {}),
    ...(options.rainBudget !== undefined ? { budget: options.rainBudget } : {}),
  });
  const visibility = createVisibilityUniforms();

  group.add(clouds.object);
  group.add(rain.object);

  let timeSeconds = 0;

  return {
    object: group,
    clouds,
    rain,
    visibility,
    update(sky, conditions, lighting, wind, dt, cameraPos, knobs): void {
      timeSeconds += Math.max(0, dt);

      clouds.update(sky, lighting, timeSeconds, cameraPos, knobs, wind);

      const rp = rainParams(conditions.precipitation, wind);
      rain.update(rp);
      // Rain box follows the camera.
      rain.object.position.set(cameraPos.x, cameraPos.y, cameraPos.z);

      visibility.update(conditions.visibility, lighting);
    },
    dispose(): void {
      clouds.dispose();
      rain.dispose();
    },
  };
}
