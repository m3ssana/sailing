/**
 * Sky state: solar position, lunar position, sidereal time, and cloud fractions.
 *
 * Solar position uses the NOAA Solar Position algorithm (based on Jean Meeus,
 * "Astronomical Algorithms") with equation of time and declination. Accuracy is
 * better than 0.5° for dates within ±50 years of J2000 — more than adequate
 * since we use it for real venues at real times.
 *
 * Lunar position uses a low-precision ephemeris accurate to ~1°, which is fine
 * for the visual moon disc and tidal phase indication.
 *
 * Local apparent sidereal time orients the star field at night.
 */

import type { Radians, SkyState } from '@/types';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const TWO_PI = Math.PI * 2;

// ----- Solar position (NOAA algorithm) -----

/**
 * Julian day number from Unix timestamp in milliseconds.
 * J2000.0 epoch is JD 2451545.0 = 2000-01-01 12:00:00 UTC.
 */
function julianDay(epochMs: number): number {
  return epochMs / 86400000 + 2440587.5;
}

function julianCentury(jd: number): number {
  return (jd - 2451545.0) / 36525.0;
}

/** Geometric mean longitude of the sun, degrees. */
function sunGeomMeanLon(T: number): number {
  return (280.46646 + T * (36000.76983 + 0.0003032 * T)) % 360;
}

/** Geometric mean anomaly of the sun, degrees. */
function sunGeomMeanAnomaly(T: number): number {
  return 357.52911 + T * (35999.05029 - 0.0001537 * T);
}

/** Eccentricity of Earth's orbit. */
function earthOrbitEccentricity(T: number): number {
  return 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
}

/** Sun equation of center, degrees. */
function sunEqOfCenter(T: number): number {
  const M = sunGeomMeanAnomaly(T) * DEG;
  return (
    Math.sin(M) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * M) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * M) * 0.000289
  );
}

/** Sun true longitude, degrees. */
function sunTrueLon(T: number): number {
  return sunGeomMeanLon(T) + sunEqOfCenter(T);
}

/** Sun apparent longitude, degrees (corrected for nutation and aberration). */
function sunApparentLon(T: number): number {
  const omega = 125.04 - 1934.136 * T;
  return sunTrueLon(T) - 0.00569 - 0.00478 * Math.sin(omega * DEG);
}

/** Mean obliquity of the ecliptic, degrees. */
function meanObliquityOfEcliptic(T: number): number {
  return 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
}

/** Corrected obliquity of the ecliptic, degrees. */
function obliquityCorrection(T: number): number {
  const omega = 125.04 - 1934.136 * T;
  return meanObliquityOfEcliptic(T) + 0.00256 * Math.cos(omega * DEG);
}

/** Solar declination, radians. */
function solarDeclination(T: number): Radians {
  const obliq = obliquityCorrection(T) * DEG;
  const appLon = sunApparentLon(T) * DEG;
  return Math.asin(Math.sin(obliq) * Math.sin(appLon));
}

/** Equation of time, minutes. */
function equationOfTime(T: number): number {
  const obliq = obliquityCorrection(T) * DEG;
  const L0 = sunGeomMeanLon(T) * DEG;
  const e = earthOrbitEccentricity(T);
  const M = sunGeomMeanAnomaly(T) * DEG;

  let y = Math.tan(obliq / 2);
  y *= y;

  const eot =
    y * Math.sin(2 * L0) -
    2 * e * Math.sin(M) +
    4 * e * y * Math.sin(M) * Math.cos(2 * L0) -
    0.5 * y * y * Math.sin(4 * L0) -
    1.25 * e * e * Math.sin(2 * M);

  return eot * 4 * RAD; // Convert radians to minutes.
}

/**
 * Compute solar elevation and azimuth.
 *
 * @param epochMs Unix timestamp in milliseconds.
 * @param latitude Degrees north.
 * @param longitude Degrees east.
 * @returns { elevation, azimuth } in radians. Azimuth is clockwise from north.
 */
export function solarPosition(
  epochMs: number,
  latitude: number,
  longitude: number,
): { elevation: Radians; azimuth: Radians } {
  const jd = julianDay(epochMs);
  const T = julianCentury(jd);

  const declination = solarDeclination(T);
  const eot = equationOfTime(T);

  // Solar time in minutes from midnight UTC.
  const utcMinutes = ((epochMs % 86400000) / 60000);
  // True solar time at the given longitude.
  const trueSolarTime = ((utcMinutes + eot + 4 * longitude) % 1440);

  // Hour angle.
  const hourAngle = (trueSolarTime / 4 - 180) * DEG;

  const latRad = latitude * DEG;
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinDec = Math.sin(declination);
  const cosDec = Math.cos(declination);

  // Solar elevation.
  const sinElev = sinLat * sinDec + cosLat * cosDec * Math.cos(hourAngle);
  const elevation = Math.asin(sinElev);

  // Solar azimuth (measured clockwise from north).
  const cosElev = Math.cos(elevation);
  let azimuth: number;
  if (cosElev === 0) {
    azimuth = 0;
  } else {
    const cosAz = (sinDec - sinLat * sinElev) / (cosLat * cosElev);
    const clampedCosAz = cosAz < -1 ? -1 : cosAz > 1 ? 1 : cosAz;
    azimuth = Math.acos(clampedCosAz);
    if (hourAngle > 0) {
      azimuth = TWO_PI - azimuth;
    }
  }

  return { elevation, azimuth };
}

// ----- Lunar position (low-precision ephemeris) -----

/**
 * Low-precision lunar position. Accuracy ~1° in ecliptic longitude, which
 * is adequate for the visual moon and phase calculation.
 *
 * Based on Meeus ch. 47 simplified.
 */
export function lunarPosition(
  epochMs: number,
  latitude: number,
  longitude: number,
): { elevation: Radians; azimuth: Radians; phase: number } {
  const jd = julianDay(epochMs);
  const T = julianCentury(jd);

  // Mean elements (degrees).
  const Lp = (218.3165 + 481267.8813 * T) % 360; // Mean longitude.
  const D = (297.8502 + 445267.1115 * T) % 360; // Mean elongation.
  const M = (357.5291 + 35999.0503 * T) % 360; // Sun mean anomaly.
  const Mp = (134.9634 + 477198.8676 * T) % 360; // Moon mean anomaly.
  const F = (93.2720 + 483202.0175 * T) % 360; // Argument of latitude.

  // Ecliptic longitude (simplified, ~1° accuracy).
  const lon =
    Lp +
    6.289 * Math.sin(Mp * DEG) +
    1.274 * Math.sin((2 * D - Mp) * DEG) +
    0.658 * Math.sin(2 * D * DEG) +
    0.214 * Math.sin(2 * Mp * DEG) -
    0.186 * Math.sin(M * DEG) -
    0.114 * Math.sin(2 * F * DEG);

  // Ecliptic latitude (simplified).
  const lat =
    5.128 * Math.sin(F * DEG) +
    0.281 * Math.sin((Mp + F) * DEG) +
    0.278 * Math.sin((Mp - F) * DEG);

  // Convert ecliptic to equatorial.
  const obliq = meanObliquityOfEcliptic(T) * DEG;
  const lonRad = lon * DEG;
  const latRad = lat * DEG;

  const sinLon = Math.sin(lonRad);
  const cosLon = Math.cos(lonRad);
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinObliq = Math.sin(obliq);
  const cosObliq = Math.cos(obliq);

  // Right ascension and declination.
  const ra = Math.atan2(sinLon * cosObliq - Math.tan(latRad) * sinObliq, cosLon);
  const dec = Math.asin(sinLat * cosObliq + cosLat * sinObliq * sinLon);

  // Hour angle.
  const gmst = greenwichMeanSiderealTime(jd);
  const lst = gmst + longitude * DEG;
  const ha = lst - ra;

  // Horizontal coordinates.
  const obsLat = latitude * DEG;
  const sinObsLat = Math.sin(obsLat);
  const cosObsLat = Math.cos(obsLat);
  const sinDec = Math.sin(dec);
  const cosDec = Math.cos(dec);

  const sinElev = sinObsLat * sinDec + cosObsLat * cosDec * Math.cos(ha);
  const elevation = Math.asin(sinElev);

  const cosElev = Math.cos(elevation);
  let azimuth: number;
  if (cosElev === 0) {
    azimuth = 0;
  } else {
    const cosAz = (sinDec - sinObsLat * sinElev) / (cosObsLat * cosElev);
    const clampedCosAz = cosAz < -1 ? -1 : cosAz > 1 ? 1 : cosAz;
    azimuth = Math.acos(clampedCosAz);
    if (Math.sin(ha) > 0) {
      azimuth = TWO_PI - azimuth;
    }
  }

  // Phase: illuminated fraction using the elongation angle.
  // Phase angle i: cos(i) ≈ -cos(D) for the simplified model.
  const elongation = D * DEG;
  const phaseAngle = Math.acos(
    Math.cos(elongation) * Math.cos(latRad) // Simplified
  );
  const illuminatedFraction = (1 - Math.cos(phaseAngle)) / 2;

  return { elevation, azimuth, phase: illuminatedFraction };
}

// ----- Sidereal time -----

/** Greenwich mean sidereal time, radians. */
function greenwichMeanSiderealTime(jd: number): Radians {
  const T = julianCentury(jd);
  // Degrees, then convert to radians.
  const gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0) +
    0.000387933 * T * T - T * T * T / 38710000;
  return ((gmst % 360 + 360) % 360) * DEG;
}

/**
 * Local apparent sidereal time for star field orientation.
 */
export function localSiderealTime(epochMs: number, longitude: number): Radians {
  const jd = julianDay(epochMs);
  const gmst = greenwichMeanSiderealTime(jd);
  // Add observer longitude (east positive).
  const lst = gmst + longitude * DEG;
  return ((lst % TWO_PI) + TWO_PI) % TWO_PI;
}

/**
 * Create a fresh SkyState object (used for initial allocation).
 */
export function createSkyState(): SkyState {
  return {
    sunDirection: { x: 0, y: 1, z: 0 },
    sunElevation: 0,
    sunAzimuth: 0,
    moonDirection: { x: 0, y: 0, z: 1 },
    moonElevation: 0,
    moonPhase: 0,
    siderealTime: 0,
    cloudLow: 0,
    cloudMid: 0,
    cloudHigh: 0,
    isNight: false,
  };
}

/**
 * Compute sky state given explicit venue coordinates.
 * This is the primary entry point used by Environment.
 */
export function computeSkyStateForVenue(
  latitude: number,
  longitude: number,
  fetchedAtEpochMs: number,
  sessionTime: number,
  cloudLow: number,
  cloudMid: number,
  cloudHigh: number,
  out: SkyState,
): SkyState {
  const epochMs = fetchedAtEpochMs + sessionTime * 1000;

  // Solar position.
  const sun = solarPosition(epochMs, latitude, longitude);
  out.sunElevation = sun.elevation;
  out.sunAzimuth = sun.azimuth;

  const cosElev = Math.cos(sun.elevation);
  out.sunDirection.x = Math.sin(sun.azimuth) * cosElev;
  out.sunDirection.y = Math.sin(sun.elevation);
  out.sunDirection.z = -Math.cos(sun.azimuth) * cosElev;

  // Lunar position.
  const moon = lunarPosition(epochMs, latitude, longitude);
  out.moonElevation = moon.elevation;
  out.moonPhase = moon.phase;

  const moonCosElev = Math.cos(moon.elevation);
  out.moonDirection.x = Math.sin(moon.azimuth) * moonCosElev;
  out.moonDirection.y = Math.sin(moon.elevation);
  out.moonDirection.z = -Math.cos(moon.azimuth) * moonCosElev;

  out.siderealTime = localSiderealTime(epochMs, longitude);

  out.cloudLow = cloudLow;
  out.cloudMid = cloudMid;
  out.cloudHigh = cloudHigh;

  out.isNight = sun.elevation < -0.5 * DEG;

  return out;
}
