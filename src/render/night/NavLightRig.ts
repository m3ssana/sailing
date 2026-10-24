/**
 * NavLightRig — the thin three/TSL layer for navigation lights (Stream F.4).
 *
 * Consumes the pure `NavLights` model. Renders each light as a point whose arc
 * visibility is evaluated IN-SHADER from the vessel-LOCAL camera direction, so a
 * single uniform update per frame keeps every arc correct from all angles — for
 * the player boat and every ambient vessel (moored fleet, signature vessels,
 * ferries) alike.
 *
 * ## In-shader arc test (no atan2 needed)
 *
 * The camera's horizontal direction in vessel-local space is `b =
 * normalize(camLocal.xz)`. A light's arc is centred on a unit 2D direction
 * `centreDir` (in the +Z=bow / +X=starboard plane) with cosine half-angle
 * `cosHalf`. The light is visible iff `dot(b, centreDir) >= cosHalf`. All-round
 * lights set `cosHalf = -1` (always visible). This is the dot-product form of
 * the pure model's `isBearingInArc`, so shader and CPU agree by construction.
 *
 * Nav lights fade with `nightFactor` and are dark by day — together with shore
 * windows they are the only emissive items in the scene (art-direction.md).
 */

import * as THREE from 'three/webgpu';
import { Fn, vec3, float, uniform, attribute, time, oscSine } from 'three/tsl';
import type { TSLNode } from 'three/tsl';
import {
  navLightConfigFor,
  navLightLayout,
  type NavLight,
  type NavLightMode,
} from './NavLights';

export interface NavLightRigOptions {
  /** Base point size in pixels. Default 6. */
  pointSize?: number;
  /** Place the disc on the sky at `distance` for the moon? N/A here. */
}

/** A navigation-light rig object with per-frame update. */
export interface NavLightRig {
  readonly object: THREE.Object3D;
  /**
   * Mount lights for a vessel kind onto a group, laying them out for the given
   * hull length and mast height. Returns the rig for chaining.
   */
  attachToVessel(
    group: THREE.Object3D,
    kind: NavLightMode,
    lengthMetres: number,
    mastHeightMetres: number,
  ): NavLightRig;
  /**
   * Update per-frame: the camera position in VESSEL-LOCAL coordinates (so the
   * caller transforms world camera → local), and the night factor.
   */
  update(cameraLocalX: number, cameraLocalY: number, cameraLocalZ: number, nightFactor: number): void;
  dispose(): void;
}

/** Centre direction (bow-frame 2D) + cosine half-angle for a light's arc. */
function arcCentreDir(light: NavLight): { cx: number; cz: number; cosHalf: number } {
  // Bow-frame plane: X = starboard, Z = bow. Bearing β (CW from bow) maps to
  // direction (sin β, cos β) in (x=starboard, z=bow).
  const b = light.centreBearing;
  const cx = Math.sin(b);
  const cz = Math.cos(b);
  const cosHalf = light.halfAngle >= Math.PI ? -1 : Math.cos(light.halfAngle);
  return { cx, cz, cosHalf };
}

/**
 * Create a navigation-light rig. The returned object is empty until
 * `attachToVessel` builds the points geometry; multiple vessels each create
 * their own rig instance.
 */
export function createNavLightRig(opts: NavLightRigOptions = {}): NavLightRig {
  const pointSize = opts.pointSize ?? 6;

  const root = new THREE.Group();

  // Uniforms shared across this rig's single points cloud.
  const uCamLocal = uniform(new THREE.Vector3(0, 0, 1));
  const uNightFactor = uniform(0);

  let geometry: THREE.BufferGeometry | null = null;
  let material: THREE.PointsNodeMaterial | null = null;
  let points: THREE.Points | null = null;

  function build(lights: NavLight[]): void {
    const n = lights.length;
    const positions = new Float32Array(n * 3);
    const colors = new Float32Array(n * 3);
    // arc.xy = centre dir (starboard, bow); arc.z = cosHalf; (w unused)
    const arcs = new Float32Array(n * 3);

    for (let i = 0; i < n; i++) {
      const l = lights[i];
      if (l === undefined) continue;
      const p = l.position ?? { x: 0, y: 0, z: 0 };
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
      colors[i * 3] = l.color.r;
      colors[i * 3 + 1] = l.color.g;
      colors[i * 3 + 2] = l.color.b;
      const a = arcCentreDir(l);
      arcs[i * 3] = a.cx;
      arcs[i * 3 + 1] = a.cz;
      arcs[i * 3 + 2] = a.cosHalf;
    }

    geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('navColor', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute('navArc', new THREE.Float32BufferAttribute(arcs, 3));

    material = new THREE.PointsNodeMaterial();
    material.transparent = true;
    material.depthWrite = false;
    material.blending = THREE.AdditiveBlending;
    material.sizeAttenuation = false;

    const navColor = attribute('navColor', 'vec3');
    const navArc = attribute('navArc', 'vec3');

    // In-shader arc visibility: dot(normalize(camLocal.xz), centreDir) >= cosHalf.
    const colorNode: TSLNode = Fn(() => {
      // Camera horizontal direction in bow frame: (x=starboard, z=bow).
      const camX = vec3(uCamLocal).x;
      const camZ = vec3(uCamLocal).z;
      const len = camX.mul(camX).add(camZ.mul(camZ)).max(1e-6).sqrt();
      const bx = camX.div(len);
      const bz = camZ.div(len);
      const d = bx.mul(navArc.x).add(bz.mul(navArc.y));
      // Visible when d >= cosHalf. TSL `node.step(edge)` = (node >= edge ? 1 : 0),
      // so `d.step(cosHalf)` is exactly (d >= cosHalf). cosHalf = -1 for all-round
      // makes this always 1.
      const inArc = d.step(navArc.z);
      // Gentle flicker so lights read as real point sources, not flat dots.
      const flicker = oscSine(time.mul(3.0)).mul(0.08).add(0.92);
      const emit = inArc.mul(uNightFactor).mul(flicker);
      return vec3(navColor).mul(emit);
    })();

    material.colorNode = colorNode;
    // Fade out completely by day via opacity too (belt and braces).
    material.opacityNode = Fn(() => {
      return uNightFactor.clamp(0, 1);
    })();
    material.sizeNode = float(pointSize);

    points = new THREE.Points(geometry, material);
    root.add(points);
  }

  return {
    object: root,
    attachToVessel(
      group: THREE.Object3D,
      kind: NavLightMode,
      lengthMetres: number,
      mastHeightMetres: number,
    ): NavLightRig {
      const config = navLightConfigFor(kind);
      const laid = navLightLayout(lengthMetres, mastHeightMetres, config);
      build(laid);
      group.add(root);
      return this;
    },
    update(camLocalX: number, camLocalY: number, camLocalZ: number, nightFactor: number): void {
      const v = uCamLocal.value as THREE.Vector3;
      v.set(camLocalX, camLocalY, camLocalZ);
      uNightFactor.value = Math.max(0, Math.min(1, nightFactor));
    },
    dispose(): void {
      geometry?.dispose();
      material?.dispose();
      points?.removeFromParent();
    },
  };
}
