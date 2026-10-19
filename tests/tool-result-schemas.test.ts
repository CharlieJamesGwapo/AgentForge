import { ProviderError } from '../src/adapters/errors.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  prepareResultSchema,
  validateToolResult,
  TOOL_ERROR_OUTPUT,
} from '../src/adapters/tool-results.js';
import { createToolSession, type ToolCodec } from '../src/adapters/tools.js';
const objectSchema = {
  type: 'object',
  properties: { value: { type: 'string' } },
  required: ['value'],
  additionalProperties: false,
};
const definition = {
  name: 'read',
  description: 'Read',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  resultSchema: objectSchema,
};
const request = { approved: true, timeoutMs: 1000 };
function fixture() {
  let requests = 0;
  let output: unknown;
  let declarations: unknown;
  const codec: ToolCodec = {
    initial: () => [],
    request: async (history, tools) => {
      requests++;
      output = history;
      declarations = tools;
      return {};
    },
    stream: async function* (history, tools) {
      requests++;
      output = history;
      declarations = tools;
      yield { type: 'response', response: {} };
    },
    parse: () => ({
      turn: {
        text: '',
        model: 'fixture',
        finishReason: 'tool-calls',
        calls: [{ id: 'c1', name: 'read', arguments: {} }],
        usage: { status: 'unavailable' },
      },
      continuation: [],
    }),
    append: (_history, _native, results) => results,
  };
  return {
    codec,
    requests: () => requests,
    output: () => output,
    declarations: () => declarations,
  };
}
test('result schemas support strict object, array and scalar JSON roots without weakening final schemas', () => {
  for (const [schema, value] of [
    [objectSchema, { value: 'ok' }],
    [{ type: 'array', items: { type: 'integer' } }, [1, 2]],
    [{ type: 'string' }, 'ok'],
    [{ type: 'number' }, 1.5],
    [{ type: 'boolean' }, true],
    [{ type: 'null' }, null],
  ] as const) {
    const prepared = prepareResultSchema(schema);
    assert.deepEqual(
      JSON.parse(
        validateToolResult(
          { callId: 'c1', output: JSON.stringify(value) },
          prepared,
        ).output,
      ),
      value,
    );
  }
  assert.throws(() =>
    prepareResultSchema({ type: 'string', $ref: 'https://untrusted.invalid' }),
  );
});
test('typed results validate raw JSON, redact data, revalidate and retain valid JSON serialization', () => {
  assert.deepEqual(
    JSON.parse(
      validateToolResult(
        { callId: 'c1', output: '{"value":"tiny"}' },
        objectSchema,
        ['tiny'],
      ).output,
    ),
    { value: '[REDACTED]' },
  );
  const tokenSchema = {
    type: 'object',
    properties: {
      token: { type: 'string', enum: ['private-value', '[REDACTED]'] },
    },
    required: ['token'],
    additionalProperties: false,
  };
  assert.deepEqual(
    JSON.parse(
      validateToolResult(
        { callId: 'c1', output: '{"token":"private-value"}' },
        tokenSchema,
      ).output,
    ),
    { token: '[REDACTED]' },
  );
  for (const output of [
    'not JSON',
    '{"value":4}',
    '{"value":"ok","extra":true}',
  ])
    assert.throws(() =>
      validateToolResult({ callId: 'c1', output }, objectSchema),
    );
  assert.throws(() =>
    validateToolResult(
      { callId: 'c1', output: '{"value":"tiny"}' },
      {
        ...objectSchema,
        properties: { value: { type: 'string', enum: ['tiny'] } },
      },
      ['tiny'],
    ),
  );
});
test('typed error payloads are normalized, never treated as success or forwarded verbatim', () => {
  const result = validateToolResult(
    {
      callId: 'c1',
      output: 'private exception and secret payload',
      isError: true,
    },
    objectSchema,
  );
  assert.equal(result.output, TOOL_ERROR_OUTPUT);
  assert.equal(result.isError, true);
  assert.equal(
    validateToolResult({ callId: 'c1', output: 'opaque text' }).output,
    'opaque text',
  );
});
test('sessions snapshot local result contracts, strip them from codecs and reject invalid follow-ups before requests', async () => {
  for (const stream of [false, true]) {
    const f = fixture();
    const tools = [structuredClone(definition)];
    const session = createToolSession({ prompt: 'x', tools }, f.codec);
    tools[0]!.resultSchema.properties.value.type = 'integer';
    if (stream) {
      for await (const event of session.stream!(request))
        assert.equal(event.type, 'complete');
    } else await session.next(request);
    assert.ok(!JSON.stringify(f.declarations()).includes('resultSchema'));
    const invalid = {
      ...request,
      results: [{ callId: 'c1', output: '{"value":4}' }],
    };
    await assert.rejects(async () => {
      if (stream) {
        for await (const event of session.stream!(invalid)) void event;
      } else await session.next(invalid);
    });
    assert.equal(f.requests(), 1);
    await session.next({
      ...request,
      results: [{ callId: 'c1', output: '{ "value": "ok" }' }],
    });
    assert.equal(f.requests(), 2);
    assert.deepEqual(f.output(), [{ callId: 'c1', output: '{"value":"ok"}' }]);
  }
});
test('result schemas cannot alter final-answer schemas or grant execution rights', () => {
  const f = fixture();
  assert.throws(() =>
    createToolSession(
      {
        prompt: 'x',
        tools: [definition],
        responseSchema: { type: 'array', items: { type: 'string' } },
      },
      f.codec,
    ),
  );
  assert.equal(f.requests(), 0);
});

test('typed results with sensitive object keys are withheld rather than renamed or leaked', () => {
  const key = 'field-private-property-fixture';
  const schema = {
    type: 'object',
    properties: { [key]: { type: 'string' } },
    required: [key],
    additionalProperties: false,
  };
  assert.throws(
    () =>
      validateToolResult(
        { callId: 'one', output: JSON.stringify({ [key]: 'ready' }) },
        schema,
        ['private-property-fixture'],
      ),
    (error: unknown) =>
      error instanceof ProviderError &&
      error.code === 'validation' &&
      !error.message.includes(key),
  );
});

test('array indexes are not JSON property names, while nested object keys remain protected', () => {
  const schema = { type: 'array', items: { type: 'string' } };
  assert.equal(
    validateToolResult({ callId: 'one', output: '["ready"]' }, schema, ['0'])
      .output,
    '["ready"]',
  );
  const nested = {
    type: 'array',
    items: {
      type: 'object',
      properties: { 'key-xy': { type: 'string' } },
      required: ['key-xy'],
      additionalProperties: false,
    },
  };
  assert.throws(
    () =>
      validateToolResult(
        { callId: 'one', output: '[{"key-xy":"ready"}]' },
        nested,
        ['xy'],
      ),
    /invalid/,
  );
});
