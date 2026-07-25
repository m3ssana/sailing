/**
 * Side-effect module: registers WindInfluenceField in the generator registry.
 *
 * The wind influence field generator produces a WindInfluenceFieldResult (not a
 * GeneratedModel), so it uses a cast similar to TerrainBuilder's registration.
 */

import { registerGenerator } from '../GeneratorRegistry';
import { generateWindInfluenceField } from './WindInfluenceField';
import type { WindInfluenceFieldParams, WindInfluenceFieldResult } from './WindInfluenceField';
import type { Generator, Seed } from '@/types';

const WindInfluenceFieldGenerator: Generator<WindInfluenceFieldParams, WindInfluenceFieldResult> = {
  id: 'windInfluenceField',
  generate(params: WindInfluenceFieldParams, _seed: Seed): WindInfluenceFieldResult {
    return generateWindInfluenceField(params);
  },
};

registerGenerator(WindInfluenceFieldGenerator as unknown as Parameters<typeof registerGenerator>[0]);
