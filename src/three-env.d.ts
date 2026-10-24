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
    constructor(r: number, g: number, b: number);
    r: number;
    g: number;
    b: number;
    set(color: number | string): this;
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

  export class Quaternion {
    constructor(x?: number, y?: number, z?: number, w?: number);
    x: number;
    y: number;
    z: number;
    w: number;
    set(x: number, y: number, z: number, w: number): this;
    copy(q: Quaternion): this;
    slerpQuaternions(qa: Quaternion, qb: Quaternion, t: number): this;
  }

  export class Object3D {
    position: Vector3;
    rotation: Euler;
    quaternion: Quaternion;
    up: Vector3;
    visible: boolean;
    name: string;
    castShadow: boolean;
    receiveShadow: boolean;
    children: Object3D[];
    add(...objects: Object3D[]): this;
    removeFromParent(): this;
  }

  export class Group extends Object3D {}

  export class BufferAttribute {
    constructor(array: ArrayLike<number>, itemSize: number, normalized?: boolean);
    array: ArrayLike<number>;
    itemSize: number;
    needsUpdate: boolean;
  }

  export class Float32BufferAttribute extends BufferAttribute {
    constructor(array: ArrayLike<number> | number, itemSize: number, normalized?: boolean);
  }

  export class Uint32BufferAttribute extends BufferAttribute {
    constructor(array: ArrayLike<number> | number, itemSize: number, normalized?: boolean);
  }

  export class Scene extends Object3D {
    background: Color | null;
    environment: Texture | null;
    fog: Fog | null;
  }

  export class Fog {
    constructor(color: Color | number, near?: number, far?: number);
    color: Color;
    near: number;
    far: number;
  }

  export class Camera extends Object3D {}

  export class PerspectiveCamera extends Camera {
    constructor(fov?: number, aspect?: number, near?: number, far?: number);
    fov: number;
    aspect: number;
    near: number;
    far: number;
    updateProjectionMatrix(): void;
    lookAt(x: number, y: number, z: number): void;
  }

  export class Vector2 {
    constructor(x?: number, y?: number);
    x: number;
    y: number;
    set(x: number, y: number): this;
    width: number;
    height: number;
  }

  export class OrthographicCamera extends Camera {
    constructor(
      left?: number,
      right?: number,
      top?: number,
      bottom?: number,
      near?: number,
      far?: number,
    );
    left: number;
    right: number;
    top: number;
    bottom: number;
    near: number;
    far: number;
    updateProjectionMatrix(): void;
  }

  export class BufferGeometry {
    setAttribute(name: string, attribute: BufferAttribute): this;
    getAttribute(name: string): BufferAttribute;
    setIndex(index: BufferAttribute | number[]): this;
    dispose(): void;
  }

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

  export const AdditiveBlending: number;
  export const NormalBlending: number;
  export const FrontSide: number;
  export const BackSide: number;
  export const DoubleSide: number;

  export class Material {
    transparent: boolean;
    depthWrite: boolean;
    depthTest: boolean;
    blending: number;
    opacity: number;
    side: number;
    fog: boolean;
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
    opacityNode: ShaderNode | null;
  }

  export class PointsNodeMaterial extends Material {
    colorNode: ShaderNode | null;
    positionNode: ShaderNode | null;
    sizeNode: ShaderNode | null;
    opacityNode: ShaderNode | null;
    sizeAttenuation: boolean;
  }

  export class Points extends Object3D {
    constructor(geometry?: BufferGeometry, material?: Material);
    geometry: BufferGeometry;
    material: Material;
  }

  export class Texture {
    needsUpdate: boolean;
    dispose(): void;
  }

  export class DataTexture extends Texture {
    constructor(
      data?: Float32Array | Uint8Array | null,
      width?: number,
      height?: number,
    );
    readonly image: { data: Float32Array | Uint8Array; width: number; height: number };
  }

  export class Mesh extends Object3D {
    constructor(geometry?: BufferGeometry, material?: Material);
    geometry: BufferGeometry;
    material: Material;
  }

  export class Light extends Object3D {
    color: Color;
    intensity: number;
    dispose?(): void;
  }

  /** Directional-light shadow camera + map configuration (subset we use). */
  export interface LightShadow {
    camera?: OrthographicCamera;
    mapSize?: Vector2;
    radius: number;
    bias: number;
    /** World-space depth offset along the surface normal (acne on flat receivers). */
    normalBias: number;
  }

  export class DirectionalLight extends Light {
    constructor(color?: number, intensity?: number);
    castShadow: boolean;
    target: Object3D;
    shadow?: LightShadow;
  }

  export class AmbientLight extends Light {
    constructor(color?: number, intensity?: number);
  }

  export class PointLight extends Light {
    constructor(color?: number, intensity?: number, distance?: number, decay?: number);
    distance: number;
    decay: number;
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

  /** A render target whose colour attachment is exposed as a Texture. */
  export class RenderTarget {
    texture: Texture;
    dispose(): void;
  }

  /**
   * Prefiltered-mipmap radiance environment generator. `fromScene` renders the
   * given scene into a cube and prefilters it for image-based lighting.
   */
  export class PMREMGenerator {
    constructor(renderer: WebGPURenderer);
    fromScene(scene: Scene, sigma?: number, near?: number, far?: number): RenderTarget;
    compileCubemapShader(): void;
    compileEquirectangularShader(): void;
    dispose(): void;
  }

  /**
   * TSL post-processing driver. `outputNode` is the final node graph; `render`
   * executes it and applies the renderer's output transform (tone map + sRGB).
   */
  export class PostProcessing {
    constructor(renderer: WebGPURenderer);
    outputNode: unknown;
    render(): void;
    dispose(): void;
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
    // NOTE: there is deliberately NO `mix` method here. In three r0.180 the
    // chaining method `x.mix` is `mixElement(t, e1, e2)`, i.e. the RECEIVER is
    // the interpolation factor, so `a.mix(b, t)` silently computes mix(b, t, a).
    // Use the free function `mix(a, b, t)` instead; tsc then rejects the method.
    abs(): TSLNode;
    sign(): TSLNode;
    floor(): TSLNode;
    ceil(): TSLNode;
    fract(): TSLNode;
    clamp(min?: TSLNode | number, max?: TSLNode | number): TSLNode;
    length(): TSLNode;
    sin(): TSLNode;
    cos(): TSLNode;
    max(other: TSLNode | number): TSLNode;
    min(other: TSLNode | number): TSLNode;
    step(edge: TSLNode | number): TSLNode;
    smoothstep(edge0: TSLNode | number, edge1: TSLNode | number): TSLNode;
    oneMinus(): TSLNode;
    negate(): TSLNode;
    sqrt(): TSLNode;
    exp(): TSLNode;
    toVar(): TSLNode;
    mod(other: TSLNode | number): TSLNode;
    /** Comparisons → boolean node (used with select / If / Loop conditions). */
    greaterThan(other: TSLNode | number): TSLNode;
    greaterThanEqual(other: TSLNode | number): TSLNode;
    lessThan(other: TSLNode | number): TSLNode;
    lessThanEqual(other: TSLNode | number): TSLNode;
    equal(other: TSLNode | number): TSLNode;
    /** Boolean combinators on comparison nodes. */
    and(other: TSLNode): TSLNode;
    or(other: TSLNode): TSLNode;
    /** Branchless select: (condition).select(ifTrue, ifFalse). */
    select(ifTrue: TSLNode | number, ifFalse: TSLNode | number): TSLNode;
    /** In-place accumulation on a var node (from toVar()). */
    addAssign(other: TSLNode | number): TSLNode;
    assign(other: TSLNode | number): TSLNode;
    /** Component swizzles (read-only accessors). */
    readonly x: TSLNode;
    readonly y: TSLNode;
    readonly z: TSLNode;
    readonly w: TSLNode;
    /** vec2 swizzle of the first two components (e.g. velocity xy). */
    readonly xy: TSLNode;
    /** vec3 swizzle of the first three components (e.g. HDR colour rgb). */
    readonly xyz: TSLNode;
    /**
     * Texture-node markers/method. Present on TextureNode-family nodes (pass
     * texture nodes, RTT nodes from `convertToTexture`). Display effects such as
     * `motionBlur`/TRAA sample their input via `.sample(uv)`, which only exists
     * on these nodes — the fields let callers/tests assert an input is
     * texture-capable before handing it to such an effect.
     */
    readonly isTextureNode?: boolean;
    readonly isSampleNode?: boolean;
    sample?(uv: TSLNode): TSLNode;
  }

  /** A TSL function created via Fn(). Callable with TSLNode arguments. */
  interface TSLFn {
    (...args: (TSLNode | number)[]): TSLNode;
  }

  export function Fn(fn: (args: TSLNode[]) => TSLNode): TSLFn;
  /**
   * Generic Fn form: a builder whose body takes a positional argument tuple and
   * may return a TSLNode or nothing (void, e.g. a loop/accumulation subroutine).
   * Returns a callable taking the same tuple of node/number args.
   */
  export function Fn<A extends readonly (TSLNode | number)[], R extends TSLNode | void>(
    fn: (args: A) => R,
  ): (...args: A) => R;

  /** Loop control-flow node. Count form and range/condition object form. */
  export function Loop(
    count: TSLNode | number,
    body: (ctx: { i: TSLNode }) => void,
  ): TSLNode;
  export function Loop(
    params: {
      start?: TSLNode | number;
      end?: TSLNode | number;
      type?: string;
      condition?: string;
    },
    body: (ctx: { i: TSLNode }) => void,
  ): TSLNode;

  /** Conditional control-flow node: If(condition, body). */
  export function If(condition: TSLNode, body: () => void): TSLNode;
  /** Loop-control expressions. */
  export function Break(): TSLNode;
  export function Continue(): TSLNode;
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

  // Free-function forms of common operations.
  export function max(a: TSLNode | number, b: TSLNode | number): TSLNode;
  export function min(a: TSLNode | number, b: TSLNode | number): TSLNode;
  export function mix(a: TSLNode | number, b: TSLNode | number, t: TSLNode | number): TSLNode;
  export function step(edge: TSLNode | number, x: TSLNode | number): TSLNode;
  export function smoothstep(
    edge0: TSLNode | number,
    edge1: TSLNode | number,
    x: TSLNode | number,
  ): TSLNode;
  export function clamp(
    x: TSLNode | number,
    min: TSLNode | number,
    max: TSLNode | number,
  ): TSLNode;
  /** Per-vertex attribute accessor. */
  export function attribute(name: string, type?: string): TSLNode;

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

  /** Screen-space UV (0..1) built-in node. */
  export const screenUV: TSLNode;

  /** Material output colour node — the default MRT 'output' channel. */
  export const output: TSLNode;

  /**
   * Per-object screen-space velocity (motion vectors) node. Routed into a pass
   * MRT channel named 'velocity' to drive TRAA reprojection and motion blur.
   */
  export const velocity: TSLNode;

  /** Wrap any node as a sampleable texture node (used by TRAA/DoF internally). */
  export function convertToTexture(node: TSLNode): TSLNode;

  /** An MRT configuration node mapping output names → producing nodes. */
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface MRTNode extends TSLNode {}

  /**
   * Build a multiple-render-target node. The keys name the pass outputs (e.g.
   * `{ output, velocity }`); the values are the nodes producing each channel.
   */
  export function mrt(outputs: Record<string, TSLNode>): MRTNode;

  /** A scene render pass node, exposing colour/depth/velocity sub-nodes. */
  interface PassNode extends TSLNode {
    getTextureNode(name?: string): TSLNode;
    getPreviousTextureNode(name?: string): TSLNode;
    getViewZNode(name?: string): TSLNode;
    getLinearDepthNode(name?: string): TSLNode;
    getVelocityNode(): TSLNode;
    getDepthNode(): TSLNode;
    /** Configure MRT outputs for this pass; returns the pass for chaining. */
    setMRT(mrt: MRTNode): PassNode;
  }

  /** Render a scene+camera into a pass node for post-processing. */
  export function pass(scene: unknown, camera: unknown): PassNode;
}

// --- three/addons TSL display post-processing nodes (JS-only, untyped) ---

declare module 'three/addons/tsl/display/BloomNode.js' {
  import type { TSLNode } from 'three/tsl';
  export function bloom(
    node: TSLNode,
    strength?: number,
    radius?: number,
    threshold?: number,
  ): TSLNode;
  const _default: unknown;
  export default _default;
}

declare module 'three/addons/tsl/display/DepthOfFieldNode.js' {
  import type { TSLNode } from 'three/tsl';
  export function dof(
    node: TSLNode,
    viewZNode: TSLNode,
    focusDistance?: number | TSLNode,
    focalLength?: number | TSLNode,
    bokehScale?: number | TSLNode,
  ): TSLNode;
  const _default: unknown;
  export default _default;
}

declare module 'three/addons/tsl/display/TRAANode.js' {
  import type { TSLNode } from 'three/tsl';
  export function traa(
    beautyNode: TSLNode,
    depthNode: TSLNode,
    velocityNode: TSLNode,
    camera: unknown,
  ): TSLNode;
  const _default: unknown;
  export default _default;
}

declare module 'three/addons/tsl/display/MotionBlur.js' {
  import type { TSLNode } from 'three/tsl';
  export function motionBlur(
    inputNode: TSLNode,
    velocity: TSLNode,
    numSamples?: TSLNode | number,
  ): TSLNode;
}
