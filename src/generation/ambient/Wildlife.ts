/**
 * Wildlife generator — D.9.
 *
 * Produces cheap, recognizable-silhouette geometry for gulls and dolphins.
 * These are intended for GPU instancing in large numbers (circling gulls,
 * dolphin pods), so triangle budgets are kept very low:
 *
 * - Gull: target <100 triangles (actual ~60–80)
 * - Dolphin: target <100 triangles (actual ~70–90)
 *
 * The gull is a boxy/faceted bird silhouette: body cylinder + flattened wing
 * planes. The dolphin is a tapered revolve body with small fin stubs.
 *
 * Engine-agnostic — no three.js.
 */

import type { GeneratedMesh, GeneratedModel, Generator, Seed, Vec2 } from '@/types';
import { extrudePolygon, revolve } from '../common/extrude';
import { computeBounds, computeNormals, mergeMeshes } from '../common/meshUtils';

// ─── Types ───────────────────────────────────────────────────────────────────

export type WildlifeKind = 'gull' | 'dolphin';

export interface WildlifeParams {
  kind: WildlifeKind;
  /** Body length, metres. Default: gull=0.4, dolphin=2.5. */
  bodyLength?: number;
}

// ─── Gull ────────────────────────────────────────────────────────────────────

/**
 * Build a gull from:
 * - A small cylindrical body (revolve, 6 segments)
 * - Two flat triangular wings (extruded thin triangles)
 *
 * Total: ~60–80 triangles
 */
function makeGull(bodyLength: number): GeneratedMesh {
  // Body: tapered ellipsoid via revolve of a simple profile
  // Profile in XY: x = radius from axis, y = position along body
  const bodyRadius = bodyLength * 0.12;
  const bodyProfile: Vec2[] = [
    { x: 0, y: 0 },                          // tail tip
    { x: bodyRadius * 0.4, y: bodyLength * 0.1 },
    { x: bodyRadius * 0.8, y: bodyLength * 0.25 },
    { x: bodyRadius, y: bodyLength * 0.45 },   // widest point
    { x: bodyRadius * 0.85, y: bodyLength * 0.65 },
    { x: bodyRadius * 0.5, y: bodyLength * 0.85 },
    { x: bodyRadius * 0.25, y: bodyLength * 0.95 }, // head taper
    { x: 0, y: bodyLength },                  // beak tip
  ];

  // Low segment count for cheapness
  const bodyMesh = revolve(bodyProfile, 6);

  // Rotate body so it's oriented along Z axis (flight direction)
  // revolve produces the profile along Y. We need to swap Y↔Z for flight along Z.
  // Actually, leave as Y-axis aligned — the body axis is along Y (height of revolve).
  // For a gull, the body axis should run horizontally. Remap: Y→Z (forward).
  const rotatedPositions = new Float32Array(bodyMesh.positions.length);
  for (let i = 0; i < bodyMesh.positions.length; i += 3) {
    // Rotate 90° about X: (x, y, z) → (x, -z, y)
    rotatedPositions[i] = bodyMesh.positions[i] ?? 0;           // x stays
    rotatedPositions[i + 1] = -(bodyMesh.positions[i + 2] ?? 0); // y = -oldZ
    rotatedPositions[i + 2] = bodyMesh.positions[i + 1] ?? 0;   // z = oldY
  }
  bodyMesh.positions = rotatedPositions;

  // Wings: two flat triangular shapes extruded to thin slabs
  const wingSpan = bodyLength * 1.8; // total wingspan
  const wingChord = bodyLength * 0.35;
  const wingThickness = bodyLength * 0.02;
  const halfSpan = wingSpan / 2;

  // Right wing outline (in XZ plane)
  const rightWingOutline: Vec2[] = [
    { x: bodyRadius * 0.5, y: -wingChord * 0.3 },   // root leading edge
    { x: halfSpan, y: 0 },                           // tip leading edge
    { x: halfSpan * 0.8, y: wingChord * 0.4 },      // tip trailing edge
    { x: bodyRadius * 0.5, y: wingChord * 0.5 },    // root trailing edge
  ];

  // Left wing (mirrored)
  const leftWingOutline: Vec2[] = rightWingOutline.map(p => ({
    x: -p.x,
    y: p.y,
  }));

  const rightWing = extrudePolygon(rightWingOutline, wingThickness, { caps: true });
  const leftWing = extrudePolygon(leftWingOutline, wingThickness, { caps: true });

  // Position wings at body midpoint (roughly where Z=bodyLength*0.45 after rotation)
  const wingZ = bodyLength * 0.45;
  for (let i = 2; i < rightWing.positions.length; i += 3) {
    rightWing.positions[i] = (rightWing.positions[i] ?? 0) + wingZ;
  }
  for (let i = 2; i < leftWing.positions.length; i += 3) {
    leftWing.positions[i] = (leftWing.positions[i] ?? 0) + wingZ;
  }

  return mergeMeshes([bodyMesh, rightWing, leftWing]);
}

// ─── Dolphin ─────────────────────────────────────────────────────────────────

/**
 * Build a dolphin as:
 * - A smooth tapered revolve body (torpedo-like)
 * - A small dorsal fin (thin extruded triangle)
 * - Tail flukes (thin flat triangles)
 *
 * Total: ~70–90 triangles
 */
function makeDolphin(bodyLength: number): GeneratedMesh {
  const bodyRadius = bodyLength * 0.1;

  // Torpedo-shaped body profile
  const bodyProfile: Vec2[] = [
    { x: 0, y: 0 },                            // snout
    { x: bodyRadius * 0.4, y: bodyLength * 0.05 },
    { x: bodyRadius * 0.8, y: bodyLength * 0.12 },
    { x: bodyRadius, y: bodyLength * 0.3 },      // max girth
    { x: bodyRadius * 0.95, y: bodyLength * 0.45 },
    { x: bodyRadius * 0.8, y: bodyLength * 0.6 },
    { x: bodyRadius * 0.5, y: bodyLength * 0.75 },
    { x: bodyRadius * 0.25, y: bodyLength * 0.88 },
    { x: bodyRadius * 0.1, y: bodyLength * 0.95 },
    { x: 0, y: bodyLength },                    // tail peduncle tip
  ];

  const bodyMesh = revolve(bodyProfile, 6);

  // Rotate body so it swims along Z (same as gull: Y→Z)
  const rotatedPositions = new Float32Array(bodyMesh.positions.length);
  for (let i = 0; i < bodyMesh.positions.length; i += 3) {
    rotatedPositions[i] = bodyMesh.positions[i] ?? 0;
    rotatedPositions[i + 1] = -(bodyMesh.positions[i + 2] ?? 0);
    rotatedPositions[i + 2] = bodyMesh.positions[i + 1] ?? 0;
  }
  bodyMesh.positions = rotatedPositions;

  // Dorsal fin: a thin triangle standing up from the back
  const finHeight = bodyLength * 0.12;
  const finChord = bodyLength * 0.15;
  const finThickness = bodyLength * 0.01;

  const dorsalOutline: Vec2[] = [
    { x: 0, y: 0 },
    { x: finChord, y: 0 },
    { x: finChord * 0.4, y: finHeight },
  ];
  const dorsalFin = extrudePolygon(dorsalOutline, finThickness, { caps: true });

  // Position dorsal fin on top of body at ~40% along
  const finZ = bodyLength * 0.4;
  for (let i = 0; i < dorsalFin.positions.length; i += 3) {
    // The fin extrudes along Y. Rotate: X→X, Y→Y(up), Z offset
    dorsalFin.positions[i + 1] = (dorsalFin.positions[i + 1] ?? 0) + bodyRadius * 0.8;
    dorsalFin.positions[i + 2] = (dorsalFin.positions[i + 2] ?? 0) + finZ;
  }

  // Tail flukes: two small flat triangles
  const flukeSpan = bodyLength * 0.2;
  const flukeChord = bodyLength * 0.08;
  const flukeThickness = bodyLength * 0.008;

  const rightFlukeOutline: Vec2[] = [
    { x: 0, y: 0 },
    { x: flukeSpan / 2, y: -flukeChord * 0.3 },
    { x: flukeSpan * 0.3, y: flukeChord * 0.5 },
  ];
  const leftFlukeOutline: Vec2[] = rightFlukeOutline.map(p => ({
    x: -p.x,
    y: p.y,
  }));

  const rightFluke = extrudePolygon(rightFlukeOutline, flukeThickness, { caps: true });
  const leftFluke = extrudePolygon(leftFlukeOutline, flukeThickness, { caps: true });

  // Position flukes at tail
  const tailZ = bodyLength * 0.95;
  for (let i = 2; i < rightFluke.positions.length; i += 3) {
    rightFluke.positions[i] = (rightFluke.positions[i] ?? 0) + tailZ;
  }
  for (let i = 2; i < leftFluke.positions.length; i += 3) {
    leftFluke.positions[i] = (leftFluke.positions[i] ?? 0) + tailZ;
  }

  return mergeMeshes([bodyMesh, dorsalFin, rightFluke, leftFluke]);
}

// ─── Generator ───────────────────────────────────────────────────────────────

export const WildlifeGenerator: Generator<WildlifeParams, GeneratedModel> = {
  id: 'ambient-wildlife',

  generate(params: WildlifeParams, _seed: Seed): GeneratedModel {
    const { kind } = params;

    let mesh: GeneratedMesh;

    switch (kind) {
      case 'gull': {
        const bodyLength = params.bodyLength ?? 0.4;
        mesh = makeGull(bodyLength);
        break;
      }
      case 'dolphin': {
        const bodyLength = params.bodyLength ?? 2.5;
        mesh = makeDolphin(bodyLength);
        break;
      }
    }

    // Recompute normals and bounds on merged mesh
    const normals = computeNormals(mesh.positions, mesh.indices);
    const bounds = computeBounds(mesh.positions);
    mesh = { ...mesh, normals, bounds };

    return {
      meshes: [mesh],
      groups: [{ name: `wildlife-${kind}`, start: 0, count: mesh.indices.length, materialId: 'gelcoat' }],
      transferables: [],
    };
  },
};
