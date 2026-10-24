/**
 * Pure, headless helpers extracted from {@link Session}.
 *
 * Everything the session can compute WITHOUT a DOM, a renderer, or three.js
 * lives here so it is unit-testable under vitest's node environment. The
 * DOM/renderer-bound orchestration (scene graph, GPU, listeners) stays in
 * `Session.ts`.
 *
 * Conventions (non-negotiable — see .kiro/steering/sailing-conventions.md):
 *   - SI and radians internally; knots/NM only at the UI boundary.
 *   - World Y-up, right-handed, +X east, +Z south; bearing θ → (sinθ, 0, −cosθ).
 *   - wind/wave directions are the bearing they come FROM; current is TOWARDS.
 *
 * No three.js import here (src/app may import three, but these helpers stay pure
 * so they run under the node test env with no GPU).
 */

import type {
  AssistLevel,
  BoatState,
  ControlState,
  CrewCommand,
  Environment,
  PolarDiagram,
  Radians,
  SessionTime,
  Vec3,
  WeatherSource,
} from '@/types';
import type { HudInput, HudPreset, HudSailTrim, UnitSystem } from '@game/hud';
import type { CameraFrame, BoatCameraGeometry } from '@game/camera';

// ─── Session time alignment ───────────────────────────────────────────────────

/**
 * The session time to sample the environment / weather at.
 *
 * The session clock advances session seconds from zero at 1× real time (the
 * weather service applies its own time compression internally when sampling the
 * forecast timeline). We expose a hook so the browser smoke test can run on a
 * compressed clock (`?speed=N`) WITHOUT changing the physics dt — only the time
 * the environment is sampled at is scaled. `speed === 1` is the shipped path.
 *
 * @param clockElapsed Raw session seconds from the session clock.
 * @param speed        Clock scale for the test harness (default 1).
 */
export function sessionTimeFor(clockElapsed: SessionTime, speed = 1): SessionTime {
  return clockElapsed * speed;
}

// ─── Wind helpers ──────────────────────────────────────────────────────────────

/** True wind at the boat, as the bearing it comes FROM and its speed (m/s). */
export interface TrueWind {
  fromBearing: Radians;
  speed: number;
}

/** Apparent wind at the rig, as a signed angle off the bow and speed (m/s). */
export interface ApparentWind {
  /** Signed angle off the bow, radians (+ = wind from starboard bow, − = port). */
  angle: Radians;
  speed: number;
}

/**
 * Sample the TRUE wind at the boat from the environment's wind field.
 *
 * `WindSample.direction` is already the meteorological bearing the wind blows
 * FROM — exactly the convention the HUD expects — so we pass it through.
 */
export function sampleTrueWind(
  env: Environment,
  boat: BoatState,
  t: SessionTime,
  coeHeight = 5,
): TrueWind {
  const w = env.wind.sample(boat.position.x, boat.position.z, coeHeight, t);
  return { fromBearing: w.direction, speed: w.speed };
}

/**
 * Compute APPARENT wind at the rig from the true wind velocity and the boat
 * velocity. Returns the speed and the signed angle off the bow.
 *
 * The air's velocity vector points the way the air MOVES (opposite the
 * meteorological "from" bearing): `windVelocity = speed · (−sinθ, −cosθ·−1)`…
 * we take the velocity the field already provides to avoid sign mistakes.
 */
export function computeApparentWind(windVelocity: Vec3, boat: BoatState): ApparentWind {
  // Apparent = true wind velocity − boat velocity (both world-space).
  const ax = windVelocity.x - boat.linearVelocity.x;
  const az = windVelocity.z - boat.linearVelocity.z;
  const speed = Math.hypot(ax, az);

  // Bearing the apparent wind comes FROM = bearing opposite its velocity.
  // velocity bearing = atan2(vx, -vz); from-bearing = that + π.
  const fromBearing = Math.atan2(-ax, az); // == atan2(ax,-az)+π reduced
  // Signed angle off the bow: positive when wind is on the starboard bow.
  const angle = signedAngleOffBow(boat.heading, fromBearing);
  return { angle, speed };
}

/**
 * Signed angle of a FROM-bearing relative to the boat's bow, normalised to
 * (−π, π]. Positive = the source is on the starboard bow.
 */
export function signedAngleOffBow(heading: Radians, fromBearing: Radians): Radians {
  let rel = fromBearing - heading;
  while (rel > Math.PI) rel -= Math.PI * 2;
  while (rel <= -Math.PI) rel += Math.PI * 2;
  return rel;
}

/** Course-over-ground bearing from a world velocity (0 when stationary). */
export function courseOverGround(velocity: Vec3): Radians {
  const speed = Math.hypot(velocity.x, velocity.z);
  if (speed < 1e-4) return 0;
  const b = Math.atan2(velocity.x, -velocity.z);
  return b < 0 ? b + Math.PI * 2 : b;
}

// ─── HUD input assembly ────────────────────────────────────────────────────────

/** Everything buildHudInput needs that is not already on the boat state. */
export interface HudInputSources {
  boat: BoatState;
  controls: ControlState;
  trueWind: TrueWind;
  apparentWind: ApparentWind;
  current: { speed: number; towardsBearing: Radians };
  visibility: number;
  weatherSource: WeatherSource;
  polar: PolarDiagram;
  nextMark: { id: string; position: { x: number; y: number } } | null;
  sails?: readonly HudSailTrim[];
  preset: HudPreset;
  units: UnitSystem;
  opaqueBackdrop: boolean;
}

/**
 * Build the frozen-shape {@link HudInput} the HUD view model consumes.
 *
 * Pure: no allocation beyond the returned object (the session reuses the result
 * via `buildHudViewModel(out)` downstream). Units stay SI/radians here — the
 * knots/NM conversion happens inside `buildHudViewModel`/`formatHud`, never here.
 */
export function buildHudInput(s: HudInputSources): HudInput {
  return {
    boat: s.boat,
    controls: s.controls,
    trueWind: { speed: s.trueWind.speed, fromBearing: s.trueWind.fromBearing },
    apparentWind: { speed: s.apparentWind.speed, angle: s.apparentWind.angle },
    courseOverGround: courseOverGround(s.boat.linearVelocity),
    speedOverGround: Math.hypot(s.boat.linearVelocity.x, s.boat.linearVelocity.z),
    weatherSource: s.weatherSource,
    visibility: s.visibility,
    current: { speed: s.current.speed, towardsBearing: s.current.towardsBearing },
    targetSpeed: (tws, twa) => s.polar.targetSpeed(tws, twa),
    nextMark: s.nextMark,
    ...(s.sails !== undefined ? { sails: s.sails } : {}),
    preset: s.preset,
    units: s.units,
    opaqueBackdrop: s.opaqueBackdrop,
  };
}

// ─── Camera frame assembly ───────────────────────────────────────────────────

/** Inputs to buildCameraFrame beyond the interpolated boat state. */
export interface CameraFrameSources {
  boatState: BoatState;
  geometry: BoatCameraGeometry;
  slam: number;
  time: number;
  lookDelta: { x: number; y: number };
  marks: readonly Vec3[];
  otherBoats: readonly Vec3[];
  sunDirection?: Vec3;
  isLand?: (x: number, z: number) => boolean;
}

/**
 * Build the {@link CameraFrame} the pure camera controller consumes from an
 * (interpolated) boat state. Fills a reusable `out` object for allocation-free
 * steady state.
 */
export function buildCameraFrame(s: CameraFrameSources, out: CameraFrame): CameraFrame {
  const st = s.boatState;
  out.boatPosition = st.position;
  out.boatOrientation = st.orientation;
  out.boatVelocity = st.linearVelocity;
  out.heel = st.heel;
  out.pitch = st.pitch;
  out.heading = st.heading;
  out.slam = s.slam;
  out.geometry = s.geometry;
  out.time = s.time;
  out.lookDelta = s.lookDelta;
  out.marks = s.marks;
  out.otherBoats = s.otherBoats;
  if (s.sunDirection !== undefined) out.sunDirection = s.sunDirection;
  else delete (out as { sunDirection?: Vec3 }).sunDirection;
  if (s.isLand !== undefined) out.isLand = s.isLand;
  else delete (out as { isLand?: (x: number, z: number) => boolean }).isLand;
  return out;
}

// ─── Fixed-step ordering ───────────────────────────────────────────────────────

/**
 * One fixed physics step, in the mandated order: input → assist → setControls →
 * sim.step. Extracted as a pure helper so the ORDER is unit-testable without a
 * renderer. The caller supplies the four side-effecting callbacks; this function
 * guarantees they fire exactly once each, in order.
 */
export interface FixedStepHooks {
  /** 1. Read input, returning the driver control patch + crew commands. */
  readInput(): { controls: Partial<ControlState>; commands: readonly CrewCommand[] };
  /** 2. Run the assist over the driver patch, returning the final control patch. */
  runAssist(
    driver: Partial<ControlState>,
    commands: readonly CrewCommand[],
  ): Partial<ControlState>;
  /** 3. Push the final controls to the simulation. */
  setControls(patch: Partial<ControlState>): void;
  /** 4. Advance the simulation by one fixed step. */
  stepSim(): void;
}

/** Run one fixed step in the canonical order. Returns the order tag list (for tests). */
export function runFixedStep(hooks: FixedStepHooks): readonly string[] {
  const order: string[] = [];
  const { controls, commands } = hooks.readInput();
  order.push('input');
  const patch = hooks.runAssist(controls, commands);
  order.push('assist');
  hooks.setControls(patch);
  order.push('setControls');
  hooks.stepSim();
  order.push('step');
  return order;
}

// ─── Query-string / backend parsing ────────────────────────────────────────────

/** Parsed session launch options from the URL query string. */
export interface LaunchOptions {
  /** Force the WebGL2 backend (`?backend=webgl`). */
  forceWebGL: boolean;
  /** Prefer the WebGPU backend explicitly (`?backend=webgpu`). Advisory only. */
  preferWebGPU: boolean;
  /** Run the scripted autosail provider (`?autosail=1`). */
  autosail: boolean;
  /** Force the offline fallback ladder, no network (`?offline=1`). */
  offline: boolean;
  /** Clock speed scale for the test harness (`?speed=N`, 1..60). */
  speed: number;
}

/** Parse launch options from a query string (e.g. `window.location.search`). */
export function parseLaunchOptions(search: string): LaunchOptions {
  const params = new URLSearchParams(search);
  const backend = (params.get('backend') ?? '').toLowerCase();
  const speedRaw = Number.parseFloat(params.get('speed') ?? '1');
  const speed = Number.isFinite(speedRaw) ? Math.max(1, Math.min(60, speedRaw)) : 1;
  return {
    forceWebGL: backend === 'webgl' || backend === 'webgl2',
    preferWebGPU: backend === 'webgpu',
    autosail: params.get('autosail') === '1',
    offline: params.get('offline') === '1',
    speed,
  };
}

// ─── Scripted autosail input provider ──────────────────────────────────────────

/**
 * A scripted input provider used by the `?autosail=1` browser smoke test. It
 * does NOT touch the DOM: it produces a control patch + crew commands as a
 * function of elapsed session time (and, when supplied, the boat state + true
 * wind so it can steer with a simple PD helm), so the browser test exercises a
 * meaningful, deterministic sail: steer onto a close-hauled course, sail, TACK,
 * sail, then bear away onto a broad reach and GYBE.
 *
 * The helm (`frame`) is the SCRIPT'S job (the human steers in 'assisted'); the
 * assist owns the sheet, hike and — during a manoeuvre — the rudder. The script
 * only sets a target heading each phase and runs a PD onto it; between the
 * `prepareTack`/`prepareGybe` command and the assist handing control back, the
 * assist's rudder override wins, so the two never fight.
 *
 * If no boat state / wind is supplied (the legacy `frame(t)` call), it falls
 * back to a gentle open-loop helm so the smoke test still observes motion and a
 * tack — exactly the previous behaviour.
 *
 * Sequence (seconds of session time, wind FROM `windFromBearing`):
 *   - 0..2:     bear away slightly, sheet in, board down — build initial way.
 *   - 2..6:     steer to a FOOTED close-hauled (TWA ~50°) on the start tack.
 *   - 6..26:    hold close-hauled (~20 s of sailing).
 *   - 26:       emit a single `prepareTack` (edge). 26.. hold the new close-hauled.
 *   - 46:       bear away toward a broad reach (TWA ~140°) and sail.
 *   - 56:       emit a single `prepareGybe` (edge). 56.. hold the new broad reach.
 */
export interface ScriptedHelmInput {
  /** Current boat heading, radians (bearing from north). */
  heading: Radians;
  /** Current boat yaw rate, rad/s (for PD damping). */
  yawRate: number;
  /** Bearing the true wind comes FROM, radians. */
  windFromBearing: Radians;
}

export class ScriptedInputProvider {
  private _tackSent = false;
  private _gybeSent = false;
  /** The start-tack sign (set on the first PD frame): +1 = wind off stbd bow. */
  private _startTackSign = 0;
  private readonly _controls: Partial<ControlState> = {
    rudder: 0,
    mainsheet: 0.6,
    board: 1,
    hike: 0,
  };
  private readonly _commands: CrewCommand[] = [];

  /** True once the scripted tack command has been issued. */
  get tackIssued(): boolean {
    return this._tackSent;
  }

  /** True once the scripted gybe command has been issued. */
  get gybeIssued(): boolean {
    return this._gybeSent;
  }

  /** Reset for a fresh run. */
  reset(): void {
    this._tackSent = false;
    this._gybeSent = false;
    this._startTackSign = 0;
  }

  /**
   * Produce the scripted controls + commands for the given session time.
   * Pass `helm` (boat heading/yaw + true-wind bearing) to engage the PD helm and
   * the full tack+gybe sequence; omit it for the legacy open-loop fallback.
   * The returned objects are reused — copy if you need to retain them.
   */
  frame(
    sessionTime: number,
    helm?: ScriptedHelmInput,
  ): { controls: Partial<ControlState>; commands: readonly CrewCommand[] } {
    this._commands.length = 0;
    this._controls.mainsheet = 0.6;
    this._controls.board = 1;
    this._controls.hike = sessionTime > 2 ? 1 : 0;

    if (helm === undefined) {
      // ── Legacy open-loop fallback (no state available) — unchanged behaviour
      // so the existing smoke test (sheet 0.7, tack at 20 s) stays valid. ──
      this._controls.mainsheet = 0.7;
      if (sessionTime < 2) this._controls.rudder = 0.1;
      else if (sessionTime < 20) this._controls.rudder = -0.15;
      else {
        this._controls.rudder = 0;
        if (!this._tackSent) {
          this._commands.push('prepareTack');
          this._tackSent = true;
        }
      }
      return { controls: this._controls, commands: this._commands };
    }

    // ── PD-helm closed-loop sequence ──
    const wf = helm.windFromBearing;
    // Latch the starting tack the first time we see state (which bow the wind is
    // on at spawn); default to starboard (+1) if dead head-to-wind.
    if (this._startTackSign === 0) {
      const spawnTwa = wrapToPiLocal(wf - helm.heading);
      this._startTackSign = spawnTwa >= 0 ? 1 : -1;
    }
    const s = this._startTackSign;
    const CLOSE = (50 * Math.PI) / 180; // footed close-hauled TWA.
    const BROAD = (140 * Math.PI) / 180; // broad reach TWA.

    // Target TWA per phase (signed; + = wind off starboard bow = port tack):
    //   start-tack close-hauled → tack → opposite close-hauled → bear away →
    //   broad reach → gybe → opposite broad reach.
    let targetTwa: number;
    if (sessionTime < 26) {
      targetTwa = s * CLOSE; // start tack, close-hauled.
    } else if (sessionTime < 46) {
      targetTwa = -s * CLOSE; // after the tack, opposite close-hauled.
      if (!this._tackSent && sessionTime >= 26) {
        this._commands.push('prepareTack');
        this._tackSent = true;
      }
    } else if (sessionTime < 56) {
      targetTwa = -s * BROAD; // bear away onto a broad reach (same tack as post-tack).
    } else {
      targetTwa = s * BROAD; // after the gybe, opposite broad reach.
      if (!this._gybeSent && sessionTime >= 56) {
        this._commands.push('prepareGybe');
        this._gybeSent = true;
      }
    }

    // PD helm onto the target heading for the desired TWA.
    // Canonical convention: +rudder (starboard) RAISES heading; +ω_y LOWERS it
    // (the heading quaternion is a rotation about +Y by −heading). So rudder =
    // −he + ω_y. (Pre-fix this used +he − ω_y under the X-mirrored frame.)
    const targetHeading = wf - targetTwa;
    const he = wrapToPiLocal(helm.heading - targetHeading);
    const rudder = -he * 2.0 + helm.yawRate * 1.2;
    this._controls.rudder = rudder < -1 ? -1 : rudder > 1 ? 1 : rudder;
    // Leave the MAINSHEET to the assist's auto-trim (do NOT command it here).
    // The script commanding a fixed sheet (0.6) every frame looked to the assist
    // like a continuous "player grab", locking out its auto-trim, so the sail
    // stayed over-trimmed (~85%) on a reach and the boat crabbed at ~1 kt — the
    // reported live-run defect. With the sheet omitted, the Session fills the
    // driver sheet from the boat's current (assist-set) value, so the assist
    // trims freely to the apparent-wind ideal and the boat makes its speed.
    delete this._controls.mainsheet;

    return { controls: this._controls, commands: this._commands };
  }
}

/** Wrap an angle into (−π, π]. Local copy (keeps this helper import-free). */
function wrapToPiLocal(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x <= -Math.PI) x += 2 * Math.PI;
  return x;
}

/** Map an assist string to the frozen {@link AssistLevel}, defaulting to assisted. */
export function toAssistLevel(value: string | undefined): AssistLevel {
  if (value === 'arcade' || value === 'assisted' || value === 'simulation') return value;
  return 'assisted';
}
