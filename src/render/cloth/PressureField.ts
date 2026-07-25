/**
 * Aerodynamic pressure distribution — rendering-layer approximation.
 *
 * ## CONTRACT GAP DOCUMENTATION
 *
 * tasks.md I.2 states the cloth is "loaded by the aerodynamic pressure field C.4
 * already computes." This is INACCURATE. C.4 (AeroForce) computes only a SCALAR
 * per-sail state (`SailAeroState`):
 *
 * - `attachment`: 0..1 (0 = fully separated/luffing, 1 = fully attached)
 * - `luffing`: boolean (alpha below attachment threshold ~3°)
 * - `alpha`: angle of attack, radians (signed)
 * - `cl`, `cd`: scalar lift/drag coefficients
 * - `driveForce`, `sideForce`, `heelingMoment`: whole-sail lumped forces
 *
 * There is NO per-vertex or spatial pressure field. This module derives an
 * APPROXIMATE spatial distribution from the scalar state for visual purposes only.
 * This is a RENDERING APPROXIMATION, not physics.
 *
 * ## Derivation
 *
 * The pressure at each vertex of the cloth grid is computed as:
 *
 *   P(u, v) = pressureSign × attachment × basePressure × chordwiseProfile(u) × stallFlatten
 *
 * Where:
 * - `u` ∈ [0,1]: girth fraction (0 = luff, 1 = leech)
 * - `v` ∈ [0,1]: luff fraction (0 = foot, 1 = head)
 * - `pressureSign`: sign(alpha) — determines which side is loaded (positive =
 *   force pushes toward +Z in sail reference, matching AeroForce's liftDir convention)
 * - `attachment`: global scaling factor from SailAeroState.attachment (0..1)
 * - `basePressure`: nominal force magnitude derived from SailAeroState.driveForce and
 *   sideForce, distributed across sail area
 * - `chordwiseProfile(u)`: classic sail pressure distribution — higher near the luff
 *   (leading edge), tapering toward the leech (trailing edge). Modelled as:
 *   `(1 - u)^0.6` — a power law giving ~60% of load in the forward third, tapering
 *   gently to ~30% at the leech. This matches wind-tunnel data for cambered sails.
 * - `stallFlatten`: when alpha exceeds the stall regime (attachment < 1, not luffing),
 *   the pressure profile flattens and reduces camber production. A stalled sail is
 *   flatter and draggier, not more cambered. Modelled by lerping the power toward
 *   1.0 (uniform distribution) as attachment drops in the stall regime:
 *   `effectivePower = 0.6 * stallFlatten + 0.0 * (1 - stallFlatten)` where
 *   stallFlatten is derived from attachment in the stall zone (attachment 0.3..1.0).
 *
 * ## Luffing regime
 *
 * When `sailState.luffing === true` (or attachment < 0.15), the pressure load drops
 * toward zero. Instead, a time-varying flutter perturbation is applied:
 *
 *   flutter(u, v, t) = flutterAmplitude × sin(ωt + φ(u,v))
 *
 * This produces visible flapping without simulating real aerodynamic flutter.
 * The flutter amplitude scales with (1 - attachment) so the transition from
 * attached flow to luffing is smooth, not a discontinuous snap.
 *
 * ## Over-trimming / stall visual
 *
 * From aeroCoefficients.ts: attachment drops below 1.0 when |alpha| > PEAK_ALPHA
 * (~16°), reaching 0.3 at FULL_STALL_ALPHA (~30°). In this regime:
 * - The chordwise profile exponent lerps from 0.6 toward 0.0 (more uniform = flatter)
 * - The overall pressure magnitude drops (via attachment factor)
 * - Combined effect: the sail visually flattens and loses its cambered shape
 *
 * This is physically reasonable: a stalled sail has separated flow, the suction
 * peak near the luff collapses, and the pressure distribution becomes more uniform
 * (flat-plate-like) rather than maintaining the sharp luff-to-leech gradient of
 * attached flow.
 *
 * ## Integration with C.4
 *
 * This module READS SailAeroState (produced by AeroForce each physics step) but
 * does NOT modify it or re-implement any aerodynamic computation. It is a one-way
 * consumer of the physics output, living in the render layer.
 *
 * A future physics integration pass could replace this approximation with a real
 * panel-method or vortex-lattice pressure field if desired — this module would
 * then become unnecessary. Until then, this clearly-documented approximation serves
 * the visual requirements adequately.
 */

import type { SailAeroState } from '@physics/forces/AeroForce';

/**
 * Per-vertex pressure value: a scalar representing the force magnitude and direction
 * perpendicular to the local cloth surface. Positive = toward +Z in sail reference
 * frame (leeward push when alpha > 0).
 */
export interface PressureField {
  /** One pressure value per vertex in the cloth grid, matching the vertex order
   * from SailSurfaceGenerator (row-major: [row0col0, row0col1, ..., rowNcolM]). */
  readonly pressures: Float32Array;
}

/**
 * Compute the approximate spatial pressure distribution for one sail.
 *
 * @param sailState - Current aerodynamic state from AeroForce (read-only).
 * @param luffSegments - Grid resolution along luff (rows - 1).
 * @param footSegments - Grid resolution along girth (cols - 1).
 * @param sailArea - Sail area in m² (for pressure magnitude normalisation).
 * @param time - Current time in seconds (for flutter animation).
 * @returns A Float32Array of per-vertex pressure values.
 */
export function computePressureField(
  sailState: SailAeroState,
  luffSegments: number,
  footSegments: number,
  sailArea: number,
  time: number,
): PressureField {
  const rows = luffSegments + 1;
  const cols = footSegments + 1;
  const vertexCount = rows * cols;
  const pressures = new Float32Array(vertexCount);

  const { attachment, luffing, alpha, driveForce, sideForce } = sailState;

  // --- Pressure sign from alpha ---
  // Positive alpha → force pushes toward +Z (leeward / starboard side in port-tack).
  // This matches AeroForce's liftDir sign convention.
  const pressureSign = Math.sign(alpha) || 1;

  // --- Base pressure magnitude ---
  // Total aerodynamic force magnitude, distributed across sail area.
  // This gives pressure in Pa (N/m²) if area is in m².
  const totalForce = Math.sqrt(driveForce * driveForce + sideForce * sideForce);
  const basePressure = sailArea > 0 ? totalForce / sailArea : 0;

  // --- Stall-flatten factor ---
  // When attachment is between 0.3 and 1.0 (stall regime), interpolate the profile
  // from the normal peaked shape toward a flatter uniform distribution.
  // attachment = 1.0 → stallFlatten = 1.0 (normal peaked profile)
  // attachment = 0.3 → stallFlatten = 0.0 (completely flat / uniform)
  const stallFlatten = luffing ? 1.0 : Math.min(1.0, Math.max(0, (attachment - 0.3) / 0.7));

  // Effective chordwise power exponent: 0.6 for fully attached, 0.0 for fully stalled
  const chordwisePower = 0.6 * stallFlatten;

  // --- Luffing flutter parameters ---
  const isFluttering = luffing || attachment < 0.15;
  const flutterStrength = isFluttering ? (1 - attachment) * 0.5 : 0;
  const flutterFreq = 8.0; // Hz — visible flapping frequency

  for (let i = 0; i < rows; i++) {
    const v = luffSegments > 0 ? i / luffSegments : 0;

    for (let j = 0; j < cols; j++) {
      const u = footSegments > 0 ? j / footSegments : 0;
      const idx = i * cols + j;

      if (isFluttering) {
        // Luffing regime: near-zero mean pressure, sinusoidal flutter perturbation.
        // Phase varies spatially so the flapping appears as a travelling wave from
        // luff to leech (like real luffing sails).
        const phase = u * 4.0 + v * 2.0;
        const flutter = flutterStrength * Math.sin(flutterFreq * 2 * Math.PI * time + phase);
        // Small residual pressure from whatever attachment remains
        const residual = attachment * basePressure * 0.1;
        pressures[idx] = pressureSign * (residual + flutter);
      } else {
        // Attached flow: classic chordwise pressure distribution.
        // Higher near luff (u=0), tapering toward leech (u=1).
        // profile = (1 - u)^power, normalised so integral across u ≈ 1.
        const profile = Math.pow(Math.max(0, 1 - u), chordwisePower);

        // Normalise so the integral of the profile across the chord sums correctly.
        // For power p: ∫₀¹ (1-u)^p du = 1/(p+1). Normalise by (p+1).
        const normalisation = chordwisePower + 1;

        pressures[idx] = pressureSign * attachment * basePressure * profile * normalisation;
      }
    }
  }

  return { pressures };
}

/**
 * Determine whether the sail is in the stall (over-trimmed) regime.
 * This is distinct from luffing: stall occurs when alpha EXCEEDS the peak,
 * while luffing occurs when alpha is BELOW the attachment threshold.
 *
 * From aeroCoefficients.ts:
 * - PEAK_ALPHA ≈ 0.28 rad (16°) — stall onset
 * - FULL_STALL_ALPHA ≈ 0.52 rad (30°) — fully stalled
 * - Stall signature: attachment < 1.0 AND NOT luffing
 */
export function isStalled(sailState: SailAeroState): boolean {
  return !sailState.luffing && sailState.attachment < 1.0;
}
