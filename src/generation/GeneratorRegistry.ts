/**
 * Generator registry — the lookup table from string id to Generator implementation.
 *
 * Every procedural generator registers itself here at module load time, and the
 * worker pool resolves generator ids through it when dispatching jobs. The
 * registry is intentionally simple: a Map with type-safe registration.
 *
 * Engine-agnostic — no three.js.
 */

import type { Generator, GeneratedModel } from '@/types';

/**
 * A generator entry as stored in the registry. We erase TParams to `unknown`
 * because the registry is heterogeneous — callers know the concrete type.
 */
type AnyGenerator = Generator<unknown, GeneratedModel>;

const generators = new Map<string, AnyGenerator>();

/**
 * Register a generator. Throws if a duplicate id is registered, since that
 * indicates a wiring bug (two generators claiming the same slot).
 */
export function registerGenerator<TParams>(
  generator: Generator<TParams, GeneratedModel>,
): void {
  if (generators.has(generator.id)) {
    throw new Error(`Generator already registered: ${generator.id}`);
  }
  generators.set(generator.id, generator as unknown as AnyGenerator);
}

/**
 * Retrieve a registered generator by id. Returns undefined if not found,
 * so callers can provide a clear error message in context.
 */
export function getGenerator(id: string): AnyGenerator | undefined {
  return generators.get(id);
}

/**
 * Check whether a generator id is registered. Useful for validation before
 * dispatching a job to a worker.
 */
export function hasGenerator(id: string): boolean {
  return generators.has(id);
}

/**
 * Clear the registry. Only used in tests to reset state between runs.
 */
export function clearRegistry(): void {
  generators.clear();
}
