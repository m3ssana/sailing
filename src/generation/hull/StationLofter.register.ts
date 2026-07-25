/**
 * Side-effect module: registers StationLofter in the generator registry.
 *
 * Imported by the geometry worker so the hull lofter is available for jobs.
 * Separate from StationLofter.ts itself so that test code can import the
 * generator without triggering registration side effects.
 */

import { registerGenerator } from '../GeneratorRegistry';
import { StationLofter } from './StationLofter';

registerGenerator(StationLofter);
