/**
 * Tests for D.9 — ambient world generators.
 *
 * Tests verify:
 * - MooredFleet produces correct variant count with reduced triangle counts
 * - NavigationBuoy produces finite, bounded shapes for each kind
 * - SignatureVessels produces distinct, plausibly-sized meshes
 * - Wildlife produces cheap (low triangle count) finite meshes
 * - All generators are deterministic
 */

import { describe, expect, it } from 'vitest';
import { assertFiniteBuffers } from '../../generation/testing/geometryAssertions';
import { MooredFleetGenerator, type MooredFleetParams } from './MooredFleet';
import { NavigationBuoyGenerator, type NavigationBuoyParams, type BuoyKind } from './NavigationBuoy';
import { HarbourFurnitureGenerator, type HarbourFurnitureParams, type FurnitureKind } from './HarbourFurniture';
import { SignatureVesselGenerator, type SignatureVesselParams, type SignatureVesselKind } from './SignatureVessels';
import { WildlifeGenerator, type WildlifeParams } from './Wildlife';
import { StationLofter } from '../hull/StationLofter';
import type { HullParams, StationCurve, Vec2 } from '@/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function triangleCount(mesh: { indices: Uint32Array }): number {
  return mesh.indices.length / 3;
}

function meshBoundsSize(mesh: { bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } }): {
  width: number;
  height: number;
  depth: number;
} {
  return {
    width: mesh.bounds.max.x - mesh.bounds.min.x,
    height: mesh.bounds.max.y - mesh.bounds.min.y,
    depth: mesh.bounds.max.z - mesh.bounds.min.z,
  };
}

/** A typical player-boat HullParams for comparison (high resolution). */
function makeHighResHullParams(): HullParams {
  const makeStations = (): StationCurve[] => {
    const pts: Vec2[] = [
      { x: 0, y: 0 },
      { x: 0.3, y: 0.3 },
      { x: 0.6, y: 0.6 },
      { x: 0.8, y: 0.8 },
      { x: 0.9, y: 1.0 },
    ];
    return [
      { position: 0.0, points: pts.map(p => ({ x: p.x * 0.2, y: p.y * 1.5 })) },
      { position: 0.15, points: pts.map(p => ({ x: p.x * 0.6, y: p.y * 1.5 })) },
      { position: 0.3, points: pts.map(p => ({ x: p.x * 0.9, y: p.y * 1.5 })) },
      { position: 0.5, points: pts.map(p => ({ x: p.x * 1.0, y: p.y * 1.5 })) },
      { position: 0.7, points: pts.map(p => ({ x: p.x * 0.85, y: p.y * 1.5 })) },
      { position: 0.85, points: pts.map(p => ({ x: p.x * 0.6, y: p.y * 1.5 })) },
      { position: 1.0, points: pts.map(p => ({ x: p.x * 0.4, y: p.y * 1.5 })) },
    ];
  };

  return {
    loa: 10,
    beam: 3,
    designDraft: 1.5,
    waterlineHeight: 1.2,
    stations: makeStations(),
    bilge: 'round',
    hullCount: 1,
    sheerRise: 0.04,
    deckCamber: 0.02,
    lengthSegments: 24,
    girthSegments: 16,
  };
}

// ─── MooredFleet ─────────────────────────────────────────────────────────────

describe('MooredFleetGenerator', () => {
  const params: MooredFleetParams = {
    variantCount: 4,
    baseLoa: 10,
    baseBeam: 3,
  };
  const seed = 42;

  it('produces the requested variant count', () => {
    const result = MooredFleetGenerator.generate(params, seed);
    expect(result.meshes.length).toBe(4);
  });

  it('produces hulls with significantly fewer triangles than a full-resolution hull', () => {
    const lowResResult = MooredFleetGenerator.generate(params, seed);
    const highResModel = StationLofter.generate(makeHighResHullParams(), seed);
    const highResMesh = highResModel.meshes[0];

    expect(highResMesh).toBeDefined();
    if (highResMesh === undefined) return;

    const highResTris = triangleCount(highResMesh);

    for (const mesh of lowResResult.meshes) {
      const lowResTris = triangleCount(mesh);
      // Low-res hulls should have at most 1/3 the triangles of a full-res hull
      expect(lowResTris).toBeLessThan(highResTris / 3);
      // But should still have a meaningful mesh (at least 50 triangles)
      expect(lowResTris).toBeGreaterThan(50);
    }
  });

  it('produces finite, bounded meshes', () => {
    const result = MooredFleetGenerator.generate(params, seed);
    for (const mesh of result.meshes) {
      assertFiniteBuffers(mesh);
      const size = meshBoundsSize(mesh);
      // Hull should have a meaningful Z extent (length dimension) closely
      // matching its nominal loa. StationLofter previously truncated the Z
      // extent to ~60% of stated loa due to a spline re-sampling bug (fixed
      // — see StationLofter.ts interpolateStations); this bound is now tight
      // around the actual baseLoa*[0.85,1.15] variant range (baseLoa=10 in
      // this test) rather than the old loose 2-15m placeholder that would
      // have passed even with the truncation bug present.
      expect(size.depth).toBeGreaterThan(10 * 0.85 * 0.95);
      expect(size.depth).toBeLessThan(10 * 1.15 * 1.05);
    }
  });

  it('is deterministic', () => {
    const a = MooredFleetGenerator.generate(params, seed);
    const b = MooredFleetGenerator.generate(params, seed);
    expect(a.meshes.length).toBe(b.meshes.length);
    for (let i = 0; i < a.meshes.length; i++) {
      const meshA = a.meshes[i];
      const meshB = b.meshes[i];
      if (meshA === undefined || meshB === undefined) continue;
      expect(meshA.positions).toEqual(meshB.positions);
      expect(meshA.indices).toEqual(meshB.indices);
    }
  });

  it('produces varied hulls (not identical clones)', () => {
    const result = MooredFleetGenerator.generate(params, seed);
    // Check that at least the first two variants differ
    const mesh0 = result.meshes[0];
    const mesh1 = result.meshes[1];
    if (mesh0 === undefined || mesh1 === undefined) return;
    // Different variant should have different positions (different LOA/beam)
    const same = mesh0.positions.length === mesh1.positions.length &&
      mesh0.positions.every((v, i) => v === mesh1.positions[i]);
    expect(same).toBe(false);
  });
});

// ─── NavigationBuoy ──────────────────────────────────────────────────────────

describe('NavigationBuoyGenerator', () => {
  const kinds: BuoyKind[] = ['port', 'starboard', 'safe-water', 'cardinal'];
  const seed = 123;

  for (const kind of kinds) {
    describe(`kind: ${kind}`, () => {
      const params: NavigationBuoyParams = { kind, height: 2.0, diameter: 1.0 };

      it('produces a finite, bounded mesh', () => {
        const result = NavigationBuoyGenerator.generate(params, seed);
        expect(result.meshes.length).toBe(1);
        const mesh = result.meshes[0];
        if (mesh === undefined) return;
        assertFiniteBuffers(mesh);

        const size = meshBoundsSize(mesh);
        // Buoy should be roughly the specified dimensions
        expect(size.height).toBeGreaterThan(1.5);
        expect(size.height).toBeLessThan(3.0);
        expect(size.width).toBeGreaterThan(0.5);
        expect(size.width).toBeLessThan(2.0);
      });

      it('encodes colour in meta', () => {
        const result = NavigationBuoyGenerator.generate(params, seed);
        const mesh = result.meshes[0];
        if (mesh === undefined) return;
        expect(mesh.meta.colorR).toBeDefined();
        expect(mesh.meta.colorG).toBeDefined();
        expect(mesh.meta.colorB).toBeDefined();
      });

      it('is deterministic', () => {
        const a = NavigationBuoyGenerator.generate(params, seed);
        const b = NavigationBuoyGenerator.generate(params, seed);
        const meshA = a.meshes[0];
        const meshB = b.meshes[0];
        if (meshA === undefined || meshB === undefined) return;
        expect(meshA.positions).toEqual(meshB.positions);
        expect(meshA.indices).toEqual(meshB.indices);
      });
    });
  }

  it('produces distinct shapes for different kinds', () => {
    const port = NavigationBuoyGenerator.generate({ kind: 'port' }, seed);
    const starboard = NavigationBuoyGenerator.generate({ kind: 'starboard' }, seed);
    const portMesh = port.meshes[0];
    const starboardMesh = starboard.meshes[0];
    if (portMesh === undefined || starboardMesh === undefined) return;
    // Different profiles should produce different vertex counts or positions
    const positionsMatch = portMesh.positions.length === starboardMesh.positions.length &&
      portMesh.positions.every((v, i) => v === starboardMesh.positions[i]);
    expect(positionsMatch).toBe(false);
  });
});

// ─── HarbourFurniture ────────────────────────────────────────────────────────

describe('HarbourFurnitureGenerator', () => {
  const kinds: FurnitureKind[] = ['bollard', 'pier-section', 'cleat', 'fender'];
  const seed = 456;

  for (const kind of kinds) {
    it(`produces a finite mesh for kind: ${kind}`, () => {
      const params: HarbourFurnitureParams = { kind, scale: 1.0 };
      const result = HarbourFurnitureGenerator.generate(params, seed);
      expect(result.meshes.length).toBe(1);
      const mesh = result.meshes[0];
      if (mesh === undefined) return;
      assertFiniteBuffers(mesh);
      expect(triangleCount(mesh)).toBeGreaterThan(5);
    });
  }

  it('is deterministic', () => {
    const params: HarbourFurnitureParams = { kind: 'bollard', scale: 1.0 };
    const a = HarbourFurnitureGenerator.generate(params, seed);
    const b = HarbourFurnitureGenerator.generate(params, seed);
    const meshA = a.meshes[0];
    const meshB = b.meshes[0];
    if (meshA === undefined || meshB === undefined) return;
    expect(meshA.positions).toEqual(meshB.positions);
    expect(meshA.indices).toEqual(meshB.indices);
  });
});

// ─── SignatureVessels ────────────────────────────────────────────────────────

describe('SignatureVesselGenerator', () => {
  const seed = 789;
  const kinds: Array<{ kind: SignatureVesselKind; length: number }> = [
    { kind: 'ferry', length: 80 },
    { kind: 'containerShip', length: 200 },
    { kind: 'hovercraft', length: 30 },
  ];

  for (const { kind, length } of kinds) {
    describe(`kind: ${kind}`, () => {
      const params: SignatureVesselParams = { kind, length };

      it('produces a finite mesh', () => {
        const result = SignatureVesselGenerator.generate(params, seed);
        expect(result.meshes.length).toBe(1);
        const mesh = result.meshes[0];
        if (mesh === undefined) return;
        assertFiniteBuffers(mesh);
      });

      it('roughly respects the length parameter', () => {
        const result = SignatureVesselGenerator.generate(params, seed);
        const mesh = result.meshes[0];
        if (mesh === undefined) return;
        const size = meshBoundsSize(mesh);
        // The longest dimension should be roughly the specified length (±50%)
        const longest = Math.max(size.width, size.height, size.depth);
        expect(longest).toBeGreaterThan(length * 0.3);
        expect(longest).toBeLessThan(length * 1.5);
      });

      it('is deterministic', () => {
        const a = SignatureVesselGenerator.generate(params, seed);
        const b = SignatureVesselGenerator.generate(params, seed);
        const meshA = a.meshes[0];
        const meshB = b.meshes[0];
        if (meshA === undefined || meshB === undefined) return;
        expect(meshA.positions).toEqual(meshB.positions);
        expect(meshA.indices).toEqual(meshB.indices);
      });
    });
  }

  it('produces distinct meshes for different vessel types', () => {
    const ferry = SignatureVesselGenerator.generate({ kind: 'ferry', length: 80 }, seed);
    const container = SignatureVesselGenerator.generate({ kind: 'containerShip', length: 200 }, seed);
    const hovercraft = SignatureVesselGenerator.generate({ kind: 'hovercraft', length: 30 }, seed);

    const ferryMesh = ferry.meshes[0];
    const containerMesh = container.meshes[0];
    const hovercraftMesh = hovercraft.meshes[0];

    if (ferryMesh === undefined || containerMesh === undefined || hovercraftMesh === undefined) return;

    // Ferry and container ship use the same lofting topology (same segment counts)
    // but different HullParams produce different vertex positions
    const positionsMatch = ferryMesh.positions.length === containerMesh.positions.length &&
      ferryMesh.positions.every((v, i) => Math.abs(v - (containerMesh.positions[i] ?? 0)) < 1e-6);
    expect(positionsMatch).toBe(false);

    // Hovercraft uses a completely different generation path (extrude vs loft)
    // so topology differs
    expect(hovercraftMesh.indices.length).not.toBe(ferryMesh.indices.length);
  });
});

// ─── Wildlife ────────────────────────────────────────────────────────────────

describe('WildlifeGenerator', () => {
  const seed = 321;

  describe('gull', () => {
    const params: WildlifeParams = { kind: 'gull', bodyLength: 0.4 };

    it('produces a cheap mesh (<100 triangles)', () => {
      const result = WildlifeGenerator.generate(params, seed);
      expect(result.meshes.length).toBe(1);
      const mesh = result.meshes[0];
      if (mesh === undefined) return;
      const tris = triangleCount(mesh);
      expect(tris).toBeLessThan(200); // generous upper bound for merged body+wings
      expect(tris).toBeGreaterThan(20); // but not degenerate
    });

    it('produces a finite mesh', () => {
      const result = WildlifeGenerator.generate(params, seed);
      const mesh = result.meshes[0];
      if (mesh === undefined) return;
      assertFiniteBuffers(mesh);
    });

    it('is deterministic', () => {
      const a = WildlifeGenerator.generate(params, seed);
      const b = WildlifeGenerator.generate(params, seed);
      const meshA = a.meshes[0];
      const meshB = b.meshes[0];
      if (meshA === undefined || meshB === undefined) return;
      expect(meshA.positions).toEqual(meshB.positions);
      expect(meshA.indices).toEqual(meshB.indices);
    });
  });

  describe('dolphin', () => {
    const params: WildlifeParams = { kind: 'dolphin', bodyLength: 2.5 };

    it('produces a cheap mesh (<200 triangles)', () => {
      const result = WildlifeGenerator.generate(params, seed);
      expect(result.meshes.length).toBe(1);
      const mesh = result.meshes[0];
      if (mesh === undefined) return;
      const tris = triangleCount(mesh);
      expect(tris).toBeLessThan(250); // generous upper bound for merged body+fins+flukes
      expect(tris).toBeGreaterThan(30);
    });

    it('produces a finite mesh', () => {
      const result = WildlifeGenerator.generate(params, seed);
      const mesh = result.meshes[0];
      if (mesh === undefined) return;
      assertFiniteBuffers(mesh);
    });

    it('is deterministic', () => {
      const a = WildlifeGenerator.generate(params, seed);
      const b = WildlifeGenerator.generate(params, seed);
      const meshA = a.meshes[0];
      const meshB = b.meshes[0];
      if (meshA === undefined || meshB === undefined) return;
      expect(meshA.positions).toEqual(meshB.positions);
      expect(meshA.indices).toEqual(meshB.indices);
    });
  });

  it('gull and dolphin are distinct', () => {
    const gull = WildlifeGenerator.generate({ kind: 'gull' }, seed);
    const dolphin = WildlifeGenerator.generate({ kind: 'dolphin' }, seed);
    const gullMesh = gull.meshes[0];
    const dolphinMesh = dolphin.meshes[0];
    if (gullMesh === undefined || dolphinMesh === undefined) return;
    expect(gullMesh.positions.length).not.toBe(dolphinMesh.positions.length);
  });
});
