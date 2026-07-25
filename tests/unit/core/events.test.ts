import { describe, it, expect, vi } from 'vitest';
import { createEventBus } from '@core/events';

describe('EventBus', () => {
  it('delivers payloads to subscribers', () => {
    const bus = createEventBus();
    const handler = vi.fn();
    bus.on('boat:slam', handler);
    bus.emit('boat:slam', { boatId: 'boat-1', energy: 42 });
    expect(handler).toHaveBeenCalledWith({ boatId: 'boat-1', energy: 42 });
  });

  it('supports multiple listeners on the same event', () => {
    const bus = createEventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('boat:capsized', a);
    bus.on('boat:capsized', b);
    bus.emit('boat:capsized', { boatId: 'x' });
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('off removes a listener', () => {
    const bus = createEventBus();
    const handler = vi.fn();
    bus.on('boat:capsized', handler);
    bus.off('boat:capsized', handler);
    bus.emit('boat:capsized', { boatId: 'x' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('on returns an unsubscribe function', () => {
    const bus = createEventBus();
    const handler = vi.fn();
    const unsub = bus.on('boat:capsized', handler);
    unsub();
    bus.emit('boat:capsized', { boatId: 'x' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('once fires exactly once', () => {
    const bus = createEventBus();
    const handler = vi.fn();
    bus.once('boat:slam', handler);
    bus.emit('boat:slam', { boatId: 'a', energy: 1 });
    bus.emit('boat:slam', { boatId: 'b', energy: 2 });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ boatId: 'a', energy: 1 });
  });

  it('once returns an unsubscribe function that cancels before firing', () => {
    const bus = createEventBus();
    const handler = vi.fn();
    const unsub = bus.once('boat:slam', handler);
    unsub();
    bus.emit('boat:slam', { boatId: 'a', energy: 1 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not crash when emitting with no subscribers', () => {
    const bus = createEventBus();
    expect(() => bus.emit('boat:capsized', { boatId: 'x' })).not.toThrow();
  });

  it('does not call listeners added during emit', () => {
    const bus = createEventBus();
    const lateHandler = vi.fn();
    bus.on('boat:capsized', () => {
      bus.on('boat:capsized', lateHandler);
    });
    bus.emit('boat:capsized', { boatId: 'x' });
    // lateHandler was added during emit, should not be called this round
    expect(lateHandler).not.toHaveBeenCalled();
    // But will be called next time
    bus.emit('boat:capsized', { boatId: 'y' });
    expect(lateHandler).toHaveBeenCalledOnce();
  });

  it('handles off for a listener that was never registered', () => {
    const bus = createEventBus();
    const handler = vi.fn();
    expect(() => bus.off('boat:capsized', handler)).not.toThrow();
  });
});
