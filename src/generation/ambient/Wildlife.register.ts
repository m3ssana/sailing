/**
 * Side-effect module: registers WildlifeGenerator in the generator registry.
 */

import { registerGenerator } from '../GeneratorRegistry';
import { WildlifeGenerator } from './Wildlife';

registerGenerator(WildlifeGenerator);
