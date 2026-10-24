/**
 * `mountHud` — the DOM entry point the app uses to attach the HUD overlay.
 *
 * It injects the HUD stylesheet (once, idempotently), mounts the store-connected
 * HUD into the given container with React's client renderer, and returns a handle
 * to unmount. React reads the store the render loop publishes into; it does not
 * touch the render loop itself.
 *
 * This is the only HUD module that imports the DOM renderer, keeping the rest of
 * the UI layer renderable headlessly via `react-dom/server`.
 */

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import type { HudStore } from './hudStore';
import { HudRootConnected } from './HudRoot';
import { HUD_CSS, HUD_STYLE_ELEMENT_ID } from './hudStyles';

/** A mounted HUD handle. */
export interface MountedHud {
  /** Unmount the HUD and leave the container empty. */
  unmount(): void;
}

/** Inject the HUD stylesheet into <head> exactly once. */
export function ensureHudStyles(doc: Document = document): void {
  if (doc.getElementById(HUD_STYLE_ELEMENT_ID) !== null) return;
  const style = doc.createElement('style');
  style.id = HUD_STYLE_ELEMENT_ID;
  style.textContent = HUD_CSS;
  doc.head.appendChild(style);
}

/**
 * Mount the HUD into `container`, bound to `store`.
 *
 * @param container a DOM element (typically the `#ui-root` overlay)
 * @param store     the HUD store the render loop publishes into
 */
export function mountHud(container: HTMLElement, store: HudStore): MountedHud {
  ensureHudStyles(container.ownerDocument);
  const root: Root = createRoot(container);
  root.render(createElement(HudRootConnected, { store }));
  return {
    unmount(): void {
      root.unmount();
    },
  };
}
