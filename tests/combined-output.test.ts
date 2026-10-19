import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createToolSession, type ToolCodec } from '../src/adapters/tools.js';
import type { ToolTurn } from '../src/adapters/types.js';
import { runToolConversation } from '../src/engines/tools.js';
const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};
const tools = [
  {
    name: 'lookup',
    description: 'Lookup',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
      additionalProperties: false,
    },
  },
];
const request = { approved: true, timeoutMs: 1000 };
const call = { id: 'c1', name: 'lookup', arguments: { key: 'entry' } };
const final: ToolTurn = {
  text: '{"answer":"validated"}',
  model: 'fixture',
  finishReason: 'completed',
  calls: [],
  usage: { status: 'unavailable' },
};
function fixture(responses: ToolTurn[] = [final]) {
  let count = 0;
  const seen: unknown[] = [];
  const codec: ToolCodec = {
    initial: (prompt) => [prompt],
    request: async (history, _tools, options) => {
      seen.push({ history, options });
      return count++;
    },
    stream: async function* (history, _tools, options) {
      seen.push({ history, options });
      const index = count++;
      yield { type: 'text-delta', text: responses[index]!.text };
      yield { type: 'response', response: index };
    },
    parse: (raw) => ({
      turn: structuredClone(responses[Number(raw)]!),
      continuation: [{ private: 'native' }],
    }),
    append: (history, continuation, results) => [
      ...history,
      ...continuation,
      ...results,
    ],
  };
  return { codec, seen, count: () => count };
}
test('combined sessions snapshot schemas before requests and validate direct structured finals', async () => {
  const f = fixture();
  const mutable = structuredClone(schema);
  const session = createToolSession(
    { prompt: 'x', tools, responseSchema: mutable },
    f.codec,
  );
  mutable.properties.answer.type = 'integer';
  const turn = await session.next(request);
  assert.deepEqual(turn.structured, {
    status: 'valid',
    data: { answer: 'validated' },
  });
  assert.deepEqual(
    (f.seen[0] as { options: { responseSchema: unknown } }).options
      .responseSchema,
    schema,
  );
});
test('invalid final schemas fail before a network request', () => {
  const f = fixture();
  assert.throws(() =>
    createToolSession(
      {
        prompt: 'x',
        tools,
        responseSchema: { ...schema, $ref: 'https://untrusted.invalid' },
      },
      f.codec,
    ),
  );
  assert.equal(f.count(), 0);
});
test('tool arguments and final schemas are independent; final data arrives only after approval', async () => {
  for (const stream of [false, true]) {
    let effects = 0,
      approvals = 0;
    const f = fixture([
      {
        ...final,
        text: 'Looking up data',
        finishReason: 'tool-calls',
        calls: [call],
      },
      final,
    ]);
    const result = await runToolConversation({
      session: createToolSession(
        { prompt: 'x', tools, responseSchema: schema },
        f.codec,
      ),
      tools: [
        {
          definition: tools[0]!,
          execute: async () => {
            effects++;
            return { value: 7 };
          },
        },
      ],
      request,
      stream,
      approve: async (batch) => {
        approvals++;
        assert.equal(effects, 0);
        assert.deepEqual(batch.calls, [call]);
        return true;
      },
      onTurn: (turn) => {
        if (turn.finishReason === 'tool-calls')
          assert.deepEqual(turn.structured, {
            status: 'pending',
            reason: 'tool-calls',
          });
      },
    });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.turn.structured, {
      status: 'valid',
      data: { answer: 'validated' },
    });
    assert.equal(effects, 1);
    assert.equal(approvals, 1);
    assert.equal(f.count(), 2);
  }
});
test('combined stream withholds all text, including tool commentary, until validated complete', async () => {
  const f = fixture();
  f.codec.stream = async function* () {
    yield { type: 'text-delta', text: '{\n"answer":' };
    yield { type: 'text-delta', text: '"validated"}' };
    yield { type: 'response', response: 0 };
  };
  f.codec.parse = () => ({
    turn: { ...final, text: '{\n"answer":"validated"}' },
    continuation: [],
  });
  const events = [];
  for await (const event of createToolSession(
    { prompt: 'x', tools, responseSchema: schema },
    f.codec,
  ).stream!(request))
    events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'complete');
});
test('malformed or wrong-schema finals never escape in reports and cannot replay prior tool effects', async () => {
  for (const stream of [false, true])
    for (const text of ['{"answer":7}', 'private-invalid-json']) {
      const f = fixture([
        {
          ...final,
          text: 'Tool commentary',
          finishReason: 'tool-calls',
          calls: [call],
        },
        { ...final, text },
      ]);
      let effects = 0;
      await assert.rejects(
        runToolConversation({
          session: createToolSession(
            { prompt: 'x', tools, responseSchema: schema },
            f.codec,
          ),
          tools: [
            {
              definition: tools[0]!,
              execute: async () => {
                effects++;
                return 'ok';
              },
            },
          ],
          request,
          stream,
          approve: async () => true,
        }),
        (error) => error instanceof Error && !error.message.includes(text),
      );
      assert.equal(effects, 1);
      assert.equal(f.count(), 2);
    }
});
test('partial/refused finals are unavailable and denial executes no tool', async () => {
  for (const finishReason of ['length', 'refusal'] as const) {
    const f = fixture([{ ...final, text: 'partial', finishReason }]);
    const turn = await createToolSession(
      { prompt: 'x', tools, responseSchema: schema },
      f.codec,
    ).next(request);
    assert.deepEqual(turn.structured, {
      status: 'unavailable',
      reason: finishReason,
    });
  }
  const f = fixture([{ ...final, finishReason: 'tool-calls', calls: [call] }]);
  let effects = 0;
  const result = await runToolConversation({
    session: createToolSession(
      { prompt: 'x', tools, responseSchema: schema },
      f.codec,
    ),
    tools: [
      {
        definition: tools[0]!,
        execute: async () => {
          effects++;
          return 'ok';
        },
      },
    ],
    request,
    approve: async () => false,
  });
  assert.equal(result.status, 'approval-required');
  assert.equal(effects, 0);
  assert.equal(f.count(), 1);
});
test('structured data is redacted and revalidated without changing the schema', async () => {
  const f = fixture([{ ...final, text: '{"answer":"tiny"}' }]);
  const session = createToolSession(
    { prompt: 'x', tools, responseSchema: schema },
    f.codec,
    'tiny',
  );
  const turn = await session.next(request);
  assert.deepEqual(turn.structured, {
    status: 'valid',
    data: { answer: '[REDACTED]' },
  });
  assert.equal(turn.text, '{"answer":"[REDACTED]"}');
  const strict = {
    ...schema,
    properties: { answer: { type: 'string', enum: ['tiny'] } },
  };
  const g = fixture([{ ...final, text: '{"answer":"tiny"}' }]);
  await assert.rejects(
    createToolSession(
      { prompt: 'x', tools, responseSchema: strict },
      g.codec,
      'tiny',
    ).next(request),
  );
});

test('streamed validated JSON is never rewritten by a second string redaction', async () => {
  const sensitiveSchema = {
    type: 'object',
    properties: { token: { type: 'string', enum: ['[REDACTED]'] } },
    required: ['token'],
    additionalProperties: false,
  };
  for (const stream of [false, true]) {
    const f = fixture([{ ...final, text: '{"token":"[REDACTED]"}' }]);
    const session = createToolSession(
      { prompt: 'x', tools, responseSchema: sensitiveSchema },
      f.codec,
    );
    let result: ToolTurn | undefined;
    if (stream) {
      for await (const event of session.stream!(request)) {
        assert.equal(event.type, 'complete');
        if (event.type === 'complete') result = event.turn;
      }
    } else result = await session.next(request);
    assert.deepEqual(JSON.parse(result!.text), { token: '[REDACTED]' });
    assert.deepEqual(result!.structured, {
      status: 'valid',
      data: { token: '[REDACTED]' },
    });
  }
});
test('mutating a wire schema copy cannot weaken final validation or change the next request schema', async () => {
  const f = fixture([
    { ...final, finishReason: 'tool-calls', calls: [call] },
    final,
  ]);
  const original = f.codec.request;
  f.codec.request = async (history, declared, options) => {
    assert.deepEqual(options.responseSchema, schema);
    (
      options.responseSchema!.properties as { answer: { type: string } }
    ).answer.type = 'integer';
    return original(history, declared, options);
  };
  const session = createToolSession(
    { prompt: 'x', tools, responseSchema: schema },
    f.codec,
  );
  await session.next(request);
  const result = await session.next({
    ...request,
    results: [{ callId: 'c1', output: 'ok' }],
  });
  assert.deepEqual(result.structured, {
    status: 'valid',
    data: { answer: 'validated' },
  });
  const g = fixture([{ ...final, text: '{"answer":7}' }]);
  g.codec.request = async (_history, _declared, options) => {
    (
      options.responseSchema!.properties as { answer: { type: string } }
    ).answer.type = 'integer';
    return 0;
  };
  await assert.rejects(
    createToolSession(
      { prompt: 'x', tools, responseSchema: schema },
      g.codec,
    ).next(request),
  );
});

test('function-looking structured answer data never becomes an executable call', async () => {
  const dataSchema = {
    type: 'object',
    properties: { tool: { type: 'string' }, arguments: tools[0]!.parameters },
    required: ['tool', 'arguments'],
    additionalProperties: false,
  };
  const value = { tool: 'lookup', arguments: { key: 'entry' } };
  let effects = 0,
    approvals = 0;
  const f = fixture([{ ...final, text: JSON.stringify(value) }]);
  const result = await runToolConversation({
    session: createToolSession(
      { prompt: 'x', tools, responseSchema: dataSchema },
      f.codec,
    ),
    tools: [
      {
        definition: tools[0]!,
        execute: async () => {
          effects++;
          return 'ok';
        },
      },
    ],
    request,
    approve: async () => {
      approvals++;
      return true;
    },
  });
  assert.deepEqual(result.turn.structured, { status: 'valid', data: value });
  assert.equal(effects, 0);
  assert.equal(approvals, 0);
});

test('schema-mode tool commentary cannot expose unvalidated JSON through terminal turns', async () => {
  for (const stream of [false, true]) {
    const f = fixture([
      {
        ...final,
        text: '{"private-intermediate":"unfinished',
        finishReason: 'tool-calls',
        calls: [call],
      },
    ]);
    const session = createToolSession(
      { prompt: 'x', tools, responseSchema: schema },
      f.codec,
    );
    let turn: ToolTurn | undefined;
    if (stream) {
      for await (const event of session.stream!(request))
        if (event.type === 'complete') turn = event.turn;
    } else turn = await session.next(request);
    assert.equal(turn?.text, '');
    assert.deepEqual(turn?.structured, {
      status: 'pending',
      reason: 'tool-calls',
    });
  }
});
