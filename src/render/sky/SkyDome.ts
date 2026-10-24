/**
 * SkyDome — TSL sky dome mirroring AtmosphereModel (Stream F.1).
 *
 * A large inverted sphere that follows the camera, rendered with depthWrite
 * off and back faces so it always sits behind everything. Its colour node is a
 * TSL graph that reproduces the CPU `AtmosphereModel`'s single-scattering look:
 * a Rayleigh-blue zenith fading to a Mie-hazy horizon, a forward-scatter glow
 * around the sun, a limb-darkened sun disc, and a night-sky base that fades in
 * with `nightFactor`.
 *
 * ## Mirroring, not re-deriving
 *
 * The exact closed-form optical-depth integral of AtmosphereModel is expensive
 * to replicate per-fragment, so the dome uses the same *phase functions* and the
 * same zenith/horizon colours (fed in as uniforms straight from the CPU model)
 * blended by a height gradient, plus the Mie forward glow. This is a documented
 * rendering-layer simplification: the CPU `skyRadiance` remains the reference;
 * the dome is tuned to match its hue/brightness trend, not its exact radiance.
 *
 * ## Night & stars hook
 *
 * Stars and moon are Stream F.4's responsibility. This module exposes an
 * `extraEmissiveNode` option and a documented insertion point so F.4 can add
 * them WITHOUT this module importing from src/render/night.
 *
 * Conventions: Linear RGB; Y-up; sun direction FROM scene TOWARDS sun.
 */

import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  vec3,
  mix,
  uniform,
  positionWorld,
  cameraPosition,
  type TSLNode,
} from 'three/tsl';
import type { RGB, SkyState } from '@/types';
import type { LightingState } from '@render/lighting/LightingState';
import { MIE_G, SUN_DISC_RENDER_RADIUS } from './AtmosphereModel';

export interface SkyDomeOptions {
  /** Dome radius in world metres. Should sit inside the camera far plane. */
  radius?: number;
  /**
   * Optional additional emissive node added on top of the sky colour — the
   * documented insertion point for F.4's stars/moon. Added as-is (linear RGB).
   */
  extraEmissiveNode?: TSLNode;
}

export interface SkyDomeUniforms {
  sunDirection: TSLNode & { value: unknown };
  zenithColor: TSLNode & { value: unknown };
  horizonColor: TSLNode & { value: unknown };
  sunColor: TSLNode & { value: unknown };
  /** Relative sun illuminance (drives disc + glow brightness). */
  sunIntensity: TSLNode & { value: unknown };
  /** 0 day .. 1 night; fades the blue sky to the night base. */
  nightFactor: TSLNode & { value: unknown };
  /** 0 clear .. 1 overcast; greys/flattens the gradient. */
  overcast: TSLNode & { value: unknown };
}

export interface SkyDome {
  mesh: THREE.Mesh;
  update(sky: SkyState, lighting: LightingState, cameraPos: { x: number; y: number; z: number }): void;
  dispose(): void;
  uniforms: SkyDomeUniforms;
}

/** Night-sky base colour (deep blue), linear RGB. */
const NIGHT_BASE: RGB = { r: 0.004, g: 0.008, b: 0.02 };

export function createSkyDome(opts: SkyDomeOptions = {}): SkyDome {
  const radius = opts.radius ?? 8000;

  // ─── Uniforms ──────────────────────────────────────────────────────────────
  const uSunDir = uniform(new THREE.Vector3(0, 1, 0));
  const uZenith = uniform(new THREE.Color(0.2, 0.4, 0.8));
  const uHorizon = uniform(new THREE.Color(0.6, 0.75, 0.9));
  const uSunColor = uniform(new THREE.Color(1, 0.96, 0.9));
  const uSunIntensity = uniform(1);
  const uNight = uniform(0);
  const uOvercast = uniform(0);

  const gMie = float(MIE_G);
  const discRadius = float(SUN_DISC_RENDER_RADIUS);

  // ─── Colour graph (mirrors AtmosphereModel look) ─────────────────────────────
  const colorNode: TSLNode = Fn(() => {
    // View direction = from camera toward this dome fragment.
    const viewDir = positionWorld.sub(cameraPosition).normalize();

    // Up-cosine via dot with world up. Height gradient drives zenith↔horizon.
    const up = vec3(0, 1, 0);
    const viewUp = viewDir.dot(up).saturate();

    // cos(angle) between view and sun for the phase functions.
    const mu = viewDir.dot(vec3(uSunDir)).clamp(-1, 1);

    // Height blend: near 1 at zenith, 0 at/under horizon. A pow sharpens the
    // horizon band so the hazy horizon colour hugs the skyline.
    const heightBlend = viewUp.pow(0.5);
    const baseSky = mix(vec3(uHorizon), vec3(uZenith), heightBlend);

    // Mie forward-scatter glow around the sun: Cornette–Shanks-ish lobe.
    // (3(1-g^2)(1+mu^2)) / (2(2+g^2)(1+g^2-2 g mu)^1.5). Scaled for display.
    const g2 = gMie.mul(gMie);
    const num = float(3).mul(float(1).sub(g2)).mul(mu.mul(mu).add(1));
    const base = float(1).add(g2).sub(gMie.mul(mu).mul(2)).max(float(1e-3));
    const denom = float(2).mul(float(2).add(g2)).mul(base.pow(1.5));
    const mieGlow = num.div(denom).mul(0.25);
    const glowColor = vec3(uSunColor).mul(mieGlow).mul(uSunIntensity);

    // Sun disc: limb-darkened, antialiased edge. angularOffset ≈ acos(mu);
    // use a cheap smoothstep on mu near 1 rather than an acos per fragment.
    const cosDisc = discRadius.cos();
    const cosEdge = discRadius.mul(1.05).cos();
    const disc = mu.smoothstep(cosEdge, cosDisc);
    // Soft limb darkening across the disc.
    const limb = float(0.4).add(mu.sub(cosDisc).max(0).mul(80).saturate().mul(0.6));
    const discColor = vec3(uSunColor).mul(disc).mul(limb).mul(uSunIntensity).mul(3);

    // Day sky = gradient + Mie glow + sun disc.
    const daySky = baseSky.add(glowColor).add(discColor);

    // Overcast: flatten toward a neutral grey of the horizon's luminance.
    const greyLum = vec3(uHorizon).dot(vec3(0.2126, 0.7152, 0.0722));
    const grey = vec3(greyLum, greyLum, greyLum);
    // Quadratic overcast response (mirrors AtmosphereModel.skyRadiance): scattered
    // fair-weather cloud barely greys the blue sky; full overcast fully flattens.
    const overcastK = uOvercast.mul(uOvercast);
    const daySkyFlat = mix(daySky, grey, overcastK);

    // Night base fades in with nightFactor.
    const nightBase = vec3(NIGHT_BASE.r, NIGHT_BASE.g, NIGHT_BASE.b);
    // Use the FUNCTIONAL `mix(a, b, t)`, NOT the `a.mix(b, t)` method. In the
    // pinned three r0.180 TSL build the chained `.mix()` METHOD on a compound
    // colour expression evaluates incorrectly — it returns the `b` argument
    // regardless of `t` (verified: `daySkyFlat.mix(nightBase, 0)` returned
    // `nightBase`, painting the whole dome near-black at noon). This was the
    // ROOT CAUSE of the "noon sky is not blue" defect: the sky dome rendered
    // black, so the only visible sky was the grey cloud dome in front of it.
    // The functional `mix()` is correct at every `t`; all mixes here use it.
    let sky = mix(daySkyFlat, nightBase, uNight);

    // Documented F.4 insertion point: stars/moon emissive added here.
    if (opts.extraEmissiveNode !== undefined) {
      sky = sky.add(opts.extraEmissiveNode);
    }
    return sky;
  })();

  // ─── Mesh ────────────────────────────────────────────────────────────────────
  const geometry = new THREE.SphereGeometry(radius, 32, 16);
  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = colorNode;
  material.side = THREE.BackSide; // render the inside of the sphere
  material.depthWrite = false; // never occlude scene geometry
  material.fog = false;
  const mesh = new THREE.Mesh(geometry, material);

  const uniforms: SkyDomeUniforms = {
    sunDirection: uSunDir,
    zenithColor: uZenith,
    horizonColor: uHorizon,
    sunColor: uSunColor,
    sunIntensity: uSunIntensity,
    nightFactor: uNight,
    overcast: uOvercast,
  };

  function update(
    sky: SkyState,
    lighting: LightingState,
    cameraPos: { x: number; y: number; z: number },
  ): void {
    // Follow the camera so the dome is effectively at infinity.
    mesh.position.set(cameraPos.x, cameraPos.y, cameraPos.z);

    const sunDir = uSunDir.value as { x: number; y: number; z: number };
    sunDir.x = sky.sunDirection.x;
    sunDir.y = sky.sunDirection.y;
    sunDir.z = sky.sunDirection.z;

    setColor(uZenith.value, lighting.zenithColor);
    setColor(uHorizon.value, lighting.horizonColor);
    setColor(uSunColor.value, lighting.sunColor);
    uSunIntensity.value = Math.max(0, lighting.sunIlluminance);
    uNight.value = lighting.nightFactor;
    uOvercast.value = lighting.overcast;
  }

  function dispose(): void {
    geometry.dispose();
    material.dispose();
  }

  return { mesh, update, dispose, uniforms };
}

function setColor(target: unknown, c: RGB): void {
  const col = target as { r: number; g: number; b: number };
  col.r = c.r;
  col.g = c.g;
  col.b = c.b;
}
