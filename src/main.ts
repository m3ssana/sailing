/**
 * Application entry point — bootstraps the renderer, starts the game loop,
 * and renders a TSL smoke-test scene proving both backends (WebGPU and WebGL2)
 * work correctly.
 *
 * The smoke-test scene consists of:
 * - A sphere with a MeshStandardNodeMaterial using a TSL fresnel emissive term.
 * - A directional light for basic PBR lighting.
 * - A large flat plane in a deep sea colour.
 *
 * This file also wires the dev overlay, handles window resize, and shows a
 * clear error message if neither rendering backend initializes.
 */

import * as THREE from 'three/webgpu';
import {
  Fn,
  float,
  color,
  normalWorld,
  cameraPosition,
  positionWorld,
} from 'three/tsl';
import { createRenderer } from '@render/Renderer';
import { createDevOverlay } from '@render/quality/DevOverlay';
import { createFrameProfiler } from '@render/quality/FrameProfiler';
import { createGameLoop, FIXED_TIMESTEP } from '@/app/GameLoop';
import { createSessionClock } from '@core/time/SessionClock';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const canvasEl = document.getElementById('canvas');
  const bootStatus = document.getElementById('boot-status');
  const boot = document.getElementById('boot');

  if (!(canvasEl instanceof HTMLCanvasElement)) {
    showFatalError('Canvas element not found.');
    return;
  }
  const canvas = canvasEl;

  updateBootStatus(bootStatus, 'probing GPU capabilities…');

  // Attempt to create the renderer (WebGPU preferred, WebGL2 fallback).
  let rendererHandle;
  try {
    rendererHandle = await createRenderer(canvas, () => {
      // Device-loss callback — in a full game this would trigger re-init.
      console.error('[main] GPU device lost — recovery would happen here.');
    });
  } catch (err) {
    showFatalError(
      'Failed to initialize a rendering backend.\n' +
      'This application requires a browser with WebGPU or WebGL2 support.\n\n' +
      String(err),
    );
    return;
  }

  const { renderer, capabilities } = rendererHandle;

  updateBootStatus(bootStatus, `${capabilities.backend} backend active — building scene…`);

  // Size the renderer to the window (camera update deferred until camera is created).
  renderer.setSize(canvas.clientWidth, canvas.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // ---------------------------------------------------------------------------
  // Smoke-test scene
  // ---------------------------------------------------------------------------

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b1c26); // --sea from CSS

  // Camera.
  const camera = new THREE.PerspectiveCamera(
    60,
    canvas.clientWidth / canvas.clientHeight,
    0.1,
    1000,
  );
  camera.position.set(0, 2, 5);
  camera.lookAt(0, 0.5, 0);

  // Wire window resize to update both renderer and camera.
  window.addEventListener('resize', () => handleResize(renderer, canvas, camera));

  // Sea-colour ground plane.
  const planeGeo = new THREE.PlaneGeometry(100, 100);
  const planeMat = new THREE.MeshStandardNodeMaterial();
  planeMat.colorNode = color(0x0e3a4a);
  planeMat.roughnessNode = float(0.85);
  const plane = new THREE.Mesh(planeGeo, planeMat);
  plane.rotation.x = -Math.PI / 2;
  scene.add(plane);

  // Sphere with TSL fresnel emissive — the smoke test that proves the TSL
  // pipeline works on both WebGPU and WebGL2.
  const sphereGeo = new THREE.SphereGeometry(1, 48, 32);
  const sphereMat = new THREE.MeshStandardNodeMaterial();
  sphereMat.colorNode = color(0x1a4f6e);
  sphereMat.roughnessNode = float(0.3);
  sphereMat.metalnessNode = float(0.0);

  // TSL fresnel: edge-glow that intensifies where the surface faces away from
  // the camera — a classic stylised-water accent colour.
  sphereMat.emissiveNode = Fn(() => {
    const viewDir = cameraPosition.sub(positionWorld).normalize();
    const fresnel = float(1.0).sub(normalWorld.dot(viewDir).saturate()).pow(3.0);
    return color(0x4fd1c5).mul(fresnel);
  })();

  const sphere = new THREE.Mesh(sphereGeo, sphereMat);
  sphere.position.set(0, 1, 0);
  scene.add(sphere);

  // Directional light (sun analogue).
  const sunLight = new THREE.DirectionalLight(0xffffff, 2.0);
  sunLight.position.set(5, 8, 3);
  scene.add(sunLight);

  // Ambient fill so the shadow side isn't pure black.
  const ambient = new THREE.AmbientLight(0x404060, 0.4);
  scene.add(ambient);

  // ---------------------------------------------------------------------------
  // Profiler and dev overlay
  // ---------------------------------------------------------------------------

  const profiler = createFrameProfiler(60);
  const devOverlay = createDevOverlay(capabilities.backend);

  // ---------------------------------------------------------------------------
  // Game loop
  // ---------------------------------------------------------------------------

  const clock = createSessionClock(1); // 1× compression for the smoke test
  let simTime = 0;

  const loop = createGameLoop(clock, {
    fixedUpdate(dt: number, _sessionTime) {
      // Smoke test: slowly rotate the sphere so we can see the fresnel move.
      simTime += dt;
      sphere.rotation.y = simTime * 0.5;
    },
    render(_alpha: number) {
      const frameStart = performance.now();

      // Render.
      renderer.render(scene, camera);

      const frameEnd = performance.now();
      const frameTime = frameEnd - frameStart;

      // Record profiler data. In a real game, simulation and sceneUpdate
      // timings would be measured separately; for the smoke test we combine.
      const timings = {
        frame: frameTime,
        simulation: 0,
        sceneUpdate: 0,
        render: frameTime,
        gpu: capabilities.timestampQueries ? -1 : -1, // Not wired yet
        steps: Math.round(FIXED_TIMESTEP * 120), // 1 step at 120 Hz
        drawCalls: (renderer.info as { render?: { calls?: number } }).render?.calls ?? 0,
        triangles: (renderer.info as { render?: { triangles?: number } }).render?.triangles ?? 0,
      };

      profiler.record(timings);
      devOverlay.update(timings, profiler.getStats());
    },
  }, 0);

  // ---------------------------------------------------------------------------
  // Boot complete — remove the boot overlay and start the loop.
  // ---------------------------------------------------------------------------

  if (boot) {
    boot.remove();
  }

  loop.start();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
}

function handleResize(renderer: THREE.WebGPURenderer, canvas: HTMLCanvasElement, camera: THREE.PerspectiveCamera): void {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const dpr = Math.min(window.devicePixelRatio, 2); // Cap at 2× to stay within GPU budgets
  renderer.setSize(width, height);
  renderer.setPixelRatio(dpr);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

main().catch((err: unknown) => {
  console.error('[main] Fatal bootstrap error:', err);
  showFatalError(`Unexpected error during initialization:\n${String(err)}`);
});
