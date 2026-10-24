/**
 * buildSessionWorld — the PURE, headless construction of the simulated world a
 * {@link Session} runs: the venue weather snapshot (offline ladder by default),
 * the venue {@link Environment} (REAL spectrum wave field + tide/current + wind
 * influence), the dinghy {@link BoatSimulation}, its polar, and the true-wind
 * sampler.
 *
 * It contains NO three.js, NO DOM and NO renderer, so it runs under vitest's
 * node environment. `Session.ts` calls this for the physics world and layers the
 * scene graph / GPU / input / HUD on top; a headless acceptance test calls it to
 * reproduce EXACTLY the conditions the real game sails in (the real wave field,
 * the real tide/current, the real spawn) without a browser.
 *
 * This is the single source of truth for "what the Session sails in", so a test
 * that drives it cannot drift from the shipped game the way a hand-rolled
 * synthetic environment would — the gap this harness was written to close.
 *
 * Conventions (non-negotiable — see .kiro/steering/sailing-conventions.md):
 *   - SI and radians internally; knots/NM only at the UI boundary.
 *   - World Y-up, right-handed, +X east, +Z south; bearing θ → (sinθ, 0, −cosθ).
 *   - wind/wave directions are the bearing they come FROM; current is TOWARDS.
 */

import type {
  BoatDefinition,
  Environment,
  PolarDiagram,
  Vec3,
  VenueDefinition,
  WaveField,
  WaveSpectrumParams,
  WeatherSnapshot,
} from '@/types';

import { resolveOffline } from '@weather/index';
import { requireVenue, createVenueEnvironment } from '@venues/index';
import { createWaveFieldCPU } from '@environment/waves';
import { getBoatDefinition, createBoatSimulation } from '@boats/index';
import type { BoatSimulationBundle } from '@boats/index';
import { solvePolar } from '@physics/PolarSolver';

/** Options for {@link buildSessionWorld}. */
export interface BuildSessionWorldOptions {
  /** Venue id. Default 'newport'. */
  venueId?: string;
  /** Boat id. Default 'dinghy'. */
  boatId?: string;
  /**
   * An explicit weather snapshot. When absent, the OFFLINE ladder is used
   * (`resolveOffline(venue)` → seasonal climatology), exactly as the Session's
   * `?offline=1` path does. A test can inject a fixed snapshot for determinism.
   */
  snapshot?: WeatherSnapshot;
  /** Session-start epoch ms used for tide phase alignment. Default snapshot.fetchedAt. */
  nowMs?: number;
  /**
   * Build the boat simulation with WaveDrag included. Default true (shipped).
   * The reproduction/bisect harness toggles this to isolate wave-added drag.
   */
  includeWaveDrag?: boolean;
  /**
   * Override the wave field entirely. Default: a real spectrum-derived field
   * built from the snapshot sea state (what the Session uses). Pass a flat stub
   * (`FLAT_WAVE_FIELD`) to bisect the effect of waves.
   */
  waveField?: WaveField;
  /**
   * Suppress the venue wave field (use flat water). Convenience for the bisect
   * harness; ignored when `waveField` is given explicitly. Default false.
   */
  flatWater?: boolean;
}

/** The pure, headless simulated world a Session (or a test) sails in. */
export interface SessionWorld {
  venue: VenueDefinition;
  boatDef: BoatDefinition;
  snapshot: WeatherSnapshot;
  environment: Environment;
  boat: BoatSimulationBundle;
  polar: PolarDiagram;
  /** The wave field injected into the environment (shared with the render clipmap). */
  waveField: WaveField;
  /** Spawn position (world) and heading (radians), already applied to the sim. */
  spawn: { position: Vec3; heading: number };
}

/**
 * A flat-water {@link WaveField} for the bisect harness: zero height, zero
 * orbital velocity, upright normal. Significant height is reported as 0 so
 * `HydroResistance`'s added-resistance-in-waves term is also disabled.
 */
export const FLAT_WAVE_FIELD: WaveField = {
  height: () => 0,
  displacement: (_x, _z, _t, out) => {
    const o = out ?? { x: 0, y: 0, z: 0 };
    o.x = 0;
    o.y = 0;
    o.z = 0;
    return o;
  },
  normal: (_x, _z, _t, out) => {
    const o = out ?? { x: 0, y: 1, z: 0 };
    o.x = 0;
    o.y = 1;
    o.z = 0;
    return o;
  },
  orbitalVelocity: (_x, _z, _y, _t, out) => {
    const o = out ?? { x: 0, y: 0, z: 0 };
    o.x = 0;
    o.y = 0;
    o.z = 0;
    return o;
  },
  components: [],
  params: {
    windSpeed: 0,
    windDirection: 0,
    fetch: 1000,
    significantHeight: 0,
    swellHeight: 0,
    swellPeriod: 8,
    swellDirection: 0,
    peakEnhancement: 3.3,
    directionalSpread: 20,
    depth: 50,
    currentVelocity: { x: 0, y: 0 },
    seed: 0,
  },
};

/**
 * Build a spectrum-derived {@link WaveField} from a snapshot's sea state. This
 * is the SAME construction the Session uses (and the one the render clipmap
 * mirrors), so the physics and the visible sea share wave components.
 *
 * Maps the normalized snapshot sea/wind to `WaveSpectrumParams`: directions are
 * the bearings the sea/wind come FROM (snapshot convention), which
 * `WaveSpectrum` converts to travel directions internally. Depth is the venue's
 * channel depth; current is taken flat (the current field handles tidal set).
 * Deterministic in `seed`.
 */
export function buildWaveFieldForVenue(
  venue: VenueDefinition,
  snapshot: WeatherSnapshot,
): WaveField {
  const sea = snapshot.sea;
  const params: WaveSpectrumParams = {
    windSpeed: snapshot.wind.trueSpeed,
    windDirection: snapshot.wind.trueDirection,
    fetch: venue.windProfile.fetch,
    significantHeight: sea.significantHeight,
    swellHeight: sea.swell.height,
    swellPeriod: sea.swell.period,
    swellDirection: sea.swell.direction,
    peakEnhancement: 3.3,
    directionalSpread: 8,
    depth: Math.max(2, venue.maxDepth),
    currentVelocity: { x: 0, y: 0 },
    seed: 0,
  };
  return createWaveFieldCPU(params);
}

function requireBoat(id: string): BoatDefinition {
  const def = getBoatDefinition(id);
  if (def === undefined) {
    throw new Error(`buildSessionWorld: unknown boat id '${id}'`);
  }
  return def;
}

/**
 * Build the pure simulated world. Resolves the offline snapshot (or uses the
 * injected one), builds the real venue environment with the spectrum wave field,
 * creates the dinghy simulation, resets it to the venue spawn, and solves the
 * polar.
 */
export function buildSessionWorld(opts: BuildSessionWorldOptions = {}): SessionWorld {
  const venue = requireVenue(opts.venueId ?? 'newport');
  const boatDef = requireBoat(opts.boatId ?? 'dinghy');

  const snapshot = opts.snapshot ?? resolveOffline(venue);
  const nowMs = opts.nowMs ?? snapshot.fetchedAt;

  const waveField: WaveField =
    opts.waveField ??
    (opts.flatWater ? FLAT_WAVE_FIELD : buildWaveFieldForVenue(venue, snapshot));

  const venueEnv = createVenueEnvironment(venue, snapshot, nowMs, { waveField });
  const environment = venueEnv.environment;

  const boat = createBoatSimulation(boatDef, {
    ...(opts.includeWaveDrag !== undefined ? { includeWaveDrag: opts.includeWaveDrag } : {}),
  });
  const polar = solvePolar(boat.spec);

  const spawnPos: Vec3 = { x: venue.spawn.position.x, y: 0, z: venue.spawn.position.y };
  boat.sim.reset(spawnPos, venue.spawn.heading);

  return {
    venue,
    boatDef,
    snapshot,
    environment,
    boat,
    polar,
    waveField,
    spawn: { position: spawnPos, heading: venue.spawn.heading },
  };
}
