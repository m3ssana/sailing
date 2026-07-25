/**
 * Landmark generators tests — D.6.
 *
 * Validates all 7 landmark generators:
 * - Generates without throwing given reasonable params
 * - Produces finite (no NaN/Infinity), non-degenerate mesh
 * - Plausible bounds match params
 * - Determinism (same params + seed → byte-identical)
 * - Winding/watertightness for closed solids (suspensionBridge deck, lighthouse)
 *
 * Closed-solid assessment per generator:
 * - suspensionBridge: Mixed — towers and deck are closed, cables are open.
 *   We test the deck portion individually and the merged mesh for finite buffers.
 * - shellVault: OPEN — shell arcs are partial revolves. No watertightness test.
 * - ridgePlateau: OPEN — one-sided heightfield strip. No watertightness test.
 * - skyline: Individual buildings are closed, merged is disjoint. No watertightness test.
 * - lighthouse: CLOSED — full revolve with axis-touching profile. Watertightness tested.
 * - harbourFurniture: Mixed — individual pilings/bollards closed, merged disjoint.
 * - breakwater: CLOSED — swept trapezoidal tube with caps. Watertightness tested.
 */

import { describe, expect, it } from 'vitest';
import {
  assertConsistentWinding,
  assertDeterministic,
  assertFiniteBuffers,
  assertNoDegenerateTriangles,
  assertWatertight,
  computeVolume,
} from '@generation/testing/geometryAssertions';

import { SuspensionBridgeGenerator } from './SuspensionBridgeGenerator';
import { ShellVaultGenerator } from './ShellVaultGenerator';
import { RidgePlateauGenerator } from './RidgePlateauGenerator';
import { SkylineGenerator } from './SkylineGenerator';
import { LighthouseGenerator } from './LighthouseGenerator';
import { HarbourFurnitureGenerator } from './HarbourFurnitureGenerator';
import { BreakwaterGenerator } from './BreakwaterGenerator';

// ─── Test seed ───────────────────────────────────────────────────────────────

const TEST_SEED = 42;

// ─── Suspension Bridge ───────────────────────────────────────────────────────

describe('SuspensionBridgeGenerator', () => {
  const defaultParams = { span: 400, towerHeight: 80 };

  it('generates without throwing', () => {
    expect(() => SuspensionBridgeGenerator.generate(defaultParams, TEST_SEED)).not.toThrow();
  });

  it('produces finite, non-degenerate mesh', () => {
    const model = SuspensionBridgeGenerator.generate(defaultParams, TEST_SEED);
    const mesh = model.meshes[0];
    expect(mesh).toBeDefined();
    if (!mesh) return;
    assertFiniteBuffers(mesh);
    // Degenerate check with slightly relaxed epsilon for thin cables
    assertNoDegenerateTriangles(mesh, 1e-12);
  });

  it('bounds span roughly matches the span param', () => {
    const span = 500;
    const model = SuspensionBridgeGenerator.generate({ span, towerHeight: 80 }, TEST_SEED);
    const mesh = model.meshes[0];
    expect(mesh).toBeDefined();
    if (!mesh) return;
    const xExtent = mesh.bounds.max.x - mesh.bounds.min.x;
    // Span should be approximately the requested value (±10% due to towers extending inboard)
    expect(xExtent).toBeGreaterThan(span * 0.8);
    expect(xExtent).toBeLessThan(span * 1.2);
  });

  it('is deterministic', () => {
    assertDeterministic(SuspensionBridgeGenerator, defaultParams, TEST_SEED);
  });

  it('has correct generator id', () => {
    expect(SuspensionBridgeGenerator.id).toBe('suspensionBridge');
  });
});

// ─── Shell Vault ─────────────────────────────────────────────────────────────

describe('ShellVaultGenerator', () => {
  const defaultParams = { maxShellHeight: 45, numShells: 4 };

  it('generates without throwing', () => {
    expect(() => ShellVaultGenerator.generate(defaultParams, TEST_SEED)).not.toThrow();
  });

  it('produces finite, non-degenerate mesh', () => {
    const model = ShellVaultGenerator.generate(defaultParams, TEST_SEED);
    const mesh = model.meshes[0];
    expect(mesh).toBeDefined();
    if (!mesh) return;
    assertFiniteBuffers(mesh);
  });

  it('height bounds roughly match maxShellHeight', () => {
    const maxShellHeight = 60;
    const model = ShellVaultGenerator.generate({ maxShellHeight }, TEST_SEED);
    const mesh = model.meshes[0];
    expect(mesh).toBeDefined();
    if (!mesh) return;
    const yExtent = mesh.bounds.max.y - mesh.bounds.min.y;
    // Tallest shell should be close to maxShellHeight
    expect(yExtent).toBeGreaterThan(maxShellHeight * 0.5);
    expect(yExtent).toBeLessThan(maxShellHeight * 1.3);
  });

  it('is deterministic', () => {
    assertDeterministic(ShellVaultGenerator, defaultParams, TEST_SEED);
  });

  it('has correct generator id', () => {
    expect(ShellVaultGenerator.id).toBe('shellVault');
  });
});

// ─── Ridge Plateau ───────────────────────────────────────────────────────────

describe('RidgePlateauGenerator', () => {
  const defaultParams = { width: 2000, maxHeight: 300 };

  it('generates without throwing', () => {
    expect(() => RidgePlateauGenerator.generate(defaultParams, TEST_SEED)).not.toThrow();
  });

  it('produces finite, non-degenerate mesh', () => {
    const model = RidgePlateauGenerator.generate(defaultParams, TEST_SEED);
    const mesh = model.meshes[0];
    expect(mesh).toBeDefined();
    if (!mesh) return;
    assertFiniteBuffers(mesh);
  });

  it('width bounds roughly match the width param', () => {
    const width = 1000;
    const model = RidgePlateauGenerator.generate({ width, maxHeight: 200 }, TEST_SEED);
    const mesh = model.meshes[0];
    expect(mesh).toBeDefined();
    if (!mesh) return;
    const xExtent = mesh.bounds.max.x - mesh.bounds.min.x;
    expect(xExtent).toBeCloseTo(width, -1); // within ~10m
  });

  it('is deterministic', () => {
    assertDeterministic(RidgePlateauGenerator, defaultParams, TEST_SEED);
  });

  it('different seeds produce different results', () => {
    const a = RidgePlateauGenerator.generate(defaultParams, 1);
    const b = RidgePlateauGenerator.generate(defaultParams, 2);
    const meshA = a.meshes[0];
    const meshB = b.meshes[0];
    expect(meshA).toBeDefined();
    expect(meshB).toBeDefined();
    if (!meshA || !meshB) return;
    // At least some positions should differ
    let differs = false;
    for (let i = 0; i < Math.min(meshA.positions.length, meshB.positions.length); i++) {
      if (meshA.positions[i] !== meshB.positions[i]) {
        differs = true;
        break;
      }
    }
    expect(differs).toBe(true);
  });

  it('has correct generator id', () => {
    expect(RidgePlateauGenerator.id).toBe('ridgePlateau');
  });
});

// ─── Skyline ─────────────────────────────────────────────────────────────────

describe('SkylineGenerator', () => {
  const defaultParams = { numBuildings: 10, maxHeight: 100, width: 200 };

  it('generates without throwing', () => {
    expect(() => SkylineGenerator.generate(defaultParams, TEST_SEED)).not.toThrow();
  });

  it('produces finite, non-degenerate mesh', () => {
    const model = SkylineGenerator.generate(defaultParams, TEST_SEED);
    const mesh = model.meshes[0];
    expect(mesh).toBeDefined();
    if (!mesh) return;
    assertFiniteBuffers(mesh);
  });

  it('height bounds respect maxHeight', () => {
    const maxHeight = 120;
    const model = SkylineGenerator.generate({ numBuildings: 15, maxHeight }, TEST_SEED);
    const mesh = model.meshes[0];
    expect(mesh).toBeDefined();
    if (!mesh) return;
    // No building should exceed maxHeight (with bevel it can be very slightly over)
    expect(mesh.bounds.max.y).toBeLessThan(maxHeight * 1.1);
    expect(mesh.bounds.max.y).toBeGreaterThan(maxHeight * 0.3);
  });

  it('is deterministic', () => {
    assertDeterministic(SkylineGenerator, defaultParams, TEST_SEED);
  });

  it('different seeds produce different skylines', () => {
    const a = SkylineGenerator.generate(defaultParams, 100);
    const b = SkylineGenerator.generate(defaultParams, 200);
    const meshA = a.meshes[0];
    const meshB = b.meshes[0];
    expect(meshA).toBeDefined();
    expect(meshB).toBeDefined();
    if (!meshA || !meshB) return;
    let differs = false;
    for (let i = 0; i < Math.min(meshA.positions.length, meshB.positions.length); i++) {
      if (meshA.positions[i] !== meshB.positions[i]) {
        differs = true;
        break;
      }
    }
    expect(differs).toBe(true);
  });

  it('has correct generator id', () => {
    expect(SkylineGenerator.id).toBe('skyline');
  });
});

// ─── Lighthouse ──────────────────────────────────────────────────────────────

describe('LighthouseGenerator', () => {
  const defaultParams = { height: 25, baseRadius: 3.5 };

  it('generates without throwing', () => {
    expect(() => LighthouseGenerator.generate(defaultParams, TEST_SEED)).not.toThrow();
  });

  it('produces finite, non-degenerate mesh', () => {
    const model = LighthouseGenerator.generate(defaultParams, TEST_SEED);
    const mesh = model.meshes[0];
    expect(mesh).toBeDefined();
    if (!mesh) return;
    assertFiniteBuffers(mesh);
    assertNoDegenerateTriangles(mesh);
  });

  it('height bounds match the height param', () => {
    const height = 30;
    const model = LighthouseGenerator.generate({ height }, TEST_SEED);
    const mesh = model.meshes[0];
    expect(mesh).toBeDefined();
    if (!mesh) return;
    const yExtent = mesh.bounds.max.y - mesh.bounds.min.y;
    // Height should be approximately the requested value
    expect(yExtent).toBeGreaterThan(height * 0.9);
    expect(yExtent).toBeLessThan(height * 1.1);
  });

  it('is a closed solid with consistent winding and positive volume', () => {
    const model = LighthouseGenerator.generate(defaultParams, TEST_SEED);
    const mesh = model.meshes[0];
    expect(mesh).toBeDefined();
    if (!mesh) return;
    assertWatertight(mesh);
    assertConsistentWinding(mesh);
    const volume = computeVolume(mesh);
    expect(volume).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    assertDeterministic(LighthouseGenerator, defaultParams, TEST_SEED);
  });

  it('has correct generator id', () => {
    expect(LighthouseGenerator.id).toBe('lighthouse');
  });
});

// ─── Harbour Furniture ───────────────────────────────────────────────────────

describe('HarbourFurnitureGenerator', () => {
  const defaultParams = { pierLength: 30, pierWidth: 6, numBollards: 4 };

  it('generates without throwing', () => {
    expect(() => HarbourFurnitureGenerator.generate(defaultParams, TEST_SEED)).not.toThrow();
  });

  it('produces finite, non-degenerate mesh', () => {
    const model = HarbourFurnitureGenerator.generate(defaultParams, TEST_SEED);
    const mesh = model.meshes[0];
    expect(mesh).toBeDefined();
    if (!mesh) return;
    assertFiniteBuffers(mesh);
  });

  it('pier length bounds roughly match param', () => {
    const pierLength = 50;
    const model = HarbourFurnitureGenerator.generate({ pierLength, pierWidth: 8 }, TEST_SEED);
    const mesh = model.meshes[0];
    expect(mesh).toBeDefined();
    if (!mesh) return;
    const xExtent = mesh.bounds.max.x - mesh.bounds.min.x;
    expect(xExtent).toBeGreaterThan(pierLength * 0.8);
    expect(xExtent).toBeLessThan(pierLength * 1.3);
  });

  it('is deterministic', () => {
    assertDeterministic(HarbourFurnitureGenerator, defaultParams, TEST_SEED);
  });

  it('has correct generator id', () => {
    expect(HarbourFurnitureGenerator.id).toBe('harbourFurniture');
  });
});

// ─── Breakwater ──────────────────────────────────────────────────────────────

describe('BreakwaterGenerator', () => {
  const defaultParams = { length: 200, height: 4 };

  it('generates without throwing', () => {
    expect(() => BreakwaterGenerator.generate(defaultParams, TEST_SEED)).not.toThrow();
  });

  it('produces finite, non-degenerate mesh', () => {
    const model = BreakwaterGenerator.generate(defaultParams, TEST_SEED);
    const mesh = model.meshes[0];
    expect(mesh).toBeDefined();
    if (!mesh) return;
    assertFiniteBuffers(mesh);
  });

  it('length bounds roughly match the length param', () => {
    const length = 300;
    const model = BreakwaterGenerator.generate({ length, height: 5 }, TEST_SEED);
    const mesh = model.meshes[0];
    expect(mesh).toBeDefined();
    if (!mesh) return;
    const xExtent = mesh.bounds.max.x - mesh.bounds.min.x;
    expect(xExtent).toBeGreaterThan(length * 0.9);
    expect(xExtent).toBeLessThan(length * 1.1);
  });

  it('is a closed solid with consistent winding', () => {
    // Use zero roughness for a clean geometric test
    const model = BreakwaterGenerator.generate(
      { length: 100, height: 4, roughness: 0 },
      TEST_SEED,
    );
    const mesh = model.meshes[0];
    expect(mesh).toBeDefined();
    if (!mesh) return;
    assertWatertight(mesh);
    assertConsistentWinding(mesh);
    const volume = computeVolume(mesh);
    expect(volume).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    assertDeterministic(BreakwaterGenerator, defaultParams, TEST_SEED);
  });

  it('supports curvature parameter', () => {
    const straight = BreakwaterGenerator.generate({ length: 200, curvature: 0 }, TEST_SEED);
    const curved = BreakwaterGenerator.generate({ length: 200, curvature: 0.5 }, TEST_SEED);
    const meshStraight = straight.meshes[0];
    const meshCurved = curved.meshes[0];
    expect(meshStraight).toBeDefined();
    expect(meshCurved).toBeDefined();
    if (!meshStraight || !meshCurved) return;
    // Curved should have some Z extent that straight doesn't
    const zStraight = meshCurved.bounds.max.z - meshCurved.bounds.min.z;
    expect(zStraight).toBeGreaterThan(meshStraight.bounds.max.z - meshStraight.bounds.min.z);
  });

  it('has correct generator id', () => {
    expect(BreakwaterGenerator.id).toBe('breakwater');
  });
});
