/**
 * CPU wave field evaluator via truncated Gerstner sum.
 *
 * This is called at 120 Hz from the physics loop at ~12 buoyancy points per
 * boat. It MUST be allocation-free: all results are written into caller-owned
 * out-params or module-scope scratch vectors.
 *
 * The Gerstner model gives both vertical displacement (height) and horizontal
 * displacement, plus exact analytic derivatives for normals. Finite differences
 * are both more expensive and introduce spatial aliasing — analytic is the right
 * choice here.
 *
 * Orbital velocity uses exp(k·y) depth decay, which drives wave drag and
 * surfing acceleration when the boat moves with or against the wave field.
 */

import type { Metres, SessionTime, Vec3, WaveComponent, WaveField, WaveSpectrumParams } from '@/types';
import { buildSpectrum } from './WaveSpectrum';

const { sin, cos, exp, sqrt } = Math;

// ─── Module-scope scratch vectors ─────────────────────────────────────────────
// Pre-allocated to avoid GC pressure in the hot loop.

const _displacement: Vec3 = { x: 0, y: 0, z: 0 };
const _normal: Vec3 = { x: 0, y: 0, z: 0 };
const _orbital: Vec3 = { x: 0, y: 0, z: 0 };

// ─── Typed array accessor ─────────────────────────────────────────────────────

/**
 * Read a Float64Array element. Exists solely because noUncheckedIndexedAccess
 * makes TypedArray indexing return `number | undefined`, but a Float64Array at a
 * valid index always returns a number (or NaN for out-of-bounds, never undefined
 * at runtime). We validate bounds at construction, not per-access.
 */
function f64(arr: Float64Array, i: number): number {
  return arr[i] as number;
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Create a CPU wave field from spectrum parameters.
 *
 * The returned object implements the frozen WaveField interface and evaluates
 * a truncated Gerstner sum over the ~24 highest-energy components extracted
 * from the same spectrum the GPU renders.
 */
export function createWaveFieldCPU(params: WaveSpectrumParams): WaveField {
  const result = buildSpectrum(params);
  const components = result.components;

  // Pre-extract component data into flat arrays for cache-friendly iteration.
  // This avoids repeated property lookups on objects in the hot loop.
  const count = components.length;
  const amplitudes = new Float64Array(count);
  const wavenumbers = new Float64Array(count);
  const frequencies = new Float64Array(count);
  const phases = new Float64Array(count);
  const steepnesses = new Float64Array(count);
  const dirXArr = new Float64Array(count);
  const dirZArr = new Float64Array(count);

  for (let i = 0; i < count; i++) {
    const c = components[i];
    if (c === undefined) continue;
    amplitudes[i] = c.amplitude;
    wavenumbers[i] = c.wavenumber;
    frequencies[i] = c.frequency;
    phases[i] = c.phase;
    steepnesses[i] = c.steepness;
    dirXArr[i] = c.direction.x;
    // Vec2.y on the ground plane corresponds to world Z (south).
    dirZArr[i] = c.direction.y;
  }

  const field: WaveField = {
    height(x: number, z: number, t: SessionTime): Metres {
      let h = 0;
      for (let i = 0; i < count; i++) {
        // Phase at this point and time: k·(d·p) - ω·t + φ
        const kDotP = f64(wavenumbers, i) * (f64(dirXArr, i) * x + f64(dirZArr, i) * z);
        const phase = kDotP - f64(frequencies, i) * t + f64(phases, i);
        h += f64(amplitudes, i) * cos(phase);
      }
      return h;
    },

    displacement(x: number, z: number, t: SessionTime, out?: Vec3): Vec3 {
      const o = out ?? _displacement;
      let dx = 0;
      let dy = 0;
      let dz = 0;

      for (let i = 0; i < count; i++) {
        const kDotP = f64(wavenumbers, i) * (f64(dirXArr, i) * x + f64(dirZArr, i) * z);
        const phase = kDotP - f64(frequencies, i) * t + f64(phases, i);
        const cosP = cos(phase);
        const sinP = sin(phase);

        // Vertical displacement
        dy += f64(amplitudes, i) * cosP;

        // Horizontal Gerstner displacement: pulls surface towards wave crests
        // D_horizontal = -Q·A·d·sin(k·d·p - ω·t + φ)
        const horizontalScale = -f64(steepnesses, i) * f64(amplitudes, i);
        dx += horizontalScale * f64(dirXArr, i) * sinP;
        dz += horizontalScale * f64(dirZArr, i) * sinP;
      }

      o.x = dx;
      o.y = dy;
      o.z = dz;
      return o;
    },

    normal(x: number, z: number, t: SessionTime, out?: Vec3): Vec3 {
      const o = out ?? _normal;

      // Analytic normal from Gerstner displacement partial derivatives.
      //
      // The displaced surface is P(x,z,t) = (x + Dx, Dy, z + Dz).
      // Tangent vectors:
      //   T_x = (1 + ∂Dx/∂x, ∂Dy/∂x, ∂Dz/∂x)
      //   T_z = (∂Dx/∂z, ∂Dy/∂z, 1 + ∂Dz/∂z)
      // Normal = T_x × T_z, normalized.
      //
      // Per component:
      //   ∂Dy/∂x = -A·k·dx·sin(phase)
      //   ∂Dy/∂z = -A·k·dz·sin(phase)
      //   ∂Dx/∂x = -Q·A·k·dx²·cos(phase)
      //   ∂Dx/∂z = -Q·A·k·dx·dz·cos(phase)
      //   ∂Dz/∂x = -Q·A·k·dx·dz·cos(phase)
      //   ∂Dz/∂z = -Q·A·k·dz²·cos(phase)

      let dDy_dx = 0;
      let dDy_dz = 0;
      let dDx_dx = 0;
      let dDx_dz = 0;
      let dDz_dx = 0;
      let dDz_dz = 0;

      for (let i = 0; i < count; i++) {
        const ki = f64(wavenumbers, i);
        const dxi = f64(dirXArr, i);
        const dzi = f64(dirZArr, i);
        const ai = f64(amplitudes, i);
        const qi = f64(steepnesses, i);

        const kDotP = ki * (dxi * x + dzi * z);
        const phase = kDotP - f64(frequencies, i) * t + f64(phases, i);
        const cosP = cos(phase);
        const sinP = sin(phase);
        const Ak = ai * ki;
        const QAk = qi * Ak;

        dDy_dx += -Ak * dxi * sinP;
        dDy_dz += -Ak * dzi * sinP;
        dDx_dx += -QAk * dxi * dxi * cosP;
        dDx_dz += -QAk * dxi * dzi * cosP;
        dDz_dx += -QAk * dxi * dzi * cosP;
        dDz_dz += -QAk * dzi * dzi * cosP;
      }

      // Tangent vectors
      const tx_x = 1 + dDx_dx;
      const tx_y = dDy_dx;
      const tx_z = dDz_dx;

      const tz_x = dDx_dz;
      const tz_y = dDy_dz;
      const tz_z = 1 + dDz_dz;

      // Cross product T_z × T_x: order chosen so that the flat-sea case
      // (T_x=(1,0,0), T_z=(0,0,1)) yields (0,1,0) — upward in Y-up world space.
      let nx = tz_y * tx_z - tz_z * tx_y;
      let ny = tz_z * tx_x - tz_x * tx_z;
      let nz = tz_x * tx_y - tz_y * tx_x;

      // Normalize
      const len = sqrt(nx * nx + ny * ny + nz * nz);
      if (len > 1e-10) {
        const invLen = 1 / len;
        nx *= invLen;
        ny *= invLen;
        nz *= invLen;
      } else {
        nx = 0;
        ny = 1;
        nz = 0;
      }

      o.x = nx;
      o.y = ny;
      o.z = nz;
      return o;
    },

    orbitalVelocity(x: number, z: number, y: number, t: SessionTime, out?: Vec3): Vec3 {
      const o = out ?? _orbital;
      let vx = 0;
      let vy = 0;
      let vz = 0;

      for (let i = 0; i < count; i++) {
        const ki = f64(wavenumbers, i);
        const dxi = f64(dirXArr, i);
        const dzi = f64(dirZArr, i);

        const kDotP = ki * (dxi * x + dzi * z);
        const phase = kDotP - f64(frequencies, i) * t + f64(phases, i);
        const cosP = cos(phase);
        const sinP = sin(phase);

        // Depth decay: exp(k·y) where y ≤ 0 below the surface.
        // Clamp k·y to prevent overflow for very deep points.
        const ky = ki * y;
        const decay = ky > 0 ? 1 : ky < -20 ? 0 : exp(ky);

        // Orbital velocity for Gerstner/Airy waves:
        //   v_horizontal = A·ω·d·cos(phase)·exp(k·y)  (in wave direction)
        //   v_vertical   = A·ω·sin(phase)·exp(k·y)    (upward at crest)
        const Aw = f64(amplitudes, i) * f64(frequencies, i) * decay;
        vx += Aw * dxi * cosP;
        vy += Aw * sinP;
        vz += Aw * dzi * cosP;
      }

      o.x = vx;
      o.y = vy;
      o.z = vz;
      return o;
    },

    get components(): readonly WaveComponent[] {
      return components;
    },

    get params(): WaveSpectrumParams {
      return params;
    },
  };

  return field;
}
