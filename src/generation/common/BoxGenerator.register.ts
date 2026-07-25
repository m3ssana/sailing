/**
 * Side-effect module: registers BoxGenerator in the generator registry.
 *
 * Imported by the geometry worker so the box generator is available for jobs.
 * Separate from BoxGenerator.ts itself so that test code can import the
 * generator without triggering registration side effects.
 */

import { registerGenerator } from '../GeneratorRegistry';
import { BoxGenerator } from './BoxGenerator';

registerGenerator(BoxGenerator);
