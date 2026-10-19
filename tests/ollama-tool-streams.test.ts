import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { ProviderError } from '../src/adapters/errors.js';
import { OllamaAdapter } from '../src/adapters/ollama.js';

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

async function withServer<T>(
  handler: Handler,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function frame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function streamFrame(
  message: Record<string, unknown> = {},
  options: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    model: 'fixture-model',
    message: { role: 'assistant', content: '', ...message },
    done: false,
    ...options,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withEnv<T>(
  name: string,
  value: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

const requestOptions = { approved: true, timeoutMs: 3000 };
const tools = [
  {
    name: 'add',
    description: 'Add two integers.',
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'integer' },
        b: { type: 'integer' },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  },
];

test('Ollama streams indexed call fragments privately, then replays thinking and approved results', async () => {
  const keyName = 'AGENTFORGE_OLLAMA_STREAM_TEST_KEY';
  const firstFrameWritten = deferred();
  const allowSecondFrame = deferred();
  const secondFrameWritten = deferred();
  const allowTerminal = deferred();
  const requests: unknown[] = [];
  let authorization: string | undefined;
  let accept: string | undefined;

  await withEnv(keyName, 'ollama-stream-fixture-secret', async () =>
    withServer(
      async (request, response) => {
        authorization = request.headers.authorization;
        accept = request.headers.accept;
        requests.push(await readJson(request));
        response.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
        });
        if (requests.length === 1) {
          const first = Buffer.from(
            frame(
              streamFrame({
                content: 'The café sums:\n',
                thinking: 'private reasoning ',
                tool_calls: [
                  {
                    type: 'function',
                    function: { index: 0, name: 'add', arguments: { a: 19 } },
                  },
                  {
                    type: 'function',
                    function: { index: 1, name: 'add', arguments: { a: 8 } },
                  },
                ],
              }),
            ),
          );
          const accent = first.indexOf(Buffer.from('é'));
          response.write(first.subarray(0, accent + 1));
          await new Promise((resolve) => setTimeout(resolve, 5));
          response.write(first.subarray(accent + 1));
          firstFrameWritten.resolve();
          await allowSecondFrame.promise;
          response.write(
            frame(
              streamFrame({
                content: 'Both calculations are ready.\n',
                thinking: 'for two calls.',
                tool_calls: [
                  {
                    type: 'function',
                    function: {
                      index: 0,
                      name: 'add',
                      arguments: { b: 23 },
                    },
                  },
                  {
                    type: 'function',
                    function: {
                      index: 1,
                      name: 'add',
                      arguments: { b: 13 },
                    },
                  },
                ],
              }),
            ),
          );
          secondFrameWritten.resolve();
          await allowTerminal.promise;
          response.write(
            frame(
              streamFrame(
                { content: '', thinking: '' },
                {
                  done: true,
                  done_reason: 'stop',
                  prompt_eval_count: 11,
                  eval_count: 5,
                },
              ),
            ),
          );
          response.end();
          return;
        }

        response.end(
          frame(
            streamFrame(
              { content: 'The sums are 42 and 21.' },
              {
                done: true,
                done_reason: 'stop',
                prompt_eval_count: 26,
                eval_count: 7,
              },
            ),
          ),
        );
      },
      async (baseUrl) => {
        const session = new OllamaAdapter({
          model: 'fixture-model',
          baseUrl,
          apiKeyEnv: keyName,
          maxOutputTokens: 31,
        }).createToolSession!({
          prompt: 'Add 19 and 23, and add 8 and 13.',
          tools,
        });
        const iterator =
          session.stream!(requestOptions)[Symbol.asyncIterator]();
        try {
          const firstEventPromise = iterator.next();
          await firstFrameWritten.promise;
          const firstEvent = await firstEventPromise;
          assert.deepEqual(firstEvent.value, {
            type: 'text-delta',
            text: 'The café sums:\n',
            provisional: true,
          });

          const secondEventPromise = iterator.next();
          allowSecondFrame.resolve();
          await secondFrameWritten.promise;
          const secondEvent = await secondEventPromise;
          assert.deepEqual(secondEvent.value, {
            type: 'text-delta',
            text: 'Both calculations are ready.\n',
            provisional: true,
          });
          assert.equal(secondEvent.done, false);

          let thirdSettled = false;
          const thirdEventPromise = iterator.next().then((event) => {
            thirdSettled = true;
            return event;
          });
          await new Promise((resolve) => setTimeout(resolve, 5));
          assert.equal(thirdSettled, false);
          allowTerminal.resolve();
          const thirdEvent = await thirdEventPromise;
          assert.equal(thirdEvent.done, false);
          assert.equal(thirdEvent.value?.type, 'complete');
          if (thirdEvent.value?.type !== 'complete')
            assert.fail('Missing completed tool turn.');
          assert.equal(thirdEvent.value.turn.finishReason, 'tool-calls');
          assert.equal(
            thirdEvent.value.turn.text,
            'The café sums:\nBoth calculations are ready.\n',
          );
          assert.deepEqual(thirdEvent.value.turn.usage, {
            status: 'available',
            inputTokens: 11,
            outputTokens: 5,
          });
          assert.deepEqual(thirdEvent.value.turn.calls, [
            { id: 'ollama-call-1', name: 'add', arguments: { a: 19, b: 23 } },
            { id: 'ollama-call-2', name: 'add', arguments: { a: 8, b: 13 } },
          ]);
          assert.equal((await iterator.next()).done, true);
          assert.equal(authorization, 'Bearer ollama-stream-fixture-secret');
          assert.equal(accept, 'application/x-ndjson');
          assert.deepEqual(requests[0], {
            model: 'fixture-model',
            messages: [
              {
                role: 'user',
                content: 'Add 19 and 23, and add 8 and 13.',
              },
            ],
            stream: true,
            options: { num_predict: 31 },
            tools: [
              {
                type: 'function',
                function: {
                  name: 'add',
                  description: 'Add two integers.',
                  parameters: tools[0]!.parameters,
                },
              },
            ],
          });

          const finalEvents = [];
          for await (const event of session.stream!({
            ...requestOptions,
            results: [
              { callId: 'ollama-call-2', output: '21' },
              { callId: 'ollama-call-1', output: '42' },
            ],
          }))
            finalEvents.push(event);
          assert.equal(finalEvents.at(-1)?.type, 'complete');
          const final = finalEvents.at(-1);
          if (final?.type !== 'complete')
            assert.fail('Missing final completed tool turn.');
          assert.equal(final.turn.text, 'The sums are 42 and 21.');
          assert.deepEqual(final.turn.usage, {
            status: 'available',
            inputTokens: 26,
            outputTokens: 7,
          });
          assert.deepEqual(requests[1], {
            model: 'fixture-model',
            messages: [
              {
                role: 'user',
                content: 'Add 19 and 23, and add 8 and 13.',
              },
              {
                role: 'assistant',
                content: 'The café sums:\nBoth calculations are ready.\n',
                thinking: 'private reasoning for two calls.',
                tool_calls: [
                  {
                    type: 'function',
                    function: {
                      index: 0,
                      name: 'add',
                      arguments: { a: 19, b: 23 },
                    },
                  },
                  {
                    type: 'function',
                    function: {
                      index: 1,
                      name: 'add',
                      arguments: { a: 8, b: 13 },
                    },
                  },
                ],
              },
              { role: 'tool', tool_name: 'add', content: '42' },
              { role: 'tool', tool_name: 'add', content: '21' },
            ],
            stream: true,
            options: { num_predict: 31 },
            tools: [
              {
                type: 'function',
                function: {
                  name: 'add',
                  description: 'Add two integers.',
                  parameters: tools[0]!.parameters,
                },
              },
            ],
          });
        } finally {
          allowSecondFrame.resolve();
          allowTerminal.resolve();
          await iterator.return?.();
        }
      },
    ),
  );
});

test('Ollama appends unindexed calls even when their function names repeat', async () => {
  await withServer(
    (_request, response) => {
      response.end(
        frame(
          streamFrame(
            {
              tool_calls: [
                {
                  type: 'function',
                  function: { name: 'add', arguments: { a: 1, b: 2 } },
                },
                {
                  type: 'function',
                  function: { name: 'add', arguments: { a: 3, b: 4 } },
                },
              ],
            },
            { done: true, done_reason: 'stop' },
          ),
        ),
      );
    },
    async (baseUrl) => {
      const turn = await collectTurn(
        new OllamaAdapter({ model: 'fixture-model', baseUrl })
          .createToolSession!({ prompt: 'Add two pairs.', tools }).stream!(
          requestOptions,
        ),
      );
      assert.deepEqual(
        turn.calls.map((call) => ({ id: call.id, arguments: call.arguments })),
        [
          { id: 'ollama-call-1', arguments: { a: 1, b: 2 } },
          { id: 'ollama-call-2', arguments: { a: 3, b: 4 } },
        ],
      );
    },
  );
});

test('Ollama rejects incomplete, malformed, conflicting, refused, and trailing tool streams without exposing calls', async (t) => {
  const toolCall = {
    type: 'function',
    function: { index: 0, name: 'add', arguments: { a: 1, b: 2 } },
  };
  const cases: Array<{
    name: string;
    frames: Record<string, unknown>[];
  }> = [
    {
      name: 'clean EOF without done=true',
      frames: [streamFrame({ tool_calls: [toolCall] })],
    },
    {
      name: 'changed model',
      frames: [
        streamFrame({ tool_calls: [toolCall] }),
        streamFrame({}, { model: 'other-model', done: true }),
      ],
    },
    {
      name: 'invalid assistant role',
      frames: [
        {
          ...streamFrame({ tool_calls: [toolCall] }),
          message: { role: 'user', content: '' },
        },
        streamFrame({}, { done: true }),
      ],
    },
    {
      name: 'raw string arguments',
      frames: [
        streamFrame({
          tool_calls: [
            {
              type: 'function',
              function: { index: 0, name: 'add', arguments: '{"a":1,"b":2}' },
            },
          ],
        }),
        streamFrame({}, { done: true }),
      ],
    },
    {
      name: 'conflicting indexed argument values',
      frames: [
        streamFrame({
          tool_calls: [
            {
              type: 'function',
              function: { index: 0, name: 'add', arguments: { a: 1 } },
            },
          ],
        }),
        streamFrame({
          tool_calls: [
            {
              type: 'function',
              function: { index: 0, name: 'add', arguments: { a: 3, b: 2 } },
            },
          ],
        }),
        streamFrame({}, { done: true }),
      ],
    },
    {
      name: 'conflicting indexed function names',
      frames: [
        streamFrame({
          tool_calls: [
            {
              type: 'function',
              function: { index: 0, name: 'add', arguments: { a: 1 } },
            },
          ],
        }),
        streamFrame({
          tool_calls: [
            {
              type: 'function',
              function: { index: 0, name: 'multiply', arguments: { b: 2 } },
            },
          ],
        }),
        streamFrame({}, { done: true }),
      ],
    },
    {
      name: 'conflicting indexed ids',
      frames: [
        streamFrame({
          tool_calls: [
            {
              id: 'call-first',
              type: 'function',
              function: { index: 0, name: 'add', arguments: { a: 1 } },
            },
          ],
        }),
        streamFrame({
          tool_calls: [
            {
              id: 'call-second',
              type: 'function',
              function: { index: 0, name: 'add', arguments: { b: 2 } },
            },
          ],
        }),
        streamFrame({}, { done: true }),
      ],
    },
    {
      name: 'more than sixteen indexed calls across frames',
      frames: [
        streamFrame({
          tool_calls: Array.from({ length: 8 }, (_, index) => ({
            type: 'function',
            function: { index, name: 'add', arguments: { a: 1, b: 2 } },
          })),
        }),
        streamFrame({
          tool_calls: Array.from({ length: 9 }, (_, index) => ({
            type: 'function',
            function: {
              index: index + 8,
              name: 'add',
              arguments: { a: 1, b: 2 },
            },
          })),
        }),
        streamFrame({}, { done: true }),
      ],
    },
    {
      name: 'incomplete arguments against the registered schema',
      frames: [
        streamFrame(
          {
            tool_calls: [
              {
                type: 'function',
                function: { index: 0, name: 'add', arguments: { a: 1 } },
              },
            ],
          },
          { done: true },
        ),
      ],
    },
    {
      name: 'tool calls on a length-limited response',
      frames: [
        streamFrame(
          { tool_calls: [toolCall] },
          { done: true, done_reason: 'length' },
        ),
      ],
    },
    {
      name: 'tool calls on a refused response',
      frames: [
        streamFrame(
          { tool_calls: [toolCall] },
          { done: true, done_reason: 'refusal' },
        ),
      ],
    },
    {
      name: 'frame after done=true',
      frames: [
        streamFrame({ tool_calls: [toolCall] }, { done: true }),
        streamFrame({ content: 'late frame' }),
      ],
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      await withServer(
        (_request, response) => {
          response.end(scenario.frames.map(frame).join(''));
        },
        async (baseUrl) => {
          const iterable = new OllamaAdapter({
            model: 'fixture-model',
            baseUrl,
          }).createToolSession!({ prompt: 'Add 1 and 2.', tools }).stream!(
            requestOptions,
          );
          const events: unknown[] = [];
          await assert.rejects(
            (async () => {
              for await (const event of iterable) events.push(event);
            })(),
            (error: unknown) => error instanceof ProviderError,
          );
          assert.equal(
            events.some(
              (event) =>
                typeof event === 'object' &&
                event !== null &&
                'type' in event &&
                event.type === 'complete',
            ),
            false,
          );
        },
      );
    });
  }
});

test('Ollama bounds nested streamed call fragments before merging them', async () => {
  const depth = 4000;
  const nestedFragment = (leaf: 'left' | 'right') =>
    `{"model":"fixture-model","message":{"role":"assistant","content":"","tool_calls":[{"type":"function","function":{"index":0,"name":"add","arguments":{"deep":${'{"next":'.repeat(depth)}{"${leaf}":1}${'}'.repeat(depth)}}}}]},"done":false}\n`;
  await withServer(
    (_request, response) => {
      response.end(
        nestedFragment('left') +
          nestedFragment('right') +
          frame(streamFrame({}, { done: true })),
      );
    },
    async (baseUrl) => {
      const iterable = new OllamaAdapter({ model: 'fixture-model', baseUrl })
        .createToolSession!({ prompt: 'Add 1 and 2.', tools }).stream!(
        requestOptions,
      );
      await assert.rejects(
        (async () => {
          for await (const event of iterable)
            assert.fail(`Unexpected stream event: ${event.type}`);
        })(),
        (error: unknown) =>
          error instanceof ProviderError && error.code === 'validation',
      );
    },
  );
});

test('Ollama cancellation closes the active HTTP stream', async () => {
  const connectionClosed = deferred();
  await withServer(
    (_request, response) => {
      response.on('close', connectionClosed.resolve);
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(frame(streamFrame({ content: 'Still working.\n' })));
    },
    async (baseUrl) => {
      const controller = new AbortController();
      const iterator = new OllamaAdapter({ model: 'fixture-model', baseUrl })
        .createToolSession!({ prompt: 'Add 1 and 2.', tools }).stream!({
        ...requestOptions,
        signal: controller.signal,
      })[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).value?.type, 'text-delta');
      controller.abort();
      await assert.rejects(
        iterator.next(),
        (error: unknown) =>
          error instanceof ProviderError && error.code === 'cancelled',
      );
      await connectionClosed.promise;
    },
  );
});

test('Ollama early iterator return closes the active HTTP stream', async () => {
  const connectionClosed = deferred();
  await withServer(
    (_request, response) => {
      response.on('close', connectionClosed.resolve);
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(frame(streamFrame({ content: 'Still working.\n' })));
    },
    async (baseUrl) => {
      const session = new OllamaAdapter({ model: 'fixture-model', baseUrl })
        .createToolSession!({ prompt: 'Add 1 and 2.', tools });
      const iterator = session.stream!(requestOptions)[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).value?.type, 'text-delta');
      await iterator.return?.();
      await connectionClosed.promise;
      await assert.rejects(session.next(requestOptions));
    },
  );
});

test('Ollama tool streaming requires approval before making a network request', async () => {
  let requests = 0;
  await withServer(
    (_request, response) => {
      requests++;
      response.end();
    },
    async (baseUrl) => {
      const iterable = new OllamaAdapter({ model: 'fixture-model', baseUrl })
        .createToolSession!({ prompt: 'Add 1 and 2.', tools }).stream!({
        approved: false,
        timeoutMs: 3000,
      });
      await assert.rejects(
        (async () => {
          for await (const event of iterable)
            assert.fail(`Unexpected stream event: ${event.type}`);
        })(),
        (error: unknown) =>
          error instanceof ProviderError && error.code === 'policy',
      );
      assert.equal(requests, 0);
    },
  );
});

async function collectTurn(
  events: AsyncIterable<{
    type: string;
    turn?: {
      calls: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      }>;
    };
  }>,
): Promise<{
  calls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
}> {
  let turn:
    | {
        calls: Array<{
          id: string;
          name: string;
          arguments: Record<string, unknown>;
        }>;
      }
    | undefined;
  for await (const event of events) {
    if (event.type === 'complete') turn = event.turn;
  }
  if (!turn) throw new Error('Missing completed tool turn.');
  return turn;
}
