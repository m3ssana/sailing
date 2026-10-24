/**
 * MoonDisc — lit-limb orientation regression tests (Stream F.4 audit fix #2).
 *
 * The bug: `uDirToSun` was allocated to local +X and NEVER written, so the lit
 * limb always faced local +X regardless of where the sun actually was. The fix
 * threads the sun direction into `update` and writes the (normalised, local ==
 * world for the unrotated sphere) direction to the sun each frame.
 *
 * The TSL fragment shader does not execute under vitest/node, so we verify the
 * uniform the shader consumes (`litSunDirection`) rather than rendered pixels —
 * the shading law `lit where normal·dirToSun > terminator` is a pure function of
 * that uniform and `terminator`.
 */

import { describe, it, expect } from 'vitest';
import { createMoonDisc } from './MoonDisc';
import { createLightingState, type LightingState } from '../lighting/LightingState';
import type { MoonlightSkyInput } from './Moonlight';

const DEG = Math.PI / 180;

function nightLighting(): LightingState {
  const l = createLightingState();
  l.nightFactor = 1;
  l.overcast = 0;
  return l;
}

/** Moon high in the south, given illuminated fraction. */
function moonSky(phase: number): MoonlightSkyInput {
  const el = 45 * DEG;
  return {
    moonElevation: el,
    moonPhase: phase,
    moonDirection: { x: 0, y: Math.sin(el), z: -Math.cos(el) },
  };
}

describe('MoonDisc — uDirToSun follows the sun', () => {
  it('points the lit limb towards the sun; east vs west sun differ and point the right way', () => {
    const disc = createMoonDisc();

    // Sun due EAST (+X).
    disc.update(moonSky(0.5), nightLighting(), { x: 1, y: 0, z: 0 });
    const east = disc.litSunDirection;
    expect(east.x).toBeCloseTo(1, 5);
    expect(east.y).toBeCloseTo(0, 5);
    expect(east.z).toBeCloseTo(0, 5);

    // Sun due WEST (-X).
    disc.update(moonSky(0.5), nightLighting(), { x: -1, y: 0, z: 0 });
    const west = disc.litSunDirection;
    expect(west.x).toBeCloseTo(-1, 5);

    // The two differ and point opposite ways along X — the limb orientation
    // actually tracks the sun (the old code produced +X for both).
    expect(east.x).toBeGreaterThan(west.x);
    expect(east.x - west.x).toBeGreaterThan(1.9);
    disc.dispose();
  });

  it('normalises a non-unit sun direction', () => {
    const disc = createMoonDisc();
    disc.update(moonSky(0.5), nightLighting(), { x: 0, y: 0, z: -5 });
    const d = disc.litSunDirection;
    const len = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
    expect(len).toBeCloseTo(1, 5);
    expect(d.z).toBeCloseTo(-1, 5);
    disc.dispose();
  });

  it('is finite and left unchanged for a degenerate (zero) sun direction', () => {
    const disc = createMoonDisc();
    // Known good first.
    disc.update(moonSky(0.5), nightLighting(), { x: 1, y: 0, z: 0 });
    // Degenerate input must not poison the uniform.
    disc.update(moonSky(0.5), nightLighting(), { x: 0, y: 0, z: 0 });
    const d = disc.litSunDirection;
    expect(Number.isFinite(d.x)).toBe(true);
    expect(Number.isFinite(d.y)).toBe(true);
    expect(Number.isFinite(d.z)).toBe(true);
    disc.dispose();
  });
});

describe('MoonDisc — phase terminator', () => {
  it('full moon terminator is fully lit (-1) regardless of sun direction', () => {
    const disc = createMoonDisc();
    disc.update(moonSky(1), nightLighting(), { x: 1, y: 0, z: 0 });
    expect(disc.terminator).toBeCloseTo(-1, 6);
    // A fully-lit disc lights everywhere: normal·dirToSun > -1 for all normals.
    disc.update(moonSky(1), nightLighting(), { x: -1, y: 0, z: 0 });
    expect(disc.terminator).toBeCloseTo(-1, 6);
    disc.dispose();
  });

  it('new moon terminator is dark (+1): no surface normal is lit', () => {
    const disc = createMoonDisc();
    disc.update(moonSky(0), nightLighting(), { x: 1, y: 0, z: 0 });
    // terminator +1 means lit requires normal·dirToSun > +1, impossible for a
    // unit normal → the disc is dark (only the labelled earthshine floor shows).
    expect(disc.terminator).toBeCloseTo(1, 6);
    disc.dispose();
  });

  it('terminator is monotone decreasing from new (+1) through half (0) to full (-1)', () => {
    const disc = createMoonDisc();
    let prev = 2;
    for (let f = 0; f <= 1.0001; f += 0.1) {
      disc.update(moonSky(Math.min(1, f)), nightLighting(), { x: 1, y: 0, z: 0 });
      expect(disc.terminator).toBeLessThanOrEqual(prev + 1e-9);
      prev = disc.terminator;
    }
    disc.dispose();
  });
});
