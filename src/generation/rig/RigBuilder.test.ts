/**
 * RigBuilder tests — D.3.
 *
 * Validates:
 * - Mast and boom tubes have consistent winding and positive volume.
 * - A full rig (spreaderPairs=2, bowsprit=true) generates without error.
 * - Triangle count scales up when more parts are enabled.
 * - Scale invariance: doubling all length dimensions doubles bounds proportionally.
 * - Determinism: same params + seed → byte-identical output.
 * - Unstayed rig (spreaderPairs=0) produces no standing rigging.
 */

import { describe, expect, it } from 'vitest';
import type { RigParams } from '@/types';
import {
  assertConsistentWinding,
  assertDeterministic,
  assertFiniteBuffers,
  assertNoDegenerateTriangles,
  assertWatertight,
  computeVolume,
} from '@generation/testing/geometryAssertions';
import { RigBuilder } from './RigBuilder';
import { sweepTube } from '../common/sweep';

// ─── Test fixtures ───────────────────────────────────────────────────────────

/**
 * A typical fractional sloop rig (e.g. a 10m racing keelboat).
 */
function makeStayedRig(overrides?: Partial<RigParams>): RigParams {
  return {
    mastHeight: 15,
    mastBaseDiameter: 0.12,
    mastTaper: 0.5,
    mastRake: 0.035, // ~2° aft rake
    boomLength: 5,
    boomDiameter: 0.08,
    boomHeight: 1.2,
    spreaderPairs: 2,
    shroudDiameter: 0.006,
    bowsprit: true,
    bowspritLength: 2.0,
    stepPosition: { x: 0, y: 0, z: 2.0 },
    ...overrides,
  };
}

/**
 * A minimal unstayed rig (e.g. a Laser/ILCA dinghy).
 */
function makeUnstayedRig(): RigParams {
  return {
    mastHeight: 6.5,
    mastBaseDiameter: 0.07,
    mastTaper: 0.6,
    mastRake: 0.05,
    boomLength: 2.8,
    boomDiameter: 0.05,
    boomHeight: 0.8,
    spreaderPairs: 0,
    shroudDiameter: 0.004,
    bowsprit: false,
    stepPosition: { x: 0, y: 0, z: 1.5 },
  };
}

// ─── Winding & watertightness tests (on mast tube directly) ──────────────────

describe('RigBuilder — mast tube geometry', () => {
  it('mast sweepTube is watertight', () => {
    const params = makeStayedRig();
    const path = [];
    const baseRadius = params.mastBaseDiameter / 2;
    const tipRadius = baseRadius * params.mastTaper;
    for (let i = 0; i < 16; i++) {
      const t = i / 15;
      const h = params.mastHeight * t;
      path.push({
        x: params.stepPosition.x,
        y: params.stepPosition.y + h * Math.cos(params.mastRake),
        z: params.stepPosition.z - h * Math.sin(params.mastRake),
      });
    }
    const mast = sweepTube(path, (t) => baseRadius + (tipRadius - baseRadius) * t, 12);
    assertWatertight(mast);
  });

  it('mast sweepTube has consistent CCW winding with positive volume', () => {
    const params = makeStayedRig();
    const path = [];
    const baseRadius = params.mastBaseDiameter / 2;
    const tipRadius = baseRadius * params.mastTaper;
    for (let i = 0; i < 16; i++) {
      const t = i / 15;
      const h = params.mastHeight * t;
      path.push({
        x: params.stepPosition.x,
        y: params.stepPosition.y + h * Math.cos(params.mastRake),
        z: params.stepPosition.z - h * Math.sin(params.mastRake),
      });
    }
    const mast = sweepTube(path, (t) => baseRadius + (tipRadius - baseRadius) * t, 12);
    assertConsistentWinding(mast);
    const vol = computeVolume(mast);
    expect(vol).toBeGreaterThan(0);
  });

  it('boom sweepTube is watertight with consistent winding', () => {
    const params = makeStayedRig();
    const start = {
      x: params.stepPosition.x,
      y: params.stepPosition.y + params.boomHeight,
      z: params.stepPosition.z,
    };
    const end = {
      x: start.x,
      y: start.y,
      z: start.z - params.boomLength,
    };
    const path = [];
    for (let i = 0; i < 16; i++) {
      const t = i / 15;
      path.push({
        x: start.x + (end.x - start.x) * t,
        y: start.y + (end.y - start.y) * t,
        z: start.z + (end.z - start.z) * t,
      });
    }
    const radius = params.boomDiameter / 2;
    const boom = sweepTube(path, (t) => radius * (1 - 0.1 * t), 12);
    assertWatertight(boom);
    assertConsistentWinding(boom);
    expect(computeVolume(boom)).toBeGreaterThan(0);
  });
});

// ─── Full rig generation ─────────────────────────────────────────────────────

describe('RigBuilder — full rig generation', () => {
  it('generates a complete stayed rig (spreaderPairs=2, bowsprit=true) without error', () => {
    const params = makeStayedRig();
    const model = RigBuilder.generate(params, 42);

    expect(model.meshes.length).toBe(1);
    const mesh = model.meshes[0]!;
    assertFiniteBuffers(mesh);
    assertNoDegenerateTriangles(mesh);
    expect(mesh.indices.length).toBeGreaterThan(0);
    expect(mesh.meta['partCount']).toBeGreaterThan(0);
  });

  it('generates a minimal unstayed rig (spreaderPairs=0, bowsprit=false) without error', () => {
    const params = makeUnstayedRig();
    const model = RigBuilder.generate(params, 42);

    expect(model.meshes.length).toBe(1);
    const mesh = model.meshes[0]!;
    assertFiniteBuffers(mesh);
    assertNoDegenerateTriangles(mesh);
    expect(mesh.indices.length).toBeGreaterThan(0);
  });

  it('stayed rig has more triangles than unstayed (more parts)', () => {
    const stayedModel = RigBuilder.generate(makeStayedRig(), 42);
    const unstayedModel = RigBuilder.generate(makeUnstayedRig(), 42);

    const stayedMesh = stayedModel.meshes[0]!;
    const unstayedMesh = unstayedModel.meshes[0]!;

    // Stayed rig includes spreaders, shrouds, stays, bowsprit — far more geometry
    expect(stayedMesh.indices.length).toBeGreaterThan(unstayedMesh.indices.length * 2);
  });

  it('unstayed rig has no standing rigging (only mast + boom + running rigging)', () => {
    const params = makeUnstayedRig();
    const model = RigBuilder.generate(params, 42);
    const mesh = model.meshes[0]!;

    // Unstayed rig: mast (1) + boom (1) + halyard ribbon (1) = 3 parts
    expect(mesh.meta['partCount']).toBe(3);
  });

  it('stayed rig part count includes spreaders and rigging', () => {
    const params = makeStayedRig({ spreaderPairs: 2, bowsprit: true });
    const model = RigBuilder.generate(params, 42);
    const mesh = model.meshes[0]!;

    // Expected parts:
    // mast(1) + boom(1) + spreaders(2 pairs × 2 = 4) +
    // cap shrouds(2) + intermediate shrouds(2 pairs × 2 = 4) + forestay(1) + backstay(1) +
    // halyard(1) + bowsprit spar(1) + bobstay(1) = 17
    expect(mesh.meta['partCount']).toBe(17);
  });
});

// ─── Scale invariance ────────────────────────────────────────────────────────

describe('RigBuilder — scale invariance', () => {
  it('doubling all length dimensions doubles bounds proportionally', () => {
    const baseParams = makeStayedRig();
    const scaledParams: RigParams = {
      ...baseParams,
      mastHeight: baseParams.mastHeight * 2,
      mastBaseDiameter: baseParams.mastBaseDiameter * 2,
      boomLength: baseParams.boomLength * 2,
      boomDiameter: baseParams.boomDiameter * 2,
      boomHeight: baseParams.boomHeight * 2,
      shroudDiameter: baseParams.shroudDiameter * 2,
      bowspritLength: (baseParams.bowspritLength ?? 2) * 2,
      stepPosition: {
        x: baseParams.stepPosition.x * 2,
        y: baseParams.stepPosition.y * 2,
        z: baseParams.stepPosition.z * 2,
      },
    };

    const baseModel = RigBuilder.generate(baseParams, 42);
    const scaledModel = RigBuilder.generate(scaledParams, 42);

    const baseMesh = baseModel.meshes[0]!;
    const scaledMesh = scaledModel.meshes[0]!;

    // Compute extents
    const baseExtentX = baseMesh.bounds.max.x - baseMesh.bounds.min.x;
    const baseExtentY = baseMesh.bounds.max.y - baseMesh.bounds.min.y;
    const baseExtentZ = baseMesh.bounds.max.z - baseMesh.bounds.min.z;

    const scaledExtentX = scaledMesh.bounds.max.x - scaledMesh.bounds.min.x;
    const scaledExtentY = scaledMesh.bounds.max.y - scaledMesh.bounds.min.y;
    const scaledExtentZ = scaledMesh.bounds.max.z - scaledMesh.bounds.min.z;

    // Expect ~2× scaling in each axis (allow 5% tolerance for numerical precision)
    const tolerance = 0.05;
    expect(scaledExtentX / baseExtentX).toBeCloseTo(2, 1);
    expect(scaledExtentY / baseExtentY).toBeCloseTo(2, 1);

    // Z extent should also scale — verify within tolerance
    if (baseExtentZ > 0.001) {
      expect(Math.abs(scaledExtentZ / baseExtentZ - 2)).toBeLessThan(tolerance);
    }
  });

  it('halving all dimensions halves bounds', () => {
    const baseParams = makeStayedRig();
    const halfParams: RigParams = {
      ...baseParams,
      mastHeight: baseParams.mastHeight * 0.5,
      mastBaseDiameter: baseParams.mastBaseDiameter * 0.5,
      boomLength: baseParams.boomLength * 0.5,
      boomDiameter: baseParams.boomDiameter * 0.5,
      boomHeight: baseParams.boomHeight * 0.5,
      shroudDiameter: baseParams.shroudDiameter * 0.5,
      bowspritLength: (baseParams.bowspritLength ?? 2) * 0.5,
      stepPosition: {
        x: baseParams.stepPosition.x * 0.5,
        y: baseParams.stepPosition.y * 0.5,
        z: baseParams.stepPosition.z * 0.5,
      },
    };

    const baseModel = RigBuilder.generate(baseParams, 42);
    const halfModel = RigBuilder.generate(halfParams, 42);

    const baseMesh = baseModel.meshes[0]!;
    const halfMesh = halfModel.meshes[0]!;

    const baseExtentX = baseMesh.bounds.max.x - baseMesh.bounds.min.x;
    const baseExtentY = baseMesh.bounds.max.y - baseMesh.bounds.min.y;

    const halfExtentX = halfMesh.bounds.max.x - halfMesh.bounds.min.x;
    const halfExtentY = halfMesh.bounds.max.y - halfMesh.bounds.min.y;

    expect(halfExtentX / baseExtentX).toBeCloseTo(0.5, 1);
    expect(halfExtentY / baseExtentY).toBeCloseTo(0.5, 1);
  });
});

// ─── Determinism ─────────────────────────────────────────────────────────────

describe('RigBuilder — determinism', () => {
  it('same params + seed produces byte-identical output', () => {
    const params = makeStayedRig();
    assertDeterministic(RigBuilder, params, 123);
  });

  it('different seed still produces identical output (no randomness used)', () => {
    const params = makeStayedRig();
    const a = RigBuilder.generate(params, 1);
    const b = RigBuilder.generate(params, 999);

    const meshA = a.meshes[0]!;
    const meshB = b.meshes[0]!;

    expect(meshA.positions.length).toBe(meshB.positions.length);
    for (let i = 0; i < meshA.positions.length; i++) {
      expect(meshA.positions[i]).toBe(meshB.positions[i]);
    }
  });
});
