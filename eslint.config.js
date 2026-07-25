import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/**
 * The engine-agnostic layers. Nothing here may import three.js — that boundary is
 * what keeps physics, wind, waves, and generators headlessly testable and
 * deterministic (see design.md §3 and §11).
 */
const ENGINE_AGNOSTIC = [
  'src/core/**/*.ts',
  'src/physics/**/*.ts',
  'src/environment/**/*.ts',
  'src/weather/**/*.ts',
  'src/generation/**/*.ts',
  'src/game/**/*.ts',
];

const NO_THREE = {
  patterns: [
    {
      group: ['three', 'three/*', 'three/**'],
      message:
        'This layer must stay engine-agnostic. three.js may only be imported from src/render/. ' +
        'Return plain numbers / ArrayBuffers and let the render layer consume them.',
    },
  ],
};

const NO_SHADER_FILES = {
  patterns: [
    {
      group: ['*.glsl', '*.wgsl', '*.vert', '*.frag', '*.comp'],
      message:
        'All shading is authored in TSL (three/tsl) inside .ts files so one source compiles ' +
        'to both WGSL and GLSL. Raw shader files are not permitted.',
    },
  ],
};

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', '*.config.js'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
        ...globals.worker,
      },
    },
    rules: {
      // Deliberate unused vars are marked with a leading underscore.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-imports': ['error', NO_SHADER_FILES],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // The architectural boundary. This rule is the reason the layering cannot erode.
  {
    files: ENGINE_AGNOSTIC,
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...NO_THREE.patterns, ...NO_SHADER_FILES.patterns] },
      ],
    },
  },

  // React is UI-only and must never touch the render loop.
  {
    files: ['src/ui/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },

  // Tests and build scripts get a little more latitude.
  {
    files: ['tests/**/*.ts', 'src/**/*.test.ts', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },

  {
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
