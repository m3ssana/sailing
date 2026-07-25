/**
 * Wet-surface darkening — a reusable TSL helper that darkens color and reduces
 * roughness based on a wetness input uniform.
 *
 * Per art-direction.md §3.3: up to 30% reduction in albedo where spray lands,
 * roughness drops by 0.15 when wet. The 5-second exponential dry-off is driven
 * by the consumer updating the wetness uniform over time — this module provides
 * the pure shading math only.
 */

import { Fn, float } from 'three/tsl';
import type { TSLNode, TSLFn } from 'three/tsl';

/**
 * Apply wet-surface darkening to a color node.
 * Call as: applyWetColor(colorNode, wetnessNode)
 *
 * @returns Darkened color node: reduces albedo by up to 30% at full wetness.
 */
export const applyWetColor: TSLFn = Fn((args) => {
  const colorNode = args[0] as TSLNode;
  const wetness = args[1] as TSLNode;
  // Darken by up to 30% (factor range: 1.0 → 0.7)
  const darkenFactor = float(1.0).sub(wetness.mul(0.3));
  return colorNode.mul(darkenFactor);
});

/**
 * Apply wet-surface roughness reduction.
 * Call as: applyWetRoughness(roughnessNode, wetnessNode)
 *
 * @returns Reduced roughness node: drops by up to 0.15 at full wetness.
 */
export const applyWetRoughness: TSLFn = Fn((args) => {
  const roughnessNode = args[0] as TSLNode;
  const wetness = args[1] as TSLNode;
  // Roughness drops by up to 0.15 when fully wet, clamped to 0 minimum.
  return roughnessNode.sub(wetness.mul(0.15)).clamp(0.0, 1.0);
});

/**
 * Convenience: applies both wet color and wet roughness modifications.
 * Returns { color, roughness } nodes.
 */
export function applyWetSurface(
  colorNode: TSLNode,
  roughnessNode: TSLNode,
  wetness: TSLNode,
): { color: TSLNode; roughness: TSLNode } {
  return {
    color: applyWetColor(colorNode, wetness),
    roughness: applyWetRoughness(roughnessNode, wetness),
  };
}
