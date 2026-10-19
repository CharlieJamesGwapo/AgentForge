import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { configSchema } from '../src/core/config.js';
import { checkpointSchema } from '../src/core/context.js';
import { skillSchema } from '../src/engines/skills.js';
for (const [name, schema] of [
  ['config', configSchema],
  ['checkpoint', checkpointSchema],
  ['skill', skillSchema],
] as const) {
  assert.deepEqual(
    JSON.parse(await readFile(`schemas/${name}.schema.json`, 'utf8')),
    z.toJSONSchema(schema, { io: 'input' }),
    `Schema drift: ${name}. Regenerate schemas.`,
  );
}
console.log('All 3 checked-in JSON schemas match runtime validators.');
