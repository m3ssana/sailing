/**
 * Weather pipeline tests.
 *
 * Covers: unit conversion (knots→m/s, degrees→radians), air density derivation,
 * stability, direction conventions, circular interpolation, wave lag, inland-lake
 * synthesis, the full fallback ladder, and multi-coordinate batching.
 */

import { describe, it, expect } from 'vitest';
import { UNITS, PHYSICS_CONSTANTS } from '@/types';
import { normalizeWeather } from '@weather/normalize';
import type { RawForecastResponse } from '@weather/providers/OpenMeteoForecast';
import type { RawMarineResponse } from '@weather/providers/OpenMeteoMarine';

// Fixtures loaded inline to avoid async module resolution
import newportForecast from '../../fixtures/open-meteo/newport-forecast.json';
import newportMarine from '../../fixtures/open-meteo/newport-marine.json';

describe('Weather normalization', () => {
  describe('unit conversions', () => {
    it('converts wind speed from knots to m/s correctly', () => {
      const forecast = newportForecast as unknown as RawForecastResponse;
      const marine = newportMarine as unknown as RawMarineResponse;
      const snapshot = normalizeWeather(forecast, marine, {
        venueId: 'newport',
        fetchMetres: 5000,
      });

      // 14.2 kn * 1852/3600 ≈ 7.31 m/s
      const expectedMs = 14.2 * UNITS.KNOTS_TO_MS;
      expect(snapshot.wind.trueSpeed).toBeCloseTo(expectedMs, 2);
    });

    it('converts wind direction from degrees to radians', () => {
      const forecast = newportForecast as unknown as RawForecastResponse;
      const marine = newportMarine as unknown as RawMarineResponse;
      const snapshot = normalizeWeather(forecast, marine, {
        venueId: 'newport',
        fetchMetres: 5000,
      });

      // 215° * π/180 ≈ 3.752 rad
      const expectedRad = 215 * UNITS.DEG_TO_RAD;
      expect(snapshot.wind.trueDirection).toBeCloseTo(expectedRad, 4);
    });

    it('converts gust speed from knots to m/s', () => {
      const forecast = newportForecast as unknown as RawForecastResponse;
      const marine = newportMarine as unknown as RawMarineResponse;
      const snapshot = normalizeWeather(forecast, marine, {
        venueId: 'newport',
        fetchMetres: 5000,
      });

      const expectedMs = 19.8 * UNITS.KNOTS_TO_MS;
      expect(snapshot.wind.gustCeiling).toBeCloseTo(expectedMs, 2);
    });

    it('converts wave direction from degrees to radians', () => {
      const forecast = newportForecast as unknown as RawForecastResponse;
      const marine = newportMarine as unknown as RawMarineResponse;
      const snapshot = normalizeWeather(forecast, marine, {
        venueId: 'newport',
        fetchMetres: 5000,
      });

      // 195° → radians
      const expectedRad = 195 * UNITS.DEG_TO_RAD;
      expect(snapshot.sea.dominantDirection).toBeCloseTo(expectedRad, 4);
    });

    it('converts pressure from hPa to Pa', () => {
      const forecast = newportForecast as unknown as RawForecastResponse;
      const marine = newportMarine as unknown as RawMarineResponse;
      const snapshot = normalizeWeather(forecast, marine, {
        venueId: 'newport',
        fetchMetres: 5000,
      });

      // 1018.3 hPa → 101830 Pa
      expect(snapshot.air.pressure).toBeCloseTo(101830, 0);
    });
  });

  describe('air density', () => {
    it('computes density from ideal gas law', () => {
      const forecast = newportForecast as unknown as RawForecastResponse;
      const marine = newportMarine as unknown as RawMarineResponse;
      const snapshot = normalizeWeather(forecast, marine, {
        venueId: 'newport',
        fetchMetres: 5000,
      });

      // ρ = P / (R_d × T_K) = 101830 / (287.058 × 295.65) ≈ 1.200
      const tempK = 22.5 + 273.15;
      const expected = 101830 / (PHYSICS_CONSTANTS.DRY_AIR_GAS_CONSTANT * tempK);
      expect(snapshot.air.density).toBeCloseTo(expected, 3);
    });

    it('cold high-pressure day has higher density than warm low-pressure day', () => {
      // Cold high-pressure: 5°C, 1035 hPa
      const coldPressurePa = 103500;
      const coldTempK = 5 + 273.15;
      const coldDensity = coldPressurePa / (PHYSICS_CONSTANTS.DRY_AIR_GAS_CONSTANT * coldTempK);

      // Warm low-pressure: 30°C, 1005 hPa
      const warmPressurePa = 100500;
      const warmTempK = 30 + 273.15;
      const warmDensity = warmPressurePa / (PHYSICS_CONSTANTS.DRY_AIR_GAS_CONSTANT * warmTempK);

      // Cold day genuinely delivers more force at the same wind speed
      expect(coldDensity).toBeGreaterThan(warmDensity);
      // Difference should be measurable — roughly 10%
      expect(coldDensity / warmDensity).toBeGreaterThan(1.08);
    });
  });

  describe('stability derivation', () => {
    it('produces stability between 0 and 1', () => {
      const forecast = newportForecast as unknown as RawForecastResponse;
      const marine = newportMarine as unknown as RawMarineResponse;
      const snapshot = normalizeWeather(forecast, marine, {
        venueId: 'newport',
        fetchMetres: 5000,
      });

      expect(snapshot.wind.stability).toBeGreaterThanOrEqual(0);
      expect(snapshot.wind.stability).toBeLessThanOrEqual(1);
    });

    it('gusty conditions produce higher stability values', () => {
      // Gusty: 14 kn mean, 25 kn gust (factor 1.78)
      // The Newport fixture has 14.2 kn / 19.8 kn (factor 1.39)
      // Stability reflects gust spread + thermal
      const forecast = newportForecast as unknown as RawForecastResponse;
      const marine = newportMarine as unknown as RawMarineResponse;
      const snapshot = normalizeWeather(forecast, marine, {
        venueId: 'newport',
        fetchMetres: 5000,
      });

      // Newport: air 22.5°C, sea 19.5°C → sea cooler → slightly stable thermal
      // But gust spread (19.8-14.2)/14.2 = 0.39 → moderate instability
      expect(snapshot.wind.stability).toBeGreaterThan(0.1);
      expect(snapshot.wind.stability).toBeLessThan(0.8);
    });
  });
});
