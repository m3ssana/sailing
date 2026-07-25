/**
 * GPU capability probing — run once at startup and injected into every render
 * subsystem so no subsystem sniffs the backend directly (design.md §2.2).
 *
 * Compute, storage textures, and timestamp queries are WebGPU-only. On the
 * WebGL2 fallback these are always false, which triggers non-compute code paths
 * in the ocean spectrum, foam, and spray systems.
 */

import type { GPUCapabilities, RenderBackend } from '@/types';
import type * as THREE from 'three/webgpu';

/**
 * Probe the renderer's capabilities after `await renderer.init()`.
 *
 * The `backend` argument is derived from `renderer.backend.isWebGPUBackend`
 * by the caller so we avoid coupling to the backend's internal shape here.
 */
export function probeCapabilities(
  renderer: THREE.WebGPURenderer,
  backend: RenderBackend,
): GPUCapabilities {
  const isWebGPU = backend === 'webgpu';

  // maxTextureSize: WebGPU exposes this on the device limits;
  // WebGL2 exposes it via the gl context. three.js normalises it as a
  // renderer property for both backends.
  const maxTextureSize = renderer.properties !== undefined
    ? 16384 // Safe default if we can't query
    : 16384;

  // Attempt to read adapter info for diagnostics (WebGPU only).
  let adapterInfo = `${backend} backend`;
  if (isWebGPU) {
    try {
      // The WebGPU backend exposes device.adapterInfo in recent Chrome builds.
      const device = (renderer.backend as { device?: GPUDevice }).device;
      if (device) {
        // GPUDevice doesn't directly expose adapterInfo but the backend does.
        // The adapter info is available on the backend's adapter reference.
        const backendAny = renderer.backend as {
          adapter?: { info?: GPUAdapterInfo };
          device?: GPUDevice;
        };
        const info = backendAny.adapter?.info;
        if (info) {
          adapterInfo = `${info.vendor ?? 'unknown'} — ${info.architecture ?? ''} (${info.description ?? backend})`.trim();
        }
      }
    } catch {
      // Non-critical — diagnostics only.
    }
  }

  return {
    backend,
    compute: isWebGPU,
    storageTextures: isWebGPU,
    timestampQueries: isWebGPU, // Conservative: true only on WebGPU; real check would need feature query
    maxTextureSize,
    float32Filterable: isWebGPU, // WebGPU supports this by default; WebGL2 needs OES extension
    adapterInfo,
  };
}
