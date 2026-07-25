/**
 * Wind vertical gradient layer: power law v(h) = v₁₀ · (h/10)^α.
 *
 * α (shearExponent) ranges from ~0.11 offshore (nearly uniform profile) to
 * ~0.20 in built-up harbours where surface roughness steepens the gradient.
 *
 * This matters because sails sample at their centre-of-effort height. A taller
 * rig genuinely sees more wind, and the masthead wind vane reads differently
 * from deck level — just as it does on a real boat.
 */

/**
 * Compute the wind speed multiplier at height h relative to the 10 m reference.
 *
 * @param height Height above mean water level, metres. Clamped to [0.1, 100]
 *   to avoid singularities at zero and unreasonable extrapolation above the
 *   boundary layer.
 * @param shearExponent Power law alpha. Typically 0.11–0.20.
 * @returns Multiplier to apply to the 10 m reference speed.
 */
export function verticalGradient(height: number, shearExponent: number): number {
  // Clamp height to avoid log/power singularity at zero and wild extrapolation.
  // 0.1 m is the waterline spray zone; 100 m is well above any mast.
  const h = height < 0.1 ? 0.1 : height > 100 ? 100 : height;
  return Math.pow(h / 10, shearExponent);
}
