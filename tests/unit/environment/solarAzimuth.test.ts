import { describe, it, expect } from 'vitest';
import { solarPosition } from '@environment/SkyState';

const RAD_TO_DEG = 180 / Math.PI;

/**
 * Regression: azimuth was mirrored whenever (utcMinutes + eot + 4*lon) went
 * negative (western longitudes around 00:00-06:00 UTC), because JS `%` keeps
 * the dividend's sign. Physical law used as the reference (no external data
 * needed): the sun is in the east (az in (0,180)) before local apparent solar
 * noon and in the west (az in (180,360)) after it, and its azimuth at hour
 * angle +h is the mirror 360 - az at hour angle -h.
 */
describe('Solar azimuth hemisphere (regression: negative modulo)', () => {
  const venues: Array<[string, number, number]> = [
    ['Newport', 41.49, -71.31],
    ['San Francisco', 37.81, -122.42],
    ['Sydney', -33.87, 151.21],
    ['Solent', 50.77, -1.3],
    ['Auckland', -36.84, 174.77],
  ];

  it.each(venues)('%s: east of meridian in the morning, west in the afternoon, all 24 UTC hours', (_n, lat, lon) => {
    for (let h = 0; h < 24; h += 1) {
      const epochMs = Date.UTC(2023, 2, 20, h, 0, 0); // near equinox, sun rises/sets on both sides
      const { elevation, azimuth } = solarPosition(epochMs, lat, lon);
      if (elevation < 5 / RAD_TO_DEG) continue;
      // Local mean solar hour (0..24); equation of time is < 0.3 h, so skip +-0.6 h around noon.
      const localHour = (((h + lon / 15) % 24) + 24) % 24;
      if (Math.abs(localHour - 12) < 0.6) continue;
      const az = azimuth * RAD_TO_DEG;
      if (localHour < 12) {
        expect(az, `utc ${h}h local ${localHour.toFixed(1)}`).toBeLessThan(180);
      } else {
        expect(az, `utc ${h}h local ${localHour.toFixed(1)}`).toBeGreaterThan(180);
      }
    }
  });

  it('Newport near sunset (00:00 UTC, 2023-06-21) is in the west-north-west, not the east', () => {
    // Local solar time ~19:15; sun elevation ~2.7 deg, azimuth ~290 deg (WNW at the June solstice).
    const { elevation, azimuth } = solarPosition(Date.UTC(2023, 5, 21, 0, 0, 0), 41.49, -71.31);
    expect(elevation * RAD_TO_DEG).toBeCloseTo(2.7, 0);
    expect(azimuth * RAD_TO_DEG).toBeGreaterThan(270);
    expect(azimuth * RAD_TO_DEG).toBeLessThan(310);
  });
});
