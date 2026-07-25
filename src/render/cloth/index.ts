/**
 * Sail cloth simulation and rendering — I.2.
 *
 * This module implements Position-Based Dynamics cloth simulation for sail surfaces,
 * driven by an approximate pressure field derived from C.4's scalar aerodynamic state.
 *
 * ## Module structure
 *
 * - `PBDSolver.ts` — Engine-agnostic Verlet PBD solver (no three.js).
 * - `PressureField.ts` — Derives spatial pressure from SailAeroState scalars.
 * - `Telltales.ts` — Computes telltale orientations from aerodynamic state.
 * - `SailCloth.ts` — Ties simulation together into per-sail instances.
 * - `SailClothMaterial.ts` — TSL material with double-sided translucency.
 */

export {
  type PBDParticle,
  type DistanceConstraint,
  type PBDConfig,
  DEFAULT_PBD_CONFIG,
  createParticle,
  createDistanceConstraint,
  computeRestLength,
  applyAcceleration,
  stepPBD,
  solveDistanceConstraint,
} from './PBDSolver';

export {
  type PressureField,
  computePressureField,
  isStalled,
} from './PressureField';

export {
  type TelltaleSide,
  type TelltalePosition,
  type TelltaleOrientation,
  STANDARD_TELLTALE_POSITIONS,
  computeTelltaleOrientation,
} from './Telltales';

export {
  type SailClothInstance,
  type SailClothMaterialParams,
  createSailCloth,
  updateSailCloth,
  getClothPositions,
  computeClothNormals,
} from './SailCloth';

export {
  buildSailClothMaterial,
  DEFAULT_SAIL_MATERIAL_PARAMS,
} from './SailClothMaterial';
