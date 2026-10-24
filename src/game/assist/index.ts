/**
 * Sailing assist — the crew/helm helper that sits between the player's input
 * mapper and the boat simulation. It is PURE game logic: no three.js, no DOM,
 * no shared module-scope mutable state (every instance owns its own phase and
 * timers), and its `update` path is allocation-free (it writes only into the
 * caller-provided `out` object and returns it).
 *
 * This is the SEAM the session-assembly agent codes against. See `AssistFrame`
 * / `SailingAssist` below for the exact contract.
 *
 * ## Assist levels (requirement 5.5 — assists only, never the physics)
 *
 *  - 'simulation' : pass-through. Writes nothing; tack/gybe commands ignored.
 *  - 'assisted'   : auto-trim the mainsheet from the apparent-wind angle (unless
 *                   the driver has touched the sheet recently), auto-hike
 *                   proportional to heel, and execute a scripted tack/gybe on
 *                   command.
 *  - 'arcade'     : everything 'assisted' does, plus steering help (anti-stall
 *                   bear-off when stuck in irons) and heavier capsize prevention
 *                   (more aggressive depower + hike as heel builds).
 *
 * Conventions: SI/radians; world +X east, +Z south; bearing θ → (sinθ,0,−cosθ);
 * wind bearing is the direction the wind comes FROM.
 */

import type {
  AssistLevel,
  BoatState,
  ControlState,
  CrewCommand,
  Radians,
} from '@/types';
import { idealSheetFor, luffSheetFor, targetHikeFor } from './helpers';

export { idealSheetFor, luffSheetFor, targetHikeFor } from './helpers';

/** One frame of context handed to the assist. */
export interface AssistFrame {
  /** Current boat state (its actuated controls are `state.controls`). */
  state: BoatState;
  /** Bearing the true wind comes FROM, radians. */
  trueWindFromBearing: Radians;
  /** True wind speed, m/s. */
  trueWindSpeed: number;
  /** Active assist level. */
  assist: AssistLevel;
  /** Crew commands edge-triggered THIS frame (e.g. 'prepareTack'). */
  commands: readonly CrewCommand[];
  /** What the player's input mapper wants this frame. */
  driverControls: Readonly<ControlState>;
  /** Fixed timestep, seconds. */
  dt: number;
}

/** The assist's manoeuvre phase. */
export type AssistPhase = 'idle' | 'tacking' | 'gybing';

/** The assist instance. */
export interface SailingAssist {
  /**
   * Compute the controls the assist overrides this frame. Writes ONLY the
   * overridden controls into `out` and returns it (allocation-free — the caller
   * owns `out` and reuses it every frame). Controls NOT written are left as the
   * driver / input mapper set them.
   */
  update(frame: AssistFrame, out: Partial<ControlState>): Partial<ControlState>;
  /** Current manoeuvre phase. */
  readonly phase: AssistPhase;
  /** Reset all internal state (phase, timers, trim memory). */
  reset(): void;
}

/** Options for {@link createSailingAssist}. */
export interface CreateSailingAssistOptions {
  /** Initial assist level. The per-frame `frame.assist` overrides this. */
  assist?: AssistLevel;
}

// ── Tunables (documented, not magic) ─────────────────────────────────────────

/** Sheet-touch epsilon: driver mainsheet differing from the assist's last
 *  output by more than this counts as "the player grabbed the sheet". */
const SHEET_TOUCH_EPS = 0.03;
/** How long the player's sheet override is honoured after they stop touching
 *  it, seconds (SEAM spec: ~1.5 s). */
const OVERRIDE_HOLD_S = 1.5;
/** Seconds in irons (near head-to-wind, near-stopped) before the arcade
 *  anti-stall bears the boat off automatically. */
const IRONS_TIMEOUT_S = 2.0;
/** Safety timeout: abort a scripted manoeuvre that has not completed. */
const MANOEUVRE_TIMEOUT_S = 12.0;
/** Heel (rad) above which capsize-prevention depowers hard (arcade). */
const CAPSIZE_HEEL = (28 * Math.PI) / 180;
/** Entry speed (m/s) below which a tack first foots off briefly to build way.
 *  ≈ 1.8 m/s = 3.5 kt. SI units (the physics unit), NOT knots. */
const TACK_BUILD_SPEED = 1.8;
/** Speed (m/s) at which the build sub-phase is satisfied and commits to the
 *  turn. ≈ 2.3 m/s = 4.5 kt — a workable entry speed to carry through the eye. */
const TACK_ENTRY_SPEED = 2.3;

function wrapPi(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Signed true-wind angle (TWA) off the bow, radians, in (−π, π].
 * Positive = wind coming from the starboard bow (boat on PORT tack).
 * Negative = wind from the port bow (STARBOARD tack).
 *
 * World +X east, +Z south; bearing θ → forward (sinθ, 0, −cosθ). The wind comes
 * FROM `windFrom`; the heading is the bow bearing. TWA is the signed difference
 * between where the wind comes from and where the bow points.
 */
function signedTwa(heading: Radians, windFrom: Radians): number {
  return wrapPi(windFrom - heading);
}

/**
 * Apparent-wind angle off the bow (unsigned, radians) and speed (m/s) from the
 * true wind and the boat's velocity. Allocation-free (scalars only).
 *
 * Decompose in the boat frame: forward = bow, the apparent wind's head-on
 * (comes-from) component is `tws·cos(twa) + boatSpeedAlongBow`, the cross
 * component is `tws·sin(twa)`. (Same velocity triangle as PolarSolver.)
 */
function apparentWind(
  state: BoatState,
  windFrom: Radians,
  tws: number,
): { awa: number; aws: number } {
  const twa = signedTwa(state.heading, windFrom);
  // Boat speed resolved along the bow (approx: use total speed; leeway is small
  // and the assist only needs AWA to a few degrees).
  const boatAlongBow = state.speed;
  const along = tws * Math.cos(twa) + boatAlongBow; // comes-from-ahead component
  const cross = tws * Math.sin(twa);
  const aws = Math.hypot(along, cross);
  const awa = Math.atan2(Math.abs(cross), along);
  return { awa, aws };
}

class SailingAssistImpl implements SailingAssist {
  phase: AssistPhase = 'idle';

  /** The mainsheet value the assist last wrote (for touch detection). */
  private _lastSheet = 0.5;
  /** The driver's mainsheet value last frame (to detect active adjustment). */
  private _lastDriverSheet = 0.5;
  /** Seconds since the player last touched the sheet (clamped at the hold). */
  private _overrideTimer = OVERRIDE_HOLD_S + 1;
  /** Seconds the boat has been stuck in irons. */
  private _ironsTimer = 0;
  /** Latched arcade bear-off direction (0 = not bearing off). */
  private _bearOffSign: 1 | -1 | 0 = 0;
  /** Seconds elapsed in the current scripted manoeuvre. */
  private _manoeuvreTimer = 0;
  /** Signed TWA at the moment a manoeuvre began (to detect the sign flip). */
  private _manoeuvreStartTwaSign = 0;
  /** Speed (m/s) at the moment a manoeuvre began (for recovery completion). */
  private _manoeuvreEntrySpeed = 0;
  /** Target heading for the new tack/gybe, set when a manoeuvre begins. */
  private _manoeuvreTargetHeading = 0;
  /** Bearing of the "eye" to turn through (head-to-wind / dead-downwind). */
  private _eyeBearing = 0;
  /** Did the boat actually pass through the wind/downwind eye yet? */
  private _passedEye = false;
  /** Still in the pre-turn "build speed by bearing off" sub-phase of a tack. */
  private _building = false;

  reset(): void {
    this.phase = 'idle';
    this._lastSheet = 0.5;
    this._lastDriverSheet = 0.5;
    this._overrideTimer = OVERRIDE_HOLD_S + 1;
    this._ironsTimer = 0;
    this._bearOffSign = 0;
    this._manoeuvreTimer = 0;
    this._building = false;
    this._manoeuvreStartTwaSign = 0;
    this._manoeuvreEntrySpeed = 0;
    this._manoeuvreTargetHeading = 0;
    this._eyeBearing = 0;
    this._passedEye = false;
  }

  update(frame: AssistFrame, out: Partial<ControlState>): Partial<ControlState> {
    // Clear the output object (allocation-free: delete known keys we may set).
    clearControls(out);

    const { state, assist, dt } = frame;

    // 'simulation' is strict pass-through: write nothing, ignore commands.
    if (assist === 'simulation') {
      this.phase = 'idle';
      return out;
    }

    const twaSigned = signedTwa(state.heading, frame.trueWindFromBearing);
    const { awa, aws } = apparentWind(state, frame.trueWindFromBearing, frame.trueWindSpeed);
    const awaDeg = (awa * 180) / Math.PI;

    // ── Manoeuvre state machine (tack / gybe) ──────────────────────────────
    if (this.phase === 'idle') {
      for (const cmd of frame.commands) {
        if (cmd === 'prepareTack') {
          this._beginManoeuvre('tacking', twaSigned, frame);
          break;
        }
        if (cmd === 'prepareGybe') {
          this._beginManoeuvre('gybing', twaSigned, frame);
          break;
        }
      }
    }

    if (this.phase !== 'idle') {
      this._runManoeuvre(frame, out, twaSigned, awaDeg, aws);
      return out;
    }

    // ── Steady-state assist: auto-trim + auto-hike ─────────────────────────
    this._autoTrim(frame, out, awaDeg, aws);
    this._autoHike(frame, out, awaDeg, twaSigned);

    // ── Arcade-only extras: anti-stall + capsize prevention ────────────────
    if (assist === 'arcade') {
      this._antiStall(frame, out, twaSigned, dt);
      this._capsizePrevention(frame, out, awaDeg);
    } else {
      this._ironsTimer = 0;
    }

    return out;
  }

  // ── Auto-trim ────────────────────────────────────────────────────────────
  private _autoTrim(
    frame: AssistFrame,
    out: Partial<ControlState>,
    awaDeg: number,
    aws: number,
  ): void {
    const driverSheet = frame.driverControls.mainsheet;
    const ideal = this._depoweredSheet(frame, awaDeg, aws);

    // "Touched" (SEAM): the driver's sheet differs from the assist's last output
    // by more than epsilon. The override then WINS until the player stops
    // adjusting it (holds it steady, frame-to-frame change below epsilon) for
    // ~1.5 s — at which point the assist resumes and trims to its ideal. We
    // require BOTH (differs-from-assist) AND (actively-moving) to START an
    // override, and (holding steady) to time out, so a player who grabs the
    // sheet and holds it off-ideal still hands control back after the hold
    // rather than locking the assist out forever.
    const differsFromAssist = Math.abs(driverSheet - this._lastSheet) > SHEET_TOUCH_EPS;
    const moving = Math.abs(driverSheet - this._lastDriverSheet) > SHEET_TOUCH_EPS;
    this._lastDriverSheet = driverSheet;

    if (differsFromAssist && moving) {
      // Actively overriding: reset the release timer.
      this._overrideTimer = 0;
    } else {
      this._overrideTimer += frame.dt;
    }

    if (differsFromAssist && this._overrideTimer < OVERRIDE_HOLD_S) {
      // Player override in effect: leave the mainsheet to the driver. Keep the
      // assist's remembered output unchanged (so the ideal it will resume to is
      // computed fresh next time), but DO NOT claim the sheet.
      return;
    }

    out.mainsheet = ideal;
    this._lastSheet = ideal;
  }

  /**
   * The assist's target mainsheet: the attached-flow ideal from the apparent
   * wind, EASED toward the LUFFING sheet (minimum sail force) as leeward heel
   * builds past a threshold (depower). This is what lets the 'assisted' level
   * hold a dinghy up in a breeze — a real ILCA sailor eases/luffs the main in
   * the puffs to spill power rather than capsizing.
   *
   * The depower target is the sheet at which the boom sits at the apparent-wind
   * incidence so the angle of attack is ≈0 (the sail luffs — lowest lift AND
   * lowest side force, hence lowest heeling moment). Blending the attached ideal
   * toward THAT sheet is a monotone de-power that works on every point of sail,
   * including close-hauled — unlike the previous version, which only eased on
   * reaches and did NOTHING close-hauled, so a pinching, over-heeling
   * close-hauled boat (the real-game capsize) got no relief. Easing toward the
   * luff is always de-powering: it drops the alpha toward the attachment
   * threshold where lift (and the cross-flow side force) collapse. Bounded and
   * monotone in heel, so it never pumps the roll.
   */
  private _depoweredSheet(frame: AssistFrame, awaDeg: number, aws: number): number {
    const base = idealSheetFor(awaDeg, aws);
    const luff = luffSheetFor(awaDeg);
    const heel = Math.abs(frame.state.heel);
    const onset = (18 * Math.PI) / 180; // start spilling at ~18° leeward heel.
    const full = (32 * Math.PI) / 180; // fully to the luff sheet by ~32°.
    const depower = clamp((heel - onset) / (full - onset), 0, 1);
    // Blend the attached ideal toward the luff sheet. Cap the blend at 0.7 so a
    // good share of drive always remains (keeps steerage way and pointing) unless
    // the arcade/capsize path dumps it fully.
    return base + (luff - base) * (0.7 * depower);
  }

  // ── Auto-hike ──────────────────────────────────────────────────────────────
  private _autoHike(
    frame: AssistFrame,
    out: Partial<ControlState>,
    awaDeg: number,
    twaSigned: number,
  ): void {
    const heel = frame.state.heel;
    const effort = targetHikeFor(heel, awaDeg, frame.trueWindSpeed);
    out.hike = effort;
    // Crew to WINDWARD. CRITICAL: the windward side is derived from the TACK
    // (sign of the true-wind angle), NOT the instantaneous heel sign. Keying it
    // to heel makes crewLateral FLIP every time the boat rolls through upright,
    // which pumps the roll resonantly and capsizes the boat — the exact failure
    // this project's STATUS warns about ("monotone — never flips → no roll
    // pumping"). On a given tack the windward side is fixed:
    //   TWA < 0 (wind off the port bow) → boat heels to starboard → hike to PORT
    //   TWA > 0 (wind off the stbd bow) → boat heels to port      → hike to STBD
    const windwardSign = Math.sign(twaSigned) || (heel >= 0 ? -1 : 1);
    out.crewLateral = windwardSign * effort;
  }

  // ── Anti-stall (arcade): bear off if stuck in irons ────────────────────────
  private _antiStall(
    frame: AssistFrame,
    out: Partial<ControlState>,
    twaSigned: number,
    dt: number,
  ): void {
    // "Stuck": inside the no-go zone and not making real sailing speed. A boat
    // pinched at ~15° TWA making ~1.2 kt is stuck just as much as one dead in
    // irons — the low-speed bear-away limit means it cannot fall off on its own
    // — so the threshold catches the pinch, not only the fully-stopped case.
    const inIrons = Math.abs(twaSigned) < (33 * Math.PI) / 180 && frame.state.speed < 1.5;
    if (inIrons) {
      this._ironsTimer += dt;
    } else {
      this._ironsTimer = 0;
    }
    // Release the latch only once clearly off the wind AND making real way.
    if (this._bearOffSign !== 0 && Math.abs(twaSigned) > (45 * Math.PI) / 180 && frame.state.speed > 1.6) {
      this._bearOffSign = 0;
    }
    if (this._ironsTimer > IRONS_TIMEOUT_S || this._bearOffSign !== 0) {
      // LATCH a bear-off direction the first time we commit, and hold it until
      // the boat is clearly off the wind. Near head-to-wind `twaSigned` flips
      // sign frame-to-frame, so picking the rudder from its instantaneous sign
      // makes the helm chatter ±0.8 and the boat wobbles AT the eye without
      // escaping — latching the direction fixes that.
      if (this._bearOffSign === 0) {
        this._bearOffSign = (Math.sign(twaSigned) || 1) as 1 | -1;
      }
      // Canonical convention: +rudder (to starboard) RAISES the heading bearing;
      // −rudder lowers it. Bearing OFF means turning AWAY from the wind: with the
      // wind off the STARBOARD bow (TWA > 0) you turn to PORT (lower the heading)
      // → −rudder; off the PORT bow (TWA < 0) you turn to starboard → +rudder.
      // So the bear-off rudder is OPPOSITE the sign of TWA. (Under the X-mirrored
      // pre-fix frame the rudder→heading sign was inverted, so the raw code read
      // the other way; the frame unification makes `−sign(TWA)` correct.)
      out.rudder = this._bearOffSign > 0 ? -0.8 : 0.8;
      // Keep the main sheeted so it FILLS and drives the moment the bow falls off
      // the wind — easing it right out (an earlier version used 0.3) left no
      // drive at all, so a boat pinned head-to-wind with low rudder authority
      // never accelerated and never escaped. A moderately sheeted main catches
      // the wind on the leeward side as soon as the latched rudder swings the bow
      // a few degrees off, and the resulting drive compounds the bear-off.
      out.mainsheet = 0.55;
      this._lastSheet = 0.55;
    }
  }

  // ── Capsize prevention (arcade): depower + hike hard as heel builds ─────────
  private _capsizePrevention(
    frame: AssistFrame,
    out: Partial<ControlState>,
    _awaDeg: number,
  ): void {
    const absHeel = Math.abs(frame.state.heel);
    if (absHeel > CAPSIZE_HEEL) {
      // Dump the sheet progressively and pin full hike.
      const over = clamp((absHeel - CAPSIZE_HEEL) / (0.35), 0, 1);
      const dumped = (out.mainsheet ?? this._lastSheet) * (1 - over);
      out.mainsheet = clamp(dumped, 0, 1);
      this._lastSheet = out.mainsheet;
      out.hike = 1;
      const windwardSign = frame.state.heel >= 0 ? -1 : 1;
      out.crewLateral = windwardSign;
    }
  }

  // ── Manoeuvre machinery ─────────────────────────────────────────────────────
  private _beginManoeuvre(
    phase: AssistPhase,
    twaSigned: number,
    frame: AssistFrame,
  ): void {
    this.phase = phase;
    this._manoeuvreTimer = 0;
    this._manoeuvreStartTwaSign = Math.sign(twaSigned) || 1;
    this._manoeuvreEntrySpeed = frame.state.speed;
    this._passedEye = false;
    // Tack technique. A tack from close-hauled turns only ~90° through the eye
    // onto the opposite close-hauled; the shortest, speed-preserving path is to
    // put the helm down and carry the entry momentum straight THROUGH the eye.
    // Only if the boat is genuinely SLOW (< ~1.8 m/s ≈ 3.5 kt, where it would
    // stall mid-turn) does it first foot off a LITTLE (to a close reach, TWA
    // ~58°, NOT a beam reach) to build a knot or two. Bearing off all the way to
    // a beam reach is counter-productive: it turns the subsequent tack into a
    // ~135° sweep that bleeds all the speed and stalls the boat in irons (the
    // documented tack-completion failure). A GYBE always has way off the wind,
    // so it never builds. NOTE the thresholds are in m/s (SI), the physics unit
    // — a previous version compared against values that were really knots
    // (2.6/3.4), so "fast enough to tack" meant 6.6 kt, which close-hauled it
    // never reached, so it ALWAYS ran the long build and never completed.
    this._building = phase === 'tacking' && frame.state.speed < TACK_BUILD_SPEED;
    const windFrom = frame.trueWindFromBearing;
    // New heading on the OPPOSITE tack: mirror the current TWA about the wind
    // axis. signedTwa(heading, windFrom) == −twaSigned → heading = windFrom +
    // twaSigned. For a TACK we FOOT the target ~10° further off the wind than
    // the mirror of the entry angle, so after crossing the eye the boat bears
    // away and rebuilds speed instead of settling pinched and stalling again.
    const startSign = Math.sign(twaSigned) || 1;
    // For a TACK, aim the exit at a CLOSE REACH on the new tack (~72° TWA), not
    // the close-hauled mirror: the boat crosses the eye at near-zero speed and
    // can only accelerate off the wind, so it must bear away to a reach to
    // rebuild way, then the steady assist/player brings it back up to
    // close-hauled. Aiming straight at the pinched close-hauled course leaves it
    // stalled head-to-wind (the documented "stops ~15° short / parks pinched"
    // failure). Exit TWA sign is −startSign (opposite tack).
    const exitTwa = phase === 'tacking' ? -startSign * (72 * Math.PI) / 180 : twaSigned;
    this._manoeuvreTargetHeading = wrapPi(windFrom - exitTwa);
    // The "eye" the boat must turn THROUGH: head-to-wind for a tack (bearing =
    // windFrom), dead-downwind for a gybe (windFrom + π).
    this._eyeBearing = phase === 'tacking' ? windFrom : wrapPi(windFrom + Math.PI);
  }

  private _runManoeuvre(
    frame: AssistFrame,
    out: Partial<ControlState>,
    twaSigned: number,
    awaDeg: number,
    aws: number,
  ): void {
    this._manoeuvreTimer += frame.dt;
    const state = frame.state;

    // Safety timeout: abort and hand control back.
    if (this._manoeuvreTimer > MANOEUVRE_TIMEOUT_S) {
      this.phase = 'idle';
      this._building = false;
      return;
    }

    // Detect passing through the eye: the signed TWA sign has flipped.
    const nowSign = Math.sign(twaSigned) || this._manoeuvreStartTwaSign;
    if (nowSign !== this._manoeuvreStartTwaSign) {
      this._passedEye = true;
    }

    const absHeel = Math.abs(state.heel);

    // ── BUILD-SPEED sub-phase (tack only, before committing to the turn) ─────
    // Foot off a LITTLE — to a close reach (TWA ~58°, NOT a beam reach) — on the
    // CURRENT tack to add a knot or two, then commit. Keeping the foot modest
    // keeps the subsequent turn-through-the-eye close to the minimal ~90° so the
    // boat carries speed across. Commit once the boat has a workable entry speed
    // (≈ TACK_ENTRY_SPEED m/s) OR a short timeout elapses (so a boat that cannot
    // accelerate still tacks rather than waiting forever). Thresholds are SI m/s.
    const BUILD_TARGET_TWA = (58 * Math.PI) / 180;
    const buildTimedOut = this._manoeuvreTimer > 2.0;
    const fastEnough = state.speed > TACK_ENTRY_SPEED;
    if (this._building) {
      if (buildTimedOut || fastEnough) {
        this._building = false;
      } else {
        // Steer to hold/bear off to the build-target TWA on the current tack.
        // Target bearing on the same tack at the build TWA.
        const buildHeading = wrapPi(
          frame.trueWindFromBearing - this._manoeuvreStartTwaSign * BUILD_TARGET_TWA,
        );
        const he = wrapPi(state.heading - buildHeading);
        // Canonical: +rudder raises heading, +ω_y lowers it → rudder = −he + ω_y.
        out.rudder = clamp(-he * 2.0 + state.angularVelocity.y * 0.8, -1, 1);
        // Drive hard (attached) to accelerate, but spill if heel runs up.
        out.mainsheet = this._heelCappedSheet(idealSheetFor(awaDeg, aws), awaDeg, absHeel);
        this._lastSheet = out.mainsheet;
        this._applyManoeuvreHike(frame, out, awaDeg);
        out.board = 1;
        return;
      }
    }

    // ── TURN sub-phase: steer through the eye, then settle on the new heading ─
    // Rudder sign convention (canonical, verified against the sim): POSITIVE
    // rudder (to starboard) turns the heading bearing UP (heading increases);
    // NEGATIVE turns it DOWN. To change heading toward a bearing B:
    // +sign(wrapPi(B − heading))·strength. (Pre-fix this was negated under the
    // X-mirrored frame; the engine-wide frame unification flipped the sign.)
    //
    // Before the eye: steer the bow HARD toward the eye (head-to-wind for a
    // tack, dead-downwind for a gybe) so the boat turns the short way THROUGH
    // the wind. No yaw-rate damping term here — it would fight the rotation and
    // stall the boat head-to-wind. After the eye: a PD onto the new (slightly
    // footed) heading so it settles and accelerates without spinning past.
    let rudder: number;
    if (!this._passedEye) {
      const towardEye = wrapPi(this._eyeBearing - state.heading);
      rudder = Math.sign(towardEye);
    } else {
      const he = wrapPi(state.heading - this._manoeuvreTargetHeading);
      // +rudder raises heading, +ω_y lowers it → rudder = −he + ω_y.
      rudder = clamp(-he * 2.5 + state.angularVelocity.y * 1.0, -1, 1);
    }
    out.rudder = rudder;

    if (this.phase === 'tacking') {
      if (!this._passedEye) {
        // Through the eye, KEEP THE MAIN SHEETED HARD IN. A cat-rigged dinghy
        // tacks by carrying the main in: as the bow comes head-to-wind the main
        // backs and pushes the bow onto the new tack — this is what actually
        // gets a slow boat THROUGH the eye (verified against the sim: luffing or
        // easing the main here stalls the boat head-to-wind and it falls back
        // onto the old tack — the predecessor's one-way-only tack failure; a
        // hard-in main crosses cleanly with < 12° heel). We keep a HEEL CAP so
        // a gust during the cross still can't knock it down, but we do NOT luff.
        out.mainsheet = this._heelCappedSheet(0.85, awaDeg, absHeel);
      } else {
        // Drawing on the new tack: trim toward the new-course ideal (heel-capped
        // so the first power-up after the tack does not knock the boat down).
        // The target heading is footed a few degrees (set in _beginManoeuvre's
        // completion target) so the boat bears away and rebuilds speed.
        out.mainsheet = this._heelCappedSheet(idealSheetFor(awaDeg, aws), awaDeg, absHeel);
      }
      this._lastSheet = out.mainsheet;
    } else {
      // Gybing: keep the sail eased right out through dead-downwind so the boom
      // does not slam across powered up; trim to the new reach once through.
      if (!this._passedEye) {
        out.mainsheet = 0.1;
      } else {
        out.mainsheet = this._heelCappedSheet(idealSheetFor(awaDeg, aws), awaDeg, absHeel);
      }
      this._lastSheet = out.mainsheet;
    }

    this._applyManoeuvreHike(frame, out, awaDeg);
    out.board = 1;

    // Completion: through the eye AND either settled near the exit (reach)
    // heading OR recovered a workable fraction of the entry speed — i.e. the
    // boat is sailing on the NEW tack with way on, at which point the steady
    // assist/player takes over and brings it up to close-hauled. Requiring it to
    // already be pinched on the close-hauled course left it parked head-to-wind;
    // completing onto the reach with speed is the real "tack done" condition.
    const headingErr = wrapPi(state.heading - this._manoeuvreTargetHeading);
    const onCourse = Math.abs(headingErr) < (22 * Math.PI) / 180;
    const recovered = state.speed > Math.max(0.55 * this._manoeuvreEntrySpeed, 1.2);
    if (this._passedEye && (onCourse || recovered)) {
      this.phase = 'idle';
      this._building = false;
    }
  }

  /**
   * Ease the given sheet toward the luff sheet if leeward heel has run up during
   * a manoeuvre — the dynamic analogue of `_depoweredSheet`, but with a tighter
   * onset (a tack/gybe is where a dinghy is most likely to be knocked down). The
   * blend is monotone in heel and bounded, so it spills power to keep the turn
   * flat without pumping the roll.
   */
  private _heelCappedSheet(base: number, awaDeg: number, absHeel: number): number {
    const onset = (11 * Math.PI) / 180;
    const full = (24 * Math.PI) / 180;
    const t = clamp((absHeel - onset) / (full - onset), 0, 1);
    const luff = luffSheetFor(awaDeg);
    return base + (luff - base) * t;
  }

  /** Auto-hike through a manoeuvre: full-effort hike to the LEEWARD-heel's
   *  windward side (crew crosses the boat during the turn; heel-keyed is correct
   *  here because the roll genuinely flips through the tack). */
  private _applyManoeuvreHike(
    frame: AssistFrame,
    out: Partial<ControlState>,
    awaDeg: number,
  ): void {
    const state = frame.state;
    const effort = targetHikeFor(state.heel, awaDeg, frame.trueWindSpeed);
    out.hike = effort;
    const windwardSign = state.heel >= 0 ? -1 : 1;
    out.crewLateral = windwardSign * effort;
  }
}

/** Keys the assist may write — cleared at the top of every `update`. */
const WRITABLE_KEYS: (keyof ControlState)[] = ['mainsheet', 'hike', 'crewLateral', 'rudder', 'board'];

function clearControls(out: Partial<ControlState>): void {
  for (const k of WRITABLE_KEYS) {
    if (out[k] !== undefined) delete out[k];
  }
}

/** Create a sailing assist instance. */
export function createSailingAssist(opts?: CreateSailingAssistOptions): SailingAssist {
  void opts; // the per-frame `frame.assist` is authoritative; opts is advisory.
  return new SailingAssistImpl();
}
