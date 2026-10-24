/**
 * MoonDisc — the thin three/TSL layer for the visible moon (Stream F.4).
 *
 * Split out from `Moonlight.ts` deliberately: `Moonlight.ts` is the PURE,
 * three-free model (brightness, colour, glitter, terminator geometry) and must
 * stay headlessly importable. This file is the thin render layer that draws the
 * disc, consuming that model's outputs. It computes no brightness/phase POLICY
 * of its own — only the billboard shading geometry.
 *
 * ## Phase shading (labelled approximation)
 *
 * The moon is a small unlit sphere. Its lit fraction is shaded by comparing each
 * surface point's normal against the direction to the sun: a point is lit where
 * `normal · dirToSun > terminator`, with `terminator = moonTerminator(phase)`
 * (the exact `cos(phaseAngle) = 1 - 2·fraction` law from the pure model). The
 * bright limb therefore faces the sun. This is a first-order approximation of
 * real lunar photometry — no libration, no earthshine on the dark limb, no
 * limb-darkening — and is LABELLED as such. It is visually correct for the
 * crescent→full→crescent silhouette, which is all the night scene needs.
 */

import * as THREE from 'three/webgpu';
import { Fn, float, vec3, uniform, normalLocal, smoothstep } from 'three/tsl';
import type { TSLNode } from 'three/tsl';
import {
  computeMoonlight,
  moonTerminator,
  type MoonlightSkyInput,
  type MoonColor,
} from './Moonlight';
import type { LightingState } from '../lighting/LightingState';
import type { Vec3 } from '@/types';

/** Options for the moon disc billboard. */
export interface MoonDiscOptions {
  /** Angular/world radius of the disc, metres (placed on the sky shell). Default 1. */
  radius?: number;
  /** Distance from the origin to place the disc along the moon direction. Default 1000. */
  distance?: number;
  /** Lit-side colour, linear RGB. Default cool white. */
  litColor?: MoonColor;
}

/** A moon disc object with a per-frame update driven by the pure model. */
export interface MoonDisc {
  /** The three object to add to the scene graph. */
  readonly object: THREE.Object3D;
  /**
   * Update position, phase shading, and visibility from sky + lighting.
   *
   * @param sunDirection Unit vector FROM the scene TOWARDS the sun
   *   (`SkyState.sunDirection`). The sun is effectively at infinity, so this is
   *   also (to a vanishing error) the direction from the moon towards the sun,
   *   which is what orients the lit limb.
   */
  update(sky: MoonlightSkyInput, lighting: LightingState, sunDirection: Vec3): void;
  /**
   * The current local-frame unit direction towards the sun written into the
   * shader (`uDirToSun`) by the last `update`. Exposed read-only so the lit-limb
   * orientation can be verified headlessly (the TSL fragment shader itself does
   * not run under vitest/node).
   */
  readonly litSunDirection: Readonly<Vec3>;
  /**
   * The current terminator offset written into the shader (`uTerminator`) by the
   * last `update`: +1 new (dark), 0 half, -1 full (fully lit). Read-only for
   * headless phase verification.
   */
  readonly terminator: number;
  /** Dispose geometry and material. */
  dispose(): void;
}

/**
 * Create the moon disc. A small sphere positioned along `sky.moonDirection`,
 * shaded by phase. Uses `MeshBasicNodeMaterial` (unlit) — the moon is a light
 * SOURCE, not a lit surface, so it is one of the few emissive-looking objects
 * the art direction permits in the sky.
 */
export function createMoonDisc(opts: MoonDiscOptions = {}): MoonDisc {
  const radius = opts.radius ?? 1;
  const distance = opts.distance ?? 1000;
  const litColor = opts.litColor ?? { r: 0.95, g: 0.96, b: 1.0 };

  const geometry = new THREE.SphereGeometry(radius, 24, 16);
  const material = new THREE.MeshBasicNodeMaterial();
  material.transparent = true;
  material.depthWrite = false;

  // Direction (in the disc's LOCAL space) from the moon towards the sun, used to
  // place the lit limb. Updated each frame. The disc is an UNROTATED sphere
  // (`mesh` is only translated along the moon direction, never rotated), so its
  // local axes coincide with world axes — the local "to sun" direction is simply
  // the world-space direction from the moon towards the sun. The sun is
  // effectively at infinity, so that equals the (normalised) world sun
  // direction. Initialised to +X; overwritten every `update`.
  const uDirToSun = uniform(new THREE.Vector3(1, 0, 0));
  const uTerminator = uniform(0);
  const uLitColor = uniform(new THREE.Color(litColor.r, litColor.g, litColor.b));
  const uBrightness = uniform(1);

  const colorNode: TSLNode = Fn(() => {
    // Lit where normal faces the sun beyond the terminator plane.
    const nDotSun = normalLocal.normalize().dot(uDirToSun.normalize());
    // Soft terminator band for an anti-aliased boundary.
    const soft = float(0.08);
    const lit = smoothstep(uTerminator.sub(soft), uTerminator.add(soft), nDotSun);
    // Dark limb retains a faint earthshine-like floor so the full disc is
    // readable against the night sky (labelled artistic floor).
    const earthshine = float(0.04);
    const litAmount = lit.max(earthshine);
    return vec3(uLitColor).mul(litAmount).mul(uBrightness);
  })();

  material.colorNode = colorNode;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.visible = false;

  const scratch = { moonColor: { r: 0, g: 0, b: 0 } as MoonColor, moonIlluminance: 0 };

  return {
    object: mesh,
    get litSunDirection(): Readonly<Vec3> {
      const v = uDirToSun.value as THREE.Vector3;
      return { x: v.x, y: v.y, z: v.z };
    },
    get terminator(): number {
      return uTerminator.value as number;
    },
    update(sky: MoonlightSkyInput, lighting: LightingState, sunDirection: Vec3): void {
      const moon = computeMoonlight(sky, lighting, scratch);
      // Position along the moon direction on the sky shell.
      mesh.position.set(
        sky.moonDirection.x * distance,
        sky.moonDirection.y * distance,
        sky.moonDirection.z * distance,
      );

      // Direction from the moon towards the sun. The sphere is unrotated, so its
      // local frame == world frame; with the sun at infinity the moon→sun
      // direction is the normalised world sun direction. Guard against a
      // degenerate (zero / non-finite) input so the uniform is never poisoned;
      // fall back to the previous value's shape (default +X) on bad input.
      const sx = sunDirection.x;
      const sy = sunDirection.y;
      const sz = sunDirection.z;
      const sunLen = Math.sqrt(sx * sx + sy * sy + sz * sz);
      if (Number.isFinite(sunLen) && sunLen > 1e-9) {
        const v = uDirToSun.value as THREE.Vector3;
        v.set(sx / sunLen, sy / sunLen, sz / sunLen);
      }

      // Encode phase via the terminator offset from the pure model; the shader
      // lights where normal·dirToSun > terminator, so the bright limb faces the
      // sun and the lit fraction follows `moonPhase`.
      uTerminator.value = moonTerminator(sky.moonPhase);

      // Visible only when above horizon and night has fallen.
      const visible = moon.moonIlluminance > 0 || (sky.moonElevation > 0 && lighting.nightFactor > 0);
      mesh.visible = visible;

      // Brightness scales with night factor so the disc fades in at dusk.
      uBrightness.value = Math.max(0.2, Math.min(1, lighting.nightFactor));
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
