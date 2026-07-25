/**
 * Side-effect module: registers SuspensionBridgeGenerator in the generator registry.
 */

import { registerGenerator } from '../GeneratorRegistry';
import { SuspensionBridgeGenerator } from './SuspensionBridgeGenerator';

registerGenerator(SuspensionBridgeGenerator);
