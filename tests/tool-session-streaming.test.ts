import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createToolSession,
  type ToolCodec,
  type NativeToolStreamEvent,
} from '../src/adapters/tools.js';
import type { ToolStreamEvent } from '../src/adapters/types.js';
const tools = [
  {
    name: 'echo',
    description: 'Echo',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
      additionalProperties: false,
    },
  },
];
const request = { approved: true, timeoutMs: 1000 };
const turn = {
  text: 'First line\nLast line',
  model: 'fixture',
  finishReason: 'tool-calls' as const,
  calls: [{ id: 'c1', name: 'echo', arguments: { message: 'hello' } }],
  usage: { status: 'unavailable' as const },
};
function fixture(
  events: NativeToolStreamEvent[] = [
    { type: 'text-delta', text: turn.text },
    { type: 'response', response: {} },
  ],
) {
  let requests = 0,
    closed = 0;
  const codec: ToolCodec = {
    initial: (prompt) => [prompt],
    request: async () => {
      requests++;
      return {};
    },
    parse: () => ({
      turn: structuredClone(turn),
      continuation: [{ private: 'state' }],
    }),
    append: (history, continuation, results) => [
      ...history,
      ...continuation,
      ...results,
    ],
    stream: async function* () {
      requests++;
      try {
        for (const event of events) yield event;
      } finally {
        closed++;
      }
    },
  };
  return { codec, requests: () => requests, closed: () => closed };
}
async function collect(source: AsyncIterable<ToolStreamEvent>) {
  const events = [];
  for await (const event of source) events.push(event);
  return events;
}
test('streamed calls appear only in validated terminal turns and share result correlation with next', async () => {
  const f = fixture();
  const session = createToolSession({ prompt: 'x', tools }, f.codec);
  assert.equal(typeof session.stream, 'function');
  const events = await collect(session.stream!(request));
  assert.ok(
    events
      .slice(0, -1)
      .every((event) => event.type === 'text-delta' && !('calls' in event)),
  );
  assert.deepEqual(events.at(-1), { type: 'complete', turn });
  assert.equal(f.closed(), 1);
  await assert.rejects(session.next(request));
  await session.next({ ...request, results: [{ callId: 'c1', output: 'ok' }] });
  assert.equal(f.requests(), 2);
});
test('truncated, duplicate, trailing and mismatched streams never complete', async () => {
  for (const events of [
    [],
    [{ type: 'text-delta' as const, text: 'partial\n' }],
    [
      { type: 'response' as const, response: {} },
      { type: 'response' as const, response: {} },
    ],
    [
      { type: 'response' as const, response: {} },
      { type: 'text-delta' as const, text: 'after' },
    ],
    [
      { type: 'text-delta' as const, text: 'disagrees\n' },
      { type: 'response' as const, response: {} },
    ],
  ]) {
    const f = fixture(events);
    const session = createToolSession({ prompt: 'x', tools }, f.codec);
    const seen: ToolStreamEvent[] = [];
    await assert.rejects(async () => {
      for await (const event of session.stream!(request)) seen.push(event);
    });
    assert.ok(!seen.some((event) => event.type === 'complete'));
    await assert.rejects(session.next(request));
  }
});
test('early iterator return closes native transport and invalidates pending stream state', async () => {
  const f = fixture();
  const session = createToolSession({ prompt: 'x', tools }, f.codec);
  for await (const event of session.stream!(request)) {
    assert.equal(event.type, 'text-delta');
    break;
  }
  assert.equal(f.closed(), 1);
  await assert.rejects(session.next(request));
});
test('stream request snapshots are inert without approval; in-flight stream and next cannot race', async () => {
  const f = fixture();
  const session = createToolSession({ prompt: 'x', tools }, f.codec);
  const options = { ...request, approved: false };
  const stream = session.stream!(options);
  options.approved = true;
  await assert.rejects(collect(stream));
  assert.equal(f.requests(), 0);
  const iterator = session.stream!(request)[Symbol.asyncIterator]();
  await iterator.next();
  await assert.rejects(session.next(request));
  await iterator.return?.();
});
test('stream terminal validation and secrets are handled before exposing executable calls', async () => {
  const f = fixture([
    { type: 'text-delta', text: 'Bearer\nprivate-value\n' },
    { type: 'response', response: {} },
  ]);
  f.codec.parse = () => ({
    turn: { ...turn, text: 'Bearer\nprivate-value\n' },
    continuation: [],
  });
  const events = await collect(
    createToolSession({ prompt: 'x', tools }, f.codec).stream!(request),
  );
  assert.ok(!JSON.stringify(events).includes('private-value'));
  f.codec.parse = () => ({
    turn: {
      ...turn,
      calls: [
        { ...turn.calls[0]!, arguments: { message: 'Bearer private-value' } },
      ],
    },
    continuation: [],
  });
  await assert.rejects(
    collect(
      createToolSession({ prompt: 'x', tools }, f.codec).stream!(request),
    ),
  );
});

test('conversation never approves while a stream remains open or ends in an error', async () => {
  const { runToolConversation } = await import('../src/engines/tools.js');
  const f = fixture();
  let finish!: () => void;
  let terminalSent!: () => void;
  const terminalReady = new Promise<void>((resolve) => {
    terminalSent = resolve;
  });
  f.codec.stream = async function* () {
    yield { type: 'response', response: {} };
    terminalSent();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    throw new Error('stream failed');
  };
  let approvals = 0,
    effects = 0;
  const pending = runToolConversation({
    session: createToolSession({ prompt: 'x', tools }, f.codec),
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
    stream: true,
    approve: async () => {
      approvals++;
      return true;
    },
  });
  await terminalReady;
  assert.equal(approvals, 0);
  assert.equal(effects, 0);
  finish();
  await assert.rejects(pending);
  assert.equal(approvals, 0);
  assert.equal(effects, 0);
});
test('streamed conversation denial performs no effects or result follow-up', async () => {
  const { runToolConversation } = await import('../src/engines/tools.js');
  const f = fixture();
  let effects = 0;
  const result = await runToolConversation({
    session: createToolSession({ prompt: 'x', tools }, f.codec),
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
    stream: true,
    approve: async () => false,
  });
  assert.equal(result.status, 'approval-required');
  assert.equal(effects, 0);
  assert.equal(f.requests(), 1);
});

test('cancellation after the final buffered text prevents terminal calls and state commit', async () => {
  const f = fixture([
    { type: 'text-delta', text: 'Reviewing' },
    { type: 'response', response: {} },
  ]);
  f.codec.parse = () => ({
    turn: { ...turn, text: 'Reviewing' },
    continuation: [],
  });
  const controller = new AbortController();
  const session = createToolSession({ prompt: 'x', tools }, f.codec);
  const iterator = session.stream!({ ...request, signal: controller.signal })[
    Symbol.asyncIterator
  ]();
  assert.equal((await iterator.next()).value?.type, 'text-delta');
  controller.abort();
  await assert.rejects(iterator.next(), /cancelled/i);
  await assert.rejects(session.next(request));
});
