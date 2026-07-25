/**
 * IndexedDB geometry cache — stores generated models keyed by a deterministic
 * hash of (generatorId, params, seed).
 *
 * Because generators are pure and deterministic, a cache hit is always valid.
 * The only invalidation is a schema version bump, which clears the entire store.
 *
 * Engine-agnostic — no three.js.
 */

import type { GeneratedMesh, GeneratedModel, MeshGroup, Seed } from '@/types';
import { hashString, hashCombine } from '@core/math';

// Bump this whenever the serialisation format changes. On mismatch the entire
// cache is cleared, which is fine — regeneration is bounded at ~3 s.
export const CACHE_VERSION = 1;

const DB_NAME = 'sailing-generation-cache';
const STORE_NAME = 'models';

// ─── Cache key derivation ────────────────────────────────────────────────────

/**
 * Produce a deterministic string key from (generatorId, params, seed).
 *
 * We JSON.stringify params with sorted keys so object property order doesn't
 * affect the hash. This is the pure, testable core of the cache.
 */
export function deriveCacheKey(generatorId: string, params: unknown, seed: Seed): string {
  const paramsStr = JSON.stringify(params, Object.keys(params as object).sort());
  const paramsHash = hashString(paramsStr);
  const combined = hashCombine(hashString(generatorId), paramsHash, seed);
  return `v${CACHE_VERSION}:${combined.toString(36)}`;
}

// ─── Serialisation helpers ───────────────────────────────────────────────────

/** Serialisable form of a GeneratedMesh for IndexedDB structured clone. */
interface SerializedMesh {
  positions: ArrayBuffer;
  normals: ArrayBuffer;
  uvs: ArrayBuffer;
  indices: ArrayBuffer;
  colors: ArrayBuffer | null;
  tangents: ArrayBuffer | null;
  bounds: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };
  meta: Record<string, number>;
}

interface SerializedModel {
  meshes: SerializedMesh[];
  groups: MeshGroup[];
}

function serializeMesh(mesh: GeneratedMesh): SerializedMesh {
  return {
    positions: mesh.positions.buffer as ArrayBuffer,
    normals: mesh.normals.buffer as ArrayBuffer,
    uvs: mesh.uvs.buffer as ArrayBuffer,
    indices: mesh.indices.buffer as ArrayBuffer,
    colors: mesh.colors ? (mesh.colors.buffer as ArrayBuffer) : null,
    tangents: mesh.tangents ? (mesh.tangents.buffer as ArrayBuffer) : null,
    bounds: mesh.bounds,
    meta: { ...mesh.meta },
  };
}

function deserializeMesh(s: SerializedMesh): GeneratedMesh {
  const mesh: GeneratedMesh = {
    positions: new Float32Array(s.positions),
    normals: new Float32Array(s.normals),
    uvs: new Float32Array(s.uvs),
    indices: new Uint32Array(s.indices),
    bounds: s.bounds,
    meta: s.meta,
  };
  if (s.colors) {
    mesh.colors = new Float32Array(s.colors);
  }
  if (s.tangents) {
    mesh.tangents = new Float32Array(s.tangents);
  }
  return mesh;
}

function serializeModel(model: GeneratedModel): SerializedModel {
  return {
    meshes: model.meshes.map(serializeMesh),
    groups: model.groups.map((g) => ({ ...g })),
  };
}

function deserializeModel(s: SerializedModel): GeneratedModel {
  const meshes = s.meshes.map(deserializeMesh);
  const transferables: ArrayBufferLike[] = [];
  for (const mesh of meshes) {
    transferables.push(
      mesh.positions.buffer,
      mesh.normals.buffer,
      mesh.uvs.buffer,
      mesh.indices.buffer,
    );
    if (mesh.colors) transferables.push(mesh.colors.buffer);
    if (mesh.tangents) transferables.push(mesh.tangents.buffer);
  }
  return { meshes, groups: s.groups, transferables };
}

// ─── IndexedDB operations ────────────────────────────────────────────────────

/**
 * Open (or create) the database. If the stored version doesn't match
 * CACHE_VERSION, we delete and recreate the store (schema migration = wipe).
 *
 * Uses the 'idb' package for a Promise-based wrapper.
 */
async function openDb() {
  const { openDB } = await import('idb');
  return openDB(DB_NAME, CACHE_VERSION, {
    upgrade(db) {
      // Clear old stores on version bump.
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      db.createObjectStore(STORE_NAME);
    },
  });
}

/**
 * Retrieve a cached model, or undefined on miss.
 */
export async function getCached(
  generatorId: string,
  params: unknown,
  seed: Seed,
): Promise<GeneratedModel | undefined> {
  const key = deriveCacheKey(generatorId, params, seed);
  try {
    const db = await openDb();
    const stored = (await db.get(STORE_NAME, key)) as SerializedModel | undefined;
    if (!stored) return undefined;
    return deserializeModel(stored);
  } catch {
    // IndexedDB failures (private browsing, quota) are non-fatal; just miss.
    return undefined;
  }
}

/**
 * Store a generated model in the cache.
 */
export async function putCached(
  generatorId: string,
  params: unknown,
  seed: Seed,
  model: GeneratedModel,
): Promise<void> {
  const key = deriveCacheKey(generatorId, params, seed);
  try {
    const db = await openDb();
    await db.put(STORE_NAME, serializeModel(model), key);
  } catch {
    // Quota or permission errors are non-fatal — next run will regenerate.
  }
}

/**
 * Clear the entire cache. Useful for development or when the user wants to
 * force regeneration.
 */
export async function clearCache(): Promise<void> {
  try {
    const db = await openDb();
    await db.clear(STORE_NAME);
  } catch {
    // Ignore.
  }
}
