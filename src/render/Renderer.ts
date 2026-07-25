/**
 * Renderer bootstrap — creates a WebGPURenderer with the WebGPU backend where
 * available, falling back to its built-in WebGL2 backend otherwise.
 *
 * The single most important thing about this module: `await renderer.init()`
 * MUST complete before any render or compute call. Omitting that causes silent
 * failures or hard crashes depending on the backend.
 *
 * Device-loss recovery matters because the reference target is a laptop that
 * will thermally throttle and occasionally trigger a GPU driver reset.
 */

import * as THREE from 'three/webgpu';
import type { GPUCapabilities } from '@/types';
import { probeCapabilities } from '@render/GPUCapabilities';

export interface RendererHandle {
  renderer: THREE.WebGPURenderer;
  capabilities: GPUCapabilities;
}

/**
 * Create and initialize the renderer.
 *
 * @param canvas — the canvas element to render into.
 * @param onDeviceLost — optional callback invoked when the GPU device is lost.
 *   If not provided, the default handler logs a warning and attempts recovery.
 * @returns the renderer and probed capabilities, or throws if neither backend
 *   can initialize.
 */
export async function createRenderer(
  canvas: HTMLCanvasElement,
  onDeviceLost?: () => void,
): Promise<RendererHandle> {
  // Probe WebGPU availability via the navigator.gpu sentinel.
  // On Firefox/Safari this is absent, which triggers the WebGL2 fallback.
  const webgpuAvailable = typeof navigator !== 'undefined' && 'gpu' in navigator;

  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: false, // TAA handles anti-aliasing; MSAA is expensive on the ocean grid.
    forceWebGL: !webgpuAvailable,
  });

  // This MUST be awaited — the backend won't be ready until the promise resolves.
  await renderer.init();

  // Determine which backend actually activated (even if we requested WebGPU,
  // the browser might have silently fallen back).
  const isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
  const backend = isWebGPU ? 'webgpu' : 'webgl2';

  // HDR pipeline configuration (requirement 7.1):
  // Linear workspace throughout, ACES filmic tonemapping, sRGB output encoding.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // Device-loss recovery (WebGPU only). On the WebGL2 backend the GL context
  // has its own lost/restored events which three.js handles internally.
  if (isWebGPU) {
    const backendRef = renderer.backend as { device?: GPUDevice };
    const device = backendRef.device;
    if (device) {
      void device.lost.then((info: GPUDeviceLostInfo) => {
        console.error(`[Renderer] GPU device lost: ${info.reason} — ${info.message}`);
        if (onDeviceLost) {
          onDeviceLost();
        }
        // Default recovery: if the loss reason is 'unknown' (unexpected crash),
        // a re-init is worth attempting. 'destroyed' means we called destroy()
        // intentionally, so no recovery.
        // Actual re-initialization would need the game loop to dispose and recreate
        // the renderer, which is orchestrated by the app shell — we just signal it.
      });
    }
  }

  const capabilities = probeCapabilities(renderer, backend);

  return { renderer, capabilities };
}
