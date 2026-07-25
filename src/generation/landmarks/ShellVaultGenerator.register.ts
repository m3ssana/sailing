/**
 * Side-effect module: registers ShellVaultGenerator in the generator registry.
 */

import { registerGenerator } from '../GeneratorRegistry';
import { ShellVaultGenerator } from './ShellVaultGenerator';

registerGenerator(ShellVaultGenerator);
