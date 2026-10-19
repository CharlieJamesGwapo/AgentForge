import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { AnthropicAdapter } from '../src/adapters/anthropic.js';
import { OpenAIAdapter } from '../src/adapters/openai.js';
import { ProviderError } from '../src/adapters/errors.js';
import type { PromptStreamEvent } from '../src/adapters/types.js';

type CapturedRequest = {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage['headers'];
  body: unknown;
};

type Route = (
  request: CapturedRequest,
  response: ServerResponse,
) => void | Promise<void>;

async function withServer(
  route: Route,
  run: (baseUrl: string, requests: CapturedRequest[]) => Promise<void>,
) {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      if (text.length > 0) body = JSON.parse(text);
      const captured = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      };
      requests.push(captured);
      void route(captured, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function withCredential(
  key: string,
  value: string | undefined,
  run: () => Promise<void>,
) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

const requestOptions = { approved: true, timeoutMs: 2_000 };
const answerSchema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};

function sse(response: ServerResponse, data: unknown) {
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function responseObject(
  text: string,
  options: { status?: 'completed' | 'incomplete'; reason?: string } = {},
) {
  const status = options.status ?? 'completed';
  return {
    status,
    ...(status === 'incomplete'
      ? {
          incomplete_details: { reason: options.reason ?? 'max_output_tokens' },
        }
      : {}),
    model: 'fixture-openai-model',
    output: text
      ? [
          {
            type: 'message',
            content: [{ type: 'output_text', text }],
          },
        ]
      : [],
    usage: {
      input_tokens: 11,
      output_tokens: 7,
      input_tokens_details: { cached_tokens: 3 },
    },
  };
}

async function collect(
  events: AsyncIterable<PromptStreamEvent>,
): Promise<PromptStreamEvent[]> {
  const output: PromptStreamEvent[] = [];
  for await (const event of events) output.push(event);
  return output;
}

function doneResult(events: PromptStreamEvent[]) {
  const last = events.at(-1);
  assert.equal(last?.type, 'complete');
  return last?.type === 'complete' ? last.result : undefined;
}

test('OpenAI parses fragmented SSE, streams complete lines before terminal EOF, and keeps native usage', async () => {
  await withCredential('OPENAI_API_KEY', 'openai-stream-secret', async () => {
    let releaseTerminal!: () => void;
    const terminalGate = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    let firstFrameSent!: () => void;
    const firstFrame = new Promise<void>((resolve) => {
      firstFrameSent = resolve;
    });
    let terminalSent = false;
    await withServer(
      async (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        sse(response, {
          type: 'response.reasoning_summary_text.delta',
          delta: 'provider-private-reasoning',
        });
        const first = `data: ${JSON.stringify({
          type: 'response.output_text.delta',
          delta: 'hello\n',
        })}\n\n`;
        response.write(first.slice(0, 19));
        await new Promise((resolve) => setTimeout(resolve, 10));
        response.write(first.slice(19));
        firstFrameSent();
        await terminalGate;
        sse(response, {
          type: 'response.output_text.delta',
          delta: 'world',
        });
        sse(response, {
          type: 'response.completed',
          response: responseObject('hello\nworld'),
        });
        terminalSent = true;
        response.end();
      },
      async (baseUrl, requests) => {
        const adapter = new OpenAIAdapter({
          model: 'requested-model',
          baseUrl,
        });
        const iterator = adapter.streamPrompt!({
          prompt: 'Stream an answer.',
          ...requestOptions,
        })[Symbol.asyncIterator]();
        const first = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('first line was delayed')),
              1_500,
            ),
          ),
        ]);
        assert.equal(first.done, false);
        assert.equal(first.value?.type, 'text-delta');
        if (first.value?.type === 'text-delta') {
          assert.equal(first.value.provisional, true);
          assert.match(first.value.text, /hello/);
        }
        await firstFrame;
        assert.equal(terminalSent, false);
        assert.equal(requests[0]?.method, 'POST');
        assert.equal(requests[0]?.url, '/responses');
        assert.equal(
          requests[0]?.headers.authorization,
          'Bearer openai-stream-secret',
        );
        assert.deepEqual(requests[0]?.body, {
          model: 'requested-model',
          input: 'Stream an answer.',
          max_output_tokens: 1024,
          store: false,
          stream: true,
        });

        releaseTerminal();
        const remaining: PromptStreamEvent[] = [];
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          remaining.push(next.value);
        }
        const events = [first.value!, ...remaining];
        const result = doneResult(events);
        assert.equal(result?.text, 'hello\nworld');
        assert.equal(result?.model, 'fixture-openai-model');
        assert.deepEqual(result?.usage, {
          status: 'available',
          inputTokens: 11,
          outputTokens: 7,
          cachedInputTokens: 3,
        });
      },
    );
  });
});

test('OpenAI streams structured JSON only as provisional text and validates the terminal result', async () => {
  await withCredential(
    'OPENAI_API_KEY',
    'openai-schema-stream-secret',
    async () => {
      await withServer(
        (_request, response) => {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          sse(response, {
            type: 'response.output_text.delta',
            delta: '{"answer":"ready"}',
          });
          sse(response, {
            type: 'response.completed',
            response: responseObject('{"answer":"ready"}'),
          });
          response.end();
        },
        async (baseUrl, requests) => {
          const events = await collect(
            new OpenAIAdapter({ model: 'fixture-model', baseUrl })
              .streamPrompt!({
              prompt: 'Return JSON.',
              responseSchema: answerSchema,
              ...requestOptions,
            }),
          );
          assert.deepEqual(requests[0]?.body, {
            model: 'fixture-model',
            input: 'Return JSON.',
            max_output_tokens: 1024,
            store: false,
            stream: true,
            text: {
              format: {
                type: 'json_schema',
                name: 'agentforge_output',
                strict: true,
                schema: answerSchema,
              },
            },
          });
          assert.deepEqual(doneResult(events)?.structured, {
            status: 'valid',
            data: { answer: 'ready' },
          });
        },
      );
    },
  );
});

test('OpenAI refuses safely, reports length, and rejects failed or truncated streams', async () => {
  await withCredential(
    'OPENAI_API_KEY',
    'openai-error-stream-secret',
    async () => {
      let index = 0;
      await withServer(
        (_request, response) => {
          index += 1;
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          if (index === 1) {
            sse(response, { type: 'response.refusal.delta', delta: 'No.' });
            sse(response, {
              type: 'response.completed',
              response: {
                ...responseObject(''),
                output: [
                  {
                    type: 'message',
                    content: [{ type: 'refusal', refusal: 'No.' }],
                  },
                ],
              },
            });
          } else if (index === 2) {
            sse(response, {
              type: 'response.output_text.delta',
              delta: 'partial',
            });
            sse(response, {
              type: 'response.incomplete',
              response: responseObject('partial', { status: 'incomplete' }),
            });
          } else if (index === 3) {
            sse(response, {
              type: 'response.failed',
              response: { error: { message: 'provider-private-detail' } },
            });
          }
          response.end();
        },
        async (baseUrl) => {
          const adapter = new OpenAIAdapter({
            model: 'fixture-model',
            baseUrl,
          });
          const refusal = doneResult(
            await collect(
              adapter.streamPrompt!({ prompt: 'first', ...requestOptions }),
            ),
          );
          const partial = doneResult(
            await collect(
              adapter.streamPrompt!({ prompt: 'second', ...requestOptions }),
            ),
          );
          assert.equal(refusal?.finishReason, 'refusal');
          assert.equal(partial?.finishReason, 'length');
          await assert.rejects(
            collect(
              adapter.streamPrompt!({ prompt: 'third', ...requestOptions }),
            ),
            (error: unknown) =>
              error instanceof ProviderError &&
              !error.message.includes('provider-private-detail') &&
              !error.message.includes('openai-error-stream-secret'),
          );
          await assert.rejects(
            collect(
              adapter.streamPrompt!({ prompt: 'truncated', ...requestOptions }),
            ),
            (error: unknown) => error instanceof ProviderError,
          );
        },
      );
    },
  );
});

test('OpenAI rejects invalid structured JSON without yielding a completion event', async () => {
  await withCredential(
    'OPENAI_API_KEY',
    'openai-invalid-json-secret',
    async () => {
      await withServer(
        (_request, response) => {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          sse(response, {
            type: 'response.output_text.delta',
            delta: '{"answer":42}',
          });
          sse(response, {
            type: 'response.completed',
            response: responseObject('{"answer":42}'),
          });
          response.end();
        },
        async (baseUrl) => {
          const observed: PromptStreamEvent[] = [];
          await assert.rejects(
            (async () => {
              for await (const event of new OpenAIAdapter({
                model: 'fixture-model',
                baseUrl,
              }).streamPrompt!({
                prompt: 'Return JSON.',
                responseSchema: answerSchema,
                ...requestOptions,
              })) {
                observed.push(event);
              }
            })(),
            (error: unknown) =>
              error instanceof ProviderError && error.code === 'validation',
          );
          assert.equal(observed.length, 0);
          assert.ok(!observed.some((event) => event.type === 'complete'));
        },
      );
    },
  );
});

function anthropicEvent(
  response: ServerResponse,
  type: string,
  rest: Record<string, unknown> = {},
) {
  sse(response, { type, ...rest });
}

function anthropicStart(response: ServerResponse) {
  anthropicEvent(response, 'message_start', {
    message: {
      type: 'message',
      model: 'fixture-anthropic-model',
      content: [],
      usage: {
        input_tokens: 10,
        output_tokens: 0,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 2,
      },
    },
  });
}

function anthropicTextBlock(response: ServerResponse, text: string, index = 0) {
  anthropicEvent(response, 'content_block_start', {
    index,
    content_block: { type: 'text', text: '' },
  });
  anthropicEvent(response, 'content_block_delta', {
    index,
    delta: { type: 'text_delta', text },
  });
  anthropicEvent(response, 'content_block_stop', { index });
}

function anthropicFinish(
  response: ServerResponse,
  stopReason: 'end_turn' | 'max_tokens' | 'refusal',
  outputTokens = 6,
) {
  anthropicEvent(response, 'message_delta', {
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  anthropicEvent(response, 'message_stop');
}

test('Anthropic assembles ordered text blocks and cumulative cache-aware usage', async () => {
  await withCredential(
    'ANTHROPIC_API_KEY',
    'anthropic-stream-secret',
    async () => {
      await withServer(
        (_request, response) => {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          anthropicStart(response);
          anthropicEvent(response, 'content_block_start', {
            index: 0,
            content_block: { type: 'thinking', thinking: '' },
          });
          anthropicEvent(response, 'content_block_delta', {
            index: 0,
            delta: {
              type: 'thinking_delta',
              thinking: 'provider-private-reasoning',
            },
          });
          anthropicEvent(response, 'content_block_stop', { index: 0 });
          anthropicTextBlock(response, 'first block ', 1);
          anthropicEvent(response, 'content_block_start', {
            index: 2,
            content_block: { type: 'text', text: '' },
          });
          anthropicEvent(response, 'content_block_delta', {
            index: 2,
            delta: { type: 'text_delta', text: 'second block' },
          });
          anthropicEvent(response, 'content_block_stop', { index: 2 });
          anthropicEvent(response, 'message_delta', {
            delta: { stop_reason: null, stop_sequence: null },
            usage: { output_tokens: 4 },
          });
          anthropicFinish(response, 'end_turn');
          response.end();
        },
        async (baseUrl, requests) => {
          const events = await collect(
            new AnthropicAdapter({ model: 'requested-model', baseUrl })
              .streamPrompt!({
              prompt: 'Stream this.',
              ...requestOptions,
            }),
          );
          assert.equal(requests[0]?.url, '/messages');
          assert.equal(
            requests[0]?.headers['x-api-key'],
            'anthropic-stream-secret',
          );
          assert.equal(requests[0]?.headers['anthropic-version'], '2023-06-01');
          assert.deepEqual(requests[0]?.body, {
            model: 'requested-model',
            messages: [{ role: 'user', content: 'Stream this.' }],
            max_tokens: 1024,
            stream: true,
          });
          const result = doneResult(events);
          assert.equal(result?.text, 'first block second block');
          assert.ok(
            events.every(
              (event) =>
                event.type !== 'text-delta' ||
                !event.text.includes('provider-private-reasoning'),
            ),
          );
          assert.deepEqual(result?.usage, {
            status: 'available',
            inputTokens: 16,
            outputTokens: 6,
            cachedInputTokens: 4,
            cacheCreationInputTokens: 2,
          });
        },
      );
    },
  );
});

test('Anthropic sends JSON output configuration and withholds structured deltas until validation', async () => {
  await withCredential(
    'ANTHROPIC_API_KEY',
    'anthropic-schema-stream-secret',
    async () => {
      await withServer(
        (_request, response) => {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          anthropicStart(response);
          anthropicTextBlock(response, '{"answer":"ready"}');
          anthropicFinish(response, 'end_turn', 2);
          response.end();
        },
        async (baseUrl, requests) => {
          const events = await collect(
            new AnthropicAdapter({ model: 'fixture-model', baseUrl })
              .streamPrompt!({
              prompt: 'Return JSON.',
              responseSchema: answerSchema,
              ...requestOptions,
            }),
          );
          assert.deepEqual(requests[0]?.body, {
            model: 'fixture-model',
            messages: [{ role: 'user', content: 'Return JSON.' }],
            max_tokens: 1024,
            stream: true,
            output_config: {
              format: { type: 'json_schema', schema: answerSchema },
            },
          });
          assert.deepEqual(events, [
            {
              type: 'complete',
              result: {
                text: '{"answer":"ready"}',
                model: 'fixture-anthropic-model',
                finishReason: 'completed',
                usage: {
                  status: 'available',
                  inputTokens: 16,
                  outputTokens: 2,
                  cachedInputTokens: 4,
                  cacheCreationInputTokens: 2,
                },
                structured: {
                  status: 'valid',
                  data: { answer: 'ready' },
                },
              },
            },
          ]);
        },
      );
    },
  );
});

test('Anthropic maps refusal and token-limit stops to terminal results', async () => {
  await withCredential(
    'ANTHROPIC_API_KEY',
    'anthropic-finish-secret',
    async () => {
      let index = 0;
      await withServer(
        (_request, response) => {
          index += 1;
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          anthropicStart(response);
          anthropicTextBlock(
            response,
            index === 1 ? 'I cannot help.' : 'partial',
          );
          anthropicFinish(response, index === 1 ? 'refusal' : 'max_tokens');
          response.end();
        },
        async (baseUrl) => {
          const adapter = new AnthropicAdapter({
            model: 'fixture-model',
            baseUrl,
          });
          const refusal = doneResult(
            await collect(
              adapter.streamPrompt!({ prompt: 'first', ...requestOptions }),
            ),
          );
          const length = doneResult(
            await collect(
              adapter.streamPrompt!({ prompt: 'second', ...requestOptions }),
            ),
          );
          assert.equal(refusal?.finishReason, 'refusal');
          assert.equal(length?.finishReason, 'length');
        },
      );
    },
  );
});

test('Anthropic rejects out-of-order blocks, tool use, provider errors, and EOF without message_stop', async () => {
  await withCredential(
    'ANTHROPIC_API_KEY',
    'anthropic-failure-secret',
    async () => {
      let index = 0;
      await withServer(
        (_request, response) => {
          index += 1;
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          if (index === 1) {
            anthropicStart(response);
            anthropicEvent(response, 'content_block_start', {
              index: 0,
              content_block: { type: 'text', text: '' },
            });
            anthropicEvent(response, 'content_block_delta', {
              index: 1,
              delta: { type: 'text_delta', text: 'wrong index' },
            });
          } else if (index === 2) {
            anthropicStart(response);
            anthropicEvent(response, 'content_block_start', {
              index: 0,
              content_block: {
                type: 'tool_use',
                id: 'toolu_private',
                name: 'lookup',
              },
            });
          } else if (index === 3) {
            anthropicEvent(response, 'error', {
              error: { message: 'anthropic-private-detail' },
            });
          } else if (index === 4) {
            anthropicStart(response);
            anthropicTextBlock(response, 'truncated');
          } else {
            anthropicStart(response);
            anthropicEvent(response, 'message_delta', {
              delta: { stop_reason: null },
              usage: { output_tokens: 1 },
            });
            anthropicEvent(response, 'content_block_start', {
              index: 0,
              content_block: { type: 'text', text: '' },
            });
          }
          response.end();
        },
        async (baseUrl) => {
          const adapter = new AnthropicAdapter({
            model: 'fixture-model',
            baseUrl,
          });
          for (const prompt of [
            'out-of-order',
            'tool-use',
            'error',
            'truncated',
            'late-content',
          ]) {
            const yielded: PromptStreamEvent[] = [];
            await assert.rejects(
              (async () => {
                for await (const event of adapter.streamPrompt!({
                  prompt,
                  ...requestOptions,
                })) {
                  yielded.push(event);
                }
              })(),
              (error: unknown) =>
                error instanceof ProviderError &&
                !error.message.includes('anthropic-private-detail') &&
                !error.message.includes('toolu_private') &&
                !yielded.some((event) => event.type === 'complete'),
            );
          }
        },
      );
    },
  );
});

test('a consumer can cancel a hosted stream after receiving a text line', async () => {
  await withCredential('OPENAI_API_KEY', 'openai-cancel-secret', async () => {
    let closed!: () => void;
    const connectionClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    await withServer(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        sse(response, {
          type: 'response.output_text.delta',
          delta: 'ready to cancel\n',
        });
        response.on('close', closed);
      },
      async (baseUrl) => {
        const iterator = new OpenAIAdapter({ model: 'fixture-model', baseUrl })
          .streamPrompt!({ prompt: 'cancel', ...requestOptions })[
          Symbol.asyncIterator
        ]();
        const first = await iterator.next();
        assert.equal(first.done, false);
        assert.equal(first.value?.type, 'text-delta');
        await iterator.return?.();
        await Promise.race([
          connectionClosed,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('server connection stayed open')),
              1_500,
            ),
          ),
        ]);
      },
    );
  });
});

test('OpenAI terminal event names must agree with the response status', async () => {
  await withCredential('OPENAI_API_KEY', 'terminal-contract-key', async () => {
    for (const [type, status] of [
      ['response.incomplete', 'completed'],
      ['response.completed', 'incomplete'],
    ] as const) {
      await withServer(
        (_request, response) => {
          response.setHeader('Content-Type', 'text/event-stream');
          sse(response, {
            type,
            response: responseObject('answer', { status }),
          });
          response.end();
        },
        async (baseUrl) => {
          const adapter = new OpenAIAdapter({ model: 'fixture', baseUrl });
          await assert.rejects(
            async () => {
              for await (const event of adapter.streamPrompt({
                prompt: 'task',
                ...requestOptions,
              }))
                void event;
            },
            { code: 'invalid-response' },
          );
        },
      );
    }
  });
});
