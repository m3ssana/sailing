/**
 * NavLights — Stream F.4 (Night). COLREGs Rule 21/22 navigation-light geometry.
 *
 * PURE model (arc geometry, per-vessel configs, layout) with NO three.js, plus a
 * THIN three/TSL `createNavLightRig` that evaluates per-light arc visibility in
 * the fragment shader from the vessel-LOCAL camera direction (one uniform,
 * updated per frame) so arcs read correctly from every angle, for the player
 * boat and every ambient vessel alike.
 *
 * ## Vessel-local axes (explicit)
 *
 * Right-handed, matching the world convention:
 *   - `+Z_local` = BOW (dead ahead / forward)
 *   - `+X_local` = STARBOARD (right, looking forward)
 *   - `+Y_local` = UP
 *
 * A relative bearing is the clockwise angle from dead-ahead (+Z) as seen from
 * above: 0 = ahead, +π/2 = starboard beam, ±π = astern, -π/2 = port beam. This
 * matches a compass-style "clockwise from the bow" reading.
 *
 * ## COLREGs arcs (Rule 21)
 *
 *   - masthead  : white, 225° total, 112.5° each side of dead-ahead.
 *   - sidelight (stbd): green, from dead-ahead to 22.5° abaft the starboard beam
 *                 (0° .. +112.5°).
 *   - sidelight (port): red, from dead-ahead to 22.5° abaft the port beam
 *                 (0° .. -112.5°).
 *   - sternlight: white, 135° total centred dead-astern (±67.5° from astern).
 *   - all-round : white, 360°.
 *
 * These arcs are defined by half-angles about a CENTRE bearing; `isLightVisible`
 * tests membership. Boundary behaviour is INCLUSIVE at the limit angle (a light
 * is considered visible exactly at its cutoff) — see the boundary tests.
 */

import type { Vec2, Vec3 } from '@/types';

/** The five light arc kinds. */
export type NavLightKind =
  | 'masthead'
  | 'sidelightStarboard'
  | 'sidelightPort'
  | 'sternlight'
  | 'allRound';

/** Linear-RGB nav-light colours (the only emissive items besides shore windows). */
export const NAV_LIGHT_COLORS = {
  white: { r: 1.0, g: 0.95, b: 0.85 },
  green: { r: 0.0, g: 1.0, b: 0.25 },
  red: { r: 1.0, g: 0.05, b: 0.05 },
} as const satisfies Record<string, { r: number; g: number; b: number }>;

/** A single navigation light: its arc + colour + (filled by layout) position. */
export interface NavLight {
  kind: NavLightKind;
  /** Centre bearing of the arc, radians, clockwise from dead-ahead (+Z). */
  centreBearing: number;
  /** Half-angle of the arc, radians. Visible within ±halfAngle of the centre. */
  halfAngle: number;
  /** Light colour, linear RGB. */
  color: { r: number; g: number; b: number };
  /** Position in vessel-local coords (filled by `navLightLayout`). */
  position?: Vec3;
}

const HALF = Math.PI;
const DEG = Math.PI / 180;

/** Arc geometry for each kind (centre bearing + half angle). */
function arcFor(kind: NavLightKind): { centreBearing: number; halfAngle: number } {
  switch (kind) {
    case 'masthead':
      return { centreBearing: 0, halfAngle: 112.5 * DEG };
    case 'sidelightStarboard':
      // 0°..+112.5°: centre at +56.25°, half-angle 56.25°.
      return { centreBearing: 56.25 * DEG, halfAngle: 56.25 * DEG };
    case 'sidelightPort':
      return { centreBearing: -56.25 * DEG, halfAngle: 56.25 * DEG };
    case 'sternlight':
      // centred dead astern (±π), 135° total → half 67.5°.
      return { centreBearing: HALF, halfAngle: 67.5 * DEG };
    case 'allRound':
      return { centreBearing: 0, halfAngle: Math.PI };
  }
}

function colorFor(kind: NavLightKind): { r: number; g: number; b: number } {
  switch (kind) {
    case 'sidelightStarboard':
      return NAV_LIGHT_COLORS.green;
    case 'sidelightPort':
      return NAV_LIGHT_COLORS.red;
    case 'masthead':
    case 'sternlight':
    case 'allRound':
      return NAV_LIGHT_COLORS.white;
  }
}

/** Build a `NavLight` descriptor for a kind (position filled later by layout). */
export function makeNavLight(kind: NavLightKind): NavLight {
  const arc = arcFor(kind);
  return {
    kind,
    centreBearing: arc.centreBearing,
    halfAngle: arc.halfAngle,
    color: colorFor(kind),
  };
}

/** Wrap an angle to (-π, π]. */
export function wrapAngle(a: number): number {
  let x = a % (2 * Math.PI);
  if (x <= -Math.PI) x += 2 * Math.PI;
  if (x > Math.PI) x -= 2 * Math.PI;
  return x;
}

/**
 * Relative bearing (clockwise from the bow, radians) of `target` as seen from
 * `from`, for a vessel on `headingRad` (bow bearing clockwise from north).
 *
 * World: heading θ → bow direction `(sin θ, 0, -cos θ)`. The relative bearing of
 * a world direction is `atan2` in the vessel frame where +Z=bow, +X=starboard.
 */
export function relativeBearing(
  headingRad: number,
  from: Vec2,
  target: Vec2,
): number {
  const dx = target.x - from.x; // east
  const dz = target.y - from.y; // south (Vec2.y is the ground-plane south axis)
  // World bow/starboard basis.
  const bowX = Math.sin(headingRad);
  const bowZ = -Math.cos(headingRad);
  const stbdX = Math.cos(headingRad); // +90° CW from bow
  const stbdZ = Math.sin(headingRad);
  // Project the line-of-sight onto bow (+Z local) and starboard (+X local).
  const forward = dx * bowX + dz * bowZ;
  const starboard = dx * stbdX + dz * stbdZ;
  // Clockwise-from-bow bearing: 0 ahead, +π/2 starboard.
  return Math.atan2(starboard, forward);
}

/** Is a relative bearing within a light's arc (inclusive at the boundary)? */
export function isBearingInArc(light: NavLight, relBearingRad: number): boolean {
  if (light.halfAngle >= Math.PI) return true; // all-round
  const delta = Math.abs(wrapAngle(relBearingRad - light.centreBearing));
  // Inclusive boundary with a tiny epsilon to absorb float error at the limit.
  return delta <= light.halfAngle + 1e-9;
}

/**
 * Is a light visible to an observer? Combines the vessel heading and the two
 * world positions into a relative bearing, then tests arc membership.
 */
export function isLightVisible(
  light: NavLight,
  vesselHeadingRad: number,
  vesselPos: Vec2,
  observerPos: Vec2,
): boolean {
  const rel = relativeBearing(vesselHeadingRad, vesselPos, observerPos);
  return isBearingInArc(light, rel);
}

/** A vessel's complete nav-light configuration. */
export interface NavLightConfig {
  /** Human label for the display mode. */
  mode: 'powerDriven' | 'sailing' | 'anchored';
  /** The lights this vessel shows. */
  lights: NavLight[];
  /** Whether a sailing tricolour (single masthead unit) is used instead of
   *  separate deck-level sidelights+stern. Only meaningful for 'sailing'. */
  tricolour: boolean;
}

/** Display-mode selector used by `navLightConfigFor`. */
export type NavLightMode =
  | 'powerDriven'
  | 'sailing'
  | 'anchored'
  | 'ferry'
  | 'containerShip'
  | 'hovercraft'
  | 'fishingBoat'
  | 'tug'
  | 'yacht';

/**
 * Build the nav-light configuration for a vessel kind / mode.
 *
 * - `powerDriven`, `ferry`, `containerShip`, `hovercraft`, `fishingBoat`, `tug`:
 *   masthead + both sidelights + sternlight (the standard power-driven set;
 *   special fishing/tug all-round day shapes and extra lights are out of scope
 *   and labelled so).
 * - `sailing` / `yacht`: sidelights + sternlight, NO masthead (sailing vessels
 *   under sail show no masthead steaming light). `tricolour` optional.
 * - `anchored`: a single all-round white light only.
 *
 * Scope note (honest): this models the COMMON underway configuration and the
 * anchored all-round light. It does NOT model the full Rule 23–30 set (towing
 * lights, NUC/RAM lights, fishing-vessel all-round red-over-white, etc.). Those
 * are deliberately out of scope for the night ambience and are flagged here.
 */
export function navLightConfigFor(kind: NavLightMode, tricolour = false): NavLightConfig {
  if (kind === 'anchored') {
    return { mode: 'anchored', tricolour: false, lights: [makeNavLight('allRound')] };
  }

  if (kind === 'sailing' || kind === 'yacht') {
    if (tricolour) {
      // A tricolour combines both sidelights + stern into one masthead unit; we
      // still emit three arc descriptors (their geometry is identical), tagged
      // via `tricolour: true` so the rig can mount them at the masthead.
      return {
        mode: 'sailing',
        tricolour: true,
        lights: [
          makeNavLight('sidelightStarboard'),
          makeNavLight('sidelightPort'),
          makeNavLight('sternlight'),
        ],
      };
    }
    return {
      mode: 'sailing',
      tricolour: false,
      lights: [
        makeNavLight('sidelightStarboard'),
        makeNavLight('sidelightPort'),
        makeNavLight('sternlight'),
      ],
    };
  }

  // All power-driven kinds share the standard underway set.
  return {
    mode: 'powerDriven',
    tricolour: false,
    lights: [
      makeNavLight('masthead'),
      makeNavLight('sidelightStarboard'),
      makeNavLight('sidelightPort'),
      makeNavLight('sternlight'),
    ],
  };
}

/**
 * Which lights an observer actually sees, given a vessel's config, heading and
 * position relative to the observer.
 */
export function visibleNavLights(
  config: NavLightConfig,
  vesselHeadingRad: number,
  vesselPos: Vec2,
  observerPos: Vec2,
): NavLight[] {
  return config.lights.filter((l) =>
    isLightVisible(l, vesselHeadingRad, vesselPos, observerPos),
  );
}

/**
 * Place each light in vessel-local coordinates (+Z bow, +X starboard, +Y up).
 *
 * - masthead      : forward, high on the mast.
 * - sidelights    : at the shoulders (±X), slightly forward, low.
 * - sternlight    : at the stern (−Z), low.
 * - all-round     : at the masthead top (anchor light), on the centreline.
 *
 * @param lengthMetres Overall length; drives longitudinal placement.
 * @param mastHeightMetres Mast height; drives masthead/all-round height.
 */
export function navLightLayout(
  lengthMetres: number,
  mastHeightMetres: number,
  config: NavLightConfig,
): NavLight[] {
  const halfLen = lengthMetres * 0.5;
  const beamHalf = Math.max(0.5, lengthMetres * 0.15); // crude half-beam estimate
  const deckY = Math.max(0.5, lengthMetres * 0.08);

  return config.lights.map((light) => {
    const placed: NavLight = { ...light };
    const tri = config.tricolour;
    switch (light.kind) {
      case 'masthead':
        placed.position = { x: 0, y: mastHeightMetres * 0.6, z: halfLen * 0.3 };
        break;
      case 'sidelightStarboard':
        placed.position = tri
          ? { x: 0, y: mastHeightMetres, z: 0 }
          : { x: beamHalf, y: deckY, z: halfLen * 0.4 };
        break;
      case 'sidelightPort':
        placed.position = tri
          ? { x: 0, y: mastHeightMetres, z: 0 }
          : { x: -beamHalf, y: deckY, z: halfLen * 0.4 };
        break;
      case 'sternlight':
        placed.position = tri
          ? { x: 0, y: mastHeightMetres, z: 0 }
          : { x: 0, y: deckY, z: -halfLen };
        break;
      case 'allRound':
        placed.position = { x: 0, y: mastHeightMetres, z: 0 };
        break;
    }
    return placed;
  });
}
