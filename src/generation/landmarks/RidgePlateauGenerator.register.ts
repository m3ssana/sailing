/**
 * Side-effect module: registers RidgePlateauGenerator in the generator registry.
 */

import { registerGenerator } from '../GeneratorRegistry';
import { RidgePlateauGenerator } from './RidgePlateauGenerator';

registerGenerator(RidgePlateauGenerator);
