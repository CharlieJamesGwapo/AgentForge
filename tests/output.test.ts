import assert from 'node:assert/strict';
import test from 'node:test';
import {
  prepareSchema,
  finishPrompt,
  finalizeStream,
} from '../src/adapters/output.js';
import type {
  PromptInput,
  PromptResult,
  PromptStreamEvent,
} from '../src/adapters/types.js';
const schema = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    count: { type: 'integer', enum: [1, 2] },
  },
  required: ['answer', 'count'],
  additionalProperties: false,
};
const input: PromptInput = {
  prompt: 'explicit',
  approved: true,
  timeoutMs: 1000,
  responseSchema: schema,
};
const result = (text: string): PromptResult => ({
  text,
  model: 'fixture',
  finishReason: 'completed',
  usage: { status: 'unavailable' },
});
test('portable schema validation rejects unsupported/recursive/oversized schemas and accepts nullable nested fields', () => {
  assert.deepEqual(prepareSchema(schema), schema);
  for (const value of [
    { type: 'string' },
    { ...schema, $ref: 'https://untrusted.example' },
    { ...schema, pattern: '.*' },
    { ...schema, additionalProperties: true },
    { ...schema, required: [] },
    { ...schema, properties: { answer: { type: 'string', format: 'email' } } },
    { ...schema, description: 'x'.repeat(70000) },
  ])
    assert.throws(() => prepareSchema(value));
  const nullable = {
    type: 'object',
    properties: { value: { type: ['string', 'null'] } },
    required: ['value'],
    additionalProperties: false,
  };
  assert.deepEqual(prepareSchema(nullable), nullable);
  const cyclic: Record<string, unknown> = { type: 'object' };
  cyclic.properties = { self: cyclic };
  assert.throws(() => prepareSchema(cyclic));
});
test('structured output validates without coercion, removing extra fields or repairing malformed JSON', () => {
  const valid = finishPrompt(result('{"answer":"ok","count":1}'), input);
  assert.deepEqual(valid.structured, {
    status: 'valid',
    data: { answer: 'ok', count: 1 },
  });
  for (const text of [
    '{"answer":"private","count":"1"}',
    '{"answer":"private","count":9}',
    '{"answer":"private","count":1,"extra":true}',
    '{"answer":"private"}',
    '```json\n{}\n```',
  ])
    assert.throws(
      () => finishPrompt(result(text), input),
      (error: Error & { code?: string }) =>
        error.code === 'validation' && !error.message.includes('private'),
    );
});
test('redaction preserves structured JSON and revalidates the delivered value', () => {
  const safe = finishPrompt(
    result('{"answer":"secret-value","count":1}'),
    input,
    'secret-value',
  );
  assert.deepEqual(safe.structured, {
    status: 'valid',
    data: { answer: '[REDACTED]', count: 1 },
  });
  assert.doesNotThrow(() => JSON.parse(safe.text));
  const exact = {
    ...schema,
    properties: {
      answer: { type: 'string', enum: ['secret-value'] },
      count: { type: 'integer', enum: [1] },
    },
  };
  assert.throws(
    () =>
      finishPrompt(
        result('{"answer":"secret-value","count":1}'),
        { ...input, responseSchema: exact },
        'secret-value',
      ),
    { code: 'validation' },
  );
});
test('length/refusal output is never described as schema-valid', () => {
  for (const finishReason of ['length', 'refusal'] as const) {
    const out = finishPrompt({ ...result('partial'), finishReason }, input);
    assert.deepEqual(out.structured, {
      status: 'unavailable',
      reason: finishReason,
    });
  }
});
async function collect(events: AsyncIterable<PromptStreamEvent>) {
  const output: PromptStreamEvent[] = [];
  for await (const event of events) output.push(event);
  return output;
}
test('stream finalizer redacts split credentials and buffers incomplete private keys', async () => {
  async function* raw(): AsyncGenerator<PromptStreamEvent> {
    yield {
      type: 'text-delta',
      text: 'First line\nsecret-',
      provisional: true,
    };
    yield { type: 'text-delta', text: 'value\nlast', provisional: true };
    yield {
      type: 'complete',
      result: result('First line\nsecret-value\nlast'),
    };
  }
  const output = await collect(
    finalizeStream(
      raw(),
      { ...input, responseSchema: undefined },
      'secret-value',
    ),
  );
  assert.ok(
    output.some((e) => e.type === 'text-delta' && e.text === 'First line\n'),
  );
  assert.ok(!JSON.stringify(output).includes('secret-value'));
  assert.equal(output.at(-1)?.type, 'complete');
});
test('structured streams emit only a locally validated terminal result; truncation fails', async () => {
  async function* valid(): AsyncGenerator<PromptStreamEvent> {
    yield { type: 'text-delta', text: '{"answer":"ok",', provisional: true };
    yield { type: 'text-delta', text: '"count":1}', provisional: true };
    yield { type: 'complete', result: result('{"answer":"ok","count":1}') };
  }
  const events = await collect(finalizeStream(valid(), input));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'complete');
  async function* broken(): AsyncGenerator<PromptStreamEvent> {
    yield { type: 'text-delta', text: 'partial', provisional: true };
  }
  await assert.rejects(collect(finalizeStream(broken(), input)), {
    code: 'invalid-response',
  });
});

test('unfinished private keys are never flushed into streaming output at completion', async () => {
  const key = '-----BEGIN PRIVATE KEY-----\nprivate-material\n';
  async function* raw(): AsyncGenerator<PromptStreamEvent> {
    yield { type: 'text-delta', text: key, provisional: true };
    yield { type: 'complete', result: result(key) };
  }
  const events = await collect(
    finalizeStream(raw(), { ...input, responseSchema: undefined }),
  );
  assert.ok(!JSON.stringify(events).includes('private-material'));
});

test('stream sanitizer retains credential prefixes across line boundaries', async () => {
  for (const text of [
    'Bearer\nunknown-credential\n',
    'api_key\n=\nunknown-credential\n',
    'Authorization: Bearer\nunknown-credential\n',
  ]) {
    async function* raw(): AsyncGenerator<PromptStreamEvent> {
      for (const line of text.match(/[^\n]*\n/g) ?? [])
        yield { type: 'text-delta', text: line, provisional: true };
      yield { type: 'complete', result: result(text) };
    }
    const events = await collect(
      finalizeStream(raw(), { ...input, responseSchema: undefined }),
    );
    assert.ok(!JSON.stringify(events).includes('unknown-credential'));
  }
});

test('structured output with secret bytes in field names is withheld in ordinary and streaming modes', async () => {
  const key = 'field-xy';
  const responseSchema = {
    type: 'object',
    properties: { [key]: { type: 'string' } },
    required: [key],
    additionalProperties: false,
  };
  const structuredInput = { ...input, responseSchema };
  const value = result(JSON.stringify({ [key]: 'ready' }));
  assert.throws(() => finishPrompt(value, structuredInput, 'xy'), {
    code: 'validation',
  });
  const events: PromptStreamEvent[] = [
    { type: 'text-delta', text: value.text, provisional: true },
    { type: 'complete', result: value },
  ];
  const emitted: PromptStreamEvent[] = [];
  await assert.rejects(
    async () => {
      for await (const event of finalizeStream(
        (async function* () {
          yield* events;
        })(),
        structuredInput,
        'xy',
      ))
        emitted.push(event);
    },
    { code: 'validation' },
  );
  assert.deepEqual(emitted, []);
});

test('schema-requested refusal and length outputs expose status without partial JSON text', () => {
  for (const finishReason of ['length', 'refusal'] as const) {
    const output = finishPrompt(
      { ...result('{"answer":"private-partial'), finishReason },
      input,
    );
    assert.equal(output.text, '');
    assert.deepEqual(output.structured, {
      status: 'unavailable',
      reason: finishReason,
    });
  }
});
