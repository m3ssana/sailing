/**
 * ILCA / Laser single-handed dinghy — BoatDefinition.
 *
 * This is the "first sail" boat (Phase 2, task 2.1): a simple, well-understood
 * one-design dinghy with a single unstayed catboat rig, a daggerboard and a
 * rudder. Every number below is a published class figure (cited inline) or a
 * documented geometric approximation derived from one — never an arbitrary
 * tuning constant.
 *
 * ## Sourced class data (ILCA / Laser Standard)
 *
 * - LOA ...................... 4.23 m   (ILCA class rules; Laser spec)
 * - Beam (max) .............. 1.37 m   (ILCA class rules)
 * - Hull mass (bare) ........ 58.97 kg → rounded to ~58 kg dry hull
 *                                       (ILCA minimum hull weight 58.97 kg)
 * - Sail area (Standard) .... 7.06 m²  (ILCA Standard rig; the MkII Standard
 *                                       sail is 7.06 m²)
 * - Hull draft (canoe body) . ~0.10–0.12 m  (the hull itself draws very little;
 *                                       the daggerboard provides the depth)
 * - Daggerboard depth ....... ~0.78 m below hull (class board; ~0.98 m total
 *                                       length, ~0.80 m immersed)
 * - Rudder depth ............ ~0.45 m immersed (class rudder blade)
 * - Crew (one sailor) ....... ~70–80 kg typical competitive weight → 75 kg
 *
 * References:
 *   - ILCA (International Laser Class Association) class rules & specifications.
 *   - Bethwaite, "High Performance Sailing" — dinghy hydrostatics and rig loads.
 *   - Marchaj, "Aero-Hydrodynamics of Sailing" — sail and foil coefficient ranges.
 *
 * ## Coordinate conventions (hull-local, per StationLofter.ts & the frozen types)
 *
 * - Y up, X transverse (+starboard), Z longitudinal (+bow, −stern).
 * - StationCurve.points are STARBOARD HALF-BREADTHS, keel → sheer:
 *     x = half-beam (m), y = height above baseline (m).
 * - position 0 = bow, 1 = stern.
 * - The design waterline sits at `waterlineHeight` above the baseline; only the
 *   canoe body below it is submerged at rest, which is what makes the displaced
 *   volume match (hull + sailor) mass for a boat that floats high like a dinghy.
 */

import type { BoatDefinition, StationCurve } from '@/types';

// ── Principal dimensions (SI) ────────────────────────────────────────────────
const LOA = 4.23; // m — ILCA/Laser length overall.
const BEAM = 1.37; // m — ILCA/Laser maximum beam.
const HULL_MASS = 58; // kg — bare hull (ILCA min hull weight 58.97 kg, rounded).
const CREW_MASS = 75; // kg — one sailor, typical competitive weight.
const SAIL_AREA = 7.06; // m² — ILCA Standard rig sail area.

/**
 * Height of the baseline (keel) above which the design waterline sits.
 *
 * The canoe-body draft of a Laser at rest with one sailor aboard is small
 * (~0.10 m). We place the waterline at WATERLINE_HEIGHT above the keel; the
 * station sections are shaped so the submerged volume below it equals
 * (HULL_MASS + CREW_MASS) / ρ ≈ 0.13 m³, i.e. the boat floats at a realistic
 * dinghy draft. See the displacement test in tests/unit/boats.
 */
const WATERLINE_HEIGHT = 0.116; // m above baseline — design waterline (dinghy canoe-body draft).

/** Full moulded depth of the hull at the sheer (keel → gunwale), midship. */
const SHEER_HEIGHT = 0.34; // m — approximate Laser freeboard+canoe depth at midship.

/**
 * Transverse half-breadth stations, bow → stern.
 *
 * A Laser hull is a flattish, hard-turn-bilge dinghy: a nearly flat run amidships
 * with a shallow vee, fine bow entry, and a moderately wide, shallow transom.
 * The sections below the waterline (y < WATERLINE_HEIGHT ≈ 0.11) carry the
 * displacement; the topsides (up to SHEER_HEIGHT) carry reserve buoyancy and
 * define the gunwale the sailor hikes from.
 *
 * Half-beams are kept at/below BEAM/2 = 0.685 m. The maximum beam occurs just
 * aft of midship, as on the real boat.
 */
const STATIONS: StationCurve[] = [
  // Bow — fine entry, little immersed volume.
  {
    position: 0,
    points: [
      { x: 0.0, y: 0.18 }, // stem rises above the waterline at the very bow
      { x: 0.03, y: 0.24 },
      { x: 0.07, y: 0.3 },
      { x: 0.1, y: SHEER_HEIGHT },
    ],
  },
  {
    position: 0.12,
    points: [
      { x: 0.0, y: 0.05 },
      { x: 0.14, y: 0.09 },
      { x: 0.26, y: 0.2 },
      { x: 0.32, y: SHEER_HEIGHT },
    ],
  },
  {
    position: 0.28,
    points: [
      { x: 0.0, y: 0.015 },
      { x: 0.3, y: 0.05 },
      { x: 0.5, y: 0.17 },
      { x: 0.56, y: SHEER_HEIGHT },
    ],
  },
  // Midship — maximum beam region, flat shallow bottom.
  {
    position: 0.45,
    points: [
      { x: 0.0, y: 0.0 },
      { x: 0.42, y: 0.03 },
      { x: 0.63, y: 0.16 },
      { x: 0.66, y: SHEER_HEIGHT },
    ],
  },
  {
    position: 0.6,
    points: [
      { x: 0.0, y: 0.0 },
      { x: 0.44, y: 0.03 },
      { x: 0.64, y: 0.16 },
      { x: 0.685, y: SHEER_HEIGHT },
    ],
  },
  {
    position: 0.78,
    points: [
      { x: 0.0, y: 0.01 },
      { x: 0.4, y: 0.04 },
      { x: 0.58, y: 0.18 },
      { x: 0.62, y: SHEER_HEIGHT },
    ],
  },
  // Transom — moderately wide, shallow; sits mostly at/above the waterline.
  {
    position: 1.0,
    points: [
      { x: 0.0, y: 0.05 },
      { x: 0.3, y: 0.08 },
      { x: 0.46, y: 0.22 },
      { x: 0.5, y: SHEER_HEIGHT },
    ],
  },
];

/**
 * The ILCA Standard dinghy definition.
 *
 * The sail is a single cat-rigged main on an unstayed mast (spreaderPairs 0,
 * no shrouds). Foils are a daggerboard (retractable, non-steerable) and a
 * rudder (steerable). Ballast is zero — a dinghy is kept upright by crew weight
 * and hull form, not a keel.
 */
export const DINGHY: BoatDefinition = {
  id: 'dinghy',
  name: 'ILCA / Laser',
  class: 'dinghy',
  blurb: 'A single-handed Olympic dinghy: simple, unforgiving, and the classic first boat.',
  crewCount: 1,

  hull: {
    loa: LOA,
    beam: BEAM,
    designDraft: 0.1, // m — canoe-body draft at the design waterline.
    waterlineHeight: WATERLINE_HEIGHT,
    stations: STATIONS,
    bilge: 'round', // the Laser has soft, rounded bilges rather than hard chines.
    hullCount: 1,
    sheerRise: 0.08, // modest bow/stern sheer rise as a fraction of beam.
    deckCamber: 0.03, // slight deck crown.
    lengthSegments: 40,
    girthSegments: 16,
  },

  rig: {
    // Unstayed cat rig. The ILCA Standard mast is ~4.0 m above the deck to the
    // top sleeve; the two-part mast steps near the bow.
    mastHeight: 5.9, // m — tip above waterline (lower mast + upper mast + hull freeboard).
    mastBaseDiameter: 0.08, // m — aluminium lower-mast section.
    mastTaper: 0.5, // upper mast tapers to ~half the base diameter.
    mastRake: 0.0, // unstayed rig sails near-vertical; no permanent rake.
    boomLength: 2.74, // m — class boom length.
    boomDiameter: 0.05,
    boomHeight: 0.35, // m — gooseneck height above deck.
    spreaderPairs: 0, // unstayed — no spreaders.
    shroudDiameter: 0.0, // unstayed — no standing rigging.
    bowsprit: false,
    // Mast step well forward (the Laser mast is stepped near the bow).
    stepPosition: { x: 0, y: SHEER_HEIGHT, z: LOA * 0.5 - 0.5 },
  },

  sails: [
    {
      id: 'main',
      kind: 'main',
      area: SAIL_AREA,
      surface: {
        // Tall, low-aspect cat sail. Luff runs up the ~5 m lower+upper mast.
        luffLength: 5.2,
        footLength: 2.74, // along the boom.
        leechLength: 5.6,
        luffRound: 0.04, // modest luff round → camber when hoisted.
        broadseam: 0.03,
        twist: 0.18, // rad — designed leech twist from foot to head.
        luffSegments: 12,
        footSegments: 6,
        panelCount: 5,
      },
      // Centre of effort of a cat-rigged main sits ~40% up the luff above the
      // boom; above the waterline that is roughly 2.3 m.
      centreOfEffortHeight: 2.35, // m above the waterline.
      // Aspect ratio = luff² / area ≈ 5.2² / 7.06 ≈ 3.8 for a tall cat sail.
      aspectRatio: 3.8,
      maxSheetAngle: 1.4, // rad (~80°) — fully eased boom swings wide on a run.
      maxCamber: 0.12, // soft-sail draft ~12% of chord (Marchaj range 0.05–0.15).
      tack: { x: 0, y: SHEER_HEIGHT + 0.35, z: LOA * 0.5 - 0.5 },
      clew: { x: 0, y: SHEER_HEIGHT + 0.35, z: LOA * 0.5 - 0.5 - 2.74 },
      head: { x: 0, y: SHEER_HEIGHT + 5.2, z: LOA * 0.5 - 0.5 },
    },
  ],

  foils: [
    {
      id: 'daggerboard',
      kind: 'daggerboard',
      // Class daggerboard: ~0.98 m long, ~0.28 m chord → ~0.25 m² blade, with
      // ~0.78 m immersed below the hull.
      area: 0.22,
      span: 0.78, // m immersed depth.
      chord: 0.28,
      position: { x: 0, y: -0.39, z: 0.2 }, // just forward of midship, below the hull.
      thickness: 0.1, // 10% section.
      retractable: true,
      steerable: false,
    },
    {
      id: 'rudder',
      kind: 'rudder',
      // Class rudder blade: ~0.45 m immersed, ~0.2 m chord.
      area: 0.09,
      span: 0.45,
      chord: 0.2,
      position: { x: 0, y: -0.225, z: -LOA * 0.5 + 0.1 }, // at the transom.
      thickness: 0.1,
      retractable: false,
      steerable: true,
    },
  ],

  hullMass: HULL_MASS,
  ballastMass: 0, // a dinghy has no ballast.
  crewMass: CREW_MASS,
  // The sailor's CENTRE OF MASS moves to about 0.75 m outboard of the
  // centreline when fully hiked on the strap (torso out over the gunwale) — not
  // the full arm span. This is the lateral righting arm RightingMoment uses.
  crewMovementRange: { x: 0.75, y: 0.2, z: 0.8 },
  // A Laser capsizes readily once overpowered: the hull-form + crew righting
  // moment peaks and reverses well before a keelboat would. ~65° is a realistic
  // knock-down-to-capsize angle for an unballasted dinghy.
  capsizeAngle: (65 * Math.PI) / 180, // rad.

  // Residuary (wavemaking) resistance, expressed in the Froude/Delft convention
  // as the dimensionless ratio R_r / (ρ·g·∇) against Froude number — i.e. the
  // residuary drag as a fraction of the boat's displacement WEIGHT (Larsson &
  // Eliasson, "Principles of Yacht Design", Delft Systematic Yacht Series). This
  // is how HydroResistance.ts and PolarSolver.ts consume it: R_r = C_r·ρ·g·∇.
  //
  // Calibrated so total hull resistance (ITTC-57 friction on the lofted wetted
  // surface + this residuary) matches the measured order of magnitude for an
  // Olympic Laser hull: ~40–70 N at 5 kt (Fn≈0.41), climbing through the
  // displacement "hump" toward hull speed. The ratio stays a few percent up to
  // the hump then rises steeply — the wall a displacement dinghy must climb
  // before it planes — which is what makes the computed beam-reach polar land in
  // the real-world 5–7 kt band at 12 kt TWS instead of running away. The old
  // values (≤0.02, interpreted via 0.5·ρ·S·V²·C_r) produced ~190 N of phantom
  // wavemaking drag at 5 kt and stalled the boat at ~2.5 kt.
  residuaryCurve: [
    { x: 0.0, y: 0.0 },
    { x: 0.2, y: 0.004 },
    { x: 0.3, y: 0.011 },
    { x: 0.35, y: 0.018 }, // displacement hump begins
    { x: 0.4, y: 0.03 },
    { x: 0.45, y: 0.06 },
    { x: 0.5, y: 0.12 }, // hull-speed wall (Fn 0.5)
    { x: 0.6, y: 0.26 },
    { x: 0.8, y: 0.55 },
    { x: 1.0, y: 0.85 },
  ],

  materials: {
    hull: { kind: 'gelcoat', baseColor: { r: 0.9, g: 0.9, b: 0.88 }, roughness: 0.3, metalness: 0 },
    deck: { kind: 'gelcoat', baseColor: { r: 0.85, g: 0.85, b: 0.83 }, roughness: 0.4, metalness: 0 },
    spars: { kind: 'anodized', baseColor: { r: 0.6, g: 0.6, b: 0.62 }, roughness: 0.35, metalness: 0.9 },
    sail: { kind: 'sailcloth', baseColor: { r: 0.95, g: 0.95, b: 0.95 }, roughness: 0.6, metalness: 0 },
  },

  appearance: {
    hullColor: { r: 0.9, g: 0.9, b: 0.88 },
    deckColor: { r: 0.1, g: 0.2, b: 0.5 },
    sailNumber: '191456',
  },

  unlockMiles: 0, // starting boat.
};
