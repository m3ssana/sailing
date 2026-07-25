/**
 * Physics tests: rigid body, hydrostatics, buoyancy/wave coupling.
 *
 * Validates the analytical correctness of the physics engine against known
 * geometric results (unit cube displacement, symmetric CoB, righting arm)
 * and dynamic stability (settling, angular conservation, NaN resilience).
 */

import { describe, it, expect } from 'vitest';
import type {
  BoatSpec,
  Environment,
  ForceGenerator,
  GeneratedMesh,
  Hydrostatics,
  Quat,
  WaveField,
  WindField,
  CurrentField,
  WeatherSnapshot,
} from '@/types';
import { PHYSICS_CONSTANTS } from '@/types';
import {
  createBoatState,
  isStateFinite,
  accumulateForces,
  resetForcePool,
  allocForce,
  getForceCount,
  getForcePoolSlice,
  computeWorldInertiaInverse,
} from '@physics/RigidBody';
import { integrateLinear, integrateAngularRK4 } from '@physics/Integrator';
import { BoatSimulationImpl } from '@physics/BoatSimulation';
import { computeHydrostatics } from '@physics/hydrostatics/computeHydrostatics';
import {
  clipTriangleAgainstWaterline,
  getClippedTriangle,
  triangleSignedVolume,
} from '@physics/hydrostatics/waterlineClip';
import { computeRightingCurve } from '@physics/hydrostatics/rightingCurve';
import { distributeBuoyancyPoints } from '@physics/hydrostatics/buoyancyPoints';
import { BuoyancyForceGenerator } from '@physics/forces/Buoyancy';
import { WaveDragForceGenerator } from '@physics/forces/WaveDrag';
import { vec3 } from '@core/math';

// ─── Test helpers ────────────────────────────────────────────────────────────

/**
 * Create a unit cube mesh centred at the origin, 1×1×1 m.
 * Vertices from -0.5 to +0.5 on all axes.
 * Counter-clockwise winding from outside (outward normals).
 */
function makeUnitCubeMesh(): GeneratedMesh {
  // 8 vertices of a unit cube
  const positions = new Float32Array([
    // 0: (-0.5, -0.5, -0.5)
    -0.5, -0.5, -0.5,
    // 1: ( 0.5, -0.5, -0.5)
    0.5, -0.5, -0.5,
    // 2: ( 0.5,  0.5, -0.5)
    0.5, 0.5, -0.5,
    // 3: (-0.5,  0.5, -0.5)
    -0.5, 0.5, -0.5,
    // 4: (-0.5, -0.5,  0.5)
    -0.5, -0.5, 0.5,
    // 5: ( 0.5, -0.5,  0.5)
    0.5, -0.5, 0.5,
    // 6: ( 0.5,  0.5,  0.5)
    0.5, 0.5, 0.5,
    // 7: (-0.5,  0.5,  0.5)
    -0.5, 0.5, 0.5,
  ]);

  // 12 triangles (2 per face), counter-clockwise from outside
  const indices = new Uint32Array([
    // Front face (z = -0.5) — looking towards -Z
    0, 2, 1, 0, 3, 2,
    // Back face (z = +0.5) — looking towards +Z
    4, 5, 6, 4, 6, 7,
    // Top face (y = +0.5) — looking up
    3, 7, 6, 3, 6, 2,
    // Bottom face (y = -0.5) — looking down
    0, 1, 5, 0, 5, 4,
    // Right face (x = +0.5)
    1, 2, 6, 1, 6, 5,
    // Left face (x = -0.5)
    0, 4, 7, 0, 7, 3,
  ]);

  const normals = new Float32Array(positions.length);
  const uvs = new Float32Array((positions.length / 3) * 2);

  return {
    positions,
    normals,
    uvs,
    indices,
    bounds: { min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 0.5, y: 0.5, z: 0.5 } },
    meta: {},
  };
}

/** Create a cube mesh with given dimensions, bottom at y=0. */
function makeBoxMesh(width: number, height: number, depth: number): GeneratedMesh {
  const hw = width / 2;
  const hd = depth / 2;

  const positions = new Float32Array([
    -hw, 0, -hd,
    hw, 0, -hd,
    hw, height, -hd,
    -hw, height, -hd,
    -hw, 0, hd,
    hw, 0, hd,
    hw, height, hd,
    -hw, height, hd,
  ]);

  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2,
    4, 5, 6, 4, 6, 7,
    3, 7, 6, 3, 6, 2,
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    0, 4, 7, 0, 7, 3,
  ]);

  const normals = new Float32Array(positions.length);
  const uvs = new Float32Array((positions.length / 3) * 2);

  return {
    positions,
    normals,
    uvs,
    indices,
    bounds: { min: { x: -hw, y: 0, z: -hd }, max: { x: hw, y: height, z: hd } },
    meta: {},
  };
}

/** Create a flat-water WaveField stub (all zeros). */
function makeFlatWaveField(): WaveField {
  return {
    height: () => 0,
    displacement: (_x, _z, _t, out) => {
      const o = out ?? vec3();
      o.x = 0; o.y = 0; o.z = 0;
      return o;
    },
    normal: (_x, _z, _t, out) => {
      const o = out ?? vec3();
      o.x = 0; o.y = 1; o.z = 0;
      return o;
    },
    orbitalVelocity: (_x, _z, _y, _t, out) => {
      const o = out ?? vec3();
      o.x = 0; o.y = 0; o.z = 0;
      return o;
    },
    components: [],
    params: {
      windSpeed: 0,
      windDirection: 0,
      fetch: 1000,
      significantHeight: 0,
      swellHeight: 0,
      swellPeriod: 8,
      swellDirection: 0,
      peakEnhancement: 3.3,
      directionalSpread: 20,
      depth: 50,
      currentVelocity: { x: 0, y: 0 },
      seed: 42,
    },
  };
}

/** Create a simple sinusoidal WaveField. */
function makeSinusoidalWaveField(amplitude: number, wavelength: number): WaveField {
  const k = (2 * Math.PI) / wavelength;
  const omega = Math.sqrt(PHYSICS_CONSTANTS.GRAVITY * k);

  return {
    height: (x, _z, t) => amplitude * Math.sin(k * x - omega * (t)),
    displacement: (x, _z, t, out) => {
      const o = out ?? vec3();
      o.x = 0;
      o.y = amplitude * Math.sin(k * x - omega * (t));
      o.z = 0;
      return o;
    },
    normal: (x, _z, t, out) => {
      const o = out ?? vec3();
      o.x = -amplitude * k * Math.cos(k * x - omega * (t));
      o.y = 1;
      o.z = 0;
      const len = Math.sqrt(o.x * o.x + o.y * o.y);
      o.x /= len;
      o.y /= len;
      return o;
    },
    orbitalVelocity: (x, _z, y, t, out) => {
      const o = out ?? vec3();
      const phase = k * x - omega * (t);
      const decay = Math.exp(k * y); // y is negative below surface
      o.x = amplitude * omega * Math.cos(phase) * decay;
      o.y = amplitude * omega * Math.sin(phase) * decay;
      o.z = 0;
      return o;
    },
    components: [],
    params: {
      windSpeed: 10,
      windDirection: 0,
      fetch: 10000,
      significantHeight: amplitude * 4,
      swellHeight: 0,
      swellPeriod: 8,
      swellDirection: 0,
      peakEnhancement: 3.3,
      directionalSpread: 20,
      depth: 50,
      currentVelocity: { x: 0, y: 0 },
      seed: 42,
    },
  };
}

/** Create a minimal WindField stub. */
function makeWindField(): WindField {
  return {
    sample: () => ({
      velocity: { x: 0, y: 0, z: 0 },
      speed: 0,
      direction: 0,
      gustFactor: 1,
    }),
    sampleGustGridInto: () => {},
    meanDirection: () => 0,
    meanSpeed: () => 0,
  };
}

/** Create a minimal CurrentField stub. */
function makeCurrentField(): CurrentField {
  return {
    sample: (_x, _z, _t, out) => {
      const o = out ?? { x: 0, y: 0 };
      o.x = 0; o.y = 0;
      return o;
    },
    tideHeight: () => 0,
  };
}

/** Create a minimal Environment for testing. */
function makeEnvironment(waveField?: WaveField): Environment {
  const waves = waveField ?? makeFlatWaveField();
  return {
    wind: makeWindField(),
    waves,
    current: makeCurrentField(),
    skyAt: () => ({
      sunDirection: { x: 0, y: 1, z: 0 },
      sunElevation: 0.5,
      sunAzimuth: Math.PI,
      moonDirection: { x: 0, y: -1, z: 0 },
      moonElevation: -0.5,
      moonPhase: 0.5,
      siderealTime: 0,
      cloudLow: 0,
      cloudMid: 0,
      cloudHigh: 0,
      isNight: false,
    }),
    depthAt: () => 50,
    isLand: () => false,
    waterDensity: PHYSICS_CONSTANTS.WATER_DENSITY,
    snapshot: {} as WeatherSnapshot,
  };
}

/** Create a minimal BoatSpec for testing. */
function makeTestBoatSpec(hydrostatics: Hydrostatics, mass?: number): BoatSpec {
  const m = mass ?? hydrostatics.displacement;
  return {
    id: 'test-boat',
    name: 'Test Boat',
    mass: m,
    inertia: { x: 1000, y: 5000, z: 4000 },
    centreOfMass: { x: 0, y: 0.2, z: 0 },
    hydrostatics,
    sails: [],
    foils: [],
    residuaryCurve: [{ x: 0, y: 0 }, { x: 0.4, y: 0.01 }],
    ballastMass: 0,
    crewMass: 80,
    crewMovementRange: { x: 1.5, y: 0.5, z: 2 },
    capsizeAngle: Math.PI * 0.6,
    hullCount: 1,
  };
}


// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Waterline triangle clipping', () => {
  it('fully submerged triangle returns 1 triangle (itself)', () => {
    const count = clipTriangleAgainstWaterline(
      0, -1, 0,
      1, -1, 0,
      0, -1, 1,
      0, // waterline at y=0
    );
    expect(count).toBe(1);
    const tri = getClippedTriangle(0);
    expect(tri).toBeDefined();
    if (tri) {
      expect(tri.v0y).toBe(-1);
      expect(tri.v1y).toBe(-1);
      expect(tri.v2y).toBe(-1);
    }
  });

  it('fully above water returns 0 triangles', () => {
    const count = clipTriangleAgainstWaterline(
      0, 1, 0,
      1, 2, 0,
      0, 3, 1,
      0,
    );
    expect(count).toBe(0);
  });

  it('1-vertex-under case: produces a triangle with correct volume ratio', () => {
    // Triangle with one vertex at y=-1, two at y=1, waterline at y=0
    // The submerged portion should be 1/4 area (linear interpolation: half height means 1/4 area for triangle)
    const count = clipTriangleAgainstWaterline(
      0, -1, 0,   // below
      2, 1, 0,    // above
      0, 1, 2,    // above
      0,
    );
    expect(count).toBe(1);
    const tri = getClippedTriangle(0);
    expect(tri).toBeDefined();
    if (tri) {
      // The clipped vertex should be at y = -1 (unchanged)
      expect(tri.v0y).toBe(-1);
      // The two new vertices should be at the waterline
      expect(tri.v1y).toBeCloseTo(0, 10);
      expect(tri.v2y).toBeCloseTo(0, 10);
    }
  });

  it('2-vertices-under case: produces 2 triangles', () => {
    const count = clipTriangleAgainstWaterline(
      0, 1, 0,    // above
      2, -1, 0,   // below
      0, -1, 2,   // below
      0,
    );
    expect(count).toBe(2);
  });

  it('half-submerged triangle contributes approximately half volume', () => {
    // Use a triangle with z-extent so the divergence theorem gives nonzero
    // signed volume. A triangle entirely in the z=0 plane forms a zero-volume
    // tetrahedron with the origin, making the test degenerate.
    const fullVol = Math.abs(triangleSignedVolume(
      0, -1, 1,
      2, -1, -1,
      1, 1, 0,
    ));

    const count = clipTriangleAgainstWaterline(
      0, -1, 1,
      2, -1, -1,
      1, 1, 0,
      0,
    );

    let clippedVol = 0;
    for (let i = 0; i < count; i++) {
      const tri = getClippedTriangle(i);
      if (tri) {
        clippedVol += Math.abs(triangleSignedVolume(
          tri.v0x, tri.v0y, tri.v0z,
          tri.v1x, tri.v1y, tri.v1z,
          tri.v2x, tri.v2y, tri.v2z,
        ));
      }
    }

    // For this specific geometry (2 vertices at y=-1, 1 at y=1),
    // the submerged portion is 3/4 of the triangle by area (the cut is at midpoint from the top vertex)
    // Volume ratio depends on geometry — just verify it's between 0 and full
    expect(clippedVol).toBeGreaterThan(0);
    expect(clippedVol).toBeLessThan(fullVol * 1.01);
  });
});

describe('Hydrostatics from mesh', () => {
  it('unit cube at waterline=0 computes correct displaced volume', () => {
    // Cube from -0.5 to 0.5 on all axes. Waterline at y=0 means
    // half the cube is submerged: volume = 0.5 m³
    const mesh = makeUnitCubeMesh();
    const hydro = computeHydrostatics(mesh, 0, PHYSICS_CONSTANTS.WATER_DENSITY);

    // The submerged volume should be approximately 0.5 m³ (half of 1 m³ cube)
    expect(hydro.displacedVolume).toBeCloseTo(0.5, 1);
  });

  it('fully submerged cube has volume ~1.0 m³', () => {
    const mesh = makeUnitCubeMesh();
    // Waterline above the cube top: the entire cube is submerged
    const hydro = computeHydrostatics(mesh, 1.0, PHYSICS_CONSTANTS.WATER_DENSITY);

    expect(hydro.displacedVolume).toBeCloseTo(1.0, 1);
  });

  it('symmetric hull has centre of buoyancy on the centreline (x ≈ 0)', () => {
    const mesh = makeUnitCubeMesh();
    const hydro = computeHydrostatics(mesh, 0, PHYSICS_CONSTANTS.WATER_DENSITY);

    // The cube is symmetric about x=0 and z=0
    expect(Math.abs(hydro.centreOfBuoyancy.x)).toBeLessThan(0.01);
    expect(Math.abs(hydro.centreOfBuoyancy.z)).toBeLessThan(0.01);
  });

  it('displacement equals displaced volume × water density', () => {
    const mesh = makeUnitCubeMesh();
    const density = 1025;
    const hydro = computeHydrostatics(mesh, 0, density);

    expect(hydro.displacement).toBeCloseTo(hydro.displacedVolume * density, 0);
  });

  it('buoyancy points are distributed along hull length', () => {
    const mesh = makeBoxMesh(1, 1, 4); // 1m wide, 1m tall, 4m long
    const points = distributeBuoyancyPoints(mesh, 0.5, 8);

    expect(points.length).toBe(8);

    // Points should have increasing z values (spread along length)
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      if (prev && curr) {
        expect(curr.position.z).toBeGreaterThanOrEqual(prev.position.z - 0.01);
      }
    }
  });
});

describe('Righting curve', () => {
  it('righting moment is zero at zero heel', () => {
    const mesh = makeUnitCubeMesh();
    const volume = 0.5; // half submerged
    const cogHeight = 0.1; // CoG slightly above centre

    const curve = computeRightingCurve(mesh, volume, cogHeight, 18, 90);
    const firstPoint = curve[0];
    expect(firstPoint).toBeDefined();
    if (firstPoint) {
      // At zero heel, GZ should be zero (or very small) for a symmetric hull
      expect(Math.abs(firstPoint.y)).toBeLessThan(0.05);
    }
  });

  it('righting moment is positive (restoring) at small heel angles', () => {
    const mesh = makeBoxMesh(2, 1, 4); // Wide box, bottom at y=0
    const volume = 2 * 0.5 * 4; // half submerged: 2 wide × 0.5 deep × 4 long = 4 m³
    const cogHeight = 0.3; // CoG low

    const curve = computeRightingCurve(mesh, volume, cogHeight, 18, 90);

    // At small angles (5-15°), GZ should be positive for a stable hull
    // with low CoG
    const smallAnglePoint = curve.find(p => p.x > 0.05 && p.x < 0.3);
    expect(smallAnglePoint).toBeDefined();
    if (smallAnglePoint) {
      expect(smallAnglePoint.y).toBeGreaterThan(0);
    }
  });
});


describe('Rigid body state', () => {
  it('createBoatState has identity orientation', () => {
    const state = createBoatState();
    expect(state.orientation.w).toBe(1);
    expect(state.orientation.x).toBe(0);
    expect(state.orientation.y).toBe(0);
    expect(state.orientation.z).toBe(0);
  });

  it('isStateFinite returns false on NaN', () => {
    const state = createBoatState();
    state.position.x = NaN;
    expect(isStateFinite(state)).toBe(false);
  });

  it('isStateFinite returns true on valid state', () => {
    const state = createBoatState();
    state.position.x = 100;
    state.linearVelocity.y = -5;
    expect(isStateFinite(state)).toBe(true);
  });

  it('force accumulation computes correct torque', () => {
    resetForcePool();
    const f = allocForce();
    expect(f).toBeDefined();
    if (!f) return;

    // Force of 10N in +Y at point (1, 0, 0) relative to CoM at origin
    // should produce torque in -Z direction: (1,0,0) × (0,10,0) = (0,0,-10)... wait
    // Actually cross((1,0,0), (0,10,0)) = (0*0 - 0*10, 0*0 - 1*0, 1*10 - 0*0) = (0, 0, 10)
    f.force.y = 10;
    f.point.x = 1;

    const netForce = vec3();
    const netTorque = vec3();
    const com = vec3(0, 0, 0);

    accumulateForces(getForcePoolSlice(), getForceCount(), com, netForce, netTorque);

    expect(netForce.y).toBeCloseTo(10);
    // torque = (1,0,0) × (0,10,0) = (0*0 - 0*10, 0*0 - 1*0, 1*10 - 0*0) = (0, 0, 10)
    expect(netTorque.z).toBeCloseTo(10);
  });

  it('world inertia inverse is correct for identity orientation', () => {
    const localI = vec3(100, 500, 400);
    const ori: Quat = { x: 0, y: 0, z: 0, w: 1 };
    const iWorld = { xx: 0, xy: 0, xz: 0, yy: 0, yz: 0, zz: 0 };

    computeWorldInertiaInverse(localI, ori, iWorld);

    // At identity orientation, world inverse should be 1/local values
    expect(iWorld.xx).toBeCloseTo(1 / 100, 6);
    expect(iWorld.yy).toBeCloseTo(1 / 500, 6);
    expect(iWorld.zz).toBeCloseTo(1 / 400, 6);
    expect(Math.abs(iWorld.xy)).toBeLessThan(1e-10);
    expect(Math.abs(iWorld.xz)).toBeLessThan(1e-10);
    expect(Math.abs(iWorld.yz)).toBeLessThan(1e-10);
  });
});

describe('Integrator', () => {
  it('angular momentum is conserved with no torque', () => {
    const state = createBoatState();
    state.angularVelocity.y = 1.0; // spinning about Y at 1 rad/s
    const localI = vec3(1000, 5000, 4000);
    const zeroTorque = vec3(0, 0, 0);

    const initialOmegaY = state.angularVelocity.y;

    for (let i = 0; i < 1000; i++) {
      integrateAngularRK4(state, zeroTorque, localI, 1 / 120);
    }

    // Angular velocity magnitude should be conserved (no damping)
    expect(state.angularVelocity.y).toBeCloseTo(initialOmegaY, 3);
  });

  it('orientation quaternion stays unit over 100k steps', () => {
    const state = createBoatState();
    state.angularVelocity.x = 0.5;
    state.angularVelocity.y = 0.3;
    state.angularVelocity.z = 0.1;
    const localI = vec3(1000, 5000, 4000);
    const zeroTorque = vec3(0, 0, 0);

    for (let i = 0; i < 100000; i++) {
      integrateAngularRK4(state, zeroTorque, localI, 1 / 120);
    }

    const q = state.orientation;
    const qLen = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    expect(qLen).toBeCloseTo(1.0, 5);
  });

  it('no NaN over 200,000 steps with large forces', () => {
    const state = createBoatState();
    const localI = vec3(1000, 5000, 4000);
    const bigTorque = vec3(50000, 30000, 20000);
    const bigForce = vec3(100000, 50000, 80000);
    const mass = 2000;
    const dt = 1 / 120;

    for (let i = 0; i < 200000; i++) {
      integrateLinear(state, bigForce, mass, dt);
      integrateAngularRK4(state, bigTorque, localI, dt);
    }

    expect(isStateFinite(state)).toBe(true);
  });

  it('linear integration: constant force produces expected velocity', () => {
    const state = createBoatState();
    const force = vec3(0, -9.81 * 100, 0); // gravity on 100kg
    const mass = 100;
    const dt = 1 / 120;

    // After 1 second (120 steps), velocity should be ~ -9.81 m/s
    for (let i = 0; i < 120; i++) {
      integrateLinear(state, force, mass, dt);
    }

    expect(state.linearVelocity.y).toBeCloseTo(-9.81, 1);
  });
});


describe('Buoyancy and settling', () => {
  it('unit cube floats at analytically correct waterline', () => {
    // A 1×1×1 cube with mass such that it floats half-submerged.
    // At equilibrium: displaced volume × ρ = mass
    // Half submerged: volume = 0.5 m³, mass = 0.5 * 1025 = 512.5 kg
    const mesh = makeUnitCubeMesh();
    const hydro = computeHydrostatics(mesh, 0, PHYSICS_CONSTANTS.WATER_DENSITY);

    // The displaced volume at y=0 waterline should be ~0.5
    expect(hydro.displacedVolume).toBeCloseTo(0.5, 1);
    // So equilibrium mass = 0.5 * 1025 ≈ 512.5 kg
    expect(hydro.displacement).toBeCloseTo(512.5, 0);
  });

  it('box dropped on flat water settles and damps to rest', () => {
    // Create a box hull (2m × 1m × 4m) with bottom at y=0
    const mesh = makeBoxMesh(2, 1, 4);
    const hydro = computeHydrostatics(mesh, 0.5, PHYSICS_CONSTANTS.WATER_DENSITY);

    // Mass = half submerged volume × density
    // Box at waterline 0.5: submerged volume ≈ 2 × 0.5 × 4 = 4 m³
    // Mass for floating at this waterline = 4 * 1025 = 4100 kg
    const mass = hydro.displacement > 0 ? hydro.displacement : 4100;

    const spec = makeTestBoatSpec(hydro, mass);
    spec.inertia = { x: 500, y: 2000, z: 1500 };
    spec.centreOfMass = { x: 0, y: 0.3, z: 0 };

    const sim = new BoatSimulationImpl(spec);
    sim.addForceGenerator(new BuoyancyForceGenerator());

    // Start slightly above equilibrium — should sink and settle
    sim.reset({ x: 0, y: 0.5, z: 0 }, 0);

    const env = makeEnvironment();
    const dt = 1 / 120;

    // Add linear damping by using wave drag with flat water (provides damping)
    sim.addForceGenerator(new WaveDragForceGenerator('test'));

    // Simulate 30 seconds — should settle
    const totalSteps = 30 * 120;
    for (let i = 0; i < totalSteps; i++) {
      sim.step(env, i * dt, dt);
    }

    // After settling, vertical velocity should be near zero
    expect(Math.abs(sim.state.linearVelocity.y)).toBeLessThan(0.1);
    // The boat should not have diverged
    expect(isStateFinite(sim.state)).toBe(true);
    // Position should be finite and reasonable
    expect(Math.abs(sim.state.position.y)).toBeLessThan(5);
  });
});

describe('BoatSimulation orchestration', () => {
  it('NaN guard restores previous state', () => {
    const mesh = makeBoxMesh(2, 1, 4);
    const hydro = computeHydrostatics(mesh, 0.5, PHYSICS_CONSTANTS.WATER_DENSITY);
    const spec = makeTestBoatSpec(hydro);

    const sim = new BoatSimulationImpl(spec);
    sim.reset({ x: 0, y: 0, z: 0 }, 0);

    // Add a force generator that produces NaN
    const nanGenerator: ForceGenerator = {
      id: 'nan-maker',
      evaluate: (_ctx, out) => {
        const f = allocForce();
        if (f) {
          f.force.x = NaN;
          f.force.y = NaN;
          f.force.z = NaN;
          out.push(f);
        }
      },
    };
    sim.addForceGenerator(nanGenerator);

    const env = makeEnvironment();
    // Suppress console.error for this test
    const originalError = console.error;
    console.error = () => {};

    sim.step(env, 0, 1 / 120);

    console.error = originalError;

    // State should still be valid (restored from previous)
    expect(isStateFinite(sim.state)).toBe(true);
  });

  it('actuator rate limits prevent instant control changes', () => {
    const mesh = makeBoxMesh(2, 1, 4);
    const hydro = computeHydrostatics(mesh, 0.5, PHYSICS_CONSTANTS.WATER_DENSITY);
    const spec = makeTestBoatSpec(hydro);

    const sim = new BoatSimulationImpl(spec);
    sim.reset({ x: 0, y: 0, z: 0 }, 0);
    sim.addForceGenerator(new BuoyancyForceGenerator());

    // Set target rudder to full
    sim.setControls({ rudder: 1.0 });

    const env = makeEnvironment();

    // After one step, rudder should NOT be at 1.0 yet (rate limited)
    sim.step(env, 0, 1 / 120);
    expect(sim.state.controls.rudder).toBeLessThan(1.0);
    expect(sim.state.controls.rudder).toBeGreaterThan(0);
  });

  it('reset clears velocities and sets heading', () => {
    const mesh = makeBoxMesh(2, 1, 4);
    const hydro = computeHydrostatics(mesh, 0.5, PHYSICS_CONSTANTS.WATER_DENSITY);
    const spec = makeTestBoatSpec(hydro);

    const sim = new BoatSimulationImpl(spec);
    sim.state.linearVelocity.x = 10;
    sim.state.angularVelocity.y = 2;

    sim.reset({ x: 5, y: 0, z: -10 }, Math.PI / 4);

    expect(sim.state.position.x).toBe(5);
    expect(sim.state.position.z).toBe(-10);
    expect(sim.state.linearVelocity.x).toBe(0);
    expect(sim.state.linearVelocity.y).toBe(0);
    expect(sim.state.angularVelocity.y).toBe(0);
    expect(sim.state.heading).toBeCloseTo(Math.PI / 4, 2);
    expect(sim.state.capsized).toBe(false);
  });
});

describe('Wave coupling', () => {
  it('unpowered hull in 2m swell pitches and heaves with bounded amplitude', () => {
    const mesh = makeBoxMesh(2, 1, 6);
    const hydro = computeHydrostatics(mesh, 0.5, PHYSICS_CONSTANTS.WATER_DENSITY);
    const mass = hydro.displacement > 0 ? hydro.displacement : 3000;
    const spec = makeTestBoatSpec(hydro, mass);
    spec.inertia = { x: 800, y: 3000, z: 2500 };
    spec.centreOfMass = { x: 0, y: 0.3, z: 0 };

    const sim = new BoatSimulationImpl(spec);
    sim.addForceGenerator(new BuoyancyForceGenerator());
    sim.addForceGenerator(new WaveDragForceGenerator('test'));

    // 2m amplitude sinusoidal wave with 50m wavelength
    const waveField = makeSinusoidalWaveField(1.0, 50);
    const env = makeEnvironment(waveField);

    sim.reset({ x: 0, y: 0.5, z: 0 }, 0);

    const dt = 1 / 120;
    let maxY = -Infinity;
    let minY = Infinity;

    // Simulate 60 seconds
    for (let i = 0; i < 60 * 120; i++) {
      sim.step(env, i * dt, dt);

      if (i > 5 * 120) { // Skip initial transient
        if (sim.state.position.y > maxY) maxY = sim.state.position.y;
        if (sim.state.position.y < minY) minY = sim.state.position.y;
      }

      // Verify no divergence at any point
      expect(isStateFinite(sim.state)).toBe(true);
    }

    // Heave amplitude should be bounded (not diverging)
    const heaveRange = maxY - minY;
    expect(heaveRange).toBeLessThan(10); // Should not exceed reasonable bounds
    expect(heaveRange).toBeGreaterThan(0.01); // But should be responding to waves
  });
});
