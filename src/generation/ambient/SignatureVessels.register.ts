/**
 * Side-effect module: registers SignatureVesselGenerator in the generator registry.
 */

import { registerGenerator } from '../GeneratorRegistry';
import { SignatureVesselGenerator } from './SignatureVessels';

registerGenerator(SignatureVesselGenerator);
