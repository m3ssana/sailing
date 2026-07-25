/**
 * Direction convention tests and inland-lake synthesis.
 *
 * windDirection is FROM (meteorological). currentDirection is TOWARDS.
 * This asymmetry is inherited from the Open-Meteo API — do not normalize it.
 */

import { describe, it, expect } from 'vitest';
import { UNITS } from '@/types';
import { normalizeWeather } from '@weather/normalize';
import { hasMarineData } from '@weather/providers/OpenMeteoMarine';
import type { RawForecastResponse } from '@weather/providers/OpenMeteoForecast';
import type { RawMarineResponse } from '@weather/providers/OpenMeteoMarine';

import newportForecast from '../../fixtures/open-meteo/newport-forecast.json';
import newportMarine from '../../fixtures/open-meteo/newport-marine.json';
import inlandLakeMarine from '../../fixtures/open-meteo/inland-lake-marine.json';

describe('Direction conventions', () => {
  it('wind direction is FROM (meteorological convention)', () => {
    const forecast = newportForecast as unknown as RawForecastResponse;
    const marine = newportMarine as unknown as RawMarineResponse;
    const snapshot = normalizeWeather(forecast, marine, {
      venueId: 'newport',
      fetchMetres: 5000,
    });

    // 215° from means wind blows FROM the south-southwest
    // The raw value is 215 degrees, stored as radians
    const expectedRad = 215 * UNITS.DEG_TO_RAD;
    expect(snapshot.wind.trueDirection).toBeCloseTo(expectedRad, 4);
  });

  it('current direction is TOWARDS (opposite to wind convention)', () => {
    const forecast = newportForecast as unknown as RawForecastResponse;
    const marine = newportMarine as unknown as RawMarineResponse;
    const snapshot = normalizeWeather(forecast, marine, {
      venueId: 'newport',
      fetchMetres: 5000,
    });

    // Marine API returns current direction 45° (towards NE)
    // This is stored as-is in radians — the asymmetry is deliberate
    const expectedRad = 45 * UNITS.DEG_TO_RAD;
    expect(snapshot.current.direction).toBeCloseTo(expectedRad, 4);
  });

  it('wave direction is FROM (same convention as wind)', () => {
    const forecast = newportForecast as unknown as RawForecastResponse;
    const marine = newportMarine as unknown as RawMarineResponse;
    const snapshot = normalizeWeather(forecast, marine, {
      venueId: 'newport',
      fetchMetres: 5000,
    });

    // Wave direction 195° FROM
    const expectedRad = 195 * UNITS.DEG_TO_RAD;
    expect(snapshot.sea.dominantDirection).toBeCloseTo(expectedRad, 4);
  });
});

describe('Marine data detection', () => {
  it('detects valid marine response', () => {
    const marine = newportMarine as unknown as RawMarineResponse;
    expect(hasMarineData(marine)).toBe(true);
  });

  it('detects null marine response (inland lake)', () => {
    const marine = inlandLakeMarine as unknown as RawMarineResponse;
    expect(hasMarineData(marine)).toBe(false);
  });

  it('detects null input', () => {
    expect(hasMarineData(null)).toBe(false);
  });
});

describe('Inland-lake wave synthesis', () => {
  it('synthesizes sea state from wind when marine data is null', () => {
    const forecast = newportForecast as unknown as RawForecastResponse;
    // Pass null marine — simulates inland lake
    const snapshot = normalizeWeather(forecast, null, {
      venueId: 'chicago',
      fetchMetres: 30000, // Lake Michigan fetch ~30 km
    });

    // Should have synthesized wave data, not zeros
    expect(snapshot.sea.significantHeight).toBeGreaterThan(0);
    expect(snapshot.sea.dominantPeriod).toBeGreaterThan(0);
  });

  it('synthesized waves align with wind direction', () => {
    const forecast = newportForecast as unknown as RawForecastResponse;
    const snapshot = normalizeWeather(forecast, null, {
      venueId: 'chicago',
      fetchMetres: 30000,
    });

    // Wind-generated waves should align with wind direction
    expect(snapshot.sea.dominantDirection).toBeCloseTo(snapshot.wind.trueDirection, 4);
  });

  it('synthesized wave height increases with wind speed', () => {
    // Create two forecasts with different wind speeds
    const lightWind = {
      ...newportForecast,
      current: { ...newportForecast.current, wind_speed_10m: 5.0 },
    } as unknown as RawForecastResponse;

    const strongWind = {
      ...newportForecast,
      current: { ...newportForecast.current, wind_speed_10m: 25.0 },
    } as unknown as RawForecastResponse;

    const lightSnapshot = normalizeWeather(lightWind, null, {
      venueId: 'chicago',
      fetchMetres: 30000,
    });

    const strongSnapshot = normalizeWeather(strongWind, null, {
      venueId: 'chicago',
      fetchMetres: 30000,
    });

    expect(strongSnapshot.sea.significantHeight)
      .toBeGreaterThan(lightSnapshot.sea.significantHeight);
  });

  it('synthesized waves have no swell on inland lakes', () => {
    const forecast = newportForecast as unknown as RawForecastResponse;
    const snapshot = normalizeWeather(forecast, null, {
      venueId: 'chicago',
      fetchMetres: 30000,
    });

    // No swell on lakes — it's all wind wave
    expect(snapshot.sea.swell.height).toBe(0);
  });

  it('handles all-null marine response the same as null', () => {
    const forecast = newportForecast as unknown as RawForecastResponse;
    const marine = inlandLakeMarine as unknown as RawMarineResponse;

    const snapshot = normalizeWeather(forecast, marine, {
      venueId: 'chicago',
      fetchMetres: 30000,
    });

    // Should still synthesize — null marine current means no coverage
    expect(snapshot.sea.significantHeight).toBeGreaterThan(0);
    expect(snapshot.sea.swell.height).toBe(0);
  });
});
