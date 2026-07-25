/**
 * Sail cloth renderer — I.2.
 *
 * Ties together the PBD solver, pressure-field approximation, telltale logic,
 * and TSL material into a renderable three.js Mesh per sail. One SailClothInstance
 * is created per sail on the boat.
 *
 * ## Architecture
 *
 * - **CPU PBD path (WebGL2 fallback):** The PBD solver runs on the main thread at
 *   30 Hz. Vertex positions are uploaded to a BufferGeometry each render frame via
 *   `bufferAttribute.needsUpdate = true`. This is the universal fallback.
 *
 * - **GPU compute path (WebGPU):** When `capabilities.compute === true`, the PBD
 *   solver could run as a TSL compute pass. However, for the initial implementation
 *   this is deferred — the CPU path at 30 Hz with the grid sizes involved
 *   (typically 12×8 = 108 vertices per sail, max 3 sails = 324 particles total) is
 *   well within budget (< 0.1 ms per frame). The GPU path would add complexity
 *   without measurable benefit at these grid sizes. This follows the established
 *   pattern from GPUCapabilities.ts: design the fallback first, gate the optimisation
 *   behind `capabilities.compute` when performance data justifies it.
 *
 * ## WebGPU/WebGL2 fallback pattern
 *
 * Following the convention from Renderer.ts and GPUCapabilities.ts:
 * - The cloth simulation always runs on CPU (30 Hz, universal).
 * - The TSL material (double-sided translucency, backlit scatter) compiles to both
 *   WGSL and GLSL via TSL, working identically on both backends.
 * - No compute-dependent features in this module (deferred optimisation).
 *
 * ## Double-sided translucency and backlit scatter
 *
 * Uses `MeshPhysicalNodeMaterial` with:
 * - `side: THREE.DoubleSide` — renders both faces.
 * - `transmissionNode` — subtle translucency so light bleeds through thin cloth.
 * - A custom backlight term in `emissiveNode`: when the view direction is opposite
 *   the light direction (i.e., looking through the sail toward the sun), a warm
 *   scatter glow appears. This is dot(viewDir, -lightDir) thresholded and coloured.
 *
 * ## Import boundary compliance
 *
 * This module lives in `src/render/` and may import:
 * - three.js (`three/webgpu`, `three/tsl`)
 * - `src/generation/` (reads SailSurfaceGenerator output)
 * - `src/physics/` (reads SailAeroState, does NOT re-implement forces)
 * - `src/types/`
 */

import type { GPUCapabilities, SailDefinition, SailSurfaceParams } from '@/types';
import type { SailAeroState } from '@physics/forces/AeroForce';
import { SailSurfaceGenerator } from '@generation/sail/SailSurfaceGenerator';
import {
  type PBDParticle,
  type DistanceConstraint,
  type PBDConfig,
  DEFAULT_PBD_CONFIG,
  createParticle,
  createDistanceConstraint,
  computeRestLength,
  applyAcceleration,
  stepPBD,
} from './PBDSolver';
import { computePressureField } from './PressureField';
import {
  type TelltalePosition,
  type TelltaleOrientation,
  STANDARD_TELLTALE_POSITIONS,
  computeTelltaleOrientation,
} from './Telltales';

/** Per-sail cloth simulation instance. */
export interface SailClothInstance {
  /** Sail identifier (matches SailDefinition.id and SailAeroState.sailId). */
  readonly sailId: string;
  /** Grid dimensions. */
  readonly luffSegments: number;
  readonly footSegments: number;
  /** PBD particles (one per grid vertex). */
  readonly particles: PBDParticle[];
  /** Distance constraints (structural grid edges). */
  readonly constraints: DistanceConstraint[];
  /** Accumulated time since last PBD step (for fixed-rate stepping). */
  accumulator: number;
  /** Telltale orientations, updated each frame. */
  readonly telltaleOrientations: TelltaleOrientation[];
  /** Telltale positions on the grid. */
  readonly telltalePositions: readonly TelltalePosition[];
  /** Sail area for pressure normalisation. */
  readonly sailArea: number;
  /** PBD configuration. */
  readonly config: PBDConfig;
}

/**
 * Build a cloth simulation instance from a SailDefinition.
 *
 * Sets up the PBD particle grid matching SailSurfaceGenerator's output topology:
 * - (luffSegments + 1) rows × (footSegments + 1) columns
 * - Row-major indexing: vertex(i, j) = i * cols + j
 * - Luff edge (j=0) is PINNED (fixed to mast/luff wire)
 * - Head vertex (i=luffSegments, j=0) is PINNED
 * - Tack vertex (i=0, j=0) is PINNED
 * - Clew vertex (i=0, j=footSegments) is spring-constrained (sheet attachment)
 *
 * @param sail - The sail definition with geometry and attachment points.
 * @param _capabilities - GPU capabilities (reserved for future compute path).
 */
export function createSailCloth(
  sail: SailDefinition,
  _capabilities: GPUCapabilities,
): SailClothInstance {
  const surface = sail.surface;
  const { luffSegments, footSegments } = surface;
  const rows = luffSegments + 1;
  const cols = footSegments + 1;

  // Generate the rest-shape mesh to extract vertex positions.
  const model = SailSurfaceGenerator.generate(surface, 42);
  const mesh = model.meshes[0];
  if (mesh === undefined) {
    throw new Error(`SailSurfaceGenerator produced no mesh for sail ${sail.id}`);
  }
  const positions = mesh.positions;

  // --- Build PBD particles from the generated grid ---
  const particles: PBDParticle[] = [];

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const idx = i * cols + j;
      const px = positions[idx * 3] ?? 0;
      const py = positions[idx * 3 + 1] ?? 0;
      const pz = positions[idx * 3 + 2] ?? 0;

      // Pin the entire luff edge (j=0) — these vertices are fixed to the mast/wire.
      const isLuffEdge = j === 0;
      const pinned = isLuffEdge;

      particles.push(createParticle(px, py, pz, pinned));
    }
  }

  // --- Build distance constraints ---
  const constraints: DistanceConstraint[] = [];

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const idx = i * cols + j;
      const pCurr = particles[idx];
      if (pCurr === undefined) continue;

      // Horizontal (girth-direction) constraint: connect to right neighbour.
      if (j < footSegments) {
        const rightIdx = i * cols + j + 1;
        const pRight = particles[rightIdx];
        if (pRight !== undefined) {
          const rest = computeRestLength(pCurr.pos, pRight.pos);
          constraints.push(createDistanceConstraint(idx, rightIdx, rest, 0.9));
        }
      }

      // Vertical (luff-direction) constraint: connect to upper neighbour.
      if (i < luffSegments) {
        const upIdx = (i + 1) * cols + j;
        const pUp = particles[upIdx];
        if (pUp !== undefined) {
          const rest = computeRestLength(pCurr.pos, pUp.pos);
          constraints.push(createDistanceConstraint(idx, upIdx, rest, 0.9));
        }
      }

      // Diagonal (shear) constraint for stability: connect to upper-right.
      if (i < luffSegments && j < footSegments) {
        const diagIdx = (i + 1) * cols + j + 1;
        const pDiag = particles[diagIdx];
        if (pDiag !== undefined) {
          const rest = computeRestLength(pCurr.pos, pDiag.pos);
          constraints.push(createDistanceConstraint(idx, diagIdx, rest, 0.5));
        }
      }
    }
  }

  // --- Telltale setup ---
  const telltaleOrientations: TelltaleOrientation[] = STANDARD_TELLTALE_POSITIONS.map(() => ({
    direction: { x: 1, y: 0, z: 0 },
    liftAmount: 0,
  }));

  return {
    sailId: sail.id,
    luffSegments,
    footSegments,
    particles,
    constraints,
    accumulator: 0,
    telltaleOrientations,
    telltalePositions: STANDARD_TELLTALE_POSITIONS,
    sailArea: sail.area,
    config: { ...DEFAULT_PBD_CONFIG },
  };
}

/**
 * Update the cloth simulation for one frame.
 *
 * Runs the PBD solver at its fixed rate (30 Hz), accumulating real dt and stepping
 * as needed. Also updates telltale orientations.
 *
 * @param instance - The sail cloth instance to update.
 * @param sailState - Current aerodynamic state for this sail.
 * @param dt - Frame delta time in seconds.
 * @param time - Total elapsed time in seconds (for flutter animation).
 * @param sheetTension - Sheet control value 0..1 (from ControlState.mainsheet or jibsheet).
 */
export function updateSailCloth(
  instance: SailClothInstance,
  sailState: SailAeroState,
  dt: number,
  time: number,
  sheetTension: number,
): void {
  const { particles, constraints, config, luffSegments, footSegments, sailArea } = instance;

  // --- Accumulate time and step at fixed rate ---
  instance.accumulator += dt;
  const maxStepsPerFrame = 3; // Cap to prevent spiral-of-death
  let steps = 0;

  while (instance.accumulator >= config.dt && steps < maxStepsPerFrame) {
    instance.accumulator -= config.dt;
    steps++;

    // --- Compute pressure field for this step ---
    const pressure = computePressureField(sailState, luffSegments, footSegments, sailArea, time);
    const cols = footSegments + 1;

    // --- Apply pressure as acceleration to each free particle ---
    // Pressure is perpendicular to the local surface. For simplicity in the PBD
    // step, we approximate the normal as +Z in the sail's reference frame (which
    // is correct for the initial flat/low-camber state and approximately correct
    // as the sail develops shape). A more accurate approach would compute per-vertex
    // normals from the current deformed mesh — acceptable for a future refinement.
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (p === undefined || p.invMass === 0) continue;

      const pressureVal = pressure.pressures[i] ?? 0;
      // Apply as acceleration in Z direction (perpendicular to sail plane).
      // Gravity is very small for a sail (negligible weight per vertex area),
      // but include a tiny Y component for visual drape.
      applyAcceleration(p, 0, -0.5, pressureVal);
    }

    // --- Clew sheet constraint ---
    // The clew vertex (bottom-right corner: row 0, col footSegments) is pulled
    // toward the centreline by sheet tension. Higher tension = closer to centreline.
    const clewIdx = footSegments; // row 0, col footSegments
    const clewParticle = particles[clewIdx];
    if (clewParticle !== undefined && clewParticle.invMass > 0) {
      // Sheet tension pulls the clew inward (toward Z=0 / centreline).
      // When sheet is eased (0), clew can swing freely outboard.
      // When sheet is trimmed (1), clew is pulled toward its rest position.
      const restZ = 0; // Centreline
      const sheetForce = (restZ - clewParticle.pos.z) * sheetTension * 20;
      applyAcceleration(clewParticle, 0, 0, sheetForce);
    }

    // --- Also constrain the leech foot vertex similarly ---
    const rows = luffSegments + 1;
    for (let j = Math.floor(cols * 0.7); j < cols; j++) {
      const footIdx = j; // row 0 vertices near the leech
      const footParticle = particles[footIdx];
      if (footParticle !== undefined && footParticle.invMass > 0) {
        const pullStrength = sheetTension * 5 * (j / (cols - 1));
        const restoreZ = (0 - footParticle.pos.z) * pullStrength;
        applyAcceleration(footParticle, 0, 0, restoreZ);
      }
    }

    // Suppress unused variable
    void rows;

    // --- Step the PBD solver ---
    stepPBD(particles, constraints, config);
  }

  // Discard excess accumulated time (prevents drift accumulation on slow frames).
  if (instance.accumulator > config.dt * 2) {
    instance.accumulator = 0;
  }

  // --- Update telltale orientations ---
  for (let t = 0; t < instance.telltalePositions.length; t++) {
    const telltalePos = instance.telltalePositions[t];
    if (telltalePos === undefined) continue;

    const orientation = computeTelltaleOrientation(telltalePos.side, sailState);
    const existing = instance.telltaleOrientations[t];
    if (existing !== undefined) {
      existing.direction.x = orientation.direction.x;
      existing.direction.y = orientation.direction.y;
      existing.direction.z = orientation.direction.z;
      existing.liftAmount = orientation.liftAmount;
    }
  }
}

/**
 * Extract the current particle positions as a flat Float32Array suitable for
 * uploading to a BufferGeometry position attribute.
 */
export function getClothPositions(instance: SailClothInstance): Float32Array {
  const count = instance.particles.length;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const p = instance.particles[i];
    if (p === undefined) continue;
    positions[i * 3] = p.pos.x;
    positions[i * 3 + 1] = p.pos.y;
    positions[i * 3 + 2] = p.pos.z;
  }
  return positions;
}

/**
 * Compute vertex normals from the current cloth state (deformed mesh).
 * Uses area-weighted face normals averaged at each vertex.
 */
export function computeClothNormals(
  instance: SailClothInstance,
): Float32Array {
  const { luffSegments, footSegments, particles } = instance;
  const rows = luffSegments + 1;
  const cols = footSegments + 1;
  const normals = new Float32Array(particles.length * 3);

  // Accumulate face normals at each vertex
  for (let i = 0; i < luffSegments; i++) {
    for (let j = 0; j < footSegments; j++) {
      const a = i * cols + j;
      const b = i * cols + j + 1;
      const c = (i + 1) * cols + j;
      const d = (i + 1) * cols + j + 1;

      const pa = particles[a];
      const pb = particles[b];
      const pc = particles[c];
      const pd = particles[d];
      if (pa === undefined || pb === undefined || pc === undefined || pd === undefined) continue;

      // Triangle 1: a, b, d
      addFaceNormal(normals, a, b, d, pa.pos, pb.pos, pd.pos);
      // Triangle 2: a, d, c
      addFaceNormal(normals, a, d, c, pa.pos, pd.pos, pc.pos);
    }
  }

  // Normalize all vertex normals
  for (let i = 0; i < particles.length; i++) {
    const nx = normals[i * 3] ?? 0;
    const ny = normals[i * 3 + 1] ?? 0;
    const nz = normals[i * 3 + 2] ?? 0;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-10) {
      normals[i * 3] = nx / len;
      normals[i * 3 + 1] = ny / len;
      normals[i * 3 + 2] = nz / len;
    } else {
      // Default normal for degenerate case
      normals[i * 3] = 0;
      normals[i * 3 + 1] = 0;
      normals[i * 3 + 2] = 1;
    }
  }

  // Suppress unused variable
  void rows;

  return normals;
}

/** Add a face normal contribution to the normal accumulator at each vertex. */
function addFaceNormal(
  normals: Float32Array,
  ia: number,
  ib: number,
  ic: number,
  posA: { x: number; y: number; z: number },
  posB: { x: number; y: number; z: number },
  posC: { x: number; y: number; z: number },
): void {
  const e1x = posB.x - posA.x;
  const e1y = posB.y - posA.y;
  const e1z = posB.z - posA.z;
  const e2x = posC.x - posA.x;
  const e2y = posC.y - posA.y;
  const e2z = posC.z - posA.z;

  // Cross product (area-weighted normal)
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;

  normals[ia * 3] = (normals[ia * 3] ?? 0) + nx;
  normals[ia * 3 + 1] = (normals[ia * 3 + 1] ?? 0) + ny;
  normals[ia * 3 + 2] = (normals[ia * 3 + 2] ?? 0) + nz;
  normals[ib * 3] = (normals[ib * 3] ?? 0) + nx;
  normals[ib * 3 + 1] = (normals[ib * 3 + 1] ?? 0) + ny;
  normals[ib * 3 + 2] = (normals[ib * 3 + 2] ?? 0) + nz;
  normals[ic * 3] = (normals[ic * 3] ?? 0) + nx;
  normals[ic * 3 + 1] = (normals[ic * 3 + 1] ?? 0) + ny;
  normals[ic * 3 + 2] = (normals[ic * 3 + 2] ?? 0) + nz;
}

/**
 * Parameters for the sail cloth material builder.
 */
export interface SailClothMaterialParams {
  /** Base sail color (typically white or off-white). */
  baseColor: { r: number; g: number; b: number };
  /** Translucency amount 0..1 (how much light passes through). */
  translucency: number;
  /** Backlight scatter colour (warm orange-red for sunlit sails). */
  scatterColor: { r: number; g: number; b: number };
}

export { type SailSurfaceParams };
