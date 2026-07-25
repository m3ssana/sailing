/**
 * Ambient type declarations for three.js 0.180 WebGPU and TSL entry points.
 *
 * Three.js 0.180 ships 'three/webgpu' and 'three/tsl' as JavaScript-only
 * bundles without .d.ts files. These declarations provide enough type coverage
 * for our usage without trying to replicate the full three.js type surface.
 *
 * The three/webgpu module re-exports everything from 'three' plus the WebGPU-
 * specific renderer and node material classes.
 */

// --- WebGPU global types (subset needed for our device-loss and capabilities code) ---

declare interface GPUAdapterInfo {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}

declare interface GPUDeviceLostInfo {
  reason: 'unknown' | 'destroyed';
  message: string;
}

declare interface GPUDevice {
  lost: Promise<GPUDeviceLostInfo>;
  destroy(): void;
}

declare interface GPUAdapter {
  info?: GPUAdapterInfo;
  requestDevice(): Promise<GPUDevice>;
}

declare interface GPU {
  requestAdapter(): Promise<GPUAdapter | null>;
}

declare interface NavigatorGPU {
  gpu?: GPU;
}

// Augment the Navigator interface to include the gpu property.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface Navigator extends NavigatorGPU {}

// --- three/webgpu ---

declare module 'three/webgpu' {
  // Re-export the core three.js namespace. Since three.js 0.180 doesn't ship
  // its own types either, we declare the minimal surface we actually use.

  export const ACESFilmicToneMapping: number;
  export const SRGBColorSpace: string;

  export class Color {
    constructor(color?: number | string);
    r: number;
    g: number;
    b: number;
  }

  export class Vector3 {
    constructor(x?: number, y?: number, z?: number);
    x: number;
    y: number;
    z: number;
    set(x: number, y: number, z: number): this;
  }

  export class Euler {
    constructor(x?: number, y?: number, z?: number, order?: string);
    x: number;
    y: number;
    z: number;
  }

  export class Object3D {
    position: Vector3;
    rotation: Euler;
    add(...objects: Object3D[]): this;
  }

  export class Scene extends Object3D {
    background: Color | null;
  }

  export class Camera extends Object3D {}

  export class PerspectiveCamera extends Camera {
    constructor(fov?: number, aspect?: number, near?: number, far?: number);
    aspect: number;
    updateProjectionMatrix(): void;
    lookAt(x: number, y: number, z: number): void;
  }

  export class BufferGeometry {}

  export class PlaneGeometry extends BufferGeometry {
    constructor(width?: number, height?: number, widthSegments?: number, heightSegments?: number);
  }

  export class SphereGeometry extends BufferGeometry {
    constructor(
      radius?: number,
      widthSegments?: number,
      heightSegments?: number,
      phiStart?: number,
      phiLength?: number,
      thetaStart?: number,
      thetaLength?: number,
    );
  }

  export class Material {
    dispose(): void;
  }

  // TSL Node types — opaque handles
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ShaderNode {}

  export class MeshStandardNodeMaterial extends Material {
    colorNode: ShaderNode | null;
    roughnessNode: ShaderNode | null;
    metalnessNode: ShaderNode | null;
    emissiveNode: ShaderNode | null;
    normalNode: ShaderNode | null;
    positionNode: ShaderNode | null;
  }

  export class MeshPhysicalNodeMaterial extends MeshStandardNodeMaterial {
    clearcoatNode: ShaderNode | null;
    transmissionNode: ShaderNode | null;
  }

  export class MeshBasicNodeMaterial extends Material {
    colorNode: ShaderNode | null;
  }

  export class PointsNodeMaterial extends Material {
    colorNode: ShaderNode | null;
    positionNode: ShaderNode | null;
    sizeNode: ShaderNode | null;
  }

  export class Mesh extends Object3D {
    constructor(geometry?: BufferGeometry, material?: Material);
  }

  export class Light extends Object3D {}

  export class DirectionalLight extends Light {
    constructor(color?: number, intensity?: number);
  }

  export class AmbientLight extends Light {
    constructor(color?: number, intensity?: number);
  }

  interface WebGPURendererBackend {
    isWebGPUBackend?: boolean;
    device?: GPUDevice;
    adapter?: GPUAdapter;
  }

  interface WebGPURenderInfo {
    render?: {
      calls?: number;
      triangles?: number;
    };
  }

  export interface WebGPURendererParameters {
    canvas?: HTMLCanvasElement;
    antialias?: boolean;
    forceWebGL?: boolean;
  }

  export class WebGPURenderer {
    constructor(parameters?: WebGPURendererParameters);
    init(): Promise<void>;
    render(scene: Scene, camera: Camera): void;
    setSize(width: number, height: number): void;
    setPixelRatio(ratio: number): void;
    dispose(): void;
    compute(node: unknown): void;
    toneMapping: number;
    toneMappingExposure: number;
    outputColorSpace: string;
    backend: WebGPURendererBackend;
    info: WebGPURenderInfo;
    domElement: HTMLCanvasElement;
    properties: unknown;
  }
}

// --- three/tsl ---

declare module 'three/tsl' {
  /** Opaque TSL node type. Nodes compose via method calls. */
  interface TSLNode {
    add(other: TSLNode | number): TSLNode;
    sub(other: TSLNode | number): TSLNode;
    mul(other: TSLNode | number): TSLNode;
    div(other: TSLNode | number): TSLNode;
    dot(other: TSLNode): TSLNode;
    cross(other: TSLNode): TSLNode;
    normalize(): TSLNode;
    saturate(): TSLNode;
    pow(exponent: number | TSLNode): TSLNode;
    mix(other: TSLNode, factor: TSLNode | number): TSLNode;
    abs(): TSLNode;
    sign(): TSLNode;
    floor(): TSLNode;
    ceil(): TSLNode;
    fract(): TSLNode;
    clamp(min?: TSLNode | number, max?: TSLNode | number): TSLNode;
    length(): TSLNode;
    sin(): TSLNode;
    cos(): TSLNode;
  }

  export function Fn(fn: () => TSLNode): () => TSLNode;
  export function float(value: number): TSLNode;
  export function vec2(x: number | TSLNode, y?: number | TSLNode): TSLNode;
  export function vec3(x: number | TSLNode, y?: number | TSLNode, z?: number | TSLNode): TSLNode;
  export function vec4(
    x: number | TSLNode,
    y?: number | TSLNode,
    z?: number | TSLNode,
    w?: number | TSLNode,
  ): TSLNode;
  export function color(hex: number): TSLNode;
  export function uniform(value: number | object): TSLNode & { value: unknown };

  // Built-in nodes
  export const time: TSLNode;
  export const normalWorld: TSLNode;
  export const normalLocal: TSLNode;
  export const positionWorld: TSLNode;
  export const positionLocal: TSLNode;
  export const cameraPosition: TSLNode;

  export function oscSine(node: TSLNode): TSLNode;
  export function instancedArray(count: number, type?: string): TSLNode;
  export const instanceIndex: TSLNode;
}
