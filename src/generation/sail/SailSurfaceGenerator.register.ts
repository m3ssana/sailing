/**
 * Side-effect module: registers SailSurfaceGenerator in the generator registry.
 *
 * Imported by the geometry worker so the sail surface generator is available
 * for jobs. Separate from SailSurfaceGenerator.ts itself so that test code can
 * import the generator without triggering registration side effects.
 */

import { registerGenerator } from '../GeneratorRegistry';
import { SailSurfaceGenerator } from './SailSurfaceGenerator';

registerGenerator(SailSurfaceGenerator);
