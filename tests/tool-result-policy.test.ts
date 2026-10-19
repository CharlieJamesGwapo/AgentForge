import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyResultSchemas } from '../src/cli/tool-result-schemas.js';
import type { RegisteredTool } from '../src/engines/tools.js';
const schema = { type: 'string' };
function registry(): RegisteredTool[] {
  return [
    {
      definition: {
        name: 'summary',
        description: 'summary',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
      execute: async () => 'summary',
    },
  ];
}
test('result policy accepts only bounded registered tool names and snapshots overrides', () => {
  const tools = registry();
  const input = { summary: schema };
  const overridden = applyResultSchemas(tools, input);
  input.summary.type = 'null';
  assert.deepEqual(overridden[0]?.definition.resultSchema, { type: 'string' });
  assert.equal(tools[0]?.definition.resultSchema, undefined);
  assert.equal(overridden[0]?.execute, tools[0]?.execute);
  for (const bad of [
    undefined,
    null,
    [],
    {},
    { unknown: { type: 'null' } },
    { summary: { type: 'number', minimum: 1 } },
    {
      summary: {
        type: 'object',
        properties: { ['__proto__']: { type: 'string' } },
      },
    },
  ]) {
    assert.throws(() => applyResultSchemas(tools, bad));
  }
});
