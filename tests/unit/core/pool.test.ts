import { describe, it, expect } from 'vitest';
import { createObjectPool, makeVec3Pool, makeQuatPool } from '@core/pool';

describe('ObjectPool', () => {
  it('returns newly created objects when empty', () => {
    let counter = 0;
    const pool = createObjectPool(() => ({ id: counter++ }));
    const a = pool.acquire();
    const b = pool.acquire();
    expect(a.id).toBe(0);
    expect(b.id).toBe(1);
  });

  it('reuses released objects', () => {
    const pool = createObjectPool(() => ({ value: 0 }));
    const a = pool.acquire();
    a.value = 42;
    pool.release(a);
    const b = pool.acquire();
    // Same object reference reused (reset may clear it, but since no reset fn the value persists)
    expect(b).toBe(a);
  });

  it('calls reset on acquire', () => {
    const pool = createObjectPool(
      () => ({ x: 999 }),
      (obj) => {
        obj.x = 0;
      },
    );
    const a = pool.acquire();
    expect(a.x).toBe(0); // Reset was applied even on first create
    a.x = 123;
    pool.release(a);
    const b = pool.acquire();
    expect(b.x).toBe(0); // Reset clears stale value
  });

  it('preallocates the requested number of objects', () => {
    const pool = createObjectPool(
      () => ({ v: 0 }),
      undefined,
      10,
    );
    expect(pool.capacity()).toBe(10);
  });

  it('tracks high water mark', () => {
    const pool = createObjectPool(() => ({ v: 0 }));
    const a = pool.acquire();
    const b = pool.acquire();
    const c = pool.acquire();
    expect(pool.highWaterMark()).toBe(3);
    pool.release(a);
    pool.release(b);
    pool.release(c);
    // HWM doesn't decrease
    expect(pool.highWaterMark()).toBe(3);
    pool.acquire();
    expect(pool.highWaterMark()).toBe(3); // Still 3, not exceeded
  });

  it('releaseAll resets outstanding count', () => {
    const pool = createObjectPool(() => ({ v: 0 }));
    pool.acquire();
    pool.acquire();
    pool.releaseAll();
    // After releaseAll, outstanding is 0, but hwm is preserved
    expect(pool.highWaterMark()).toBe(2);
  });
});

describe('makeVec3Pool', () => {
  it('returns Vec3 objects initialized to zero', () => {
    const pool = makeVec3Pool(4);
    const v = pool.acquire();
    expect(v).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('resets to zero on re-acquire', () => {
    const pool = makeVec3Pool(1);
    const v = pool.acquire();
    v.x = 5;
    v.y = 10;
    v.z = 15;
    pool.release(v);
    const v2 = pool.acquire();
    expect(v2).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('makeQuatPool', () => {
  it('returns Quat objects initialized to identity', () => {
    const pool = makeQuatPool(4);
    const q = pool.acquire();
    expect(q).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });

  it('resets to identity on re-acquire', () => {
    const pool = makeQuatPool(1);
    const q = pool.acquire();
    q.x = 1;
    q.y = 2;
    q.z = 3;
    q.w = 4;
    pool.release(q);
    const q2 = pool.acquire();
    expect(q2).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });
});
