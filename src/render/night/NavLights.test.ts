import { describe, it, expect } from 'vitest';
import {
  makeNavLight,
  isBearingInArc,
  relativeBearing,
  isLightVisible,
  navLightConfigFor,
  visibleNavLights,
  navLightLayout,
  wrapAngle,
  type NavLight,
  type NavLightKind,
} from './NavLights';
import type { Vec2 } from '@/types';

const DEG = Math.PI / 180;

// ─── Arc membership at boundary angles ─────────────────────────────────────

describe('isBearingInArc — masthead (±112.5°)', () => {
  const m = makeNavLight('masthead');
  it('visible dead ahead (0°)', () => expect(isBearingInArc(m, 0)).toBe(true));
  it('visible at +90°', () => expect(isBearingInArc(m, 90 * DEG)).toBe(true));
  it('visible exactly at +112.5° (inclusive boundary)', () =>
    expect(isBearingInArc(m, 112.5 * DEG)).toBe(true));
  it('NOT visible just past 112.5° (113°)', () =>
    expect(isBearingInArc(m, 113 * DEG)).toBe(false));
  it('NOT visible dead astern (180°)', () =>
    expect(isBearingInArc(m, 180 * DEG)).toBe(false));
  it('symmetric on the port side (-112.5°)', () =>
    expect(isBearingInArc(m, -112.5 * DEG)).toBe(true));
});

describe('isBearingInArc — starboard sidelight (0°..+112.5°)', () => {
  const s = makeNavLight('sidelightStarboard');
  it('visible dead ahead (0°, inclusive)', () => expect(isBearingInArc(s, 0)).toBe(true));
  it('visible at +22.5°', () => expect(isBearingInArc(s, 22.5 * DEG)).toBe(true));
  it('visible on the starboard beam (+90°)', () => expect(isBearingInArc(s, 90 * DEG)).toBe(true));
  it('visible at +112.5° (22.5° abaft the beam, inclusive)', () =>
    expect(isBearingInArc(s, 112.5 * DEG)).toBe(true));
  it('NOT visible past +112.5°', () => expect(isBearingInArc(s, 113 * DEG)).toBe(false));
  it('NOT visible on the port bow (-10°)', () => expect(isBearingInArc(s, -10 * DEG)).toBe(false));
});

describe('isBearingInArc — port sidelight (0°..-112.5°)', () => {
  const p = makeNavLight('sidelightPort');
  it('visible dead ahead (0°)', () => expect(isBearingInArc(p, 0)).toBe(true));
  it('visible on the port beam (-90°)', () => expect(isBearingInArc(p, -90 * DEG)).toBe(true));
  it('visible at -112.5° (inclusive)', () => expect(isBearingInArc(p, -112.5 * DEG)).toBe(true));
  it('NOT visible on the starboard bow (+10°)', () => expect(isBearingInArc(p, 10 * DEG)).toBe(false));
});

describe('isBearingInArc — sternlight (±67.5° about astern)', () => {
  const st = makeNavLight('sternlight');
  it('visible dead astern (180°)', () => expect(isBearingInArc(st, 180 * DEG)).toBe(true));
  it('visible at 112.5° (the stern/sidelight crossover, inclusive)', () =>
    expect(isBearingInArc(st, 112.5 * DEG)).toBe(true));
  it('NOT visible at +90° (abeam)', () => expect(isBearingInArc(st, 90 * DEG)).toBe(false));
  it('NOT visible dead ahead (0°)', () => expect(isBearingInArc(st, 0)).toBe(false));
});

describe('isBearingInArc — all-round (360°)', () => {
  const a = makeNavLight('allRound');
  it('visible from every bearing', () => {
    for (let deg = -180; deg <= 180; deg += 15) {
      expect(isBearingInArc(a, deg * DEG)).toBe(true);
    }
  });
});

describe('wrapAngle', () => {
  it('wraps into (-π, π]', () => {
    expect(wrapAngle(0)).toBeCloseTo(0);
    expect(wrapAngle(Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(1.5 * Math.PI)).toBeCloseTo(-0.5 * Math.PI, 6);
    expect(wrapAngle(-1.5 * Math.PI)).toBeCloseTo(0.5 * Math.PI, 6);
  });
});

// ─── relativeBearing world-frame correctness ────────────────────────────────

describe('relativeBearing', () => {
  // Vessel heading north (0): bow = -Z (north), starboard = +X (east).
  it('observer dead ahead (north) → bearing 0', () => {
    const b = relativeBearing(0, { x: 0, y: 0 }, { x: 0, y: -10 }); // -Z = north
    expect(b).toBeCloseTo(0, 6);
  });
  it('observer to the east → +90° (starboard beam) for a north-heading vessel', () => {
    const b = relativeBearing(0, { x: 0, y: 0 }, { x: 10, y: 0 }); // +X = east
    expect(b).toBeCloseTo(Math.PI / 2, 6);
  });
  it('observer to the south → ±180° (astern)', () => {
    const b = relativeBearing(0, { x: 0, y: 0 }, { x: 0, y: 10 }); // +Z = south
    expect(Math.abs(b)).toBeCloseTo(Math.PI, 6);
  });
  it('observer to the west → -90° (port beam)', () => {
    const b = relativeBearing(0, { x: 0, y: 0 }, { x: -10, y: 0 });
    expect(b).toBeCloseTo(-Math.PI / 2, 6);
  });
});

describe('isLightVisible — end-to-end', () => {
  it('starboard sidelight is visible to an observer on the starboard beam', () => {
    const stbd = makeNavLight('sidelightStarboard');
    // North-heading vessel, observer due east (starboard beam).
    expect(isLightVisible(stbd, 0, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(true);
    // Observer due west (port beam) must NOT see the starboard light.
    expect(isLightVisible(stbd, 0, { x: 0, y: 0 }, { x: -10, y: 0 })).toBe(false);
  });
});

// ─── Classic COLREGs cases, tested across several headings (rotation invariance) ──

/** Place an observer at a given relative bearing from a vessel at the origin. */
function observerAtRelativeBearing(heading: number, relBearing: number, dist = 100): Vec2 {
  // World direction at absolute bearing (heading + relBearing), clockwise from N.
  const abs = heading + relBearing;
  return { x: Math.sin(abs) * dist, y: -Math.cos(abs) * dist };
}

function kindsVisible(
  config: ReturnType<typeof navLightConfigFor>,
  heading: number,
  observer: Vec2,
): Set<NavLightKind> {
  const vis = visibleNavLights(config, heading, { x: 0, y: 0 }, observer);
  return new Set(vis.map((l) => l.kind));
}

const HEADINGS = [0, 30 * DEG, 90 * DEG, 180 * DEG, 245 * DEG, 359 * DEG];

describe('COLREGs classic cases — power-driven vessel (rotation invariant)', () => {
  const config = navLightConfigFor('powerDriven');

  for (const h of HEADINGS) {
    it(`bow-on sees red AND green + masthead (heading ${(h / DEG).toFixed(0)}°)`, () => {
      const obs = observerAtRelativeBearing(h, 0);
      const k = kindsVisible(config, h, obs);
      expect(k.has('sidelightStarboard')).toBe(true);
      expect(k.has('sidelightPort')).toBe(true);
      expect(k.has('masthead')).toBe(true);
      expect(k.has('sternlight')).toBe(false);
    });

    it(`abeam to starboard sees green only + masthead, no stern (heading ${(h / DEG).toFixed(0)}°)`, () => {
      const obs = observerAtRelativeBearing(h, 90 * DEG);
      const k = kindsVisible(config, h, obs);
      expect(k.has('sidelightStarboard')).toBe(true);
      expect(k.has('sidelightPort')).toBe(false);
      expect(k.has('masthead')).toBe(true);
      expect(k.has('sternlight')).toBe(false);
    });

    it(`abeam to port sees red only (heading ${(h / DEG).toFixed(0)}°)`, () => {
      const obs = observerAtRelativeBearing(h, -90 * DEG);
      const k = kindsVisible(config, h, obs);
      expect(k.has('sidelightPort')).toBe(true);
      expect(k.has('sidelightStarboard')).toBe(false);
      expect(k.has('masthead')).toBe(true);
      expect(k.has('sternlight')).toBe(false);
    });

    it(`dead astern sees white stern light only (heading ${(h / DEG).toFixed(0)}°)`, () => {
      const obs = observerAtRelativeBearing(h, 180 * DEG);
      const k = kindsVisible(config, h, obs);
      expect(k.has('sternlight')).toBe(true);
      expect(k.has('sidelightStarboard')).toBe(false);
      expect(k.has('sidelightPort')).toBe(false);
      expect(k.has('masthead')).toBe(false);
    });
  }
});

describe('COLREGs classic cases — anchored vessel', () => {
  const config = navLightConfigFor('anchored');
  for (const h of HEADINGS) {
    for (const rel of [0, 45 * DEG, 90 * DEG, 180 * DEG, -120 * DEG]) {
      it(`shows only all-round white (heading ${(h / DEG).toFixed(0)}°, rel ${(rel / DEG).toFixed(0)}°)`, () => {
        const obs = observerAtRelativeBearing(h, rel);
        const k = kindsVisible(config, h, obs);
        expect(k.size).toBe(1);
        expect(k.has('allRound')).toBe(true);
      });
    }
  }
});

describe('COLREGs — sailing vessel has no masthead', () => {
  const config = navLightConfigFor('sailing');
  it('bow-on sees red + green + stern-? but never masthead', () => {
    const obs = observerAtRelativeBearing(0, 0);
    const k = kindsVisible(config, 0, obs);
    expect(k.has('masthead')).toBe(false);
    expect(k.has('sidelightStarboard')).toBe(true);
    expect(k.has('sidelightPort')).toBe(true);
  });
});

// ─── Config mapping for TrafficSpec kinds ───────────────────────────────────

describe('navLightConfigFor — TrafficSpec kind mapping', () => {
  const powerKinds = ['ferry', 'containerShip', 'hovercraft', 'fishingBoat', 'tug'] as const;
  for (const kind of powerKinds) {
    it(`${kind} → power-driven set (masthead + sides + stern)`, () => {
      const c = navLightConfigFor(kind);
      expect(c.mode).toBe('powerDriven');
      const kinds = new Set(c.lights.map((l) => l.kind));
      expect(kinds.has('masthead')).toBe(true);
      expect(kinds.has('sidelightStarboard')).toBe(true);
      expect(kinds.has('sidelightPort')).toBe(true);
      expect(kinds.has('sternlight')).toBe(true);
    });
  }

  it('yacht → sailing set (no masthead)', () => {
    const c = navLightConfigFor('yacht');
    expect(c.mode).toBe('sailing');
    expect(c.lights.some((l) => l.kind === 'masthead')).toBe(false);
  });

  it('sailing with tricolour flag mounts the three arcs', () => {
    const c = navLightConfigFor('sailing', true);
    expect(c.tricolour).toBe(true);
    expect(c.lights.length).toBe(3);
  });
});

// ─── Layout ─────────────────────────────────────────────────────────────────

describe('navLightLayout', () => {
  it('places lights in vessel-local coords (+Z bow, +X starboard, +Y up)', () => {
    const config = navLightConfigFor('powerDriven');
    const laid = navLightLayout(12, 8, config);
    const byKind = (k: NavLightKind): NavLight | undefined => laid.find((l) => l.kind === k);

    const stbd = byKind('sidelightStarboard');
    const port = byKind('sidelightPort');
    const stern = byKind('sternlight');
    const mast = byKind('masthead');

    expect(stbd?.position?.x).toBeGreaterThan(0); // starboard = +X
    expect(port?.position?.x).toBeLessThan(0); // port = -X
    expect(stern?.position?.z).toBeLessThan(0); // stern = -Z (aft)
    expect(mast?.position?.y).toBeGreaterThan(0); // masthead up
  });

  it('scales with hull length', () => {
    const config = navLightConfigFor('powerDriven');
    const small = navLightLayout(8, 6, config).find((l) => l.kind === 'sternlight');
    const big = navLightLayout(80, 30, config).find((l) => l.kind === 'sternlight');
    expect(Math.abs(big?.position?.z ?? 0)).toBeGreaterThan(Math.abs(small?.position?.z ?? 0));
  });
});
