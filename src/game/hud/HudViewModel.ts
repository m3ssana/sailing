/**
 * `buildHudViewModel` — the single pure function the render loop calls each UI
 * tick to turn raw SI/radians simulation state into a flat, display-ready view
 * model (numbers + enums; no strings, no three.js, no React).
 *
 * String formatting lives in `formatHud.ts`; this layer only computes numbers
 * and chooses display units. Unit conversions use the exact `UNITS` constants
 * (derived from 1852/3600) so a round trip is lossless.
 *
 * Allocation discipline: pass a reusable `out` object to mutate in place. The
 * steady-state per-frame path then allocates nothing (asserted by a test).
 */

import { UNITS } from '@/types/units';
import type {
  ConditionsViewModel,
  DistanceReadout,
  HudInput,
  HudViewModel,
  SpeedReadout,
  UnitSystem,
} from './types';
import { widgetVisibility } from './presets';
import {
  bearingTo,
  computeVmg,
  distanceTo,
  laylineBearings,
  optimalUpwindTwa,
  pointOfSail,
  targetSpeedFraction,
  windAngleOffBow,
} from './navMath';

/** Below this distance, knots/NM display switches mark distance to metres. */
export const SHORT_DISTANCE_METRES = 1000;
/** Above this distance, metric display switches to kilometres. */
const KM_DISTANCE_METRES = 1000;

function toKnots(mps: number): number {
  return mps * UNITS.MS_TO_KNOTS;
}

function fillSpeed(out: SpeedReadout, mps: number, units: UnitSystem): SpeedReadout {
  out.mps = mps;
  out.display = units === 'knotsNm' ? toKnots(mps) : mps;
  return out;
}

function fillDistance(out: DistanceReadout, metres: number, units: UnitSystem): DistanceReadout {
  out.metres = metres;
  if (units === 'knotsNm') {
    if (metres < SHORT_DISTANCE_METRES) {
      out.display = metres;
      out.unit = 'm';
    } else {
      out.display = metres * UNITS.M_TO_NM;
      out.unit = 'nm';
    }
  } else {
    if (metres >= KM_DISTANCE_METRES) {
      out.display = metres / 1000;
      out.unit = 'km';
    } else {
      out.display = metres;
      out.unit = 'm';
    }
  }
  return out;
}

/** Create an empty view model, suitable for reuse as the `out` argument. */
export function createHudViewModel(): HudViewModel {
  const speed = (): SpeedReadout => ({ mps: 0, display: 0 });
  const dist = (): DistanceReadout => ({ metres: 0, display: 0, unit: 'm' });
  return {
    preset: 'full',
    units: 'knotsNm',
    opaqueBackdrop: false,
    visible: {
      wind: true,
      speed: true,
      trim: true,
      heelHelm: true,
      compass: true,
      conditions: true,
      coaching: true,
    },
    wind: {
      apparentAngle: 0,
      apparentSpeed: speed(),
      trueAngle: 0,
      trueSpeed: speed(),
      trueFromBearing: 0,
      pointOfSail: 'head-to-wind',
      tack: 'starboard',
      laylines: { port: 0, starboard: 0 },
      tackAngle: 0,
    },
    speed: {
      sog: speed(),
      vmgUpwind: speed(),
      vmgDownwind: speed(),
      targetFraction: 0,
      target: speed(),
    },
    trim: {
      mainsheet: 0,
      jibsheet: 0,
      traveller: 0,
      board: 0,
      rudder: 0,
      vang: 0,
      sails: [],
    },
    heelHelm: { heel: 0, pitch: 0, helmLoad: 0, capsized: false },
    compass: { heading: 0, cog: 0, bearingToMark: null, distanceToMark: null, markId: null },
    conditions: {
      source: 'default',
      simulated: false,
      trueWindSpeed: speed(),
      trueWindFrom: 0,
      currentSpeed: speed(),
      currentTowards: 0,
      visibility: dist(),
    },
    coaching: null,
  };
}

/**
 * Build (or re-fill) the HUD view model from one frame of simulation state.
 *
 * @param input raw SI/radians state
 * @param out   optional view model to mutate in place for allocation-free reuse
 */
export function buildHudViewModel(input: HudInput, out?: HudViewModel): HudViewModel {
  const vm = out ?? createHudViewModel();
  const { units } = input;

  vm.preset = input.preset;
  vm.units = units;
  vm.opaqueBackdrop = input.opaqueBackdrop;

  // Visibility: overwrite each key (does not reallocate the record).
  const vis = widgetVisibility(input.preset);
  vm.visible.wind = vis.wind;
  vm.visible.speed = vis.speed;
  vm.visible.trim = vis.trim;
  vm.visible.heelHelm = vis.heelHelm;
  vm.visible.compass = vis.compass;
  vm.visible.conditions = vis.conditions;
  vm.visible.coaching = vis.coaching;

  // ── Wind ────────────────────────────────────────────────────────────────
  const heading = input.boat.heading;
  const trueAngle = windAngleOffBow(heading, input.trueWind.fromBearing);
  vm.wind.apparentAngle = input.apparentWind.angle;
  vm.wind.trueAngle = trueAngle;
  vm.wind.trueFromBearing = input.trueWind.fromBearing;
  fillSpeed(vm.wind.apparentSpeed, input.apparentWind.speed, units);
  fillSpeed(vm.wind.trueSpeed, input.trueWind.speed, units);
  vm.wind.pointOfSail = pointOfSail(trueAngle);
  vm.wind.tack = trueAngle >= 0 ? 'starboard' : 'port';
  const tackAngle = optimalUpwindTwa(input.trueWind.speed, input.targetSpeed);
  vm.wind.tackAngle = tackAngle;
  const lay = laylineBearings(input.trueWind.fromBearing, tackAngle);
  vm.wind.laylines.port = lay.port;
  vm.wind.laylines.starboard = lay.starboard;

  // ── Speed + VMG ─────────────────────────────────────────────────────────
  const vmg = computeVmg(input.speedOverGround, input.courseOverGround, input.trueWind.fromBearing);
  fillSpeed(vm.speed.sog, input.speedOverGround, units);
  fillSpeed(vm.speed.vmgUpwind, vmg.upwind, units);
  fillSpeed(vm.speed.vmgDownwind, vmg.downwind, units);
  const target = input.targetSpeed(input.trueWind.speed, Math.abs(trueAngle));
  fillSpeed(vm.speed.target, target, units);
  vm.speed.targetFraction = targetSpeedFraction(
    input.speedOverGround,
    input.trueWind.speed,
    trueAngle,
    input.targetSpeed,
  );

  // ── Trim ────────────────────────────────────────────────────────────────
  vm.trim.mainsheet = input.controls.mainsheet;
  vm.trim.jibsheet = input.controls.jibsheet;
  vm.trim.traveller = input.controls.traveller;
  vm.trim.board = input.controls.board;
  vm.trim.rudder = input.controls.rudder;
  vm.trim.vang = input.controls.vang;
  // Sails: shallow-copy the supplied array (physics owns the source objects).
  vm.trim.sails = input.sails ?? [];

  // ── Heel + helm ───────────────────────────────────────────────────────────
  vm.heelHelm.heel = input.boat.heel;
  vm.heelHelm.pitch = input.boat.pitch;
  vm.heelHelm.helmLoad = input.boat.helmLoad;
  vm.heelHelm.capsized = input.boat.capsized;

  // ── Compass ───────────────────────────────────────────────────────────────
  vm.compass.heading = heading;
  vm.compass.cog = input.courseOverGround;
  if (input.nextMark) {
    const from = { x: input.boat.position.x, y: input.boat.position.z };
    vm.compass.bearingToMark = bearingTo(from, input.nextMark.position);
    vm.compass.distanceToMark = fillDistance(
      vm.compass.distanceToMark ?? { metres: 0, display: 0, unit: 'm' },
      distanceTo(from, input.nextMark.position),
      units,
    );
    vm.compass.markId = input.nextMark.id;
  } else {
    vm.compass.bearingToMark = null;
    vm.compass.distanceToMark = null;
    vm.compass.markId = null;
  }

  // ── Conditions ────────────────────────────────────────────────────────────
  const c: ConditionsViewModel = vm.conditions;
  c.source = input.weatherSource;
  c.simulated = input.weatherSource === 'sandbox';
  fillSpeed(c.trueWindSpeed, input.trueWind.speed, units);
  c.trueWindFrom = input.trueWind.fromBearing;
  fillSpeed(c.currentSpeed, input.current.speed, units);
  c.currentTowards = input.current.towardsBearing;
  fillDistance(c.visibility, input.visibility, units);

  // ── Coaching ──────────────────────────────────────────────────────────────
  if (input.coaching) {
    // Reuse the existing coaching object when ids match, else replace it.
    if (vm.coaching && vm.coaching.id === input.coaching.id) {
      vm.coaching.message = input.coaching.message;
      vm.coaching.severity = input.coaching.severity;
    } else {
      vm.coaching = {
        id: input.coaching.id,
        message: input.coaching.message,
        severity: input.coaching.severity,
      };
    }
  } else {
    vm.coaching = null;
  }

  return vm;
}
