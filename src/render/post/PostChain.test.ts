/**
 * Tests for postChainConfig (pure, exhaustive) and createPostChain build/dispose
 * under vitest/node (no GPU — construction must not throw, like the ocean/night
 * render tests).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three/webgpu';
import {
  postChainConfig,
  postChainStages,
  createPostChain,
  buildPostOutputNode,
  LENS_DROPLET_EPSILON,
  type PostChainConfig,
  type PostStage,
} from './PostChain';
import { createGradeUniforms, gradeNode, NEUTRAL_GRADE, applyColorGrade } from './ColorGrade';
import { pass, uniform, screenUV } from 'three/tsl';
import type { QualityKnobs, RenderBackend } from '@/types';
import type { ColorGradeParams } from '@/types';

function baseKnobs(overrides: Partial<QualityKnobs> = {}): QualityKnobs {
  return {
    renderScale: 1,
    oceanCascades: 3,
    oceanResolution: 256,
    oceanGridRings: 6,
    reflectionScale: 1,
    reflectionCadence: 1,
    shadowCascades: 3,
    cloudMarchSteps: 16,
    sprayBudget: 1000,
    ambientBudget: 12,
    taa: false,
    motionBlur: false,
    depthOfField: false,
    bloom: false,
    ...overrides,
  };
}

const BACKENDS: RenderBackend[] = ['webgpu', 'webgl2'];

describe('postChainConfig — knob/pass one-to-one mapping', () => {
  it('each boolean knob toggles exactly its pass, nothing it disables is active', () => {
    for (const backend of BACKENDS) {
      for (const taa of [false, true]) {
        for (const motionBlur of [false, true]) {
          for (const depthOfField of [false, true]) {
            for (const bloom of [false, true]) {
              const knobs = baseKnobs({ taa, motionBlur, depthOfField, bloom });
              // DoF also needs the cinematic camera; test both.
              for (const cinematicCamera of [false, true]) {
                const cfg = postChainConfig(knobs, backend, { cinematicCamera });
                // TAA is WebGPU-only: r0.180 TRAANode's per-frame
                // copyTextureToTexture throws on the WebGL2 backend (see
                // PostChain.ts). So on webgl2 the knob is forced off.
                const expectedTaa = taa && backend !== 'webgl2';
                expect(cfg.taa.active).toBe(expectedTaa);
                expect(cfg.bloom.active).toBe(bloom);
                expect(cfg.motionBlur.active).toBe(motionBlur);
                expect(cfg.dof.active).toBe(depthOfField && cinematicCamera);
                // Grade is always on (carries the venue palette grade).
                expect(cfg.grade.active).toBe(true);
              }
            }
          }
        }
      }
    }
  });

  it('TAA is force-disabled on the webgl2 backend but honoured on webgpu', () => {
    // Documented honest reduction: three r0.180 TRAANode cannot resolve on the
    // WebGL2 fallback (copyTextureToTexture → "Invalid value used as weak map
    // key" every frame). Motion blur / bloom / DoF are unaffected by backend.
    const knobs = baseKnobs({ taa: true, motionBlur: true, bloom: true });
    expect(postChainConfig(knobs, 'webgpu').taa.active).toBe(true);
    expect(postChainConfig(knobs, 'webgl2').taa.active).toBe(false);
    // The other passes do NOT get disabled on webgl2.
    expect(postChainConfig(knobs, 'webgl2').motionBlur.active).toBe(true);
    expect(postChainConfig(knobs, 'webgl2').bloom.active).toBe(true);
    // And the stage list on webgl2 omits 'taa' while keeping the rest.
    const stagesGl = postChainStages(postChainConfig(knobs, 'webgl2'));
    expect(stagesGl).not.toContain('taa');
    expect(stagesGl).toContain('motionBlur');
    expect(stagesGl).toContain('bloom');
    const stagesGpu = postChainStages(postChainConfig(knobs, 'webgpu'));
    expect(stagesGpu).toContain('taa');
  });

  it('shadowCascades 1..4 never affect the post config (orthogonal)', () => {
    const a = postChainConfig(baseKnobs({ shadowCascades: 1 }), 'webgpu');
    const b = postChainConfig(baseKnobs({ shadowCascades: 4 }), 'webgpu');
    expect(a.bloom.active).toBe(b.bloom.active);
    expect(a.taa.active).toBe(b.taa.active);
  });

  it('DoF requires BOTH the knob and the cinematic camera', () => {
    const knobs = baseKnobs({ depthOfField: true });
    expect(postChainConfig(knobs, 'webgpu', { cinematicCamera: false }).dof.active).toBe(false);
    expect(postChainConfig(knobs, 'webgpu', { cinematicCamera: true }).dof.active).toBe(true);
    // Knob off, camera on → still off.
    expect(
      postChainConfig(baseKnobs({ depthOfField: false }), 'webgpu', { cinematicCamera: true }).dof
        .active,
    ).toBe(false);
  });

  it('lens droplets require coverage > epsilon AND camera exposed', () => {
    const knobs = baseKnobs();
    // Below epsilon → off.
    expect(
      postChainConfig(knobs, 'webgpu', {
        lensDropletCoverage: LENS_DROPLET_EPSILON / 2,
        cameraExposed: true,
      }).lensDroplets.active,
    ).toBe(false);
    // Above epsilon but not exposed → off.
    expect(
      postChainConfig(knobs, 'webgpu', { lensDropletCoverage: 0.5, cameraExposed: false })
        .lensDroplets.active,
    ).toBe(false);
    // Above epsilon and exposed → on.
    expect(
      postChainConfig(knobs, 'webgpu', { lensDropletCoverage: 0.5, cameraExposed: true })
        .lensDroplets.active,
    ).toBe(true);
  });

  it('bloom threshold is high so the whole sky does not bloom', () => {
    const cfg = postChainConfig(baseKnobs({ bloom: true }), 'webgpu');
    expect(cfg.bloom.threshold).toBeGreaterThan(1);
  });

  it('motion-blur strength is capped', () => {
    const cfg = postChainConfig(baseKnobs({ motionBlur: true }), 'webgpu');
    expect(cfg.motionBlur.strength).toBeLessThanOrEqual(0.5);
  });

  it('renderScale is clamped to [0.6, 1.0]', () => {
    expect(postChainConfig(baseKnobs({ renderScale: 0.2 }), 'webgpu').renderScale).toBeCloseTo(0.6);
    expect(postChainConfig(baseKnobs({ renderScale: 2 }), 'webgpu').renderScale).toBeCloseTo(1);
    expect(postChainConfig(baseKnobs({ renderScale: 0.8 }), 'webgpu').renderScale).toBeCloseTo(0.8);
  });

  it('nothing is active that all-off knobs disable', () => {
    const cfg: PostChainConfig = postChainConfig(baseKnobs(), 'webgpu', {
      cinematicCamera: true,
      lensDropletCoverage: 0,
      cameraExposed: true,
    });
    expect(cfg.taa.active).toBe(false);
    expect(cfg.bloom.active).toBe(false);
    expect(cfg.motionBlur.active).toBe(false);
    expect(cfg.dof.active).toBe(false);
    expect(cfg.lensDroplets.active).toBe(false);
  });
});

// ─── createPostChain build/dispose (requires an initialised renderer) ──────────

const GRADE: ColorGradeParams = {
  exposure: 0,
  contrast: 0.1,
  saturation: 1,
  shadowTint: { r: 0, g: 0.02, b: 0.05 },
  highlightTint: { r: 0.03, g: 0.02, b: 0 },
  palette: [],
};

describe('createPostChain build/dispose', () => {
  let renderer: THREE.WebGPURenderer;
  let ok = true;

  beforeAll(async () => {
    try {
      renderer = new THREE.WebGPURenderer({ forceWebGL: true });
      await renderer.init();
    } catch {
      ok = false; // headless node may lack any GL backend; skip gracefully
    }
  });

  it('builds a chain with effects enabled and disposes cleanly', () => {
    if (!ok) return;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
    const chain = createPostChain(renderer, scene, camera, {
      knobs: baseKnobs({ bloom: true, depthOfField: true }),
      backend: 'webgl2',
      grade: GRADE,
      cinematicCamera: true,
      lensDropletCoverage: 0.3,
      cameraExposed: true,
    });
    expect(chain.config.bloom.active).toBe(true);
    expect(chain.config.dof.active).toBe(true);
    expect(chain.config.lensDroplets.active).toBe(true);
    expect(() => chain.setGrade(GRADE)).not.toThrow();
    expect(() => chain.setLensDroplets(0)).not.toThrow();
    expect(() => chain.updateConfig(baseKnobs())).not.toThrow();
    expect(() => chain.dispose()).not.toThrow();
  });

  it('builds a minimal (all effects off) chain', () => {
    if (!ok) return;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
    const chain = createPostChain(renderer, scene, camera, {
      knobs: baseKnobs(),
      backend: 'webgpu',
      grade: GRADE,
    });
    expect(chain.config.grade.active).toBe(true);
    chain.dispose();
  });
});

// ─── buildPostOutputNode: TSL node-graph construction (headless, no renderer) ──

describe('buildPostOutputNode (node-graph construction)', () => {
  function scenePassFixture() {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
    return { sp: pass(scene, camera), camera };
  }

  it('builds the full chain (bloom + dof + droplets + grade) without throwing', () => {
    const { sp, camera } = scenePassFixture();
    const gu = createGradeUniforms(GRADE);
    const lens = uniform(0.5);
    const cfg: PostChainConfig = postChainConfig(
      baseKnobs({ bloom: true, depthOfField: true }),
      'webgpu',
      { cinematicCamera: true, lensDropletCoverage: 0.5, cameraExposed: true },
    );
    expect(cfg.bloom.active && cfg.dof.active && cfg.lensDroplets.active).toBe(true);
    const result = buildPostOutputNode(sp, cfg, gu, lens, camera);
    expect(result.node).toBeDefined();
    expect(result.bloomApplied).toBe(true);
    expect(result.dofApplied).toBe(true);
    expect(result.lensDropletsApplied).toBe(true);
    expect(result.gradeApplied).toBe(true);
  });

  it('builds a grade-only chain when all effects are off', () => {
    const { sp, camera } = scenePassFixture();
    const gu = createGradeUniforms(GRADE);
    const lens = uniform(0);
    const cfg = postChainConfig(baseKnobs(), 'webgl2');
    const result = buildPostOutputNode(sp, cfg, gu, lens, camera);
    expect(result.node).toBeDefined();
    expect(result.taaApplied).toBe(false);
    expect(result.motionBlurApplied).toBe(false);
    expect(result.bloomApplied).toBe(false);
    expect(result.dofApplied).toBe(false);
    expect(result.lensDropletsApplied).toBe(false);
    expect(result.gradeApplied).toBe(true);
  });

  it('NEUTRAL_GRADE is an exact identity and builds a valid grade node', () => {
    // The post-chain default grade (used when a venue supplies none) must be a
    // true no-op so a missing grade can never darken/tint the image.
    for (const c of [
      { r: 0, g: 0, b: 0 },
      { r: 0.18, g: 0.18, b: 0.18 },
      { r: 0.7, g: 0.3, b: 0.1 },
    ]) {
      const out = applyColorGrade(c, NEUTRAL_GRADE);
      expect(out.r).toBeCloseTo(c.r, 12);
      expect(out.g).toBeCloseTo(c.g, 12);
      expect(out.b).toBeCloseTo(c.b, 12);
    }
    const { sp, camera } = scenePassFixture();
    const gu = createGradeUniforms(NEUTRAL_GRADE);
    const result = buildPostOutputNode(sp, postChainConfig(baseKnobs(), 'webgl2'), gu, uniform(0), camera);
    expect(result.gradeApplied).toBe(true);
    expect(result.node).toBeDefined();
  });

  it('constructs without throwing for ALL 16 boolean knob permutations', () => {
    // taa × motionBlur × depthOfField × bloom = 16. DoF additionally needs the
    // cinematic camera, so enable it to exercise the DoF branch fully.
    let built = 0;
    for (const taa of [false, true]) {
      for (const motionBlur of [false, true]) {
        for (const depthOfField of [false, true]) {
          for (const bloom of [false, true]) {
            const { sp, camera } = scenePassFixture();
            const gu = createGradeUniforms(GRADE);
            const lens = uniform(0.5);
            const cfg = postChainConfig(
              baseKnobs({ taa, motionBlur, depthOfField, bloom }),
              'webgpu',
              { cinematicCamera: true, lensDropletCoverage: 0.5, cameraExposed: true },
            );
            expect(() => {
              const result = buildPostOutputNode(sp, cfg, gu, lens, camera);
              expect(result.node).toBeDefined();
              // Descriptor mirrors the config exactly.
              expect(result.taaApplied).toBe(taa);
              expect(result.motionBlurApplied).toBe(motionBlur);
              expect(result.bloomApplied).toBe(bloom);
              expect(result.dofApplied).toBe(depthOfField);
            }).not.toThrow();
            built++;
          }
        }
      }
    }
    expect(built).toBe(16);
  });

  it('the graph differs structurally with TAA on vs off (descriptor + node identity)', () => {
    const gu = createGradeUniforms(GRADE);
    const lens = uniform(0);

    const off = (() => {
      const { sp, camera } = scenePassFixture();
      return buildPostOutputNode(sp, postChainConfig(baseKnobs({ taa: false }), 'webgpu'), gu, lens, camera);
    })();
    const on = (() => {
      const { sp, camera } = scenePassFixture();
      return buildPostOutputNode(sp, postChainConfig(baseKnobs({ taa: true }), 'webgpu'), gu, lens, camera);
    })();

    expect(off.taaApplied).toBe(false);
    expect(on.taaApplied).toBe(true);
    // The stage lists differ (taa present only when on).
    expect(off.stages).not.toContain('taa');
    expect(on.stages).toContain('taa');
    // And the returned root nodes are distinct objects.
    expect(on.node).not.toBe(off.node);
  });

  it('motion-blur input is a TEXTURE-CAPABLE node (regression: inputNode.sample)', () => {
    // r0.180 MotionBlur.js samples its input with `inputNode.sample(uv)`, which
    // only exists on texture nodes. The original chain passed the composited
    // beauty+bloom node straight in, which built fine headlessly but threw
    // `TypeError: inputNode.sample is not a function` at GPU compile time. This
    // asserts the node now handed to motionBlur is texture-capable, so the bug
    // cannot regress without this test failing.
    const { sp, camera } = scenePassFixture();
    const gu = createGradeUniforms(GRADE);
    const lens = uniform(0);
    // bloom on too, so the input to motion blur is a *composited* node pre-wrap.
    const cfg = postChainConfig(baseKnobs({ motionBlur: true, bloom: true }), 'webgpu');
    const result = buildPostOutputNode(sp, cfg, gu, lens, camera);
    expect(result.motionBlurApplied).toBe(true);
    expect(result.motionBlurInput).toBeDefined();
    const input = result.motionBlurInput as {
      isTextureNode?: boolean;
      sample?: unknown;
    };
    // Texture-capable == either flagged as a texture node OR exposes .sample().
    const textureCapable =
      input.isTextureNode === true || typeof input.sample === 'function';
    expect(textureCapable).toBe(true);
  });

  it('motion blur with NO bloom still wraps its input as a texture node', () => {
    // Even when the input is the raw beauty pass texture (already a texture
    // node), the wrapped input must remain texture-capable.
    const { sp, camera } = scenePassFixture();
    const gu = createGradeUniforms(GRADE);
    const result = buildPostOutputNode(
      sp,
      postChainConfig(baseKnobs({ motionBlur: true, bloom: false }), 'webgpu'),
      gu,
      uniform(0),
      camera,
    );
    expect(result.motionBlurApplied).toBe(true);
    const input = result.motionBlurInput as {
      isTextureNode?: boolean;
      sample?: unknown;
    };
    expect(input.isTextureNode === true || typeof input.sample === 'function').toBe(true);
  });

  it('TAA node is built under webgpu config but NOT under webgl2 config', () => {
    const gu = createGradeUniforms(GRADE);
    const knobs = baseKnobs({ taa: true });
    const gpu = (() => {
      const { sp, camera } = scenePassFixture();
      return buildPostOutputNode(sp, postChainConfig(knobs, 'webgpu'), gu, uniform(0), camera);
    })();
    const gl = (() => {
      const { sp, camera } = scenePassFixture();
      return buildPostOutputNode(sp, postChainConfig(knobs, 'webgl2'), gu, uniform(0), camera);
    })();
    expect(gpu.taaApplied).toBe(true);
    expect(gl.taaApplied).toBe(false);
  });

  it('the graph differs structurally with motion blur on vs off', () => {
    const gu = createGradeUniforms(GRADE);
    const lens = uniform(0);

    const off = (() => {
      const { sp, camera } = scenePassFixture();
      return buildPostOutputNode(sp, postChainConfig(baseKnobs({ motionBlur: false }), 'webgpu'), gu, lens, camera);
    })();
    const on = (() => {
      const { sp, camera } = scenePassFixture();
      return buildPostOutputNode(sp, postChainConfig(baseKnobs({ motionBlur: true }), 'webgpu'), gu, lens, camera);
    })();

    expect(off.motionBlurApplied).toBe(false);
    expect(on.motionBlurApplied).toBe(true);
    expect(off.stages).not.toContain('motionBlur');
    expect(on.stages).toContain('motionBlur');
    expect(on.node).not.toBe(off.node);
  });

  it('TAA/motion-blur disabled path does not request the velocity channel', () => {
    // When both velocity consumers are off, getTextureNode('velocity') must not
    // be called — assert via a spy on a minimal ScenePassLike.
    const requested: string[] = [];
    const stub = pass(new THREE.Scene(), new THREE.PerspectiveCamera());
    const spy = {
      getTextureNode(name?: string) {
        requested.push(name ?? 'output');
        return stub.getTextureNode(name);
      },
      getViewZNode(name?: string) {
        return stub.getViewZNode(name);
      },
      setMRT(m: unknown) {
        return stub.setMRT(m as never);
      },
    };
    const gu = createGradeUniforms(GRADE);
    const cfg = postChainConfig(baseKnobs({ taa: false, motionBlur: false }), 'webgpu');
    buildPostOutputNode(spy, cfg, gu, uniform(0));
    expect(requested).not.toContain('velocity');
  });

  it('grade uniforms update without throwing', () => {
    const gu = createGradeUniforms(GRADE);
    expect(() =>
      gu.update({ ...GRADE, exposure: 0.5, shadowTint: { r: 0.1, g: 0.1, b: 0.2 } }),
    ).not.toThrow();
  });

  it('gradeNode composes on an arbitrary input node', () => {
    const gu = createGradeUniforms(GRADE);
    const node = gradeNode(screenUV, gu);
    expect(node).toBeDefined();
  });
});

// ─── postChainStages: documented ordering (pure) ───────────────────────────────

describe('postChainStages — canonical documented order', () => {
  it('full chain follows scene → taa → bloom → motionBlur → dof → lensDroplets → grade → output', () => {
    const cfg = postChainConfig(
      baseKnobs({ taa: true, bloom: true, motionBlur: true, depthOfField: true }),
      'webgpu',
      { cinematicCamera: true, lensDropletCoverage: 0.5, cameraExposed: true },
    );
    const expected: PostStage[] = [
      'scene',
      'taa',
      'bloom',
      'motionBlur',
      'dof',
      'lensDroplets',
      'grade',
      'output',
    ];
    expect(postChainStages(cfg)).toEqual(expected);
  });

  it('always brackets with scene first and output last, grade always present', () => {
    const cfg = postChainConfig(baseKnobs(), 'webgpu');
    const stages = postChainStages(cfg);
    expect(stages[0]).toBe('scene');
    expect(stages[stages.length - 1]).toBe('output');
    expect(stages).toContain('grade');
    // All-off chain is exactly scene → grade → output.
    expect(stages).toEqual(['scene', 'grade', 'output']);
  });

  it('relative order is preserved regardless of which optional stages are active', () => {
    // Enable only taa + dof: order must still be scene, taa, dof, grade, output.
    const cfg = postChainConfig(baseKnobs({ taa: true, depthOfField: true }), 'webgpu', {
      cinematicCamera: true,
    });
    expect(postChainStages(cfg)).toEqual(['scene', 'taa', 'dof', 'grade', 'output']);
  });
});
