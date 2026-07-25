/**
 * Current field: tidal current + base ocean current from the marine API,
 * modulated by venue spatial patterns.
 *
 * The spatial modulation uses a simple continuity/venturi approximation:
 * current accelerates in narrow channels (where depth is shallower on the
 * sides) and decays in wide bays and shallow water. This produces the
 * venue-characteristic current patterns that make local knowledge valuable.
 */

import type { CurrentField, Metres, SessionTime, Vec2 } from '@/types';
import type { TideProfile, WeatherService } from '@/types';
import { createTideModel } from './TideModel';
import type { TideModel } from './TideModel';
import { clamp } from '@core/math';

export interface CurrentFieldConfig {
  weatherService: WeatherService;
  tideProfile: TideProfile;
  /**
   * Depth field sampler for venturi modulation.
   * If not provided, uniform depth is assumed.
   */
  depthAt?: (x: number, z: number) => Metres;
  /** Reference depth for the venue (m). Currents at this depth are unmodified. */
  referenceDepth?: number;
  /** Session start epoch ms for tide phase alignment. */
  sessionStartEpochMs: number;
}

export function createCurrentField(config: CurrentFieldConfig): CurrentField & { tideModel: TideModel } {
  const { weatherService, tideProfile, sessionStartEpochMs } = config;
  const depthAt = config.depthAt;
  const referenceDepth = config.referenceDepth ?? 20;

  const snapshot = weatherService.snapshot;
  const baseCurrentSpeed = snapshot.current.speed;
  const baseCurrentDir = snapshot.current.direction; // Direction TOWARDS.

  // Current flows TOWARDS baseCurrentDir: (sin dir, 0, -cos dir) in world,
  // but CurrentField.sample returns Vec2 on the ground plane (x=east, y=south).
  // For Vec2 ground plane: bearing θ → (sin θ, cos θ) where y is south.
  // Wait — Vec2 in the type system: x=east, y=south (per world-space convention).
  // A bearing θ in world 3D is (sinθ, 0, -cosθ). On the (x, z) ground plane
  // that's (sinθ, -cosθ) with z=south... but Vec2.y corresponds to z (south).
  // So Vec2 bearing θ = (sinθ, cosθ)? No — in Vec2, y is the second component.
  // Let's look at Vec2 definition: "x = east, y = south when used as ground plane".
  // So bearing θ on ground plane Vec2: x = sin θ (east), y = -(-cos θ) = cos θ... 
  // Actually +Z is south in 3D. If Vec2 y = south, then bearing θ gives:
  //   x = sin θ (east component)
  //   y = cos θ... no. Bearing 0 = north = (0, 0, -1) in 3D = no east, towards north.
  //   But y = south means y pointing south... bearing 0 (north) → movement north → y negative? 
  // Wait: "y = south when used as a ground plane" means positive y is south direction.
  //   bearing 0 = north → goes north → x=0, y=-1 (negative y = north).
  //   bearing 90 = east → x=1, y=0.
  //   bearing 180 = south → x=0, y=1.
  // So Vec2 from bearing θ: x = sin θ, y = cos θ... no.
  //   bearing 0: (sin0, cos0) = (0, 1) which is south. Wrong.
  // Let me re-derive. In 3D: bearing θ → (sinθ, 0, -cosθ). Z axis is south (positive Z = south).
  // Vec2 ground plane maps 3D (x, z) → Vec2 (x, y) where Vec2.y = z = south.
  // So bearing θ → Vec2(sinθ, -cosθ). 
  //   bearing 0: (0, -1) → points north (negative south). ✓
  //   bearing 90: (1, 0) → points east. ✓
  //   bearing 180: (0, 1) → points south. ✓
  // Perfect. Vec2 from bearing: (sinθ, -cosθ).
  // BUT wait: current direction is "TOWARDS", so the velocity points towards that bearing.
  const baseDirX = Math.sin(baseCurrentDir);
  const baseDirY = -Math.cos(baseCurrentDir);
  const baseVelX = baseDirX * baseCurrentSpeed;
  const baseVelY = baseDirY * baseCurrentSpeed;

  const tideModel = createTideModel({
    profile: tideProfile,
    baseTideHeight: snapshot.sea.tideHeight,
    utcOffsetSeconds: snapshot.localTime.utcOffsetSeconds,
    sessionStartEpochMs,
  });

  // Per-instance scratch Vec2 for hot-path reuse — avoids module-scope aliasing
  // when multiple CurrentField instances coexist (e.g. tests, multi-venue).
  const _out: Vec2 = { x: 0, y: 0 };

  function sample(x: number, z: number, t: SessionTime, out?: Vec2): Vec2 {
    const target = out ?? _out;

    // Tidal current (already a Vec2 in the same convention).
    const tideCurrent = tideModel.currentVelocity(t);

    // Sum base ocean current + tidal current.
    let vx = baseVelX + tideCurrent.x;
    let vy = baseVelY + tideCurrent.y;

    // Venturi/depth modulation: current accelerates where depth decreases
    // (continuity: same flux through narrower cross-section).
    if (depthAt !== undefined) {
      const depth = depthAt(x, z);
      if (depth > 0) {
        // Speed up inversely with sqrt(depth/refDepth) — a gentler approximation
        // than full continuity (which would be linear) to avoid extreme values.
        const depthFactor = Math.sqrt(referenceDepth / Math.max(depth, 1));
        const modulation = clamp(depthFactor, 0.3, 2.5);
        vx *= modulation;
        vy *= modulation;
      } else {
        // On land or at zero depth: no current.
        vx = 0;
        vy = 0;
      }
    }

    target.x = vx;
    target.y = vy;
    return target;
  }

  function tideHeight(t: SessionTime): Metres {
    return tideModel.height(t);
  }

  return { sample, tideHeight, tideModel };
}
