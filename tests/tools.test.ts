import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createToolSession,
  prepareTools,
  validateToolCalls,
} from '../src/adapters/tools.js';
import type { ToolCodec } from '../src/adapters/tools.js';
import type { ToolDefinition, ToolTurn } from '../src/adapters/types.js';
const definitions: ToolDefinition[] = [
  {
    name: 'echo',
    description: 'Echo a message',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
      additionalProperties: false,
    },
  },
];
const call = { id: 'c1', name: 'echo', arguments: { message: 'hello' } };
const turn: ToolTurn = {
  text: '',
  model: 'fixture',
  finishReason: 'tool-calls',
  calls: [call],
  usage: { status: 'unavailable' },
};
const options = { approved: true, timeoutMs: 1000 };
function fixture(response: ToolTurn = turn) {
  let requests = 0;
  const codec: ToolCodec = {
    initial: (prompt) => [prompt],
    request: async () => {
      requests++;
      return {};
    },
    parse: () => ({
      turn: structuredClone(response),
      continuation: [{ native: 'private' }],
    }),
    append: (history, continuation, results) => [
      ...history,
      ...continuation,
      ...results,
    ],
  };
  return { codec, requests: () => requests };
}
test('tool definitions and calls use strict bounded schemas and never coerce arguments', () => {
  assert.deepEqual(prepareTools(definitions), definitions);
  for (const tools of [
    [],
    [...definitions, ...definitions],
    [{ ...definitions[0], name: 'shell;rm' }],
    [{ ...definitions[0], parameters: { $ref: 'https://example.invalid' } }],
  ])
    assert.throws(() => prepareTools(tools));
  for (const calls of [
    [{ ...call, name: 'unknown' }],
    [call, call],
    [{ ...call, arguments: { message: 4 } }],
    [{ ...call, arguments: { message: 'x', extra: true } }],
  ])
    assert.throws(() => validateToolCalls(definitions, calls));
  assert.deepEqual(validateToolCalls(definitions, [call]), [call]);
});
test('tool sessions require per-request network approval and matching results before continuing', async () => {
  const f = fixture();
  const session = createToolSession(
    { prompt: 'explicit', tools: definitions },
    f.codec,
  );
  await assert.rejects(
    session.next({ ...options, approved: false }),
    /approval/i,
  );
  assert.equal(f.requests(), 0);
  assert.deepEqual((await session.next(options)).calls, [call]);
  await assert.rejects(session.next(options));
  await assert.rejects(
    session.next({ ...options, results: [{ callId: 'wrong', output: 'x' }] }),
  );
  assert.equal(f.requests(), 1);
  await session.next({
    ...options,
    results: [{ callId: 'c1', output: 'done' }],
  });
  assert.equal(f.requests(), 2);
});
test('sessions snapshot definitions, isolate returned calls and enforce turn limit', async () => {
  const f = fixture();
  const tools = structuredClone(definitions);
  const session = createToolSession(
    { prompt: 'explicit', tools, maxTurns: 2 },
    f.codec,
  );
  tools[0]!.name = 'changed';
  const first = await session.next(options);
  first.calls[0]!.id = 'tampered';
  await assert.rejects(
    session.next({ ...options, results: [{ callId: 'c1', output: 'ok' }] }),
    /limit/i,
  );
  assert.equal(f.requests(), 2);
});
test('partial, refusal, unknown and secret-bearing calls are never executable', async () => {
  for (const response of [
    { ...turn, finishReason: 'length' as const },
    { ...turn, finishReason: 'refusal' as const },
    { ...turn, calls: [{ ...call, name: 'unknown' }] },
    {
      ...turn,
      calls: [{ ...call, arguments: { message: 'Bearer sensitive' } }],
    },
  ]) {
    const f = fixture(response);
    await assert.rejects(
      createToolSession(
        { prompt: 'explicit', tools: definitions },
        f.codec,
      ).next(options),
    );
  }
  const f = fixture({
    ...turn,
    calls: [{ ...call, arguments: { message: 'tiny' } }],
  });
  await assert.rejects(
    createToolSession(
      { prompt: 'explicit', tools: definitions },
      f.codec,
      'tiny',
    ).next(options),
  );
});
test('completed sessions close, reject unsolicited results and sanitize text', async () => {
  const f = fixture({
    ...turn,
    calls: [],
    finishReason: 'completed',
    text: 'Bearer private',
  });
  const s = createToolSession(
    { prompt: 'explicit', tools: definitions },
    f.codec,
  );
  await assert.rejects(
    s.next({ ...options, results: [{ callId: 'extra', output: 'x' }] }),
  );
  assert.equal((await s.next(options)).text, 'Bearer [REDACTED]');
  await assert.rejects(s.next(options));
});
test('in-flight requests cannot race and cancellation prevents a request', async () => {
  const f = fixture();
  const cancelled = AbortSignal.abort();
  await assert.rejects(
    createToolSession({ prompt: 'x', tools: definitions }, f.codec).next({
      ...options,
      signal: cancelled,
    }),
  );
  assert.equal(f.requests(), 0);
  let release!: (value: unknown) => void;
  f.codec.request = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const s = createToolSession({ prompt: 'x', tools: definitions }, f.codec);
  const pending = s.next(options);
  await assert.rejects(s.next(options));
  release({});
  await pending;
});

test('tool result limits also apply after selected-credential redaction expands text', async () => {
  const f = fixture();
  const session = createToolSession(
    { prompt: 'x', tools: definitions },
    f.codec,
    'z',
  );
  await session.next(options);
  await assert.rejects(
    session.next({
      ...options,
      results: [{ callId: 'c1', output: 'z'.repeat(10000) }],
    }),
    /limit/i,
  );
  assert.equal(f.requests(), 1);
});
