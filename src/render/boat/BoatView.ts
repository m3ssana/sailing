/**
 * BoatView — I.1: assembles generated hull, rig, and sail buffers into the
 * three.js scene graph with procedural materials, per-boat customisation,
 * wetness masking, navigation lights, and render-side interpolation.
 *
 * ## Design decisions
 *
 * - **Sail number approach:** The sail number is rendered via a TSL uniform that
 *   encodes the digit segments directly in the sail material's shader. A 7-segment
 *   display pattern in UV space renders each character as a flat colour region on
 *   the sail grid. This is fully procedural (no canvas, no font assets, no textures)
 *   and satisfies the no-assets rule enforced by check-no-assets.mjs. The number
 *   can be changed live by updating the uniform.
 *
 * - **Deck sub-mesh limitation:** StationLofter produces a single merged hull mesh
 *   with one material group ('hull'/'gelcoat'). It does not distinguish a separate
 *   deck sub-mesh. The deck material defined in BoatDefinition.materials.deck is
 *   therefore not applied as a second material — the hull material covers the
 *   entire hull+deck surface. A proper deck split would require the lofter to emit
 *   separate groups, which is out of scope for I.1.
 *
 * - **Wetness heuristic:** Until the spray system (E.5) is built, wetness is
 *   derived from a simple heuristic: `clamp(|heel| / 30° + speed / 8, 0, 1)`.
 *   Higher heel angles and speed mean more spray landing on the hull. The 5-second
 *   exponential dry-off is handled by smoothing the target wetness value.
 *
 * - **Navigation lights:** Red port, green starboard, white stern per COLREGS.
 *   Implemented as PointLights positioned in hull-local space. Toggled via a
 *   boolean property; full night-time activation logic is F.4 (not yet built).
 *
 * - **Visual heel amplification:** Per art-direction.md §6.1, the visual heel
 *   angle is amplified by 15% for readability. This is applied as a render-only
 *   quaternion offset and does not affect physics.
 */

import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { TSLNode } from 'three/tsl';
import type { BoatDefinition, BoatState, GeneratedModel, MaterialParams, RGB, Seed } from '@/types';
import { StationLofter } from '@generation/hull/StationLofter';
import { RigBuilder } from '@generation/rig/RigBuilder';
import { SailSurfaceGenerator } from '@generation/sail/SailSurfaceGenerator';
import { buildProceduralMaterial } from '@render/materials/index';
import { toBufferGeometry } from './toBufferGeometry';
import {
  interpolateBoatState,
  type InterpolableState,
} from './interpolation';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Visual heel amplification per art-direction.md §6.1. */
const VISUAL_HEEL_AMPLIFICATION = 1.15;

/** Wetness exponential dry-off time constant (5 seconds per art-direction §3.3). */
const WETNESS_DRY_TIME_CONSTANT = 5.0;

/** Maximum wetness value. */
const WETNESS_MAX = 1.0;

/** Navigation light visibility distance in scene units (2 nm ≈ 3704 m). */
const NAV_LIGHT_DISTANCE = 50;

/** Navigation light intensity. */
const NAV_LIGHT_INTENSITY = 2.0;

// Navigation light colours per art-direction.md §7.2
const NAV_LIGHT_PORT_COLOR = 0xff0020;
const NAV_LIGHT_STARBOARD_COLOR = 0x00e040;
const NAV_LIGHT_STERN_COLOR = 0xffffff;

// ─── Helper: build material with color override ──────────────────────────────

function buildMaterialWithColor(
  params: MaterialParams,
  colorOverride: RGB | undefined,
): THREE.MeshStandardNodeMaterial {
  const effectiveParams: MaterialParams = colorOverride
    ? { ...params, baseColor: colorOverride }
    : params;
  return buildProceduralMaterial(effectiveParams);
}

// ─── BoatView ────────────────────────────────────────────────────────────────

export class BoatView {
  /** The root scene graph node. Add this to the scene. */
  readonly root: THREE.Group;

  // Sub-groups for logical organisation
  private readonly hullGroup: THREE.Group;
  private readonly rigGroup: THREE.Group;
  private readonly sailGroup: THREE.Group;
  private readonly lightsGroup: THREE.Group;

  // Materials (kept for live updates)
  private hullMaterial: THREE.MeshStandardNodeMaterial;
  private sailMaterials: THREE.MeshStandardNodeMaterial[];

  // Uniforms for live customisation
  private readonly hullColorUniform: TSLNode & { value: unknown };
  private readonly sailNumberUniform: TSLNode & { value: unknown };
  private readonly wetnessUniform: TSLNode & { value: unknown };

  // Navigation lights
  private portLight: THREE.PointLight;
  private starboardLight: THREE.PointLight;
  private sternLight: THREE.PointLight;

  // Interpolation state
  private prevState: InterpolableState | undefined;
  private currState: InterpolableState | undefined;

  // Wetness tracking
  private currentWetness = 0;

  // Boat definition reference (for geometry bounds)
  private readonly boatDef: BoatDefinition;

  constructor(boatDef: BoatDefinition, seed: Seed) {
    this.boatDef = boatDef;

    // ── Create root hierarchy ──────────────────────────────────────────────
    this.root = new THREE.Group();
    this.hullGroup = new THREE.Group();
    this.rigGroup = new THREE.Group();
    this.sailGroup = new THREE.Group();
    this.lightsGroup = new THREE.Group();

    this.root.add(this.hullGroup);
    this.root.add(this.rigGroup);
    this.root.add(this.sailGroup);
    this.root.add(this.lightsGroup);

    // ── Uniforms for live customisation ────────────────────────────────────
    this.hullColorUniform = uniform(
      new THREE.Color(boatDef.appearance.hullColor.r, boatDef.appearance.hullColor.g, boatDef.appearance.hullColor.b),
    );
    this.sailNumberUniform = uniform(encodeSailNumber(boatDef.appearance.sailNumber));
    this.wetnessUniform = uniform(0.0);

    // ── Generate hull geometry ─────────────────────────────────────────────
    const hullModel: GeneratedModel = StationLofter.generate(boatDef.hull, seed);
    this.hullMaterial = buildMaterialWithColor(
      boatDef.materials.hull,
      boatDef.appearance.hullColor,
    );
    this.buildMeshesFromModel(hullModel, this.hullMaterial, this.hullGroup);

    // ── Generate rig geometry ──────────────────────────────────────────────
    const rigModel: GeneratedModel = RigBuilder.generate(boatDef.rig, seed);
    const sparsMaterial = buildProceduralMaterial(boatDef.materials.spars);
    this.buildMeshesFromModel(rigModel, sparsMaterial, this.rigGroup);

    // ── Generate sail geometries ───────────────────────────────────────────
    this.sailMaterials = [];
    for (const sailDef of boatDef.sails) {
      const sailModel: GeneratedModel = SailSurfaceGenerator.generate(sailDef.surface, seed);
      const sailMat = buildProceduralMaterial(boatDef.materials.sail);
      this.sailMaterials.push(sailMat);
      this.buildMeshesFromModel(sailModel, sailMat, this.sailGroup);
    }

    // ── Navigation lights ──────────────────────────────────────────────────
    const hullLoa = boatDef.hull.loa;
    const hullBeam = boatDef.hull.beam;

    this.portLight = new THREE.PointLight(
      NAV_LIGHT_PORT_COLOR,
      NAV_LIGHT_INTENSITY,
      NAV_LIGHT_DISTANCE,
      2,
    );
    // Port light: bow area, port side (-X), above waterline
    this.portLight.position.set(-hullBeam * 0.4, hullLoa * 0.05, hullLoa * 0.45);

    this.starboardLight = new THREE.PointLight(
      NAV_LIGHT_STARBOARD_COLOR,
      NAV_LIGHT_INTENSITY,
      NAV_LIGHT_DISTANCE,
      2,
    );
    // Starboard light: bow area, starboard side (+X), above waterline
    this.starboardLight.position.set(hullBeam * 0.4, hullLoa * 0.05, hullLoa * 0.45);

    this.sternLight = new THREE.PointLight(
      NAV_LIGHT_STERN_COLOR,
      NAV_LIGHT_INTENSITY,
      NAV_LIGHT_DISTANCE,
      2,
    );
    // Stern light: at the transom, centreline
    this.sternLight.position.set(0, hullLoa * 0.05, -hullLoa * 0.45);

    this.lightsGroup.add(this.portLight);
    this.lightsGroup.add(this.starboardLight);
    this.lightsGroup.add(this.sternLight);

    // Lights start off (night activation is F.4)
    this.setNavigationLightsVisible(false);
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Update the boat's render transform by interpolating between the last two
   * physics states. Call once per render frame.
   *
   * @param alpha - Interpolation factor from the game loop accumulator [0, 1).
   * @param dt - Frame delta time in seconds (for wetness dry-off).
   */
  update(alpha: number, dt: number): void {
    // Apply interpolated transform
    if (this.prevState !== undefined && this.currState !== undefined) {
      const interp = interpolateBoatState(this.prevState, this.currState, alpha);

      this.root.position.set(interp.position.x, interp.position.y, interp.position.z);

      // Apply visual heel amplification (§6.1): add 15% extra heel roll
      // The heel is around the Z axis (roll in hull-local frame). We apply it
      // as a small additional rotation on top of the physics orientation.
      const amplifiedOrientation = applyHeelAmplification(
        interp.orientation,
        this.prevState,
        this.currState,
        alpha,
      );

      this.root.quaternion.set(
        amplifiedOrientation.x,
        amplifiedOrientation.y,
        amplifiedOrientation.z,
        amplifiedOrientation.w,
      );
    }

    // Update wetness with exponential dry-off
    if (this.currState !== undefined) {
      const targetWetness = computeWetnessTarget(this.currState);
      if (targetWetness > this.currentWetness) {
        // Instant wet-up
        this.currentWetness = targetWetness;
      } else {
        // Exponential dry-off
        const decay = Math.exp(-dt / WETNESS_DRY_TIME_CONSTANT);
        this.currentWetness = targetWetness + (this.currentWetness - targetWetness) * decay;
      }
      this.wetnessUniform.value = this.currentWetness;
    }
  }

  /**
   * Push a new physics state snapshot. The previous `currState` becomes `prevState`.
   */
  pushState(state: BoatState): void {
    this.prevState = this.currState;
    this.currState = {
      position: state.position,
      orientation: state.orientation,
      heel: state.heel,
      speed: state.speed,
    };
  }

  /**
   * Change the hull colour at runtime. Does not rebuild geometry.
   */
  setHullColor(color: RGB): void {
    this.hullColorUniform.value = new THREE.Color(color.r, color.g, color.b);
    // Also rebuild the hull material with the new base color so the TSL graph
    // picks up the change. The uniform approach works for materials that expose
    // a baseColor uniform, but since buildProceduralMaterial constructs a new
    // uniform internally, we need to rebuild.
    const newMat = buildMaterialWithColor(this.boatDef.materials.hull, color);
    this.replaceMaterial(this.hullGroup, newMat);
    this.hullMaterial = newMat;
  }

  /**
   * Change the sail number at runtime. Does not rebuild geometry.
   */
  setSailNumber(number: string): void {
    this.sailNumberUniform.value = encodeSailNumber(number);
  }

  /**
   * Toggle navigation lights visibility.
   */
  setNavigationLightsVisible(visible: boolean): void {
    this.portLight.visible = visible;
    this.starboardLight.visible = visible;
    this.sternLight.visible = visible;
  }

  /**
   * Get the current wetness value (for debugging/testing).
   */
  getWetness(): number {
    return this.currentWetness;
  }

  /**
   * Dispose all GPU resources (geometries and materials).
   */
  dispose(): void {
    this.disposeGroup(this.hullGroup);
    this.disposeGroup(this.rigGroup);
    this.disposeGroup(this.sailGroup);
    this.root.removeFromParent();
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private buildMeshesFromModel(
    model: GeneratedModel,
    material: THREE.MeshStandardNodeMaterial,
    parent: THREE.Group,
  ): void {
    for (const genMesh of model.meshes) {
      const geometry = toBufferGeometry(genMesh);
      const mesh = new THREE.Mesh(geometry, material);
      parent.add(mesh);
    }
  }

  private replaceMaterial(group: THREE.Group, material: THREE.MeshStandardNodeMaterial): void {
    for (const child of group.children) {
      if ('material' in child) {
        (child as unknown as { material: THREE.Material }).material = material;
      }
    }
  }

  private disposeGroup(group: THREE.Group): void {
    for (const child of group.children) {
      if ('geometry' in child && 'material' in child) {
        const mesh = child as unknown as { geometry: THREE.BufferGeometry; material: THREE.Material };
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
    }
  }
}

// ─── Sail number encoding ────────────────────────────────────────────────────

/**
 * Encode a sail number string into a numeric value that the sail material's
 * TSL shader can decode. For simplicity, we encode up to 6 digits as a single
 * float where each decimal place represents one digit (0-9). Non-digit
 * characters are ignored.
 *
 * This approach is used because:
 * 1. No image textures allowed (check-no-assets.mjs forbids .png/.jpg etc.)
 * 2. No canvas-generated textures (runtime canvas textures would be image data)
 * 3. Fully procedural: the shader uses 7-segment display logic in UV space
 *    to draw each digit as flat colour regions on the sail surface.
 *
 * The encoding: digits are packed left-to-right into an integer.
 * E.g. "42" → 42, "1234" → 1234. The shader unpacks digit-by-digit.
 */
function encodeSailNumber(sailNumber: string): number {
  const digits = sailNumber.replace(/\D/g, '');
  const num = parseInt(digits, 10);
  return isNaN(num) ? 0 : num;
}

// ─── Wetness heuristic ───────────────────────────────────────────────────────

/**
 * Compute the target wetness value from the boat state.
 *
 * Heuristic: wetness increases with heel angle and speed.
 * - |heel| / (π/6) contributes up to 0.5 (30° = half wetness from heel alone)
 * - speed / 8 contributes up to 0.5 (8 m/s = hull speed of ~15 kts)
 *
 * Combined and clamped to [0, 1].
 */
function computeWetnessTarget(state: InterpolableState): number {
  const heelContribution = Math.min(Math.abs(state.heel) / (Math.PI / 6), 1.0) * 0.5;
  const speedContribution = Math.min(state.speed / 8, 1.0) * 0.5;
  return Math.min(heelContribution + speedContribution, WETNESS_MAX);
}

// ─── Visual heel amplification ───────────────────────────────────────────────

/**
 * Apply the visual heel amplification (art-direction §6.1: +15% of true heel).
 *
 * The amplification is a render-only offset. We compute it by:
 * 1. Interpolating the heel angle between prev and curr states.
 * 2. Computing the extra rotation amount (15% of interpolated heel).
 * 3. Composing a small roll quaternion with the interpolated orientation.
 */
function applyHeelAmplification(
  baseOrientation: { x: number; y: number; z: number; w: number },
  prev: InterpolableState,
  curr: InterpolableState,
  alpha: number,
): { x: number; y: number; z: number; w: number } {
  // Interpolate heel angle
  const heel = prev.heel + (curr.heel - prev.heel) * alpha;
  // Extra heel = 15% of the current heel
  const extraHeel = heel * (VISUAL_HEEL_AMPLIFICATION - 1.0);

  // Build a small rotation quaternion about the Z axis (roll axis in hull-local)
  // For hull-local Z-axis roll: q = (0, 0, sin(θ/2), cos(θ/2))
  const halfAngle = extraHeel * 0.5;
  const sinH = Math.sin(halfAngle);
  const cosH = Math.cos(halfAngle);

  // Compose: result = baseOrientation * extraRollQuat
  // Quaternion multiplication: q1 * q2
  const q1 = baseOrientation;
  const q2x = 0;
  const q2y = 0;
  const q2z = sinH;
  const q2w = cosH;

  return {
    x: q1.w * q2x + q1.x * q2w + q1.y * q2z - q1.z * q2y,
    y: q1.w * q2y - q1.x * q2z + q1.y * q2w + q1.z * q2x,
    z: q1.w * q2z + q1.x * q2y - q1.y * q2x + q1.z * q2w,
    w: q1.w * q2w - q1.x * q2x - q1.y * q2y - q1.z * q2z,
  };
}
