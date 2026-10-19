import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { configSchema } from '../src/core/config.js';
import { checkpointSchema } from '../src/core/context.js';
import { skillSchema } from '../src/engines/skills.js';
for (const [name, schema] of [
  ['config', configSchema],
  ['checkpoint', checkpointSchema],
  ['skill', skillSchema],
] as const) {
  await writeFile(
    `schemas/${name}.schema.json`,
    JSON.stringify(z.toJSONSchema(schema, { io: 'input' }), null, 2) + '\n',
  );
}
