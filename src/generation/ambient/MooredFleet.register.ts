/**
 * Side-effect module: registers MooredFleetGenerator in the generator registry.
 */

import { registerGenerator } from '../GeneratorRegistry';
import { MooredFleetGenerator } from './MooredFleet';

registerGenerator(MooredFleetGenerator);
