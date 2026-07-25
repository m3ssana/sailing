/**
 * Centralized user-facing display text.
 *
 * All player-visible strings live here so that internationalization is a
 * single-module addition rather than a codebase-wide refactor (requirement 11.13).
 * Keys are compile-time checked — a misspelled key fails typecheck.
 *
 * English-only in v1. When i18n is added, this module becomes the fallback table
 * and a locale loader returns a compatible object of the same shape.
 */

import type { WeatherSource } from '@/types';

/**
 * The string table type. Exported so i18n modules can declare conformance
 * against it without importing the default strings.
 */
export interface StringTable {
  boot: {
    initializing: string;
    loadingVenue: string;
    generatingTerrain: string;
    generatingBoat: string;
    preparingOcean: string;
    fetchingWeather: string;
    ready: string;
  };
  weather: {
    /** Labels for the active weather source shown in the HUD conditions panel. */
    sourceLabels: Record<WeatherSource, string>;
  };
  renderer: {
    /** Shown when the WebGPU backend is unavailable and WebGL2 is active. */
    webgl2Notice: string;
  };
}

/**
 * Default English strings. Import this as the single source of display text
 * throughout the UI layer.
 */
export const strings: StringTable = {
  boot: {
    initializing: 'Initializing…',
    loadingVenue: 'Loading venue…',
    generatingTerrain: 'Generating terrain…',
    generatingBoat: 'Generating boat…',
    preparingOcean: 'Preparing ocean…',
    fetchingWeather: 'Fetching weather…',
    ready: 'Ready',
  },
  weather: {
    sourceLabels: {
      live: 'Live conditions',
      cache: 'Cached conditions',
      climatology: 'Seasonal average (offline)',
      default: 'Default conditions',
      sandbox: 'Simulated conditions',
    },
  },
  renderer: {
    webgl2Notice:
      'WebGPU is not available — running in reduced fidelity mode. ' +
      'For full visual quality, use Chrome or Edge on a device with WebGPU support.',
  },
} as const satisfies StringTable;
