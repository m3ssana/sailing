/**
 * Tests for the generation harness infrastructure.
 *
 * Tests the pure, Node-testable parts of the harness:
 * - Generator registry (register, lookup, duplicate detection)
 * - Cache key derivation (deterministic hashing)
 * - Worker pool size derivation
 * - Generation phase orchestration (direct mode, no actual workers)
 * - Mesh utilities (bounds, normals, merge, transferables)
 *
 * NOT tested here (requires browser environment):
 * - Actual web worker dispatch and ArrayBuffer transfer
 * - IndexedDB storage and retrieval
 * - Real cross-thread communication
 *
 * These are explicitly untested because Vitest runs in Node.js where Web Workers
 * and IndexedDB are not available. The logic is structured so the pure parts
 * (tested here) are separated from the browser-only parts.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import {
  registerGenerator,
  getGenerator,
  hasGenerator,
  clearRegistry,
} from '@generation/GeneratorRegistry';
import { deriveCacheKey } from '@generation/cache';
import { derivePoolSize } from '@generation/WorkerPool';
import { runGenerationPhaseDirect } from '@generation/GenerationPhase';
import {
  computeBounds,
  computeNormals,
  mergeMeshes,
  gatherTransferables,
} from '@generation/common/meshUtils';
import { BoxGenerator } from '@generation/common/BoxGenerator';
import type { GenerationProgress } from '@/types';

// ─── Generator Registry ──────────────────────────────────────────────────────

describe('GeneratorRegistry', () => {
  beforeEach(() => {
    clearRegistry();
  });

  it('registers and retrieves a generator', () => {
    registerGenerator(BoxGenerator);
    const gen = getGenerator('box');
    expect(gen).toBeDefined();
    expect(gen?.id).toBe('box');
  });

  it('returns undefined for unknown id', () => {
    expect(getGenerator('nonexistent')).toBeUndefined();
  });

  it('hasGenerator returns correct boolean', () => {
    expect(hasGenerator('box')).toBe(false);
    registerGenerator(BoxGenerator);
    expect(hasGenerator('box')).toBe(true);
  });

  it('throws on duplicate registration', () => {
    registerGenerator(BoxGenerator);
    expect(() => registerGenerator(BoxGenerator)).toThrow(/already registered/);
  });

  it('clearRegistry removes all generators', () => {
    registerGenerator(BoxGenerator);
    clearRegistry();
    expect(hasGenerator('box')).toBe(false);
  });
});

// ─── Cache key derivation ────────────────────────────────────────────────────

describe('deriveCacheKey', () => {
  it('produces deterministic keys for the same input', () => {
    const key1 = deriveCacheKey('box', { width: 1, height: 2, depth: 3 }, 42);
    const key2 = deriveCacheKey('box', { width: 1, height: 2, depth: 3 }, 42);
    expect(key1).toBe(key2);
  });

  it('produces different keys for different generators', () => {
    const key1 = deriveCacheKey('box', { width: 1 }, 42);
    const key2 = deriveCacheKey('sphere', { width: 1 }, 42);
    expect(key1).not.toBe(key2);
  });

  it('produces different keys for different params', () => {
    const key1 = deriveCacheKey('box', { width: 1, height: 2 }, 42);
    const key2 = deriveCacheKey('box', { width: 2, height: 1 }, 42);
    expect(key1).not.toBe(key2);
  });

  it('produces different keys for different seeds', () => {
    const key1 = deriveCacheKey('box', { width: 1 }, 42);
    const key2 = deriveCacheKey('box', { width: 1 }, 43);
    expect(key1).not.toBe(key2);
  });

  it('is insensitive to property order in params', () => {
    const key1 = deriveCacheKey('box', { width: 1, height: 2, depth: 3 }, 42);
    const key2 = deriveCacheKey('box', { depth: 3, width: 1, height: 2 }, 42);
    expect(key1).toBe(key2);
  });

  it('includes the cache version in the key', () => {
    const key = deriveCacheKey('box', { width: 1 }, 42);
    expect(key).toMatch(/^v\d+:/);
  });
});

// ─── Worker pool size derivation ─────────────────────────────────────────────

describe('derivePoolSize', () => {
  it('clamps to minimum 1', () => {
    expect(derivePoolSize(1)).toBe(1);
    expect(derivePoolSize(0)).toBe(1);
    expect(derivePoolSize(-1)).toBe(1);
  });

  it('clamps to maximum 4', () => {
    expect(derivePoolSize(16)).toBe(4);
    expect(derivePoolSize(100)).toBe(4);
  });

  it('uses hardwareConcurrency - 1', () => {
    expect(derivePoolSize(4)).toBe(3);
    expect(derivePoolSize(3)).toBe(2);
    expect(derivePoolSize(2)).toBe(1);
  });

  it('caps at 4 even for high concurrency', () => {
    expect(derivePoolSize(8)).toBe(4);
    expect(derivePoolSize(5)).toBe(4);
  });
});

// ─── Generation phase (direct mode) ─────────────────────────────────────────

describe('runGenerationPhaseDirect', () => {
  it('runs a single job and returns the model', async () => {
    const generators = new Map([['box', BoxGenerator]]);
    const result = await runGenerationPhaseDirect(
      [{ stage: 'Hull', generatorId: 'box', params: { width: 2, height: 1, depth: 3 }, seed: 1 }],
      generators,
    );

    expect(result.models.size).toBe(1);
    expect(result.models.has('Hull')).toBe(true);
    expect(result.elapsed).toBeGreaterThanOrEqual(0);
    expect(result.cacheHits).toBe(0);
  });

  it('runs multiple jobs respecting priority', async () => {
    const generators = new Map([['box', BoxGenerator]]);
    const progress: GenerationProgress[] = [];

    await runGenerationPhaseDirect(
      [
        { stage: 'Terrain', generatorId: 'box', params: { width: 10, height: 1, depth: 10 }, seed: 1, priority: 2 },
        { stage: 'Hull', generatorId: 'box', params: { width: 2, height: 1, depth: 5 }, seed: 2, priority: 0 },
        { stage: 'Rig', generatorId: 'box', params: { width: 0.1, height: 10, depth: 0.1 }, seed: 3, priority: 1 },
      ],
      generators,
      {
        onProgress: (p) => progress.push({ ...p }),
      },
    );

    // Should have progress reports in priority order + completion
    expect(progress.length).toBe(4); // 3 jobs + final "complete"
    expect(progress[0]?.stage).toBe('Hull'); // priority 0 first
    expect(progress[1]?.stage).toBe('Rig'); // priority 1 second
    expect(progress[2]?.stage).toBe('Terrain'); // priority 2 third
    expect(progress[3]?.stage).toBe('complete');
  });

  it('throws for unknown generator', async () => {
    const generators = new Map([['box', BoxGenerator]]);
    await expect(
      runGenerationPhaseDirect(
        [{ stage: 'Bad', generatorId: 'nonexistent', params: {}, seed: 1 }],
        generators,
      ),
    ).rejects.toThrow(/Unknown generator/);
  });

  it('reports progress with increasing fractions', async () => {
    const generators = new Map([['box', BoxGenerator]]);
    const fractions: number[] = [];

    await runGenerationPhaseDirect(
      [
        { stage: 'A', generatorId: 'box', params: { width: 1, height: 1, depth: 1 }, seed: 1 },
        { stage: 'B', generatorId: 'box', params: { width: 1, height: 1, depth: 1 }, seed: 2 },
        { stage: 'C', generatorId: 'box', params: { width: 1, height: 1, depth: 1 }, seed: 3 },
      ],
      generators,
      { onProgress: (p) => fractions.push(p.progress) },
    );

    // Progress should be monotonically non-decreasing
    for (let i = 1; i < fractions.length; i++) {
      const prev = fractions[i - 1];
      const curr = fractions[i];
      if (prev !== undefined && curr !== undefined) {
        expect(curr).toBeGreaterThanOrEqual(prev);
      }
    }
    // Last should be 1
    expect(fractions[fractions.length - 1]).toBe(1);
  });
});

// ─── Mesh utilities ──────────────────────────────────────────────────────────

describe('computeBounds', () => {
  it('computes correct bounds for a unit cube', () => {
    const mesh = BoxGenerator.generate({ width: 2, height: 4, depth: 6 }, 0).meshes[0];
    if (!mesh) throw new Error('no mesh');
    const bounds = computeBounds(mesh.positions);
    expect(bounds.min.x).toBeCloseTo(-1, 10);
    expect(bounds.max.x).toBeCloseTo(1, 10);
    expect(bounds.min.y).toBeCloseTo(-2, 10);
    expect(bounds.max.y).toBeCloseTo(2, 10);
    expect(bounds.min.z).toBeCloseTo(-3, 10);
    expect(bounds.max.z).toBeCloseTo(3, 10);
  });

  it('returns zero bounds for empty buffer', () => {
    const bounds = computeBounds(new Float32Array(0));
    expect(bounds.min.x).toBe(0);
    expect(bounds.max.x).toBe(0);
  });
});

describe('computeNormals', () => {
  it('produces unit-length normals', () => {
    const mesh = BoxGenerator.generate({ width: 1, height: 1, depth: 1 }, 0).meshes[0];
    if (!mesh) throw new Error('no mesh');
    const normals = computeNormals(mesh.positions, mesh.indices);

    for (let i = 0; i < normals.length; i += 3) {
      const nx = normals[i] ?? 0;
      const ny = normals[i + 1] ?? 0;
      const nz = normals[i + 2] ?? 0;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      // Each vertex normal should be unit length (box faces don't share vertices)
      expect(len).toBeCloseTo(1.0, 5);
    }
  });
});

describe('mergeMeshes', () => {
  it('merges two meshes with correct index offsets', () => {
    const model1 = BoxGenerator.generate({ width: 1, height: 1, depth: 1 }, 0);
    const model2 = BoxGenerator.generate({ width: 2, height: 2, depth: 2 }, 0);
    const mesh1 = model1.meshes[0];
    const mesh2 = model2.meshes[0];
    if (!mesh1 || !mesh2) throw new Error('no meshes');

    const merged = mergeMeshes([mesh1, mesh2]);

    expect(merged.positions.length).toBe(mesh1.positions.length + mesh2.positions.length);
    expect(merged.indices.length).toBe(mesh1.indices.length + mesh2.indices.length);

    // Second mesh's indices should be offset
    const vertexCount1 = mesh1.positions.length / 3;
    const firstIdxOfMesh2 = merged.indices[mesh1.indices.length];
    if (firstIdxOfMesh2 !== undefined) {
      expect(firstIdxOfMesh2).toBeGreaterThanOrEqual(vertexCount1);
    }
  });

  it('returns empty mesh for empty array', () => {
    const merged = mergeMeshes([]);
    expect(merged.positions.length).toBe(0);
    expect(merged.indices.length).toBe(0);
  });
});

describe('gatherTransferables', () => {
  it('collects all unique buffers from a model', () => {
    const model = BoxGenerator.generate({ width: 1, height: 1, depth: 1 }, 0);
    const transferables = gatherTransferables(model);

    // At minimum: positions, normals, uvs, indices = 4 buffers per mesh
    expect(transferables.length).toBeGreaterThanOrEqual(4);

    // All should be ArrayBuffer instances
    for (const t of transferables) {
      expect(t).toBeInstanceOf(ArrayBuffer);
    }
  });

  it('deduplicates shared buffers', () => {
    const model = BoxGenerator.generate({ width: 1, height: 1, depth: 1 }, 0);
    const transferables = gatherTransferables(model);
    const unique = new Set(transferables);
    expect(unique.size).toBe(transferables.length);
  });
});

// ─── BoxGenerator basic sanity ───────────────────────────────────────────────

describe('BoxGenerator', () => {
  it('has id "box"', () => {
    expect(BoxGenerator.id).toBe('box');
  });

  it('produces one mesh with one group', () => {
    const model = BoxGenerator.generate({ width: 1, height: 1, depth: 1 }, 0);
    expect(model.meshes.length).toBe(1);
    expect(model.groups.length).toBe(1);
  });

  it('produces 8 vertices and 36 indices (6 faces × 2 tris)', () => {
    const model = BoxGenerator.generate({ width: 1, height: 1, depth: 1 }, 0);
    const mesh = model.meshes[0];
    if (!mesh) throw new Error('no mesh');
    expect(mesh.positions.length).toBe(8 * 3);
    expect(mesh.indices.length).toBe(36);
  });

  it('includes volume and surface area in meta', () => {
    const model = BoxGenerator.generate({ width: 2, height: 3, depth: 5 }, 0);
    const mesh = model.meshes[0];
    if (!mesh) throw new Error('no mesh');
    expect(mesh.meta['volume']).toBeCloseTo(30, 10);
    expect(mesh.meta['surfaceArea']).toBeCloseTo(2 * (6 + 15 + 10), 10);
  });
});
