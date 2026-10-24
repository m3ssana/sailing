/**
 * DOM input adapters. These are the only input-layer modules permitted to touch
 * the DOM; they shape browser events into the engine-agnostic `DeviceSnapshot`
 * that the pure models in `@game/input` consume. All dependencies (event
 * targets, gamepad provider, storage) are injectable so the adapters are
 * testable under vitest's node environment with hand-written fakes.
 */
export * from './KeyboardInput';
export * from './MouseInput';
export * from './GamepadInput';
export * from './InputManager';
export * from './LocalStorageKeyValueStore';
