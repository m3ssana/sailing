/**
 * Side-effect module: registers RigBuilder in the generator registry.
 *
 * Imported by the geometry worker so the rig builder is available for jobs.
 * Separate from RigBuilder.ts itself so that test code can import the
 * generator without triggering registration side effects.
 */

import { registerGenerator } from '../GeneratorRegistry';
import { RigBuilder } from './RigBuilder';

registerGenerator(RigBuilder);
