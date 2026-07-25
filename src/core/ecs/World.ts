/**
 * Minimal entity/component registry.
 *
 * This is not a full ECS framework — it exists only to organize the handful of
 * game entities (boats, marks, ambient vessels, birds) so systems can query by
 * component presence without ad-hoc arrays scattered around the codebase.
 *
 * Component data lives in per-type Maps keyed by entity id. Queries reuse a
 * scratch array to avoid allocation in the frame loop. The trade-off is that
 * callers must not hold a reference to the query result across frames.
 */

/** Opaque entity identifier. Monotonically increasing integer. */
export type EntityId = number;

/** A component type id. String so it reads well in debug output. */
export type ComponentId = string;

export interface World {
  /** Create a new entity and return its id. */
  createEntity(): EntityId;
  /** Destroy an entity, removing all its components. */
  destroyEntity(entity: EntityId): void;
  /** Attach a component to an entity. Overwrites if already present. */
  addComponent<T>(entity: EntityId, componentId: ComponentId, data: T): void;
  /** Retrieve a component. Returns undefined if the entity doesn't have it. */
  getComponent<T>(entity: EntityId, componentId: ComponentId): T | undefined;
  /** Remove a component from an entity. */
  removeComponent(entity: EntityId, componentId: ComponentId): void;
  /** Return all entities that have ALL of the given components. */
  query(...componentIds: ComponentId[]): readonly EntityId[];
  /** Whether the entity exists. */
  hasEntity(entity: EntityId): boolean;
}

export function createWorld(): World {
  let nextId: EntityId = 1;

  // Which entities exist. Using a Set avoids iterating a sparse id space.
  const entities = new Set<EntityId>();

  // Per-component-type storage: componentId → (entityId → data).
  const stores = new Map<ComponentId, Map<EntityId, unknown>>();

  // Scratch array reused by every query() call. Callers must consume results
  // before the next query() invocation, which is fine for iterate-and-process.
  const scratch: EntityId[] = [];

  function getStore(componentId: ComponentId): Map<EntityId, unknown> {
    let store = stores.get(componentId);
    if (!store) {
      store = new Map<EntityId, unknown>();
      stores.set(componentId, store);
    }
    return store;
  }

  return {
    createEntity(): EntityId {
      const id = nextId++;
      entities.add(id);
      return id;
    },

    destroyEntity(entity: EntityId): void {
      if (!entities.has(entity)) return;
      entities.delete(entity);
      // Remove from all component stores.
      for (const store of stores.values()) {
        store.delete(entity);
      }
    },

    addComponent<T>(entity: EntityId, componentId: ComponentId, data: T): void {
      if (!entities.has(entity)) return;
      getStore(componentId).set(entity, data);
    },

    getComponent<T>(entity: EntityId, componentId: ComponentId): T | undefined {
      const store = stores.get(componentId);
      if (!store) return undefined;
      return store.get(entity) as T | undefined;
    },

    removeComponent(entity: EntityId, componentId: ComponentId): void {
      const store = stores.get(componentId);
      if (store) store.delete(entity);
    },

    query(...componentIds: ComponentId[]): readonly EntityId[] {
      scratch.length = 0;

      if (componentIds.length === 0) {
        // No filter: return all entities.
        for (const e of entities) {
          scratch.push(e);
        }
        return scratch;
      }

      // Start with the smallest store for an early-out inner loop.
      let smallest: Map<EntityId, unknown> | undefined;
      let smallestSize = Infinity;
      for (const cid of componentIds) {
        const store = stores.get(cid);
        const size = store ? store.size : 0;
        if (size < smallestSize) {
          smallestSize = size;
          smallest = store;
        }
      }

      if (!smallest || smallestSize === 0) return scratch;

      // Iterate the smallest store and check presence in the others.
      outer: for (const entity of smallest.keys()) {
        for (const cid of componentIds) {
          const store = stores.get(cid);
          if (!store || !store.has(entity)) continue outer;
        }
        scratch.push(entity);
      }

      return scratch;
    },

    hasEntity(entity: EntityId): boolean {
      return entities.has(entity);
    },
  };
}
