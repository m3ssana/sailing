import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * `base` must match the GitHub Pages path (`/<repo>/`) for the deployed build,
 * but stay `/` for local dev and preview. CI sets DEPLOY_BASE.
 */
const base = process.env['DEPLOY_BASE'] ?? '/';

const alias = (segment: string) => fileURLToPath(new URL(`./src/${segment}`, import.meta.url));

export default defineConfig({
  base,
  plugins: [react()],
  resolve: {
    alias: {
      '@': alias(''),
      '@core': alias('core'),
      '@weather': alias('weather'),
      '@environment': alias('environment'),
      '@physics': alias('physics'),
      '@generation': alias('generation'),
      '@render': alias('render'),
      '@game': alias('game'),
      '@boats': alias('boats'),
      '@venues': alias('venues'),
      '@audio': alias('audio'),
      '@input': alias('input'),
      '@ui': alias('ui'),
    },
  },
  build: {
    target: 'esnext',
    sourcemap: true,
    // Report on chunks over 600 kB; the hard budget is enforced by scripts/check-budget.mjs.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/types/**'],
    },
  },
});
