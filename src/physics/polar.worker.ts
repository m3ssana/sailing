/**
 * Web Worker for polar diagram computation.
 *
 * Polar solving is CPU-intensive (sweeping a grid of wind conditions) and must
 * not block the render loop. This worker receives a BoatSpec, computes the full
 * polar, and posts the result back as a serializable PolarDiagram (minus the
 * targetSpeed method, which is re-attached on the main thread).
 */

/// <reference lib="webworker" />

import type { BoatSpec } from '@/types';
import { solvePolar } from './PolarSolver';

export interface PolarWorkerInput {
  boat: BoatSpec;
  windSpeeds?: number[];
  windAngles?: number[];
}

export interface PolarWorkerOutput {
  windSpeeds: number[];
  windAngles: number[];
  boatSpeeds: number[][];
  optimalUpwindAngle: number[];
  optimalDownwindAngle: number[];
}

self.onmessage = (event: MessageEvent<PolarWorkerInput>) => {
  const { boat, windSpeeds, windAngles } = event.data;
  const polar = solvePolar(boat, windSpeeds, windAngles);

  const output: PolarWorkerOutput = {
    windSpeeds: polar.windSpeeds,
    windAngles: polar.windAngles,
    boatSpeeds: polar.boatSpeeds,
    optimalUpwindAngle: polar.optimalUpwindAngle,
    optimalDownwindAngle: polar.optimalDownwindAngle,
  };

  self.postMessage(output);
};
