/**
 * Side-effect module: registers SkylineGenerator in the generator registry.
 */

import { registerGenerator } from '../GeneratorRegistry';
import { SkylineGenerator } from './SkylineGenerator';

registerGenerator(SkylineGenerator);
