/**
 * Dev overlay — a plain DOM element (no React) showing frame profiler stats.
 *
 * Toggled with the backtick/tilde key. Only active in development builds
 * (`import.meta.env.DEV`). In production builds, this module's public functions
 * are no-ops so tree-shaking can eliminate it entirely.
 */

import type { FrameTimings, PerformanceStats, RenderBackend } from '@/types';

export interface DevOverlay {
  /** Update the overlay with the latest profiler data. Call once per frame. */
  update(timings: FrameTimings, stats: PerformanceStats): void;
  /** Toggle visibility. */
  toggle(): void;
  /** Clean up the DOM element. */
  dispose(): void;
}

/**
 * Create the dev overlay. Returns a no-op handle in production builds.
 *
 * @param backend — which renderer backend is active, shown in the header.
 */
export function createDevOverlay(backend: RenderBackend): DevOverlay {
  // Production guard: return an inert handle that does nothing.
  if (!import.meta.env.DEV) {
    return {
      update() {},
      toggle() {},
      dispose() {},
    };
  }

  // Build the DOM element.
  const el = document.createElement('div');
  el.id = 'dev-overlay';
  el.setAttribute('aria-hidden', 'true');
  Object.assign(el.style, {
    position: 'fixed',
    top: '8px',
    left: '8px',
    padding: '8px 12px',
    background: 'rgba(0, 0, 0, 0.75)',
    color: '#e8eef2',
    fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
    fontSize: '11px',
    lineHeight: '1.5',
    borderRadius: '4px',
    pointerEvents: 'none',
    zIndex: '99999',
    whiteSpace: 'pre',
    display: 'none', // Hidden by default; toggled with the key
  });
  document.body.appendChild(el);

  let visible = false;

  // Toggle on backtick key.
  const handleKey = (e: KeyboardEvent): void => {
    if (e.code === 'Backquote' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      visible = !visible;
      el.style.display = visible ? 'block' : 'none';
    }
  };
  document.addEventListener('keydown', handleKey);

  return {
    update(timings: FrameTimings, stats: PerformanceStats): void {
      if (!visible) return;

      const thermal = stats.thermalThrottleSuspected ? ' ⚠ THERMAL' : '';
      el.textContent =
        `backend: ${backend}${thermal}\n` +
        `frame:   ${timings.frame.toFixed(1)} ms\n` +
        `  sim:   ${timings.simulation.toFixed(1)} ms\n` +
        `  scene: ${timings.sceneUpdate.toFixed(1)} ms\n` +
        `  gpu:   ${timings.gpu >= 0 ? timings.gpu.toFixed(1) + ' ms' : 'n/a'}\n` +
        `median:  ${stats.medianFrameTime.toFixed(1)} ms  p95: ${stats.p95FrameTime.toFixed(1)} ms\n` +
        `draws:   ${timings.drawCalls}  tris: ${formatTriangles(timings.triangles)}\n` +
        `steps:   ${timings.steps}`;
    },

    toggle(): void {
      visible = !visible;
      el.style.display = visible ? 'block' : 'none';
    },

    dispose(): void {
      document.removeEventListener('keydown', handleKey);
      el.remove();
    },
  };
}

/** Format triangle count as e.g. "65.5k" for readability. */
function formatTriangles(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}
