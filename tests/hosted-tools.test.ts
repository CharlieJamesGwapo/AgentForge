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

function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

const requestOptions = { approved: true, timeoutMs: 2_000 };
const placeSchema = {
  type: 'object',
  properties: { place: { type: 'string' } },
  required: ['place'],
  additionalProperties: false,
};
const tools = [
  {
    name: 'lookup_weather',
    description: 'Look up weather for a place.',
    parameters: placeSchema,
  },
];

function openAIToolResponse() {
  return {
    status: 'completed',
    model: 'fixture-openai-model',
    output: [
      {
        id: 'rs_1',
        type: 'reasoning',
        summary: [],
        encrypted_content: 'opaque-reasoning-envelope',
      },
      {
        id: 'fc_item_1',
        type: 'function_call',
        status: 'completed',
        call_id: 'call_1',
        name: 'lookup_weather',
        arguments: '{"place":"Paris"}',
      },
      {
        id: 'fc_item_2',
        type: 'function_call',
        status: 'completed',
        call_id: 'call_2',
        name: 'lookup_weather',
        arguments: '{"place":"Manila"}',
      },
    ],
    usage: { input_tokens: 21, output_tokens: 8 },
  };
}

function anthropicToolResponse() {
  return {
    type: 'message',
    model: 'fixture-anthropic-model',
    role: 'assistant',
    content: [
      {
        type: 'thinking',
        thinking: 'private continuation state',
        signature: 'signed-thinking-state',
      },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'lookup_weather',
        input: { place: 'Paris' },
      },
      {
        type: 'tool_use',
        id: 'toolu_2',
        name: 'lookup_weather',
        input: { place: 'Manila' },
      },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 15, output_tokens: 9 },
  };
}

test('OpenAI exposes calls without executing tools, then replays complete reasoning and results', async () => {
  await withCredential('OPENAI_API_KEY', 'openai-tools-secret', async () => {
    let callsInRun = 0;
    await withServer(
      (_request, response) => {
        if (callsInRun++ === 0) json(response, openAIToolResponse());
        else
          json(response, {
            status: 'completed',
            model: 'fixture-openai-model',
            output: [
              {
                type: 'message',
                id: 'msg_final',
                status: 'completed',
                role: 'assistant',
                content: [
                  { type: 'output_text', text: 'Both checks are ready.' },
                ],
              },
            ],
            usage: { input_tokens: 31, output_tokens: 5 },
          });
      },
      async (baseUrl, requests) => {
        const adapter = new OpenAIAdapter({
          model: 'fixture-openai-requested',
          baseUrl,
          maxOutputTokens: 77,
        });
        assert.equal(adapter.capabilities().toolInvocation, true);
        const session = adapter.createToolSession!({
          prompt: 'Check both places.',
          tools,
        });
        const first = await session.next(requestOptions);

        assert.deepEqual(first, {
          text: '',
          model: 'fixture-openai-model',
          finishReason: 'tool-calls',
          usage: { status: 'available', inputTokens: 21, outputTokens: 8 },
          calls: [
            {
              id: 'call_1',
              name: 'lookup_weather',
              arguments: { place: 'Paris' },
            },
            {
              id: 'call_2',
              name: 'lookup_weather',
              arguments: { place: 'Manila' },
            },
          ],
        });
        assert.equal(requests.length, 1);
        assert.deepEqual(requests[0]?.body, {
          model: 'fixture-openai-requested',
          input: [{ role: 'user', content: 'Check both places.' }],
          max_output_tokens: 77,
          store: false,
          stream: false,
          include: ['reasoning.encrypted_content'],
          tools: [
            {
              type: 'function',
              name: 'lookup_weather',
              description: 'Look up weather for a place.',
              parameters: placeSchema,
              strict: true,
            },
          ],
        });

        const final = await session.next({
          ...requestOptions,
          results: [
            { callId: 'call_1', output: 'sunny' },
            { callId: 'call_2', output: 'cloudy' },
          ],
        });
        assert.deepEqual(final, {
          text: 'Both checks are ready.',
          model: 'fixture-openai-model',
          finishReason: 'completed',
          usage: { status: 'available', inputTokens: 31, outputTokens: 5 },
          calls: [],
        });
        assert.equal(requests.length, 2);
        assert.deepEqual(requests[1]?.body, {
          model: 'fixture-openai-requested',
          input: [
            { role: 'user', content: 'Check both places.' },
            openAIToolResponse().output[0],
            openAIToolResponse().output[1],
            openAIToolResponse().output[2],
            {
              type: 'function_call_output',
              call_id: 'call_1',
              output: 'sunny',
            },
            {
              type: 'function_call_output',
              call_id: 'call_2',
              output: 'cloudy',
            },
          ],
          max_output_tokens: 77,
          store: false,
          stream: false,
          include: ['reasoning.encrypted_content'],
          tools: [
            {
              type: 'function',
              name: 'lookup_weather',
              description: 'Look up weather for a place.',
              parameters: placeSchema,
              strict: true,
            },
          ],
        });
        assert.equal(requests[0]?.url, '/responses');
        assert.equal(
          requests[0]?.headers.authorization,
          'Bearer openai-tools-secret',
        );
      },
    );
  });
});

test('Anthropic preserves signed thinking and sends every tool result in one user message', async () => {
  await withCredential(
    'ANTHROPIC_API_KEY',
    'anthropic-tools-secret',
    async () => {
      let callsInRun = 0;
      await withServer(
        (_request, response) => {
          if (callsInRun++ === 0) json(response, anthropicToolResponse());
          else
            json(response, {
              type: 'message',
              model: 'fixture-anthropic-model',
              role: 'assistant',
              content: [{ type: 'text', text: 'Both checks are ready.' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 22, output_tokens: 4 },
            });
        },
        async (baseUrl, requests) => {
          const adapter = new AnthropicAdapter({
            model: 'fixture-anthropic-requested',
            baseUrl,
            maxOutputTokens: 77,
          });
          assert.equal(adapter.capabilities().toolInvocation, true);
          const session = adapter.createToolSession!({
            prompt: 'Check both places.',
            tools,
          });
          const first = await session.next(requestOptions);

          assert.deepEqual(first, {
            text: '',
            model: 'fixture-anthropic-model',
            finishReason: 'tool-calls',
            usage: { status: 'available', inputTokens: 15, outputTokens: 9 },
            calls: [
              {
                id: 'toolu_1',
                name: 'lookup_weather',
                arguments: { place: 'Paris' },
              },
              {
                id: 'toolu_2',
                name: 'lookup_weather',
                arguments: { place: 'Manila' },
              },
            ],
          });
          assert.equal(requests.length, 1);
          assert.deepEqual(requests[0]?.body, {
            model: 'fixture-anthropic-requested',
            messages: [{ role: 'user', content: 'Check both places.' }],
            max_tokens: 77,
            stream: false,
            tools: [
              {
                name: 'lookup_weather',
                description: 'Look up weather for a place.',
                input_schema: placeSchema,
                strict: true,
              },
            ],
          });

          const final = await session.next({
            ...requestOptions,
            results: [
              { callId: 'toolu_1', output: 'sunny', isError: true },
              { callId: 'toolu_2', output: 'cloudy' },
            ],
          });
          assert.deepEqual(final, {
            text: 'Both checks are ready.',
            model: 'fixture-anthropic-model',
            finishReason: 'completed',
            usage: { status: 'available', inputTokens: 22, outputTokens: 4 },
            calls: [],
          });
          assert.equal(requests.length, 2);
          assert.deepEqual(requests[1]?.body, {
            model: 'fixture-anthropic-requested',
            messages: [
              { role: 'user', content: 'Check both places.' },
              { role: 'assistant', content: anthropicToolResponse().content },
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'toolu_1',
                    content: 'sunny',
                    is_error: true,
                  },
                  {
                    type: 'tool_result',
                    tool_use_id: 'toolu_2',
                    content: 'cloudy',
                  },
                ],
              },
            ],
            max_tokens: 77,
            stream: false,
            tools: [
              {
                name: 'lookup_weather',
                description: 'Look up weather for a place.',
                input_schema: placeSchema,
                strict: true,
              },
            ],
          });
          assert.equal(requests[0]?.url, '/messages');
          assert.equal(
            requests[0]?.headers['x-api-key'],
            'anthropic-tools-secret',
          );
          assert.equal(requests[0]?.headers['anthropic-version'], '2023-06-01');
        },
      );
    },
  );
});

test('OpenAI rejects a partial response that contains a function call', async () => {
  await withCredential('OPENAI_API_KEY', 'openai-partial-secret', async () => {
    await withServer(
      (_request, response) =>
        json(response, {
          ...openAIToolResponse(),
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
        }),
      async (baseUrl) => {
        const session = new OpenAIAdapter({ model: 'fixture-model', baseUrl })
          .createToolSession!({ prompt: 'Check weather.', tools });
        await assert.rejects(
          session.next(requestOptions),
          (error: unknown) =>
            error instanceof ProviderError && error.code === 'invalid-response',
        );
      },
    );
  });
});

test('OpenAI rejects malformed function arguments without exposing a call', async () => {
  await withCredential(
    'OPENAI_API_KEY',
    'openai-malformed-secret',
    async () => {
      await withServer(
        (_request, response) =>
          json(response, {
            status: 'completed',
            model: 'fixture-openai-model',
            output: [
              {
                type: 'function_call',
                call_id: 'call_bad',
                name: 'lookup_weather',
                arguments: '{not json',
              },
            ],
          }),
        async (baseUrl) => {
          const session = new OpenAIAdapter({ model: 'fixture-model', baseUrl })
            .createToolSession!({ prompt: 'Check weather.', tools });
          await assert.rejects(
            session.next(requestOptions),
            (error: unknown) =>
              error instanceof ProviderError &&
              error.code === 'invalid-response',
          );
        },
      );
    },
  );
});

test('Anthropic rejects server-owned tool blocks', async () => {
  await withCredential(
    'ANTHROPIC_API_KEY',
    'anthropic-server-tool-secret',
    async () => {
      await withServer(
        (_request, response) =>
          json(response, {
            type: 'message',
            model: 'fixture-anthropic-model',
            role: 'assistant',
            content: [
              {
                type: 'server_tool_use',
                id: 'srvtoolu_1',
                name: 'web_search',
                input: { query: 'weather' },
              },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 7, output_tokens: 2 },
          }),
        async (baseUrl) => {
          const session = new AnthropicAdapter({
            model: 'fixture-model',
            baseUrl,
          }).createToolSession!({ prompt: 'Check weather.', tools });
          await assert.rejects(
            session.next(requestOptions),
            (error: unknown) =>
              error instanceof ProviderError &&
              error.code === 'invalid-response',
          );
        },
      );
    },
  );
});

test('hosted adapters reject refusal, length and unknown server output mixed with client calls', async () => {
  await withCredential(
    'OPENAI_API_KEY',
    'openai-invalid-turn-secret',
    async () => {
      await withCredential(
        'ANTHROPIC_API_KEY',
        'anthropic-invalid-turn-secret',
        async () => {
          const fixtures: Array<{
            provider: 'openai' | 'anthropic';
            response: unknown;
          }> = [
            {
              provider: 'openai',
              response: {
                status: 'completed',
                model: 'fixture-openai-model',
                output: [
                  {
                    type: 'message',
                    content: [{ type: 'refusal', refusal: 'Cannot comply.' }],
                  },
                  {
                    type: 'function_call',
                    call_id: 'call_refused',
                    name: 'lookup_weather',
                    arguments: '{"place":"Paris"}',
                  },
                ],
              },
            },
            {
              provider: 'openai',
              response: {
                status: 'completed',
                model: 'fixture-openai-model',
                output: [
                  {
                    type: 'web_search_call',
                    id: 'srv_search_1',
                    status: 'completed',
                  },
                ],
              },
            },
            {
              provider: 'anthropic',
              response: {
                type: 'message',
                model: 'fixture-anthropic-model',
                content: [
                  {
                    type: 'tool_use',
                    id: 'toolu_partial',
                    name: 'lookup_weather',
                    input: { place: 'Paris' },
                  },
                ],
                stop_reason: 'max_tokens',
                usage: { input_tokens: 7, output_tokens: 2 },
              },
            },
            {
              provider: 'anthropic',
              response: {
                type: 'message',
                model: 'fixture-anthropic-model',
                content: [
                  {
                    type: 'tool_use',
                    id: 'toolu_refused',
                    name: 'lookup_weather',
                    input: { place: 'Paris' },
                  },
                ],
                stop_reason: 'refusal',
                usage: { input_tokens: 7, output_tokens: 2 },
              },
            },
          ];

          for (const fixture of fixtures) {
            await withServer(
              (_request, response) => json(response, fixture.response),
              async (baseUrl) => {
                const adapter =
                  fixture.provider === 'openai'
                    ? new OpenAIAdapter({ model: 'fixture-model', baseUrl })
                    : new AnthropicAdapter({ model: 'fixture-model', baseUrl });
                const session = adapter.createToolSession!({
                  prompt: 'Check weather.',
                  tools,
                });
                await assert.rejects(
                  session.next(requestOptions),
                  (error: unknown) =>
                    error instanceof ProviderError &&
                    error.code === 'invalid-response',
                );
              },
            );
          }
        },
      );
    },
  );
});

test('provider authentication errors omit response details and credentials', async () => {
  await withCredential('OPENAI_API_KEY', 'openai-http-secret', async () => {
    await withServer(
      (_request, response) =>
        json(response, { error: 'openai-http-secret must not escape' }, 401),
      async (baseUrl) => {
        const session = new OpenAIAdapter({ model: 'fixture-model', baseUrl })
          .createToolSession!({ prompt: 'Check weather.', tools });
        await assert.rejects(
          session.next(requestOptions),
          (error: unknown) =>
            error instanceof ProviderError &&
            error.code === 'authentication' &&
            !error.message.includes('openai-http-secret'),
        );
      },
    );
  });
});

test('tool results containing a credential are redacted before another provider request', async () => {
  await withCredential(
    'OPENAI_API_KEY',
    'openai-redaction-secret',
    async () => {
      await withServer(
        (_request, response) => json(response, openAIToolResponse()),
        async (baseUrl, requests) => {
          const session = new OpenAIAdapter({ model: 'fixture-model', baseUrl })
            .createToolSession!({ prompt: 'Check weather.', tools });
          await session.next(requestOptions);
          assert.equal(requests.length, 1);
          await session.next({
            ...requestOptions,
            results: [
              { callId: 'call_1', output: 'openai-redaction-secret' },
              { callId: 'call_2', output: 'safe result' },
            ],
          });
          assert.equal(requests.length, 2);
          const resent = requests[1]?.body as {
            input: Array<Record<string, unknown>>;
          };
          assert.deepEqual(resent.input.slice(-2), [
            {
              type: 'function_call_output',
              call_id: 'call_1',
              output: '[REDACTED]',
            },
            {
              type: 'function_call_output',
              call_id: 'call_2',
              output: 'safe result',
            },
          ]);
          assert.equal(
            JSON.stringify(resent).includes('openai-redaction-secret'),
            false,
          );
        },
      );
    },
  );
});

test('tool sessions require configured credentials before creating a session', async () => {
  await withCredential('ANTHROPIC_API_KEY', undefined, async () => {
    const adapter = new AnthropicAdapter({ model: 'fixture-model' });
    assert.throws(
      () => adapter.createToolSession!({ prompt: 'Check weather.', tools }),
      (error: unknown) =>
        error instanceof ProviderError && error.code === 'authentication',
    );
  });
});

test('malformed native continuation blocks stop before approval or tool effects', async () => {
  const { runToolConversation } = await import('../src/engines/tools.js');
  await withCredential('OPENAI_API_KEY', 'continuation-test-key', async () =>
    withCredential('ANTHROPIC_API_KEY', 'continuation-test-key', async () => {
      const fixtures: Array<{
        provider: 'openai' | 'anthropic';
        response: unknown;
      }> = [];
      for (const reasoning of [
        { type: 'reasoning', id: 'rs_1', summary: 'malformed' },
        { type: 'reasoning', summary: [] },
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 4 }],
        },
        { type: 'reasoning', id: 'rs_1', summary: [], status: 'in_progress' },
        { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 4 },
      ])
        fixtures.push({
          provider: 'openai',
          response: {
            ...openAIToolResponse(),
            output: [reasoning, ...openAIToolResponse().output.slice(1)],
          },
        });
      fixtures.push({
        provider: 'anthropic',
        response: {
          ...anthropicToolResponse(),
          content: [
            { type: 'thinking', thinking: 'missing signature' },
            ...anthropicToolResponse().content.slice(1),
          ],
        },
      });
      for (const message of [
        { id: 'm1', role: 'system', status: 'completed' },
        { id: 'm1', role: 'assistant', status: 'in_progress' },
        { role: 'assistant', status: 'completed' },
      ])
        fixtures.push({
          provider: 'openai',
          response: {
            ...openAIToolResponse(),
            output: [
              {
                type: 'message',
                ...message,
                content: [
                  {
                    type: 'output_text',
                    text: 'side message',
                    annotations: [],
                  },
                ],
              },
              ...openAIToolResponse().output.slice(1),
            ],
          },
        });
      for (const fixture of fixtures)
        await withServer(
          (_request, response) => json(response, fixture.response),
          async (baseUrl) => {
            let effects = 0,
              approvals = 0;
            const adapter =
              fixture.provider === 'openai'
                ? new OpenAIAdapter({ model: 'fixture', baseUrl })
                : new AnthropicAdapter({ model: 'fixture', baseUrl });
            await assert.rejects(
              runToolConversation({
                session: adapter.createToolSession({ prompt: 'Check', tools }),
                tools: [
                  {
                    definition: tools[0]!,
                    execute: async () => {
                      effects++;
                      return 'ok';
                    },
                  },
                ],
                request: requestOptions,
                approve: async () => {
                  approvals++;
                  return true;
                },
              }),
            );
            assert.equal(effects, 0);
            assert.equal(approvals, 0);
          },
        );
    }),
  );
});
