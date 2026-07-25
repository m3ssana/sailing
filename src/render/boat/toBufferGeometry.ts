/**
 * Converts a GeneratedMesh (engine-agnostic typed arrays) into a three.js
 * BufferGeometry with position, normal, uv, and optional color attributes.
 *
 * This is the bridge between the generation layer (no three.js) and the render
 * layer (three.js scene graph). Lives in src/render/ so it may import three.js.
 */

import * as THREE from 'three/webgpu';
import type { GeneratedMesh } from '@/types';

/**
 * Build a three.js BufferGeometry from a GeneratedMesh's flat typed arrays.
 *
 * @param mesh - The generated mesh containing positions (3/vtx), normals (3/vtx),
 *   uvs (2/vtx), indices (3/face), and optional colors (3/vtx).
 * @returns A ready-to-render BufferGeometry.
 */
export function toBufferGeometry(mesh: GeneratedMesh): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(mesh.uvs, 2));

  if (mesh.colors) {
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(mesh.colors, 3));
  }

  geometry.setIndex(new THREE.Uint32BufferAttribute(mesh.indices, 1));

  return geometry;
}
