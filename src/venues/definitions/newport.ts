/**
 * Newport, Rhode Island — Phase 2 task 2.1 venue definition.
 *
 * Narragansett Bay / East Passage near Newport Harbor and Fort Adams.
 * Real coordinates 41.4901 N, -71.3128 W; timezone America/New_York.
 *
 * Everything here is pure JSON-shaped data against the frozen
 * {@link VenueDefinition} contract — no three.js, no mesh/texture/audio files.
 * Large coordinate tables live in {@link ./data/newport.coastline}.
 *
 * ## What is real vs. approximated (be honest)
 *
 * - **Coordinates, timezone:** real.
 * - **Coastline & bathymetry:** hand-digitised approximations — see the
 *   provenance block in `data/newport.coastline.ts`. Labelled, not chart-accurate.
 * - **Palette:** the normative Newport palette from `docs/art-direction.md §4.1`,
 *   converted sRGB→linear.
 * - **Wind profile (SW sea breeze, East-Passage funnelling):** a real,
 *   well-documented feature of summer sailing on Narragansett Bay — see the
 *   citation on {@link NEWPORT_WIND_PROFILE}.
 * - **Tide:** semi-diurnal, M2-dominant, mean range ~1.1 m — see citation on
 *   {@link NEWPORT_TIDE}. The engine's {@link TideModel} already synthesises the
 *   M2+S2 harmonic set, so `TideProfile` only carries amplitude/phase/current.
 * - **Landmarks:** Newport's signature structures approximated with the
 *   generators the engine actually ships (bridge/lighthouse/breakwater). Each is
 *   labelled as an approximation in its comment.
 * - **Traffic, ambience:** plausible, not measured.
 */

import type {
  ColorGradeParams,
  CourseDefinition,
  LandmarkSpec,
  MonthlyClimate,
  RGB,
  TideProfile,
  TrafficSpec,
  VenueDefinition,
  WaterAppearance,
  WindProfile,
} from '@/types';
import {
  NEWPORT_COASTLINE_ATTRIBUTION,
  NEWPORT_FORT_ADAMS,
  NEWPORT_HALF_EXTENT,
} from '../data/newport.coastline';

// ─── sRGB → linear (local; src/venues must not import the render layer) ───────

/** Convert one sRGB channel (0..1) to linear. IEC 61966-2-1. */
function srgbChannelToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Convert an sRGB hex string (`#RRGGBB`) to linear {@link RGB}. */
export function srgbHexToLinear(hex: string): RGB {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return {
    r: srgbChannelToLinear(r),
    g: srgbChannelToLinear(g),
    b: srgbChannelToLinear(b),
  };
}

const DEG = Math.PI / 180;
/** Nautical miles → metres (exact international definition). */
const NM_TO_M = 1852;
/** Knots → m/s (exact reciprocal of the m/s→kn definition). */
const KNOTS_TO_MS = 1852 / 3600;

// ─── Palette (docs/art-direction.md §4.1, normative) ──────────────────────────
//
// 7 curated colours. A player should recognise Newport from these alone:
// cold green-grey Atlantic, grey shingle shore, weathered New England clapboard.

const NEWPORT_PALETTE_HEX = [
  '#2B4A4F', // Narragansett Deep  — deep water
  '#4A7068', // Bay Green          — shallow water
  '#8A9EAB', // Atlantic Overcast  — sky base
  '#6B7178', // Shingle Grey       — land primary
  '#5C7A5A', // Salt Marsh         — vegetation
  '#D8DDE0', // Clapboard White    — architecture
  '#8B3A3A', // Lighthouse Red     — accent
] as const;

const NEWPORT_PALETTE: RGB[] = NEWPORT_PALETTE_HEX.map(srgbHexToLinear);

// ─── Water appearance (Atlantic green-blue, turbid; §4.1 turbidity 0.45) ──────

export const NEWPORT_WATER: WaterAppearance = {
  colorShallow: srgbHexToLinear('#4A7068'),
  colorDeep: srgbHexToLinear('#2B4A4F'),
  // §4.1: Newport turbidity 0.45 — cold, moderately turbid New England water.
  turbidity: 0.45,
  // Light is effectively gone by ~8 m in this turbidity class.
  extinctionDepth: 8,
};

// ─── Wind profile ─────────────────────────────────────────────────────────────
//
// CITATION: Narragansett Bay's summer prevailing wind is a south-to-south-west
// sea breeze ("the southerly") that fills in most afternoons, building through
// the day as the land heats. In the East Passage this flow is funnelled and
// accelerated along the roughly N–S channel between Aquidneck and Conanicut
// islands — classic venue local knowledge for Newport sailing (and why Newport
// has hosted the America's Cup and remains a premier US racing venue). See e.g.
// Sailing Narragansett Bay cruising guides and US Sailing's Newport venue notes.
//
// `WindProfile` carries only the per-venue CHARACTER; the actual speed/direction
// come from the live forecast. The prevailing SW bearing itself is encoded in the
// climatology table below (prevailingDirection), which the offline fallback uses.

export const NEWPORT_WIND_PROFILE: WindProfile = {
  // Open coastal water with islands — a touch above the 0.11 offshore baseline,
  // below a built-up harbour's 0.20.
  shearExponent: 0.13,
  // The sea breeze is fairly steady once established, but the channel edges and
  // islands add moderate oscillation.
  oscillationScale: 1.1,
  // Gusty near the Fort Adams shore and island lees; moderate overall.
  gustScale: 1.15,
  // Fetch down the East Passage to the open Rhode Island Sound is a few km;
  // the dominant summer sea is short and wind-driven rather than long swell.
  fetch: 4000,
};

// ─── Tide profile ─────────────────────────────────────────────────────────────
//
// CITATION: Newport (Narragansett Bay) tides are semi-diurnal with a mean range
// of about 1.1 m (NOAA station 8452660 "Newport, RI": mean range ≈ 1.07 m, great
// diurnal range ≈ 1.30 m). The M2 (principal lunar semidiurnal) constituent
// dominates; the engine's TideModel synthesises M2 + S2 (spring/neap) from the
// amplitude below. Tidal current in the East Passage is weak — order 0.3–0.5 kn
// — because the bay's tidal prism is spread across a wide cross-section.
//
// `amplitude` is the tidal AMPLITUDE (half-range): mean range 1.1 m → 0.55 m
// amplitude. `currentAxis` points along the channel (roughly N–S here; the
// channel runs slightly W-of-N, so the axis is mostly ∓Z with a little −X).

const CURRENT_AXIS = (() => {
  // Flood flows roughly NNW up the passage; set the principal axis as a unit
  // Vec2 (x east, y south) pointing "up-channel" to the NNW.
  const bearing = 340 * DEG; // NNW
  const x = Math.sin(bearing);
  const y = -Math.cos(bearing);
  const len = Math.hypot(x, y);
  return { x: x / len, y: y / len };
})();

export const NEWPORT_TIDE: TideProfile = {
  // Mean range ~1.1 m → amplitude ~0.55 m.
  amplitude: 0.55,
  phaseOffsetHours: 0,
  // Weak East-Passage current, ~0.4 kn on a spring peak.
  currentStrength: 0.4 * KNOTS_TO_MS,
  currentAxis: CURRENT_AXIS,
};

// ─── Landmarks (signature Newport structures; approximations, labelled) ───────
//
// Newport's real signature landmarks are the Claiborne Pell (Newport) Bridge,
// Fort Adams, Castle Hill Lighthouse and the Brenton Reef tower. We map them to
// the generators the engine ships:
//   - Pell Bridge  → `suspensionBridge` (Pell is actually a suspension bridge —
//     a good structural match; span/towers approximated).
//   - Castle Hill Lighthouse → `lighthouse` (a small granite light; the generator
//     is a generic tower, so proportions are approximate).
//   - Fort Adams   → approximated as a low `breakwater`-style stone mass on its
//     peninsula (the engine has no fort/bastion generator; this stands in for the
//     fort's seaward granite wall silhouette). Labelled approximation.
//   - Brenton Reef tower → `lighthouse` stand-in (the real one is a skeletal
//     light tower / former Texas-tower; lighthouse is the closest shipping shape).
//
// Positions are venue-local metres (x east, y south, y-up is +Y). Pell Bridge's
// southern approach is near the NW corner; Fort Adams is on its peninsula apex;
// Castle Hill sits further SW at the passage mouth (near the venue edge).

export const NEWPORT_LANDMARKS: LandmarkSpec[] = [
  {
    // Claiborne Pell (Newport) Bridge — suspension bridge across the East
    // Passage. Real main span ~488 m; approximated. Placed spanning the channel
    // near the northern edge, oriented E–W (crosses the N–S passage).
    generator: 'suspensionBridge',
    params: {
      span: 1600, // Approximation of the full crossing incl. approaches.
      towerHeight: 120,
      deckWidth: 24,
      deckHeight: 4,
      numSuspenders: 28,
      sag: 0.11,
    },
    position: { x: -2900, y: 70, z: -5200 }, // Across the channel near north edge.
    rotation: 90 * DEG, // Deck runs E–W across the N–S passage.
    scale: 1,
  },
  {
    // Fort Adams — APPROXIMATION. Low stone mass on the peninsula apex standing
    // in for the fort's seaward granite wall (no fort generator exists).
    generator: 'breakwater',
    params: {
      length: 420,
      height: 9,
      baseWidth: 60,
      topWidth: 40,
      curvature: 0.5,
      roughness: 0.4,
    },
    position: { x: NEWPORT_FORT_ADAMS.local.x, y: 0, z: NEWPORT_FORT_ADAMS.local.y },
    rotation: 20 * DEG,
    scale: 1,
  },
  {
    // Castle Hill Lighthouse — small granite light at the passage mouth (SW).
    // Proportions approximated by the generic lighthouse generator.
    generator: 'lighthouse',
    params: {
      height: 14,
      baseRadius: 2.4,
      topRadius: 1.8,
      galleryRadius: 2.6,
    },
    position: { x: -3900, y: 2, z: 3100 },
    rotation: 0,
    scale: 1,
  },
  {
    // Brenton Reef tower — APPROXIMATION via the lighthouse generator (the real
    // structure is a skeletal light tower). Placed near the SW passage mouth.
    generator: 'lighthouse',
    params: {
      height: 20,
      baseRadius: 2.0,
      topRadius: 1.6,
      galleryRadius: 2.2,
    },
    position: { x: -4600, y: 1, z: 4200 },
    rotation: 0,
    scale: 1,
  },
];

// ─── Traffic (plausible; not measured) ────────────────────────────────────────
//
// Routes are venue-local metre waypoints. The Jamestown–Newport ferry crosses
// the passage; small fishing boats work the harbour mouth; cruising yachts
// transit the channel.

export const NEWPORT_TRAFFIC: TrafficSpec[] = [
  {
    // Jamestown ⇄ Newport ferry across the East Passage.
    kind: 'ferry',
    route: [
      { x: -4300, y: 400 }, // Jamestown (Conanicut) side.
      { x: -2900, y: 200 },
      { x: -200, y: 450 }, // Newport waterfront side.
    ],
    speed: 8 * KNOTS_TO_MS,
    intervalSeconds: 1800,
    length: 28,
  },
  {
    // Small fishing boats working the harbour mouth.
    kind: 'fishingBoat',
    route: [
      { x: -800, y: 1200 },
      { x: -1800, y: 600 },
      { x: -1400, y: -400 },
      { x: -600, y: 200 },
    ],
    speed: 6 * KNOTS_TO_MS,
    intervalSeconds: 2400,
    length: 11,
  },
  {
    // Cruising yachts transiting the channel N–S.
    kind: 'yacht',
    route: [
      { x: -2900, y: -3200 },
      { x: -2900, y: 0 },
      { x: -2900, y: 3200 },
    ],
    speed: 5 * KNOTS_TO_MS,
    intervalSeconds: 3000,
    length: 13,
  },
];

// ─── Colour grade (in-contract; §5.3) ─────────────────────────────────────────
//
// NEUTRAL BASELINE DISCIPLINE (from Stream F's hard-won knowledge): contrast is
// applied as a POWER-LAW about the 0.18 pivot, `out = 0.18·(c/0.18)^(1+contrast)`.
// Keep |contrast| modest so dim scene values (e.g. a noon sky zenith ≈ 0.02–0.05)
// are not crushed. Neutral grade is EXACTLY contrast 0, saturation 1, zero tints.
//
// Newport's overcast maritime light wants a gentle, slightly cool, slightly
// low-saturation look — but well inside the "white stays white, black stays
// black" rule (§5.3). Palette-clamp strength lives in the grade node, not here;
// the palette itself is the 7 entries above.

export const NEWPORT_GRADE: ColorGradeParams = {
  // No exposure push here — exposure is driven by solar elevation globally (§5.2).
  exposure: 0,
  // Subtle S-curve. Power-law pivot k = 1.08 at 0.18. Well under the ±0.15 cap.
  contrast: 0.08,
  // Slightly desaturated for the cool Atlantic overcast; within §5.3's 0.9–1.1.
  saturation: 0.97,
  // Shadows lift gently toward the deep-water colour (cool), per §5.3(1).
  shadowTint: {
    r: 0.02,
    g: 0.05,
    b: 0.06,
  },
  // Highlights warm gently toward the sky base, per §5.3(2) — small magnitude.
  highlightTint: {
    r: 0.05,
    g: 0.05,
    b: 0.04,
  },
  palette: NEWPORT_PALETTE,
};

// ─── Ambience (procedural synthesis params) ───────────────────────────────────

export const NEWPORT_AMBIENCE = {
  surf: 0.3, // Sheltered bay — modest surf.
  gullDensity: 8, // Plenty of gulls around the harbour.
  urban: 0.15, // Small city; low urban bed.
  harbour: 0.5, // Busy working/cruising harbour — halyards, machinery.
  riggingResonance: 220, // Hz — rigging whistle resonance.
};

// ─── Climatology (12 months, offline fallback; requirement 2.6) ───────────────
//
// Approximate monthly means for Narragansett Bay. Prevailing direction is the
// bearing the wind comes FROM: winters are NW-dominated, summers SW (the sea
// breeze). Speeds in m/s, directions in radians, temps °C.

function climate(
  month: number,
  windKn: number,
  prevailingDeg: number,
  gustFactor: number,
  waveM: number,
  wavePeriod: number,
  airC: number,
  seaC: number,
  cloud: number,
): MonthlyClimate {
  return {
    month,
    meanWindSpeed: windKn * KNOTS_TO_MS,
    prevailingDirection: prevailingDeg * DEG,
    gustFactor,
    meanWaveHeight: waveM,
    meanWavePeriod: wavePeriod,
    meanAirTemp: airC,
    meanSeaTemp: seaC,
    meanCloudCover: cloud,
  };
}

export const NEWPORT_CLIMATOLOGY: MonthlyClimate[] = [
  climate(1, 13, 315, 1.5, 0.9, 5.0, 0.5, 4.5, 0.6), // Jan — NW winter winds.
  climate(2, 13, 315, 1.5, 0.9, 5.0, 0.8, 3.8, 0.6), // Feb.
  climate(3, 12, 300, 1.45, 0.8, 4.8, 4.5, 4.2, 0.6), // Mar.
  climate(4, 11, 225, 1.4, 0.7, 4.5, 9.5, 7.0, 0.55), // Apr — turning southerly.
  climate(5, 10, 210, 1.35, 0.6, 4.2, 14.5, 11.0, 0.5), // May — SW sea breeze builds.
  climate(6, 10, 205, 1.3, 0.6, 4.0, 19.5, 16.5, 0.45), // Jun — SW sea breeze.
  climate(7, 9, 205, 1.3, 0.5, 3.8, 23.0, 21.0, 0.4), // Jul — classic SW southerly.
  climate(8, 9, 205, 1.3, 0.5, 3.8, 22.5, 22.0, 0.4), // Aug.
  climate(9, 10, 215, 1.35, 0.6, 4.2, 19.0, 20.0, 0.45), // Sep.
  climate(10, 11, 270, 1.4, 0.7, 4.5, 13.5, 16.0, 0.55), // Oct — westerlies return.
  climate(11, 12, 300, 1.45, 0.8, 4.8, 8.0, 11.0, 0.6), // Nov.
  climate(12, 13, 315, 1.5, 0.9, 5.0, 2.5, 7.0, 0.65), // Dec.
];

// ─── Windward–leeward course ───────────────────────────────────────────────────
//
// Short W/L course in the open channel. The engine auto-orients the axis to the
// current wind (`windAligned: true`); the mark positions below encode the
// NOMINAL geometry for the prevailing summer SW sea breeze (~205° FROM).
//
// Course axis: upwind points INTO the wind, i.e. toward the FROM bearing. In Vec2
// (x east, y south) a bearing θ maps to `(sinθ, −cosθ)` (see CurrentField's
// derivation). So the "up the course" direction = (sin 205°, −cos 205°).
// The windward mark is ~1 nm (1852 m) up-axis from the start-line centre; the
// leeward gate is a pair of marks straddling the start, down-axis.

const PREVAILING_WIND_FROM = 205 * DEG;
/** Unit "up the course" direction (toward the wind it comes FROM), Vec2 x/y. */
const COURSE_AXIS = {
  x: Math.sin(PREVAILING_WIND_FROM),
  y: -Math.cos(PREVAILING_WIND_FROM),
};
/** Start-line centre, in the open channel (deep water, clear of land). */
const START_CENTRE = { x: -2900, y: 400 };
const BEAT_LENGTH = 1 * NM_TO_M; // ~1 nautical mile windward leg.
/** Line/gate half-width, metres. */
const LINE_HALF_WIDTH = 60;
const GATE_HALF_WIDTH = 50;
/** Perpendicular to the course axis (for laying out line/gate pins). */
const PERP = { x: -COURSE_AXIS.y, y: COURSE_AXIS.x };

function along(base: { x: number; y: number }, up: number, across: number) {
  return {
    x: base.x + COURSE_AXIS.x * up + PERP.x * across,
    y: base.y + COURSE_AXIS.y * up + PERP.y * across,
  };
}

export const NEWPORT_WL_COURSE: CourseDefinition = {
  id: 'newport-wl-1',
  name: 'East Passage Windward–Leeward',
  kind: 'windwardLeeward',
  marks: [
    {
      id: 'start-pin',
      position: along(START_CENTRE, 0, -LINE_HALF_WIDTH),
      kind: 'start',
      rounding: 'port',
      radius: 2,
    },
    {
      id: 'start-boat',
      position: along(START_CENTRE, 0, LINE_HALF_WIDTH),
      kind: 'start',
      rounding: 'starboard',
      radius: 2,
    },
    {
      id: 'windward',
      position: along(START_CENTRE, BEAT_LENGTH, 0),
      kind: 'windward',
      rounding: 'port',
      radius: 3,
    },
    {
      id: 'gate-left',
      position: along(START_CENTRE, -80, -GATE_HALF_WIDTH),
      kind: 'gate',
      rounding: 'port',
      radius: 3,
    },
    {
      id: 'gate-right',
      position: along(START_CENTRE, -80, GATE_HALF_WIDTH),
      kind: 'gate',
      rounding: 'starboard',
      radius: 3,
    },
  ],
  sequence: ['windward', 'gate-left'],
  laps: 2,
  windAligned: true,
  legLength: BEAT_LENGTH,
};

/** Default free-sail spawn: start-line centre, heading up the beat (close-hauled-ish). */
const SPAWN_HEADING = (() => {
  // Heading is the boat's bow bearing, clockwise from true north. Point the bow
  // roughly up the course (toward the wind) so the player starts on a beat.
  // directionToBearing of the course-axis world vector: axis Vec2 (x,y) → world
  // (x, 0, y); bearing = atan2(x, -z) = atan2(axis.x, -axis.y).
  const b = Math.atan2(COURSE_AXIS.x, -COURSE_AXIS.y);
  return b < 0 ? b + Math.PI * 2 : b;
})();

// ─── The complete venue ────────────────────────────────────────────────────────

export const NEWPORT: VenueDefinition = {
  id: 'newport',
  name: 'Newport, Rhode Island',
  region: 'United States — New England',
  coordinates: { latitude: 41.4901, longitude: -71.3128 },
  timezone: 'America/New_York',
  difficulty: 3,
  blurb:
    'Cold green Atlantic in the East Passage of Narragansett Bay — the classic ' +
    'American keelboat venue, with a steady SW summer sea breeze funnelling past ' +
    'Fort Adams.',
  bounds: {
    min: { x: -NEWPORT_HALF_EXTENT, y: -NEWPORT_HALF_EXTENT },
    max: { x: NEWPORT_HALF_EXTENT, y: NEWPORT_HALF_EXTENT },
  },
  // The coastline/bathymetry data lives in a typed TS module rather than a JSON
  // file (keeps it validated by the compiler); this string documents its origin.
  coastlineFile: 'src/venues/data/newport.coastline.ts',
  coastlineAttribution: NEWPORT_COASTLINE_ATTRIBUTION,
  relief: 'hilly', // Aquidneck/Conanicut are low rolling terrain.
  maxElevation: 60,
  maxDepth: 30, // Deepest hole in the East Passage channel.
  freshwater: false,
  landmarks: NEWPORT_LANDMARKS,
  traffic: NEWPORT_TRAFFIC,
  water: NEWPORT_WATER,
  windProfile: NEWPORT_WIND_PROFILE,
  tide: NEWPORT_TIDE,
  courses: [NEWPORT_WL_COURSE],
  climatology: NEWPORT_CLIMATOLOGY,
  grade: NEWPORT_GRADE,
  ambience: NEWPORT_AMBIENCE,
  spawn: {
    position: { x: START_CENTRE.x, y: START_CENTRE.y },
    heading: SPAWN_HEADING,
  },
};
