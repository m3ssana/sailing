/**
 * Stream F — atmosphere integration facade. Public barrel.
 *
 * `createAtmosphereSystem` owns and orchestrates the sky dome, environment
 * probe, weather visuals, night system, shadow rig, and the water hookups
 * behind one `update(AtmosphereFrame)`; `createPost` builds the post chain once
 * a live renderer exists; `attachNavLightsToBoatView` mounts COLREGs nav lights
 * on a boat render view.
 */

export {
  createAtmosphereSystem,
  attachNavLightsToBoatView,
  type AtmosphereSystem,
  type AtmosphereSystemOptions,
  type AtmosphereFrame,
  type AtmosphereCamera,
  type NavLightBoatView,
  type NavLightDimensions,
} from './AtmosphereSystem';
