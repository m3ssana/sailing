/**
 * Wave spectrum and CPU field evaluator.
 *
 * The single authoritative source for wave parameters — both the GPU IFFT ocean
 * and the CPU Gerstner physics path derive from the same WaveSpectrum object.
 */

export { buildSpectrum, buildComponents } from './WaveSpectrum';
export type { SpectrumResult } from './WaveSpectrum';
export { createWaveFieldCPU } from './WaveFieldCPU';
