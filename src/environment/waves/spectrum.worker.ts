/**
 * Web Worker for precomputing wave spectrum tables.
 *
 * Heavy spectrum sampling (128 frequency × 36 direction bins with Newton-Raphson
 * dispersion solving) is done here so the main thread never blocks during weather
 * transitions. The result is a transferable Float32Array of component data that
 * the main thread uses to instantiate WaveFieldCPU.
 *
 * Message protocol:
 *   Main → Worker: { type: 'buildSpectrum', params: WaveSpectrumParams, id: number }
 *   Worker → Main: { type: 'spectrumResult', components: Float32Array, id: number }
 *                  (transferred, not copied)
 */

import type { WaveSpectrumParams } from '@/types';
import { buildSpectrum } from './WaveSpectrum';
import type { SpectrumResult } from './WaveSpectrum';

/** Fields per component in the packed Float32Array. */
const FIELDS_PER_COMPONENT = 7;

interface BuildMessage {
  type: 'buildSpectrum';
  params: WaveSpectrumParams;
  componentCount: number;
  id: number;
}

type WorkerMessage = BuildMessage;

/**
 * Pack WaveComponent[] into a flat Float32Array for zero-copy transfer.
 * Layout per component: [amplitude, wavenumber, dirX, dirZ, frequency, phase, steepness]
 */
function packComponents(result: SpectrumResult): Float32Array {
  const components = result.components;
  const buffer = new Float32Array(components.length * FIELDS_PER_COMPONENT + 3);

  // Header: [componentCount, m0, significantHeight]
  buffer[0] = components.length;
  buffer[1] = result.m0;
  buffer[2] = result.significantHeight;

  for (let i = 0; i < components.length; i++) {
    const c = components[i];
    if (c === undefined) continue;
    const offset = 3 + i * FIELDS_PER_COMPONENT;
    buffer[offset] = c.amplitude;
    buffer[offset + 1] = c.wavenumber;
    buffer[offset + 2] = c.direction.x;
    buffer[offset + 3] = c.direction.y;
    buffer[offset + 4] = c.frequency;
    buffer[offset + 5] = c.phase;
    buffer[offset + 6] = c.steepness;
  }

  return buffer;
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const msg = event.data;

  if (msg.type === 'buildSpectrum') {
    const result = buildSpectrum(msg.params, msg.componentCount);
    const packed = packComponents(result);

    self.postMessage(
      { type: 'spectrumResult', components: packed, id: msg.id },
      { transfer: [packed.buffer] },
    );
  }
};
