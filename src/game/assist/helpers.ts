/**
 * Pure assist helpers — trim and hike targets derived from apparent wind and
 * heel. No three.js, no DOM, no mutable module state. SI + radians internally;
 * the two exported helpers take DEGREES for the apparent-wind angle because they
 * are also called straight from the HUD and tests, where degrees read naturally.
 *
 * Conventions (shared with AeroForce / the frozen ControlState):
 *   - mainsheet 0 = fully EASED (boom at maxSheetAngle from centreline, for a
 *     run); 1 = fully TRIMMED IN (close-hauled). A reach wants an eased sheet.
 *   - AWA here is the apparent-wind angle OFF THE BOW (0 = head to wind, 180 =
 *     dead astern), the same incidence AeroForce computes.
 */

/** Ideal sail angle of attack for attached, near-peak lift, radians (~14°). */
export const IDEAL_SAIL_ALPHA = 0.25;

/** The dinghy main's maximum sheeting angle from centreline, radians (~80°).
 *  Mirrors DINGHY.sails[0].maxSheetAngle; kept here so the helper is a pure
 *  function of its arguments and does not import the boat definition. */
export const MAIN_MAX_SHEET_ANGLE = 1.4;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Ideal mainsheet (0..1) for a given apparent-wind angle.
 *
 * The boom should sit at `boomAngle = AWA − idealAlpha` off the centreline so
 * the flow attaches near peak lift. The sheet maps boom angle linearly:
 *   mainsheet = 1 − boomAngle / maxSheetAngle
 * so close-hauled (small AWA) → trimmed near 1, a broad reach (large AWA) →
 * eased toward 0. Clamped to [0,1].
 *
 * @param awaDeg    apparent-wind angle off the bow, DEGREES (0..180).
 * @param windSpeed apparent (or true) wind speed, m/s. Currently only used to
 *                  pull the sheet fractionally tighter in very light air (where
 *                  a dinghy sheets harder to keep the leech working) — a small,
 *                  bounded effect so the helper stays monotone in AWA.
 */
export function idealSheetFor(awaDeg: number, windSpeed: number): number {
  const awa = (Math.abs(awaDeg) * Math.PI) / 180;
  const boomAngle = awa - IDEAL_SAIL_ALPHA;
  let sheet = 1 - boomAngle / MAIN_MAX_SHEET_ANGLE;
  // Light-air nudge: below ~3 m/s apparent, sheet marginally harder (up to
  // +0.08) to keep the sail from under-trimming; negligible above 6 m/s.
  const lightAir = clamp01((3 - windSpeed) / 3) * 0.08;
  sheet += lightAir;
  return clamp01(sheet);
}

/**
 * The mainsheet (0..1) at which the main LUFFS for a given apparent-wind angle —
 * the boom sits right at the incidence so the angle of attack is ≈0 and the
 * sail produces the least lift AND the least cross-flow side force, hence the
 * least heeling moment. This is the de-power target the assist eases toward as
 * heel builds (see `_depoweredSheet`): blending the attached ideal toward the
 * luff sheet spills power on every point of sail, close-hauled included.
 *
 * `boomAngle = AWA` (alpha ≈ 0) → `mainsheet = 1 − AWA/maxSheetAngle`, clamped.
 * Note it is strictly LESS than `idealSheetFor` (which targets boomAngle =
 * AWA − idealAlpha), so easing from the ideal toward the luff always lowers the
 * sheet (opens the boom) — the physically correct "let it breathe" direction.
 *
 * @param awaDeg apparent-wind angle off the bow, DEGREES (0..180).
 */
export function luffSheetFor(awaDeg: number): number {
  const awa = (Math.abs(awaDeg) * Math.PI) / 180;
  return clamp01(1 - awa / MAIN_MAX_SHEET_ANGLE);
}

/**
 * Target hiking effort (0..1) for a given heel and point of sail.
 *
 * Monotone and bounded in heel: no hike when upright or heeling to windward,
 * rising smoothly to full hike as leeward heel builds past a small deadband.
 * Stronger wind and a broader (more powered-up) apparent angle bring the full-
 * hike point in a little earlier, but the result is always clamped to [0,1] and
 * never decreases with heel — so it cannot pump the roll.
 *
 * `heel` is signed (positive to starboard). The caller supplies the windward
 * SIGN separately when turning this into a crewLateral command; this function
 * returns the magnitude of effort for the leeward-heel magnitude.
 *
 * @param heel      heel angle, RADIANS (signed; magnitude used).
 * @param awaDeg    apparent-wind angle off the bow, DEGREES (reserved; broad
 *                  reaches are less heel-critical, tight reaches more).
 * @param windSpeed wind speed, m/s (more wind → hike sooner).
 */
export function targetHikeFor(heel: number, awaDeg: number, windSpeed: number): number {
  const absHeel = Math.abs(heel);
  // Deadband: sit in until ~3° of heel.
  const deadband = (3 * Math.PI) / 180;
  // Full hike reached by this heel; shrinks (hike sooner) with more wind.
  const windFactor = clamp01((windSpeed - 2) / 10); // 0 at ≤2 m/s, 1 at ≥12 m/s.
  const fullHikeHeel = ((22 - 8 * windFactor) * Math.PI) / 180; // 22°→14° as wind rises.
  if (absHeel <= deadband) return 0;
  const t = (absHeel - deadband) / Math.max(fullHikeHeel - deadband, 1e-3);
  // Tight apparent angles (beating) are more heel-critical than broad reaches:
  // a small bounded boost when sailing high. Monotone in heel regardless.
  const awa = Math.abs(awaDeg);
  const pointBoost = awa < 70 ? 1.1 : 1.0;
  return clamp01(t * pointBoost);
}
