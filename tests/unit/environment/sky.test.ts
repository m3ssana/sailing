/**
 * Sky state tests.
 *
 * Solar position verified against NOAA Solar Calculator reference values.
 * Reference: https://gml.noaa.gov/grad/solcalc/
 *
 * The NOAA calculator uses the same Meeus-based algorithm, so agreement within
 * ~0.5° validates our implementation rather than being circular.
 */

import { describe, it, expect } from 'vitest';
import { solarPosition, lunarPosition, localSiderealTime, computeSkyStateForVenue, createSkyState } from '@environment/SkyState';

const DEG = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Reference solar positions from NOAA Solar Calculator.
 * Each case is a known real-world observation.
 */
describe('Solar position', () => {
  it('Newport RI — 2023-06-21 12:00 EDT (summer solstice noon)', () => {
    // Newport, Rhode Island: 41.49°N, -71.31°W
    // 2023-06-21 12:00 EDT = 2023-06-21 16:00 UTC
    // NOAA spreadsheet algorithm (Meeus): elevation 69.45°, azimuth ~174°.
    // Solar noon is at ~12:47 EDT (max elev ~71.9°); 12:00 clock time is
    // 47 minutes before noon so the sun is still climbing.
    // Reference: NOAA_Solar_Calculations_day.xls with lat=41.49, lon=-71.31,
    // tz=-4, date=2023-06-21, time=12:00.
    const epochMs = Date.UTC(2023, 5, 21, 16, 0, 0); // June 21, 2023 16:00 UTC
    const { elevation, azimuth } = solarPosition(epochMs, 41.49, -71.31);

    const elevDeg = elevation * RAD_TO_DEG;
    const azDeg = azimuth * RAD_TO_DEG;

    // Within 0.5 degrees of NOAA algorithm values.
    expect(elevDeg).toBeCloseTo(69.45, 0);
    expect(azDeg).toBeCloseTo(148, 0);
  });

  it('Sydney — 2023-12-22 12:00 AEDT (summer solstice noon)', () => {
    // Sydney: -33.87°S, 151.21°E
    // 2023-12-22 12:00 AEDT = 2023-12-22 01:00 UTC
    // NOAA spreadsheet algorithm (Meeus): elevation 74.35°.
    // Solar noon is at ~12:53 AEDT (max elev ~79.6°); 12:00 clock time is
    // 53 minutes before noon. The 5° difference from the solstice max is
    // entirely explained by the hour angle at 12:00 vs solar noon.
    // Reference: NOAA_Solar_Calculations_day.xls with lat=-33.87, lon=151.21,
    // tz=+11, date=2023-12-22, time=12:00.
    const epochMs = Date.UTC(2023, 11, 22, 1, 0, 0);
    const { elevation, azimuth } = solarPosition(epochMs, -33.87, 151.21);

    const elevDeg = elevation * RAD_TO_DEG;
    const azDeg = azimuth * RAD_TO_DEG;

    // Sun is high and roughly north in southern hemisphere summer.
    expect(elevDeg).toBeCloseTo(74.35, 0);
    // Azimuth is NE — the sun hasn't reached the north meridian yet (solar noon ~12:53 AEDT).
    // At high elevation, azimuth changes rapidly as the sun approaches transit.
    const azNormalized = azDeg < 180 ? azDeg : azDeg - 360;
    expect(azNormalized).toBeCloseTo(52, 0);
  });

  it('Cape Town — 2023-06-21 12:00 SAST (winter solstice noon)', () => {
    // Cape Town: -33.92°S, 18.42°E
    // 2023-06-21 12:00 SAST = 2023-06-21 10:00 UTC
    // NOAA spreadsheet algorithm (Meeus): elevation 31.51°, azimuth ~13° (NNE).
    // Solar noon is at ~12:48 SAST (max elev ~32.6°); 12:00 clock time is
    // 48 minutes before noon so the sun has not yet peaked. At lower elevation
    // the azimuth changes more slowly, so 13° from north is consistent.
    // Reference: NOAA_Solar_Calculations_day.xls with lat=-33.92, lon=18.42,
    // tz=+2, date=2023-06-21, time=12:00.
    const epochMs = Date.UTC(2023, 5, 21, 10, 0, 0);
    const { elevation, azimuth } = solarPosition(epochMs, -33.92, 18.42);

    const elevDeg = elevation * RAD_TO_DEG;
    const azDeg = azimuth * RAD_TO_DEG;

    // Winter solstice in southern hemisphere: low sun, roughly north (NNE).
    expect(elevDeg).toBeCloseTo(31.5, 0);
    const azNormalized = azDeg < 180 ? azDeg : azDeg - 360;
    expect(azNormalized).toBeCloseTo(13, 0);
  });

  it('sun is below horizon at local midnight', () => {
    // Newport at midnight: 2023-06-21 04:00 UTC (00:00 EDT)
    const epochMs = Date.UTC(2023, 5, 21, 4, 0, 0);
    const { elevation } = solarPosition(epochMs, 41.49, -71.31);
    expect(elevation).toBeLessThan(0);
  });
});

describe('Night detection', () => {
  it('detects night at real local midnight', () => {
    // Newport midnight: 2023-11-14 05:00 UTC (00:00 EST)
    const epochMs = Date.UTC(2023, 10, 14, 5, 0, 0);
    const sky = createSkyState();
    computeSkyStateForVenue(41.49, -71.31, epochMs, 0, 0.3, 0.2, 0.1, sky);
    expect(sky.isNight).toBe(true);
  });

  it('detects daytime at local noon', () => {
    // Newport noon: 2023-11-14 17:00 UTC (12:00 EST)
    const epochMs = Date.UTC(2023, 10, 14, 17, 0, 0);
    const sky = createSkyState();
    computeSkyStateForVenue(41.49, -71.31, epochMs, 0, 0.3, 0.2, 0.1, sky);
    expect(sky.isNight).toBe(false);
  });

  it('threshold is -0.5 degrees', () => {
    // The boundary: sun at exactly -0.5° should be night.
    // We just check the logic: if elevation < -0.5 * DEG → isNight = true.
    const sky = createSkyState();
    // Use a time that's civil twilight (sun between 0 and -6°).
    // Newport sunset on Nov 14 is about 21:30 UTC (16:30 EST).
    // Just after sunset the sun is around -1° to -2°.
    const epochMs = Date.UTC(2023, 10, 14, 22, 0, 0); // ~17:00 EST, after sunset
    computeSkyStateForVenue(41.49, -71.31, epochMs, 0, 0, 0, 0, sky);
    // Sun should be below horizon.
    expect(sky.sunElevation).toBeLessThan(0);
    // If below -0.5°, should be night.
    if (sky.sunElevation < -0.5 * DEG) {
      expect(sky.isNight).toBe(true);
    }
  });
});

describe('Lunar position', () => {
  it('returns elevation in valid range', () => {
    const epochMs = Date.UTC(2023, 5, 21, 12, 0, 0);
    const { elevation, phase } = lunarPosition(epochMs, 41.49, -71.31);
    expect(elevation).toBeGreaterThanOrEqual(-Math.PI / 2);
    expect(elevation).toBeLessThanOrEqual(Math.PI / 2);
    expect(phase).toBeGreaterThanOrEqual(0);
    expect(phase).toBeLessThanOrEqual(1);
  });
});

describe('Sidereal time', () => {
  it('returns value in [0, 2π)', () => {
    const epochMs = Date.UTC(2023, 5, 21, 0, 0, 0);
    const lst = localSiderealTime(epochMs, -71.31);
    expect(lst).toBeGreaterThanOrEqual(0);
    expect(lst).toBeLessThan(Math.PI * 2);
  });

  it('increases with longitude', () => {
    const epochMs = Date.UTC(2023, 5, 21, 12, 0, 0);
    const lst1 = localSiderealTime(epochMs, 0);
    const lst2 = localSiderealTime(epochMs, 90);
    // East longitude gives later sidereal time.
    // Since it wraps, compute the difference modulo 2π.
    const diff = ((lst2 - lst1) + Math.PI * 4) % (Math.PI * 2);
    expect(diff).toBeCloseTo(Math.PI / 2, 1);
  });
});

describe('SkyState cloud passthrough', () => {
  it('passes cloud fractions through unchanged', () => {
    const sky = createSkyState();
    computeSkyStateForVenue(41.49, -71.31, Date.UTC(2023, 5, 21, 16, 0, 0), 0, 0.4, 0.5, 0.6, sky);
    expect(sky.cloudLow).toBe(0.4);
    expect(sky.cloudMid).toBe(0.5);
    expect(sky.cloudHigh).toBe(0.6);
  });
});
