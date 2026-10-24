/**
 * Tests for AtmosphereModel (F.1) — the CPU Rayleigh+Mie sky reference.
 */

import { describe, it, expect } from 'vitest';
import {
  skyRadiance,
  sunDiscRadiance,
  rayleighPhase,
  miePhase,
  createAtmosphereParams,
  SUN_ANGULAR_RADIUS,
  SUN_DISC_RENDER_RADIUS,
  type AtmosphereParams,
} from './AtmosphereModel';
import type { Vec3 } from '@/types';

const DEG = Math.PI / 180;

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}
function dirFromElevAz(elevDeg: number, azDeg: number): Vec3 {
  const e = elevDeg * DEG;
  const a = azDeg * DEG;
  const c = Math.cos(e);
  return { x: Math.sin(a) * c, y: Math.sin(e), z: -Math.cos(a) * c };
}

function finite(c: { r: number; g: number; b: number }): boolean {
  return Number.isFinite(c.r) && Number.isFinite(c.g) && Number.isFinite(c.b);
}

// ─── Phase functions ─────────────────────────────────────────────────────────

describe('phase functions', () => {
  it('Rayleigh phase is symmetric and peaks forward/backward', () => {
    expect(rayleighPhase(1)).toBeCloseTo(rayleighPhase(-1), 10);
    expect(rayleighPhase(1)).toBeGreaterThan(rayleighPhase(0));
  });

  it('Mie phase is strongly forward-peaked (g>0)', () => {
    expect(miePhase(1)).toBeGreaterThan(miePhase(0));
    expect(miePhase(0)).toBeGreaterThan(miePhase(-1));
    expect(miePhase(1)).toBeGreaterThan(miePhase(-1) * 5);
  });

  it('phase functions are finite for all mu in [-1,1]', () => {
    for (let mu = -1; mu <= 1; mu += 0.05) {
      expect(Number.isFinite(rayleighPhase(mu))).toBe(true);
      expect(Number.isFinite(miePhase(mu))).toBe(true);
      expect(miePhase(mu)).toBeGreaterThan(0);
    }
  });
});

// ─── skyRadiance ─────────────────────────────────────────────────────────────

describe('skyRadiance', () => {
  const sunDir = norm(dirFromElevAz(30, 180)); // sun in the south, 30° up
  const params: AtmosphereParams = createAtmosphereParams();
  params.sunDir = sunDir;

  it('zenith is blue-dominant (Rayleigh)', () => {
    const z = skyRadiance({ x: 0, y: 1, z: 0 }, sunDir, params);
    expect(finite(z)).toBe(true);
    expect(z.b).toBeGreaterThan(z.r);
  });

  it('horizon is brighter and whiter than zenith', () => {
    const z = skyRadiance({ x: 0, y: 1, z: 0 }, sunDir, params);
    // Horizon direction away from the sun.
    const h = skyRadiance(norm({ x: 1, y: 0.02, z: 0 }), sunDir, params);
    const lum = (c: { r: number; g: number; b: number }) => c.r + c.g + c.b;
    expect(lum(h)).toBeGreaterThan(lum(z));
    // Whiter: blue fraction of total is lower at the horizon.
    const blueFracZ = z.b / Math.max(lum(z), 1e-9);
    const blueFracH = h.b / Math.max(lum(h), 1e-9);
    expect(blueFracH).toBeLessThan(blueFracZ);
  });

  it('forward-scatter glow is brighter near the sun than 90° away', () => {
    // A view direction 5° off the sun vs 90° off.
    const near = norm(dirFromElevAz(30, 185));
    const far = norm(dirFromElevAz(30, 90));
    const lumNear = sum(skyRadiance(near, sunDir, params));
    const lumFar = sum(skyRadiance(far, sunDir, params));
    expect(lumNear).toBeGreaterThan(lumFar);
  });

  it('is finite everywhere including at/below the horizon', () => {
    for (let elev = -90; elev <= 90; elev += 5) {
      for (let az = 0; az < 360; az += 30) {
        const v = norm(dirFromElevAz(elev, az));
        const c = skyRadiance(v, sunDir, params);
        expect(finite(c)).toBe(true);
        expect(c.r).toBeGreaterThanOrEqual(0);
        expect(c.g).toBeGreaterThanOrEqual(0);
        expect(c.b).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('overcast desaturates the zenith colour', () => {
    const clearZ = skyRadiance({ x: 0, y: 1, z: 0 }, sunDir, params);
    const overcastParams = { ...params, overcast: 1 };
    const greyZ = skyRadiance({ x: 0, y: 1, z: 0 }, sunDir, overcastParams);
    const chroma = (c: { r: number; g: number; b: number }) =>
      Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
    expect(chroma(greyZ)).toBeLessThan(chroma(clearZ));
  });
});

function sum(c: { r: number; g: number; b: number }): number {
  return c.r + c.g + c.b;
}

// ─── Sun disc ─────────────────────────────────────────────────────────────────

describe('sunDiscRadiance', () => {
  it('is 0 outside the disc and positive inside', () => {
    expect(sunDiscRadiance(SUN_DISC_RENDER_RADIUS * 1.1)).toBe(0);
    expect(sunDiscRadiance(0)).toBeGreaterThan(0);
  });

  it('limb-darkens: centre is brighter than near the edge', () => {
    const centre = sunDiscRadiance(0);
    const edge = sunDiscRadiance(SUN_DISC_RENDER_RADIUS * 0.9);
    expect(centre).toBeGreaterThan(edge);
  });

  it('render disc is a documented enlargement of the true disc', () => {
    expect(SUN_DISC_RENDER_RADIUS).toBeGreaterThan(SUN_ANGULAR_RADIUS);
    expect(SUN_DISC_RENDER_RADIUS).toBeCloseTo(SUN_ANGULAR_RADIUS * 3.5, 10);
  });
});
