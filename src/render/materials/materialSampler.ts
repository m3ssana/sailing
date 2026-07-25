/**
 * Material sampler — instantiates every MaterialParams.kind side by side for
 * visual verification per art-direction.md §0.7's demo requirement.
 *
 * This is NOT a unit test (requires GPU/DOM). It returns a Scene and mesh array
 * that can be rendered in a development harness or browser environment.
 *
 * Usage:
 *   const { scene, meshes, camera } = createMaterialSampler();
 *   // Attach to a renderer for visual inspection.
 */

import * as THREE from 'three/webgpu';
import type { MaterialParams } from '@/types';
import { buildProceduralMaterial } from './index';

/** Representative MaterialParams for each kind, conforming to art-direction.md §3.2 ranges. */
const SAMPLER_PARAMS: MaterialParams[] = [
  {
    kind: 'gelcoat',
    baseColor: { r: 0.9, g: 0.95, b: 0.98 },
    roughness: 0.30,
    metalness: 0.0,
    detail: { orangePeelScale: 80, orangePeelAmplitude: 0.002, flakeDensity: 0.02, flakeScale: 200 },
  },
  {
    kind: 'carbon',
    baseColor: { r: 0.05, g: 0.05, b: 0.06 },
    roughness: 0.25,
    metalness: 0.0,
    detail: { weaveScale: 40, weaveAngle: 0.785, weaveContrast: 0.03 },
  },
  {
    kind: 'anodized',
    baseColor: { r: 0.6, g: 0.6, b: 0.65 },
    roughness: 0.40,
    metalness: 0.8,
    detail: { grainScale: 60, grainStrength: 0.02 },
  },
  {
    kind: 'sailcloth',
    baseColor: { r: 0.95, g: 0.93, b: 0.90 },
    roughness: 0.75,
    metalness: 0.0,
    detail: { panelWidth: 0.5, seamDarkening: 0.05, seamSharpness: 30 },
  },
  {
    kind: 'teak',
    baseColor: { r: 0.55, g: 0.38, b: 0.22 },
    roughness: 0.60,
    metalness: 0.0,
    detail: { plankWidth: 0.05, grainScale: 8, grainContrast: 0.025 },
  },
  {
    kind: 'terrain',
    baseColor: { r: 0.42, g: 0.44, b: 0.38 },
    roughness: 0.80,
    metalness: 0.0,
    detail: { slopeThreshold: 0.7, slopeBlend: 0.1, rockRoughness: 0.85 },
  },
  {
    kind: 'concrete',
    baseColor: { r: 0.54, g: 0.54, b: 0.55 },
    roughness: 0.85,
    metalness: 0.0,
    detail: { surfaceScale: 10, surfaceStrength: 0.03 },
  },
  {
    kind: 'water',
    baseColor: { r: 0.17, g: 0.29, b: 0.31 },
    roughness: 0.02,
    metalness: 0.0,
  },
];

export interface MaterialSamplerResult {
  scene: THREE.Scene;
  meshes: THREE.Mesh[];
  camera: THREE.PerspectiveCamera;
}

/**
 * Creates a scene with one sphere per material kind, laid out in a row.
 * Each sphere is 1 unit radius, spaced 3 units apart along the X axis.
 */
export function createMaterialSampler(): MaterialSamplerResult {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a1a);

  const meshes: THREE.Mesh[] = [];
  const spacing = 3.0;
  const startX = -((SAMPLER_PARAMS.length - 1) * spacing) / 2;

  for (let i = 0; i < SAMPLER_PARAMS.length; i++) {
    const params = SAMPLER_PARAMS[i];
    if (params === undefined) continue;

    const material = buildProceduralMaterial(params);
    const geometry = new THREE.SphereGeometry(1, 32, 24);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(startX + i * spacing, 0, 0);
    scene.add(mesh);
    meshes.push(mesh);
  }

  // Simple lighting
  const ambient = new THREE.AmbientLight(0x404040, 0.4);
  scene.add(ambient);

  const directional = new THREE.DirectionalLight(0xffffff, 1.0);
  directional.position.set(5, 10, 7);
  scene.add(directional);

  // Camera positioned to see all spheres
  const camera = new THREE.PerspectiveCamera(50, 2.0, 0.1, 100);
  camera.position.set(0, 2, SAMPLER_PARAMS.length * 2);
  camera.lookAt(0, 0, 0);

  return { scene, meshes, camera };
}

/** The sampler parameter set, exported for test use. */
export { SAMPLER_PARAMS };
