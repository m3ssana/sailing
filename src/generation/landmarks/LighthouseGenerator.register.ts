/**
 * Side-effect module: registers LighthouseGenerator in the generator registry.
 */

import { registerGenerator } from '../GeneratorRegistry';
import { LighthouseGenerator } from './LighthouseGenerator';

registerGenerator(LighthouseGenerator);
