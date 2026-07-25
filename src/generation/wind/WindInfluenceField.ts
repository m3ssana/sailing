/**
 * Wind influence field generator — D.7.
 *
 * Derives a per-venue speed/direction influence field from coastline geometry
 * and relief via a diffusion/advection approximation. The output feeds B.1's
 * terrain layer (`TerrainInfluenceField` in src/environment/wind/layers/terrain.ts).
 *
 * Three qualitative effects are produced:
 *   1. Lee shadow — reduced speed multiplier downwind of land/relief
 *   2. Gap acceleration — increased speed in narrow channels (venturi effect)
 *   3. Shoreline bend — direction deflection near coast, bending toward shore-parallel
 *
 * The algorithm is NOT a real CFD/PDE solver. It uses:
 *   - Raymarching along the wind direction to seed lee shadow from land/relief
 *   - Perpendicular-to-wind sampling to detect channels for gap acceleration
 *   - Shore-distance-weighted deflection toward the local shore tangent
 *   - Iterative box-blur diffusion + directional advection to smooth the field
 *
 * Design choice: D.7 duplicates a small amount of coastline-to-grid rasterization
 * logic from D.5 (TerrainBuilder) rather than importing it, because:
 *   - The two generators run in different contexts (workers, tests)
 *   - Tight coupling between generators is undesirable per the generation harness design
 *   - The duplicated code is ~50 lines of point-in-polygon + distance-to-segment
 *
 * Convention: world space Y-up, +X east, +Z south. Wind direction is bearing
 * the wind comes FROM. Bearing θ → direction vector (sin θ, 0, -cos θ).
 * Units: SI, radians.
 *
 * Engine-agnostic — no three.js imports.
 */

import type { Polyline, Seed, Vec2 } from '@/types';
import { hashCombine } from '@core/math';
import { createNoiseSource2D } from '../common/noise';

// ─── Consumer contract (matches src/environment/wind/layers/terrain.ts) ──────

/**
 * Output format matching the TerrainInfluenceField interface consumed by B.1.
 *
 * NOTE: This type is defined locally because the frozen types in src/types/
 * do not include it. The consumer contract lives in
 * src/environment/wind/layers/terrain.ts as `TerrainInfluenceField`.
 * If the frozen types are later extended to include a generation output type
 * for wind influence fields, this should be aligned. ESCALATION NEEDED.
 */
export interface WindInfluenceFieldResult {
  /** Interleaved RG data: R = speed multiplier, G = direction bias (0..1 → ±45°). */
  readonly data: Float32Array;
  /** World-space origin X (south-west corner). */
  readonly originX: number;
  /** World-space origin Z (south-west corner). */
  readonly originZ: number;
  /** World-space extent X. */
  readonly extentX: number;
  /** World-space extent Z. */
  readonly extentZ: number;
  /** Pixel resolution per axis. */
  readonly resolution: number;
}

/** Parameters for the wind influence field generator. */
export interface WindInfluenceFieldParams {
  /** Venue extent in local metres. */
  bounds: { min: Vec2; max: Vec2 };
  /** Coastline polylines separating land from water. */
  coastlines: Polyline[];
  /** Relief character — drives lee shadow intensity. */
  relief: 'flat' | 'hilly' | 'mountainous';
  /** Maximum inland elevation, metres. Used for lee shadow scaling. */
  maxElevation: number;
  /** Grid resolution per axis (default 512; use smaller for tests). */
  resolution?: number;
  /** Reference wind bearing (direction wind comes FROM), radians. */
  referenceWindDirection: number;
  /** Seed for deterministic noise. */
  seed: Seed;
}



// ─── Geometry helpers (duplicated from TerrainBuilder — see design note above) ─

function signedArea2D(points: readonly Vec2[]): number {
  let sum = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const curr = points[i];
    const next = points[(i + 1) % n];
    if (curr === undefined || next === undefined) continue;
    sum += curr.x * next.y - next.x * curr.y;
  }
  return sum * 0.5;
}

function pointInPolygon(px: number, py: number, ring: readonly Vec2[]): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const vi = ring[i];
    const vj = ring[j];
    if (vi === undefined || vj === undefined) continue;
    if (
      (vi.y > py) !== (vj.y > py) &&
      px < ((vj.x - vi.x) * (py - vi.y)) / (vj.y - vi.y) + vi.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = px - ax;
    const ey = py - ay;
    return Math.sqrt(ex * ex + ey * ey);
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const closestX = ax + t * dx;
  const closestY = ay + t * dy;
  const ex = px - closestX;
  const ey = py - closestY;
  return Math.sqrt(ex * ex + ey * ey);
}

function distanceToPolyline(px: number, py: number, polyline: Polyline): number {
  const pts = polyline.points;
  let minDist = Infinity;
  const segCount = polyline.closed ? pts.length : pts.length - 1;
  for (let i = 0; i < segCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (a === undefined || b === undefined) continue;
    const d = distanceToSegment(px, py, a.x, a.y, b.x, b.y);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

/**
 * Find the nearest segment on any coastline and return the tangent direction
 * as an angle in radians (the direction the coastline runs at that point).
 */
function nearestShoreTangent(px: number, py: number, coastlines: readonly Polyline[]): number {
  let minDist = Infinity;
  let tangentAngle = 0;

  for (const coast of coastlines) {
    const pts = coast.points;
    const segCount = coast.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < segCount; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if (a === undefined || b === undefined) continue;
      const d = distanceToSegment(px, py, a.x, a.y, b.x, b.y);
      if (d < minDist) {
        minDist = d;
        // Tangent direction of this segment
        const segDx = b.x - a.x;
        const segDy = b.y - a.y;
        tangentAngle = Math.atan2(segDx, -segDy); // Convert to bearing convention
      }
    }
  }

  return tangentAngle;
}



// ─── Grid builders ───────────────────────────────────────────────────────────

function buildLandMask(
  resolution: number,
  bounds: { min: Vec2; max: Vec2 },
  coastlines: readonly Polyline[],
): Uint8Array {
  const mask = new Uint8Array(resolution * resolution);
  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;

  const outerRings: Vec2[][] = [];
  const holeRings: Vec2[][] = [];

  for (const coast of coastlines) {
    if (!coast.closed) continue;
    const area = signedArea2D(coast.points);
    if (area < 0) outerRings.push(coast.points);
    else if (area > 0) holeRings.push(coast.points);
  }

  for (let row = 0; row < resolution; row++) {
    for (let col = 0; col < resolution; col++) {
      const px = bounds.min.x + (col + 0.5) * (width / resolution);
      const py = bounds.min.y + (row + 0.5) * (height / resolution);

      let isLand = false;
      for (const ring of outerRings) {
        if (pointInPolygon(px, py, ring)) { isLand = true; break; }
      }
      if (isLand) {
        for (const hole of holeRings) {
          if (pointInPolygon(px, py, hole)) { isLand = false; break; }
        }
      }

      mask[row * resolution + col] = isLand ? 1 : 0;
    }
  }

  return mask;
}

function buildShoreDistance(
  resolution: number,
  bounds: { min: Vec2; max: Vec2 },
  coastlines: readonly Polyline[],
  landMask: Uint8Array,
): Float32Array {
  const field = new Float32Array(resolution * resolution);
  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;

  for (let row = 0; row < resolution; row++) {
    for (let col = 0; col < resolution; col++) {
      const px = bounds.min.x + (col + 0.5) * (width / resolution);
      const py = bounds.min.y + (row + 0.5) * (height / resolution);

      let minDist = Infinity;
      for (const coast of coastlines) {
        if (coast.points.length < 2) continue;
        const d = distanceToPolyline(px, py, coast);
        if (d < minDist) minDist = d;
      }

      const idx = row * resolution + col;
      const isLand = (landMask[idx] ?? 0) === 1;
      field[idx] = isLand ? minDist : -minDist;
    }
  }

  return field;
}

/**
 * Build an elevation grid for land cells using seeded noise.
 * Elevation rises with distance from shore, modulated by noise.
 */
function buildElevation(
  resolution: number,
  bounds: { min: Vec2; max: Vec2 },
  landMask: Uint8Array,
  shoreDistance: Float32Array,
  relief: 'flat' | 'hilly' | 'mountainous',
  maxElevation: number,
  seed: number,
): Float32Array {
  const elevations = new Float32Array(resolution * resolution);
  const noise = createNoiseSource2D(seed);
  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;
  const extent = Math.max(width, height);
  const noiseScale = 1 / extent;

  const amplitudeMap = { flat: 0.3, hilly: 0.7, mountainous: 1.0 } as const;
  const amplitude = amplitudeMap[relief];
  const beachWidth = extent * 0.05;

  for (let row = 0; row < resolution; row++) {
    for (let col = 0; col < resolution; col++) {
      const idx = row * resolution + col;
      if ((landMask[idx] ?? 0) === 0) continue;

      const px = bounds.min.x + (col + 0.5) * (width / resolution);
      const py = bounds.min.y + (row + 0.5) * (height / resolution);

      const noiseVal = (noise.fbm(px * noiseScale * 4, py * noiseScale * 4, 4, 2.0, 0.5) + 1) * 0.5;
      const dist = shoreDistance[idx] ?? 0;
      const shoreRamp = Math.min(1, Math.max(0, dist / beachWidth));
      const smoothRamp = shoreRamp * shoreRamp * (3 - 2 * shoreRamp);

      elevations[idx] = noiseVal * amplitude * maxElevation * smoothRamp;
    }
  }

  return elevations;
}



// ─── Wind effect computations ────────────────────────────────────────────────

/**
 * Lee shadow model:
 * For each water cell, march upwind (opposite to wind direction). If land is
 * encountered, reduce the speed multiplier proportional to:
 *   - The maximum elevation encountered upwind
 *   - Distance from the nearest downwind land edge (exponential decay)
 *
 * Decay model: multiplier = 1 - shadowStrength * exp(-distFromEdge / decayLength)
 * where shadowStrength = clamp(maxUpwindElevation / referenceHeight, 0, 0.85)
 * and decayLength = 15 * maxUpwindElevation (taller obstacles cast longer shadows).
 *
 * referenceHeight is set to maxElevation so that the tallest terrain produces
 * the deepest shadow (0.15 multiplier floor from the consumer's clamp).
 *
 * The march tracks the LAST land cell seen (closest downwind edge of land),
 * which gives the correct distance for computing shadow decay. Even a single
 * land cell at low resolution will produce a measurable shadow immediately
 * downwind.
 */
function computeLeeShadow(
  resolution: number,
  bounds: { min: Vec2; max: Vec2 },
  landMask: Uint8Array,
  elevation: Float32Array,
  windBearing: number,
  maxElevation: number,
): Float32Array {
  const shadow = new Float32Array(resolution * resolution);
  shadow.fill(1.0); // Default: no shadow (multiplier = 1)

  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;
  const cellSizeX = width / resolution;
  const cellSizeY = height / resolution;
  const cellSize = Math.min(cellSizeX, cellSizeY);

  // Upwind march direction in grid space.
  // Bearing θ = where wind comes FROM. Upwind direction in grid (col=east, row=south):
  const upwindCol = Math.sin(windBearing);
  const upwindRow = -Math.cos(windBearing);

  const maxSteps = Math.ceil(Math.sqrt(2) * resolution);
  const referenceHeight = Math.max(maxElevation, 1);

  for (let row = 0; row < resolution; row++) {
    for (let col = 0; col < resolution; col++) {
      const idx = row * resolution + col;

      if ((landMask[idx] ?? 0) === 1) {
        shadow[idx] = 0.5; // Land cells get moderate reduction
        continue;
      }

      // March upwind from this cell. Track max elevation and the distance
      // from the nearest downwind edge of land (= the last land cell encountered
      // when walking upwind, i.e. the one closest to us).
      let maxUpwindElev = 0;
      let lastLandStep = -1; // Step of the closest land cell (walking upwind)

      for (let step = 1; step <= maxSteps; step++) {
        const sampleCol = Math.round(col + upwindCol * step);
        const sampleRow = Math.round(row + upwindRow * step);

        if (sampleCol < 0 || sampleCol >= resolution || sampleRow < 0 || sampleRow >= resolution) break;

        const sampleIdx = sampleRow * resolution + sampleCol;
        if ((landMask[sampleIdx] ?? 0) === 1) {
          const elev = elevation[sampleIdx] ?? 0;
          if (elev > maxUpwindElev) maxUpwindElev = elev;
          // Always update: we want the NEAREST land cell (smallest step)
          if (lastLandStep < 0) lastLandStep = step;
        }
      }

      if (lastLandStep > 0 && maxUpwindElev > 0) {
        const distFromEdge = lastLandStep * cellSize;
        const shadowStrength = Math.min(0.85, maxUpwindElev / referenceHeight);
        // Decay length proportional to obstacle height
        const decayLength = Math.max(cellSize * 3, 15 * maxUpwindElev);
        const decay = Math.exp(-distFromEdge / decayLength);
        shadow[idx] = 1.0 - shadowStrength * decay;
      }
    }
  }

  return shadow;
}

/**
 * Gap acceleration (venturi effect) model:
 * For each water cell, sample land density in a strip perpendicular to the wind.
 * If both sides have high land density but the centre is clear, boost speed.
 *
 * The strip width adapts to the grid: covers ~40% of the resolution on each side,
 * ensuring channels are detectable even at low resolutions (32×32 for tests).
 * A "gap" is detected when:
 *   - Left-side land fraction > 0.3
 *   - Right-side land fraction > 0.3
 *   - Centre land fraction < 0.2
 *
 * Boost magnitude: up to 1.35 (the consumer's clamp ceiling).
 */
function computeGapAcceleration(
  resolution: number,
  landMask: Uint8Array,
  windBearing: number,
): Float32Array {
  const boost = new Float32Array(resolution * resolution);
  boost.fill(1.0);

  // Perpendicular to wind direction (90° clockwise from upwind)
  const perpCol = Math.cos(windBearing);
  const perpRow = Math.sin(windBearing);

  // Strip half-width: ~40% of resolution to ensure we reach land on both sides
  const stripHalf = Math.max(4, Math.floor(resolution * 0.4));
  // Centre half-width: cells considered "centre" of the gap
  const centreHalf = Math.max(1, Math.floor(resolution * 0.05));

  for (let row = 0; row < resolution; row++) {
    for (let col = 0; col < resolution; col++) {
      const idx = row * resolution + col;
      if ((landMask[idx] ?? 0) === 1) continue;

      let leftLand = 0;
      let leftTotal = 0;
      let rightLand = 0;
      let rightTotal = 0;
      let centreLand = 0;
      let centreTotal = 0;

      for (let s = -stripHalf; s <= stripHalf; s++) {
        const sCol = Math.round(col + perpCol * s);
        const sRow = Math.round(row + perpRow * s);

        if (sCol < 0 || sCol >= resolution || sRow < 0 || sRow >= resolution) continue;

        const sIdx = sRow * resolution + sCol;
        const isLand = (landMask[sIdx] ?? 0) === 1 ? 1 : 0;

        const absS = Math.abs(s);
        if (absS <= centreHalf) {
          centreLand += isLand;
          centreTotal++;
        } else if (s < 0) {
          leftLand += isLand;
          leftTotal++;
        } else {
          rightLand += isLand;
          rightTotal++;
        }
      }

      const leftFrac = leftTotal > 0 ? leftLand / leftTotal : 0;
      const rightFrac = rightTotal > 0 ? rightLand / rightTotal : 0;
      const centreFrac = centreTotal > 0 ? centreLand / centreTotal : 0;

      // Detect gap: high land on both sides, low in centre
      if (leftFrac > 0.3 && rightFrac > 0.3 && centreFrac < 0.2) {
        const constriction = (leftFrac + rightFrac) * 0.5;
        boost[idx] = 1.0 + constriction * 0.35; // max ~1.35
      }
    }
  }

  return boost;
}

/**
 * Shoreline bend model:
 * Near the coastline, deflect wind direction toward shore-parallel.
 *
 * The deflection is proportional to:
 *   - Proximity to shore: (1 - |shoreDistance| / influenceRadius)
 *   - The angular difference between the wind direction and the local shore tangent
 *
 * The deflection bends the wind toward the closer of the two tangent directions
 * (shore tangent or its reverse), weighted by the proximity factor.
 * Maximum deflection: ±45° (matching the consumer's ±π/4 range).
 */
function computeShorelineBend(
  resolution: number,
  bounds: { min: Vec2; max: Vec2 },
  coastlines: readonly Polyline[],
  shoreDistance: Float32Array,
  landMask: Uint8Array,
  windBearing: number,
): Float32Array {
  const deflection = new Float32Array(resolution * resolution);
  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;
  const extent = Math.max(width, height);
  // Influence radius: shoreline bend fades over ~15% of venue extent
  const influenceRadius = extent * 0.15;
  const maxDeflection = Math.PI / 4; // ±45°

  for (let row = 0; row < resolution; row++) {
    for (let col = 0; col < resolution; col++) {
      const idx = row * resolution + col;
      if ((landMask[idx] ?? 0) === 1) continue; // Skip land

      const dist = Math.abs(shoreDistance[idx] ?? Infinity);
      if (dist >= influenceRadius) continue; // Too far from shore

      const px = bounds.min.x + (col + 0.5) * (width / resolution);
      const py = bounds.min.y + (row + 0.5) * (height / resolution);

      // Get the shore tangent direction at the nearest point
      const tangent = nearestShoreTangent(px, py, coastlines);

      // Find the smallest angle between wind direction and shore tangent
      // (tangent has two directions: tangent and tangent + π)
      let delta = tangent - windBearing;
      // Normalize to [-π, π]
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;

      // If the other tangent direction is closer, use it
      if (Math.abs(delta) > Math.PI / 2) {
        delta = delta > 0 ? delta - Math.PI : delta + Math.PI;
      }

      // Proximity factor: strongest at shore, zero at influenceRadius
      const proximity = 1 - dist / influenceRadius;
      // Smoothstep for gradual transition
      const smooth = proximity * proximity * (3 - 2 * proximity);

      // Deflection: fraction of the delta toward shore-parallel
      deflection[idx] = delta * smooth * 0.6; // 60% of full deflection at maximum

      // Clamp to max deflection
      if (deflection[idx] > maxDeflection) deflection[idx] = maxDeflection;
      if (deflection[idx] < -maxDeflection) deflection[idx] = -maxDeflection;
    }
  }

  return deflection;
}



// ─── Diffusion/advection smoothing ──────────────────────────────────────────

/**
 * Apply iterative box-blur diffusion to a scalar field.
 * Each pass averages each cell with its 8 neighbours (3×3 kernel).
 * Land cells are excluded from both input and output (they retain their value,
 * and water cells only average with other water cells and boundary values).
 */
function diffuse(
  field: Float32Array,
  resolution: number,
  landMask: Uint8Array,
  passes: number,
  neutralValue: number,
): void {
  const size = resolution * resolution;
  const temp = new Float32Array(size);

  for (let pass = 0; pass < passes; pass++) {
    for (let row = 0; row < resolution; row++) {
      for (let col = 0; col < resolution; col++) {
        const idx = row * resolution + col;

        // Keep land cells fixed
        if ((landMask[idx] ?? 0) === 1) {
          temp[idx] = field[idx] ?? neutralValue;
          continue;
        }

        // Average with 3×3 neighbourhood, excluding land cells
        let sum = 0;
        let count = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const nr = row + dr;
            const nc = col + dc;
            if (nr < 0 || nr >= resolution || nc < 0 || nc >= resolution) {
              // Boundary: use neutral value
              sum += neutralValue;
              count++;
            } else {
              const nIdx = nr * resolution + nc;
              // Skip land neighbours — they shouldn't influence water cells
              if ((landMask[nIdx] ?? 0) === 1) continue;
              sum += field[nIdx] ?? neutralValue;
              count++;
            }
          }
        }

        temp[idx] = count > 0 ? sum / count : neutralValue;
      }
    }

    // Copy back
    field.set(temp);
  }
}

/**
 * Directional advection step: shift the field slightly in the downwind direction.
 * This extends shadows and effects in the wind direction, simulating advection.
 *
 * Implementation: for each cell, sample the field one step upwind and blend
 * with the current value. This effectively "pushes" patterns downwind.
 */
function advect(
  field: Float32Array,
  resolution: number,
  landMask: Uint8Array,
  windBearing: number,
  strength: number,
  neutralValue: number,
): void {
  const size = resolution * resolution;
  const temp = new Float32Array(size);

  // Upwind direction in grid cells
  const upCol = Math.sin(windBearing) * strength;
  const upRow = -Math.cos(windBearing) * strength;

  for (let row = 0; row < resolution; row++) {
    for (let col = 0; col < resolution; col++) {
      const idx = row * resolution + col;

      if ((landMask[idx] ?? 0) === 1) {
        temp[idx] = field[idx] ?? neutralValue;
        continue;
      }

      // Sample upwind with bilinear interpolation
      const srcCol = col + upCol;
      const srcRow = row + upRow;

      const c0 = Math.floor(srcCol);
      const r0 = Math.floor(srcRow);
      const fc = srcCol - c0;
      const fr = srcRow - r0;

      const sample = (r: number, c: number): number => {
        if (r < 0 || r >= resolution || c < 0 || c >= resolution) return neutralValue;
        const i = r * resolution + c;
        return field[i] ?? neutralValue;
      };

      const v00 = sample(r0, c0);
      const v10 = sample(r0, c0 + 1);
      const v01 = sample(r0 + 1, c0);
      const v11 = sample(r0 + 1, c0 + 1);

      const top = v00 + (v10 - v00) * fc;
      const bot = v01 + (v11 - v01) * fc;
      const interpolated = top + (bot - top) * fr;

      // Blend: 70% advected, 30% current (avoids washing out local effects)
      temp[idx] = interpolated * 0.7 + (field[idx] ?? neutralValue) * 0.3;
    }
  }

  field.set(temp);
}



// ─── Main generator ──────────────────────────────────────────────────────────

/**
 * Generate a wind influence field for a venue.
 *
 * The output matches the `TerrainInfluenceField` contract consumed by B.1's
 * terrain wind layer. Data is interleaved RG format:
 *   - R (even indices) = speed multiplier (0.15..1.35)
 *   - G (odd indices) = direction bias encoded as 0..1 → ±π/4
 *
 * Deterministic in (params, seed) — same inputs produce identical output.
 */
export function generateWindInfluenceField(params: WindInfluenceFieldParams): WindInfluenceFieldResult {
  const {
    bounds,
    coastlines,
    relief,
    maxElevation,
    referenceWindDirection,
    seed,
  } = params;
  const resolution = params.resolution ?? 512;

  const width = bounds.max.x - bounds.min.x;
  const height = bounds.max.y - bounds.min.y;

  // If no coastlines, return neutral field (all water, no influence)
  if (coastlines.length === 0) {
    const data = new Float32Array(resolution * resolution * 2);
    for (let i = 0; i < resolution * resolution; i++) {
      data[i * 2] = 1.0;     // speed multiplier = 1 (no effect)
      data[i * 2 + 1] = 0.5; // direction bias = 0.5 (neutral, maps to 0°)
    }
    return {
      data,
      originX: bounds.min.x,
      originZ: bounds.min.y,
      extentX: width,
      extentZ: height,
      resolution,
    };
  }

  // 1. Build land mask
  const landMask = buildLandMask(resolution, bounds, coastlines);

  // 2. Build shore distance field
  const shoreDistance = buildShoreDistance(resolution, bounds, coastlines, landMask);

  // 3. Build elevation for lee shadow scaling
  const elevation = buildElevation(
    resolution, bounds, landMask, shoreDistance,
    relief, maxElevation, hashCombine(seed, 4217),
  );

  // 4. Compute raw effects
  const leeShadow = computeLeeShadow(
    resolution, bounds, landMask, elevation,
    referenceWindDirection, maxElevation,
  );

  const gapBoost = computeGapAcceleration(
    resolution, landMask, referenceWindDirection,
  );

  const shoreDeflection = computeShorelineBend(
    resolution, bounds, coastlines, shoreDistance, landMask,
    referenceWindDirection,
  );

  // 5. Compose speed field: lee shadow × gap boost
  const speedField = new Float32Array(resolution * resolution);
  for (let i = 0; i < speedField.length; i++) {
    const leeVal = leeShadow[i] ?? 1;
    const gapVal = gapBoost[i] ?? 1;
    speedField[i] = leeVal * gapVal;
  }

  // 6. Apply diffusion/advection to smooth both fields
  // Speed: 3 diffusion passes + 2 advection steps
  diffuse(speedField, resolution, landMask, 3, 1.0);
  advect(speedField, resolution, landMask, referenceWindDirection, 1.5, 1.0);
  diffuse(speedField, resolution, landMask, 2, 1.0);
  advect(speedField, resolution, landMask, referenceWindDirection, 1.0, 1.0);

  // Direction deflection: 2 diffusion passes + 1 advection step
  diffuse(shoreDeflection, resolution, landMask, 2, 0.0);
  advect(shoreDeflection, resolution, landMask, referenceWindDirection, 1.0, 0.0);
  diffuse(shoreDeflection, resolution, landMask, 1, 0.0);

  // 7. Add subtle noise variation to break grid regularity
  const noise = createNoiseSource2D(hashCombine(seed, 8831));
  const noiseScale = 1 / Math.max(width, height);

  for (let row = 0; row < resolution; row++) {
    for (let col = 0; col < resolution; col++) {
      const idx = row * resolution + col;
      if ((landMask[idx] ?? 0) === 1) continue;

      const px = bounds.min.x + (col + 0.5) * (width / resolution);
      const py = bounds.min.y + (row + 0.5) * (height / resolution);
      const n = noise.fbm(px * noiseScale * 8, py * noiseScale * 8, 2, 2.0, 0.5);

      // Subtle speed noise: ±3%
      const currentSpeed = speedField[idx] ?? 1;
      speedField[idx] = currentSpeed * (1 + n * 0.03);

      // Subtle direction noise: ±2°
      const currentDeflection = shoreDeflection[idx] ?? 0;
      shoreDeflection[idx] = currentDeflection + n * (2 * Math.PI / 180);
    }
  }

  // 8. Encode into interleaved RG format
  const data = new Float32Array(resolution * resolution * 2);
  const maxDeflection = Math.PI / 4;

  for (let i = 0; i < resolution * resolution; i++) {
    // R channel: speed multiplier, clamped to consumer's valid range
    let speed = speedField[i] ?? 1;
    speed = Math.max(0.15, Math.min(1.35, speed));
    data[i * 2] = speed;

    // G channel: direction bias encoded as 0..1
    // Consumer decodes: (g - 0.5) * 2 * π/4, so we encode: deflection / (2 * π/4) + 0.5
    let defl = shoreDeflection[i] ?? 0;
    defl = Math.max(-maxDeflection, Math.min(maxDeflection, defl));
    data[i * 2 + 1] = defl / (2 * maxDeflection) + 0.5;
  }

  return {
    data,
    originX: bounds.min.x,
    originZ: bounds.min.y,
    extentX: width,
    extentZ: height,
    resolution,
  };
}
