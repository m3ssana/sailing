/**
 * Side-effect module: registers HarbourFurnitureGenerator in the generator registry.
 */

import { registerGenerator } from '../GeneratorRegistry';
import { HarbourFurnitureGenerator } from './HarbourFurniture';

registerGenerator(HarbourFurnitureGenerator);
