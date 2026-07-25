/**
 * Chamfer and bevel utilities.
 *
 * docs/art-direction.md §2.2 mandates chamfers at 1–2% of the object's major
 * dimension on all hard edges. This module provides the profile generation
 * needed by extrude and other generators.
 *
 * Rather than a mesh-level `chamferEdges` (which requires half-edge
 * connectivity and is fragile on procedural meshes), we provide:
 *
 * - `bevelProfile`: generates a 2D profile curve for bevelled edges, usable
 *   directly with extrude/revolve.
 * - `chamferSize`: computes the art-direction-mandated chamfer distance from
 *   the object's major dimension.
 *
 * Engine-agnostic — no three.js.
 */

import type { Vec2 } from '@/types';

/**
 * Compute the chamfer distance for an object.
 *
 * Art direction mandates 1–2% of the major dimension. We use 1.5% as the
 * default, which hits the midpoint of the range and looks right on both
 * large hulls and small fittings.
 *
 * @param majorDimension The largest extent of the object (metres).
 * @param fraction Fraction of the major dimension. Default 0.015 (1.5%).
 */
export function chamferSize(majorDimension: number, fraction = 0.015): number {
  return majorDimension * fraction;
}

/**
 * Generate a 2D bevel profile — a quarter-circle arc from (size, 0) to (0, size).
 *
 * Used as the corner profile for extruded shapes. When applied at the top/bottom
 * edges of an extrusion, it creates the mandatory chamfer that catches specular
 * highlights and prevents aliasing on thin silhouettes.
 *
 * @param size The bevel radius (use `chamferSize` to compute it).
 * @param segments Number of segments in the arc. More = rounder.
 * @returns Points along the arc, from (size, 0) to (0, size).
 */
export function bevelProfile(size: number, segments = 4): Vec2[] {
  const result: Vec2[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const angle = t * (Math.PI / 2);
    result.push({
      x: size * Math.cos(angle),
      y: size * Math.sin(angle),
    });
  }
  return result;
}

/**
 * Generate a bevelled extrusion profile for a rectangular cross-section.
 *
 * Returns a closed 2D outline suitable for revolve or as a profile for
 * extrusion, with rounded corners at the specified bevel radius.
 *
 * @param width Half-width of the rectangle.
 * @param height Half-height of the rectangle.
 * @param bevel Corner radius.
 * @param cornerSegments Segments per corner arc.
 */
export function bevelledRect(
  width: number,
  height: number,
  bevel: number,
  cornerSegments = 4,
): Vec2[] {
  const b = Math.min(bevel, width, height);
  const result: Vec2[] = [];

  // Bottom-right corner arc
  for (let i = 0; i <= cornerSegments; i++) {
    const t = i / cornerSegments;
    const angle = -Math.PI / 2 + t * (Math.PI / 2);
    result.push({
      x: width - b + b * Math.cos(angle),
      y: -height + b + b * Math.sin(angle),
    });
  }

  // Top-right corner arc
  for (let i = 0; i <= cornerSegments; i++) {
    const t = i / cornerSegments;
    const angle = t * (Math.PI / 2);
    result.push({
      x: width - b + b * Math.cos(angle),
      y: height - b + b * Math.sin(angle),
    });
  }

  // Top-left corner arc
  for (let i = 0; i <= cornerSegments; i++) {
    const t = i / cornerSegments;
    const angle = Math.PI / 2 + t * (Math.PI / 2);
    result.push({
      x: -width + b + b * Math.cos(angle),
      y: height - b + b * Math.sin(angle),
    });
  }

  // Bottom-left corner arc
  for (let i = 0; i <= cornerSegments; i++) {
    const t = i / cornerSegments;
    const angle = Math.PI + t * (Math.PI / 2);
    result.push({
      x: -width + b + b * Math.cos(angle),
      y: -height + b + b * Math.sin(angle),
    });
  }

  return result;
}
