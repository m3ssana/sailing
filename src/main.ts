/**
 * Application entry point — Phase 2 task 2.1 "first sail".
 *
 * Bootstraps the renderer (WebGPU preferred, WebGL2 fallback; `?backend=webgl`
 * forces WebGL2), creates a {@link Session} for the venue in real weather (with
 * the offline fallback ladder), removes the boot overlay once the first frame
 * renders, and shows the pre-existing fatal error UI on failure.
 *
 * It also:
 *   - shows a graceful "WebGL2 fallback notice" banner when the active backend
 *     is WebGL2 (requirement 7.13; text from `src/ui/strings.ts`);
 *   - wires the dev/test hooks `?autosail=1`, `?offline=1`, `?speed=N`, and
 *     `?backend=webgpu|webgl`, publishing a `window.__sailing` object the
 *     browser smoke test reads.
 *
 * URL params:
 *   - `?backend=webgl`   force the WebGL2 backend.
 *   - `?backend=webgpu`  prefer WebGPU (advisory; headless usually falls back).
 *   - `?autosail=1`      run the scripted input provider.
 *   - `?offline=1`       force the offline weather fallback ladder (no fetch).
 *   - `?speed=N`         scale the session clock for the test harness (1..60).
 */

import { createRenderer } from '@render/Renderer';
import { createSession } from '@/app/Session';
import type { SailingTestHook } from '@/app/Session';
import { parseLaunchOptions } from '@/app/sessionHelpers';
import { strings } from '@/ui/strings';
import type { CameraMode } from '@game/camera';

declare global {
  interface Window {
    __sailing?: SailingTestHook;
  }
}

async function main(): Promise<void> {
  const canvasEl = document.getElementById('canvas');
  const uiRoot = document.getElementById('ui-root');
  const bootStatus = document.getElementById('boot-status');
  const boot = document.getElementById('boot');

  if (!(canvasEl instanceof HTMLCanvasElement)) {
    showFatalError('Canvas element not found.');
    return;
  }
  if (!(uiRoot instanceof HTMLElement)) {
    showFatalError('UI root element not found.');
    return;
  }
  const canvas = canvasEl;

  const launch = parseLaunchOptions(
    typeof window !== 'undefined' ? window.location.search : '',
  );

  // Optional start-camera override (`?cam=chase|helm|drone|mast|broadcast`).
  // Parsed locally so the shared `parseLaunchOptions` (owned elsewhere) is not
  // touched. Unknown/absent → undefined (session defaults to chase).
  const startCamera = parseStartCamera(
    typeof window !== 'undefined' ? window.location.search : '',
  );

  // The browser smoke test reads this. Populated even before the session exists
  // so a crash during bootstrap is still observable (done stays false).
  const testHook: SailingTestHook = {
    frames: 0,
    boatSpeedKnots: 0,
    heading: 0,
    tackCount: 0,
    gybeCount: 0,
    maxHeelDeg: 0,
    capsized: false,
    errors: [],
    backend: 'webgl2',
    weatherSource: 'default',
    done: false,
  };
  if (typeof window !== 'undefined') {
    window.__sailing = testHook;
    // Capture any uncaught error / rejection for the smoke harness.
    window.addEventListener('error', (e) => {
      testHook.errors.push(String(e.message ?? e));
    });
    window.addEventListener('unhandledrejection', (e) => {
      testHook.errors.push(String(e.reason));
    });
  }

  updateBootStatus(bootStatus, strings.boot.initializing);

  // ── Renderer ──────────────────────────────────────────────────────────────
  let rendererHandle;
  try {
    rendererHandle = await createRenderer(
      canvas,
      () => {
        console.error('[main] GPU device lost — recovery would happen here.');
      },
      launch.forceWebGL,
    );
  } catch (err) {
    showFatalError(
      'Failed to initialize a rendering backend.\n' +
        'This application requires a browser with WebGPU or WebGL2 support.\n\n' +
        String(err),
    );
    testHook.done = true;
    return;
  }

  const { renderer, capabilities } = rendererHandle;
  testHook.backend = capabilities.backend;
  renderer.setSize(canvas.clientWidth, canvas.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // WebGL2 fallback notice (requirement 7.13).
  if (capabilities.backend === 'webgl2') {
    showWebGL2Notice(uiRoot);
  }

  updateBootStatus(bootStatus, `${capabilities.backend} backend — ${strings.boot.fetchingWeather}`);

  // ── Session ──────────────────────────────────────────────────────────────
  try {
    const session = await createSession({
      canvas,
      uiRoot,
      venueId: 'newport',
      boatId: 'dinghy',
      assist: 'assisted',
      renderer: rendererHandle,
      offline: launch.offline,
      speed: launch.speed,
      autosail: launch.autosail,
      ...(startCamera !== undefined ? { startCamera } : {}),
      testHook,
    });

    testHook.weatherSource = session.weatherSource;
    testHook.backend = session.backend;

    // Remove the boot overlay just before the first frame renders.
    if (boot) boot.remove();

    session.start();

    // Signal the smoke harness as "done" after the scripted autosail sequence
    // has had time to run its full tack (session-time 26 s) AND gybe (56 s). At
    // Signal the smoke harness "done" once the scripted autosail has executed
    // BOTH a tack and a gybe (what the acceptance asserts), or after a wall-clock
    // safety timeout. The scripted sequence tacks at session-time 26 s and gybes
    // at 56 s; at the SHIPPED/undistorted clock (speed=1) that is ~56 s of wall
    // time at any frame rate, because maneuvers integrate at the real 120 Hz
    // step. A large `?speed` would race the SCRIPT ahead of the physics (the env
    // sample time is scaled but the fixed step is not), so the maneuvers would
    // not complete — the browser acceptance therefore runs at speed=1.
    if (launch.autosail) {
      const started = Date.now();
      const poll = window.setInterval(() => {
        const bothDone = testHook.tackCount >= 1 && testHook.gybeCount >= 1;
        const timedOut = Date.now() - started > 90000;
        if (bothDone || timedOut) {
          window.clearInterval(poll);
          testHook.done = true;
        }
      }, 250);
    } else {
      testHook.done = true;
    }
  } catch (err) {
    showFatalError(`Failed to start the session:\n${String(err)}`);
    testHook.errors.push(String(err));
    testHook.done = true;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Parse `?cam=` into a camera mode, or undefined if absent/unknown. */
function parseStartCamera(search: string): CameraMode | undefined {
  const params = new URLSearchParams(search);
  const cam = params.get('cam');
  const valid: readonly CameraMode[] = ['helm', 'chase', 'mast', 'drone', 'broadcast'];
  return cam !== null && (valid as readonly string[]).includes(cam)
    ? (cam as CameraMode)
    : undefined;
}

function updateBootStatus(el: HTMLElement | null, message: string): void {
  if (el) el.textContent = message;
}

function showFatalError(message: string): void {
  const boot = document.getElementById('boot');
  const status = document.getElementById('boot-status');
  if (status) {
    status.textContent = message;
    status.style.color = '#f87171';
    status.style.whiteSpace = 'pre-wrap';
  }
  if (boot) {
    boot.style.display = 'grid';
  }
  console.error('[main]', message);
}

/** Show the dismissible WebGL2 fallback notice banner. */
function showWebGL2Notice(uiRoot: HTMLElement): void {
  if (document.getElementById('webgl2-notice') !== null) return;
  const banner = document.createElement('div');
  banner.id = 'webgl2-notice';
  banner.setAttribute('role', 'status');
  banner.style.cssText = [
    'position:fixed',
    'left:50%',
    'top:1rem',
    'transform:translateX(-50%)',
    'max-width:min(90vw, 44rem)',
    'padding:0.6rem 2.4rem 0.6rem 0.9rem',
    'background:rgba(11,28,38,0.92)',
    'color:#e8eef2',
    'border:1px solid #4fd1c5',
    'border-radius:0.4rem',
    'font:0.8rem ui-sans-serif, system-ui, sans-serif',
    'line-height:1.35',
    'z-index:50',
    'pointer-events:auto',
  ].join(';');
  banner.textContent = strings.renderer.webgl2Notice;

  const close = document.createElement('button');
  close.textContent = '×';
  close.setAttribute('aria-label', 'Dismiss notice');
  close.style.cssText = [
    'position:absolute',
    'right:0.4rem',
    'top:0.3rem',
    'background:transparent',
    'border:none',
    'color:#8fa3b0',
    'font-size:1.1rem',
    'cursor:pointer',
  ].join(';');
  close.addEventListener('click', () => banner.remove());
  banner.appendChild(close);

  uiRoot.appendChild(banner);
}

// ─── Start ──────────────────────────────────────────────────────────────────

main().catch((err: unknown) => {
  console.error('[main] Fatal bootstrap error:', err);
  showFatalError(`Unexpected error during initialization:\n${String(err)}`);
  if (typeof window !== 'undefined' && window.__sailing) {
    window.__sailing.errors.push(String(err));
    window.__sailing.done = true;
  }
});
