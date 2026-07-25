/**
 * Composed wind field implementing the frozen WindField interface.
 *
 * Layers (evaluated bottom-up):
 *   1. Base: spatially uniform forecast from WeatherService.sampleAt(t)
 *   2. Oscillation: temporal sinusoidal wander of direction and speed
 *   3. Gusts: 2D advecting noise field — spatial and temporal variation
 *   4. Terrain: per-venue influence field modifying speed and direction
 *   5. Gradient: power-law vertical profile
 *
 * The result at any point is deterministic in (seed, snapshot) per req 3.7.
 */

import type {
  MetresPerSecond,
  Radians,
  Seed,
  SessionTime,
  Vec2,
  WindField,
  WindSample,
} from '@/types';
import type { WeatherService } from '@/types';
import type { WindProfile } from '@/types';
import { windVector } from '@core/math';
import { clamp, wrapAngle } from '@core/math';
import {
  createBaseWindSample,
  sampleBaseWind,
} from './layers/base';
import type { BaseWindSample } from './layers/base';
import {
  createOscillationConfig,
  sampleOscillation,
  sampleOscillationSpeed,
} from './layers/oscillation';
import type { OscillationConfig } from './layers/oscillation';
import { createGustConfig, sampleGust, sampleGustFactor } from './layers/gust';
import type { GustConfig } from './layers/gust';
import {
  createNeutralTerrainField,
  sampleTerrainInfluence,
} from './layers/terrain';
import type { TerrainInfluenceField, TerrainSample } from './layers/terrain';
import { verticalGradient } from './layers/gradient';

export interface WindFieldConfig {
  weatherService: WeatherService;
  seed: Seed;
  windProfile: WindProfile;
  terrainField?: TerrainInfluenceField;
}

/**
 * Module-scope scratch objects used in per-frame sampling.
 * NO ALLOCATION in hot paths — these are reused every call.
 */
const _baseSample: BaseWindSample = createBaseWindSample();
const _terrainSample: TerrainSample = { speedMultiplier: 1, directionBias: 0 };
const _gustSample = { gustFactor: 1, directionBias: 0 };

export function createWindField(config: WindFieldConfig): WindField {
  const { weatherService, seed, windProfile } = config;
  const terrainField = config.terrainField ?? createNeutralTerrainField();

  const venueId = weatherService.snapshot.venueId;
  const fetchedAt = weatherService.snapshot.fetchedAt;

  // Deterministic layer configurations.
  const oscConfig: OscillationConfig = createOscillationConfig(
    venueId,
    fetchedAt,
    seed,
    windProfile.oscillationScale,
  );
  const gustConfig: GustConfig = createGustConfig(
    venueId,
    fetchedAt,
    seed,
    windProfile.gustScale,
  );

  const shearExponent = windProfile.shearExponent;

  // Pre-allocated result for sample().
  const _result: WindSample = {
    velocity: { x: 0, y: 0, z: 0 },
    speed: 0,
    direction: 0,
    gustFactor: 1,
  };

  function sample(x: number, z: number, height: number, t: SessionTime): WindSample {
    // 1. Base forecast (uniform in space).
    sampleBaseWind(weatherService, t, _baseSample);
    const baseSpeed = _baseSample.speed;
    const baseDir = _baseSample.direction;
    const gustCeiling = _baseSample.gustCeiling;
    const stability = _baseSample.stability;

    // 2. Oscillation: temporal wander.
    const oscDirection = sampleOscillation(oscConfig, stability, t);
    const oscSpeedFactor = sampleOscillationSpeed(oscConfig, stability, t);

    // 3. Gusts: spatial + temporal variation.
    sampleGust(x, z, t, baseSpeed, baseDir, gustCeiling, stability, gustConfig, _gustSample);

    // 4. Terrain influence.
    sampleTerrainInfluence(terrainField, x, z, _terrainSample);

    // 5. Compose direction: base + oscillation + gust bias + terrain bias.
    const direction = wrapAngle(
      baseDir + oscDirection + _gustSample.directionBias + _terrainSample.directionBias,
    );

    // Compose speed: base × oscillation × gust × terrain × vertical gradient.
    const heightFactor = verticalGradient(height, shearExponent);
    const speed = clamp(
      baseSpeed * oscSpeedFactor * _gustSample.gustFactor * _terrainSample.speedMultiplier * heightFactor,
      0,
      gustCeiling * 1.5, // Hard cap at 1.5× gust ceiling for numerical safety.
    );

    // Convert meteorological direction + speed to velocity vector.
    windVector(direction, speed, _result.velocity);

    _result.speed = speed;
    _result.direction = direction;
    _result.gustFactor = _gustSample.gustFactor;

    return _result;
  }

  function sampleGustGridInto(
    target: Float32Array,
    origin: Vec2,
    cellSize: number,
    resolution: number,
    t: SessionTime,
  ): void {
    // Get current base conditions for the grid centre (all cells share the same
    // base since the forecast is spatially uniform).
    sampleBaseWind(weatherService, t, _baseSample);
    const baseSpeed = _baseSample.speed;
    const baseDir = _baseSample.direction;
    const gustCeiling = _baseSample.gustCeiling;
    const stability = _baseSample.stability;

    // Fill row-major. NO allocation — caller owns the target buffer.
    let idx = 0;
    for (let row = 0; row < resolution; row++) {
      const z = origin.y + row * cellSize;
      for (let col = 0; col < resolution; col++) {
        const x = origin.x + col * cellSize;
        target[idx] = sampleGustFactor(
          x, z, t, baseSpeed, baseDir, gustCeiling, stability, gustConfig,
        );
        idx++;
      }
    }
  }

  function meanDirection(t: SessionTime): Radians {
    sampleBaseWind(weatherService, t, _baseSample);
    const oscDir = sampleOscillation(oscConfig, _baseSample.stability, t);
    return wrapAngle(_baseSample.direction + oscDir);
  }

  function meanSpeed(t: SessionTime): MetresPerSecond {
    sampleBaseWind(weatherService, t, _baseSample);
    const oscFactor = sampleOscillationSpeed(oscConfig, _baseSample.stability, t);
    return _baseSample.speed * oscFactor;
  }

  return {
    sample,
    sampleGustGridInto,
    meanDirection,
    meanSpeed,
  };
}
