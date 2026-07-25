/**
 * Side-effect module: registers HarbourFurnitureGenerator in the generator registry.
 */

import { registerGenerator } from '../GeneratorRegistry';
import { HarbourFurnitureGenerator } from './HarbourFurnitureGenerator';

registerGenerator(HarbourFurnitureGenerator);
