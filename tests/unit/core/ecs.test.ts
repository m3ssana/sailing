import { describe, it, expect } from 'vitest';
import { createWorld } from '@core/ecs';

describe('ECS World', () => {
  it('creates entities with unique ids', () => {
    const world = createWorld();
    const a = world.createEntity();
    const b = world.createEntity();
    expect(a).not.toBe(b);
  });

  it('stores and retrieves components', () => {
    const world = createWorld();
    const e = world.createEntity();
    world.addComponent(e, 'position', { x: 1, y: 2, z: 3 });
    const pos = world.getComponent<{ x: number; y: number; z: number }>(e, 'position');
    expect(pos).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('returns undefined for missing components', () => {
    const world = createWorld();
    const e = world.createEntity();
    expect(world.getComponent(e, 'velocity')).toBeUndefined();
  });

  it('overwrites components with addComponent', () => {
    const world = createWorld();
    const e = world.createEntity();
    world.addComponent(e, 'health', 100);
    world.addComponent(e, 'health', 50);
    expect(world.getComponent<number>(e, 'health')).toBe(50);
  });

  it('removes components', () => {
    const world = createWorld();
    const e = world.createEntity();
    world.addComponent(e, 'tag', true);
    world.removeComponent(e, 'tag');
    expect(world.getComponent(e, 'tag')).toBeUndefined();
  });

  it('destroys entities and removes all their components', () => {
    const world = createWorld();
    const e = world.createEntity();
    world.addComponent(e, 'a', 1);
    world.addComponent(e, 'b', 2);
    world.destroyEntity(e);
    expect(world.hasEntity(e)).toBe(false);
    expect(world.getComponent(e, 'a')).toBeUndefined();
    expect(world.getComponent(e, 'b')).toBeUndefined();
  });

  it('queries entities with a single component', () => {
    const world = createWorld();
    const e1 = world.createEntity();
    const e2 = world.createEntity();
    const e3 = world.createEntity();
    world.addComponent(e1, 'pos', { x: 0 });
    world.addComponent(e2, 'pos', { x: 1 });
    world.addComponent(e3, 'vel', { x: 2 });

    const result = world.query('pos');
    expect([...result].sort()).toEqual([e1, e2].sort());
  });

  it('queries entities with multiple components (AND logic)', () => {
    const world = createWorld();
    const e1 = world.createEntity();
    const e2 = world.createEntity();
    const e3 = world.createEntity();
    world.addComponent(e1, 'pos', {});
    world.addComponent(e1, 'vel', {});
    world.addComponent(e2, 'pos', {});
    world.addComponent(e3, 'vel', {});

    const result = world.query('pos', 'vel');
    expect([...result]).toEqual([e1]);
  });

  it('returns empty when no entities match', () => {
    const world = createWorld();
    world.createEntity();
    const result = world.query('nonexistent');
    expect([...result]).toEqual([]);
  });

  it('returns all entities when query has no component filter', () => {
    const world = createWorld();
    const e1 = world.createEntity();
    const e2 = world.createEntity();
    const result = world.query();
    expect([...result].sort()).toEqual([e1, e2].sort());
  });

  it('destroyed entities do not appear in queries', () => {
    const world = createWorld();
    const e1 = world.createEntity();
    const e2 = world.createEntity();
    world.addComponent(e1, 'tag', true);
    world.addComponent(e2, 'tag', true);
    world.destroyEntity(e1);
    const result = world.query('tag');
    expect([...result]).toEqual([e2]);
  });

  it('ignores addComponent on destroyed entities', () => {
    const world = createWorld();
    const e = world.createEntity();
    world.destroyEntity(e);
    world.addComponent(e, 'tag', true);
    expect(world.getComponent(e, 'tag')).toBeUndefined();
  });

  it('query result is reused (same array reference)', () => {
    const world = createWorld();
    const e = world.createEntity();
    world.addComponent(e, 'a', 1);
    const r1 = world.query('a');
    const r2 = world.query('a');
    // Both calls return the same scratch array
    expect(r1).toBe(r2);
  });
});
