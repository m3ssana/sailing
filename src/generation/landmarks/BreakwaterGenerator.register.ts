/**
 * Side-effect module: registers BreakwaterGenerator in the generator registry.
 */

import { registerGenerator } from '../GeneratorRegistry';
import { BreakwaterGenerator } from './BreakwaterGenerator';

registerGenerator(BreakwaterGenerator);
