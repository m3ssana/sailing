/**
 * Side-effect module: registers NavigationBuoyGenerator in the generator registry.
 */

import { registerGenerator } from '../GeneratorRegistry';
import { NavigationBuoyGenerator } from './NavigationBuoy';

registerGenerator(NavigationBuoyGenerator);
