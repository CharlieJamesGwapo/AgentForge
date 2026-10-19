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
import type {
  ProviderAdapter,
  ToolDefinition,
  ToolTurn,
} from '../src/adapters/types.js';

type ProviderName = 'openai' | 'anthropic';
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

const providers: ProviderName[] = ['openai', 'anthropic'];
const requestOptions = { approved: true, timeoutMs: 2_000 };
const responseSchema: Record<string, unknown> = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};
const parameters = {
  type: 'object',
  properties: { place: { type: 'string' } },
  required: ['place'],
  additionalProperties: false,
};
const tools: ToolDefinition[] = [
  {
    name: 'lookup_weather',
    description: 'Look up weather for a place.',
    parameters,
  },
];

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
      const captured = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: text.length ? (JSON.parse(text) as unknown) : undefined,
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
  provider: ProviderName,
  run: () => Promise<void>,
) {
  const key = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  const previous = process.env[key];
  process.env[key] = `${provider}-combined-secret`;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

function makeAdapter(provider: ProviderName, baseUrl: string): ProviderAdapter {
  return provider === 'openai'
    ? new OpenAIAdapter({ model: 'fixture-model', baseUrl })
    : new AnthropicAdapter({ model: 'fixture-model', baseUrl });
}

function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function sse(response: ServerResponse, value: unknown) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function toolResponse(provider: ProviderName) {
  if (provider === 'openai') {
    return {
      status: 'completed',
      model: 'fixture-model',
      output: [
        {
          id: 'rs_1',
          type: 'reasoning',
          summary: [],
          encrypted_content: 'private-openai-reasoning',
        },
        {
          id: 'fc_1',
          type: 'function_call',
          status: 'completed',
          call_id: 'call_1',
          name: 'lookup_weather',
          arguments: '{"place":"Paris"}',
        },
      ],
      usage: { input_tokens: 2, output_tokens: 2 },
    };
  }
  return {
    type: 'message',
    model: 'fixture-model',
    role: 'assistant',
    content: [
      {
        type: 'thinking',
        thinking: 'private anthropic reasoning',
        signature: 'signed-thinking-state',
      },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'lookup_weather',
        input: { place: 'Paris' },
      },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 2, output_tokens: 2 },
  };
}

function finalResponse(provider: ProviderName, text: string) {
  if (provider === 'openai') {
    return {
      status: 'completed',
      model: 'fixture-model',
      output: [
        {
          id: 'msg_final',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        },
      ],
      usage: { input_tokens: 3, output_tokens: 2 },
    };
  }
  return {
    type: 'message',
    model: 'fixture-model',
    role: 'assistant',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 2 },
  };
}

function combinedField(provider: ProviderName) {
  return provider === 'openai'
    ? {
        text: {
          format: {
            type: 'json_schema',
            name: 'agentforge_output',
            strict: true,
            schema: responseSchema,
          },
        },
      }
    : {
        output_config: {
          format: { type: 'json_schema', schema: responseSchema },
        },
      };
}

function toolField(provider: ProviderName) {
  return provider === 'openai'
    ? [
        {
          type: 'function',
          name: 'lookup_weather',
          description: 'Look up weather for a place.',
          parameters,
          strict: true,
        },
      ]
    : [
        {
          name: 'lookup_weather',
          description: 'Look up weather for a place.',
          input_schema: parameters,
          strict: true,
        },
      ];
}

function assertCombinedRequest(
  provider: ProviderName,
  request: CapturedRequest | undefined,
  streaming: boolean,
) {
  assert.ok(request);
  const body = request.body as Record<string, unknown>;
  assert.deepEqual(
    provider === 'openai'
      ? { text: body.text }
      : { output_config: body.output_config },
    combinedField(provider),
  );
  assert.deepEqual(body.tools, toolField(provider));
  assert.equal(body.stream, streaming);
}

function completedTurn(
  events: ToolTurn[] | { type: string; turn?: ToolTurn }[],
) {
  const last = events.at(-1);
  if (last && 'turn' in last) return last.turn;
  return undefined;
}

test('ordinary hosted tool turns combine strict tools and final schemas, then validate final JSON', async () => {
  for (const provider of providers) {
    await withCredential(provider, async () => {
      let requestCount = 0;
      await withServer(
        (_request, response) => {
          if (requestCount++ === 0) json(response, toolResponse(provider));
          else json(response, finalResponse(provider, '{"answer":"ready"}'));
        },
        async (baseUrl, requests) => {
          const sourceSchema = structuredClone(responseSchema);
          const session = makeAdapter(provider, baseUrl).createToolSession!({
            prompt: 'Check Paris and report the result as JSON.',
            tools,
            responseSchema: sourceSchema,
          });
          (
            sourceSchema.properties as Record<string, Record<string, unknown>>
          ).answer!.type = 'integer';

          const first = await session.next(requestOptions);
          assert.equal(first.finishReason, 'tool-calls');
          assert.deepEqual(first.structured, {
            status: 'pending',
            reason: 'tool-calls',
          });
          assert.deepEqual(first.calls, [
            {
              id: provider === 'openai' ? 'call_1' : 'toolu_1',
              name: 'lookup_weather',
              arguments: { place: 'Paris' },
            },
          ]);
          assertCombinedRequest(provider, requests[0], false);

          (
            sourceSchema.properties as Record<string, Record<string, unknown>>
          ).answer!.type = 'boolean';
          const final = await session.next({
            ...requestOptions,
            results: [
              {
                callId: provider === 'openai' ? 'call_1' : 'toolu_1',
                output: 'sunny',
              },
            ],
          });
          assert.equal(final.finishReason, 'completed');
          assertCombinedRequest(provider, requests[1], false);
          const finalBody = requests[1]?.body as Record<string, unknown>;
          assert.deepEqual(
            provider === 'openai'
              ? (finalBody.input as unknown[])[1]
              : (finalBody.messages as unknown[])[1],
            provider === 'openai'
              ? {
                  id: 'rs_1',
                  type: 'reasoning',
                  summary: [],
                  encrypted_content: 'private-openai-reasoning',
                }
              : {
                  role: 'assistant',
                  content: [
                    {
                      type: 'thinking',
                      thinking: 'private anthropic reasoning',
                      signature: 'signed-thinking-state',
                    },
                    {
                      type: 'tool_use',
                      id: 'toolu_1',
                      name: 'lookup_weather',
                      input: { place: 'Paris' },
                    },
                  ],
                },
          );
          assert.deepEqual(final.structured, {
            status: 'valid',
            data: { answer: 'ready' },
          });
        },
      );
    });
  }
});

test('denying approval blocks the tool-result follow-up before another request', async () => {
  for (const provider of providers) {
    await withCredential(provider, async () => {
      let requestCount = 0;
      await withServer(
        (_request, response) => {
          requestCount++;
          json(response, toolResponse(provider));
        },
        async (baseUrl, requests) => {
          const session = makeAdapter(provider, baseUrl).createToolSession!({
            prompt: 'Check Paris.',
            tools,
            responseSchema,
          });
          await session.next(requestOptions);
          await assert.rejects(
            session.next({
              approved: false,
              timeoutMs: 2_000,
              results: [
                {
                  callId: provider === 'openai' ? 'call_1' : 'toolu_1',
                  output: 'sunny',
                },
              ],
            }),
            (error: unknown) =>
              error instanceof ProviderError && error.code === 'policy',
          );
          assert.equal(requestCount, 1);
          assert.equal(requests.length, 1);
        },
      );
    });
  }
});

test('invalid final structured JSON is rejected without echoing the provider payload', async () => {
  const invalidPayload = '{"answer":"private-output-marker", broken}';
  for (const provider of providers) {
    await withCredential(provider, async () => {
      let requestCount = 0;
      await withServer(
        (_request, response) => {
          if (requestCount++ === 0) json(response, toolResponse(provider));
          else json(response, finalResponse(provider, invalidPayload));
        },
        async (baseUrl, requests) => {
          const session = makeAdapter(provider, baseUrl).createToolSession!({
            prompt: 'Check Paris.',
            tools,
            responseSchema,
          });
          await session.next(requestOptions);
          await assert.rejects(
            session.next({
              ...requestOptions,
              results: [
                {
                  callId: provider === 'openai' ? 'call_1' : 'toolu_1',
                  output: 'sunny',
                },
              ],
            }),
            (error: unknown) => {
              assert.ok(error instanceof ProviderError);
              assert.equal(error.code, 'validation');
              assert.equal(
                error.message.includes('private-output-marker'),
                false,
              );
              return true;
            },
          );
          assert.equal(requests.length, 2);
        },
      );
    });
  }
});

function streamToolCall(response: ServerResponse, id: string) {
  const call = {
    id: 'fc_1',
    type: 'function_call',
    status: 'completed',
    call_id: 'call_1',
    name: 'lookup_weather',
    arguments: '{"place":"Paris"}',
  };
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  sse(response, {
    type: 'response.created',
    response: { id, status: 'in_progress' },
  });
  sse(response, {
    type: 'response.output_item.added',
    output_index: 0,
    item: { ...call, status: undefined, arguments: '' },
  });
  sse(response, {
    type: 'response.function_call_arguments.delta',
    output_index: 0,
    item_id: call.id,
    delta: call.arguments,
  });
  sse(response, {
    type: 'response.function_call_arguments.done',
    output_index: 0,
    item_id: call.id,
    arguments: call.arguments,
  });
  sse(response, {
    type: 'response.output_item.done',
    output_index: 0,
    item: call,
  });
  sse(response, {
    type: 'response.completed',
    response: {
      id,
      status: 'completed',
      model: 'fixture-model',
      output: [call],
      usage: { input_tokens: 2, output_tokens: 2 },
    },
  });
  response.end();
}

function streamFinalText(response: ServerResponse, id: string, text: string) {
  const itemId = 'msg_final';
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  sse(response, {
    type: 'response.created',
    response: { id, status: 'in_progress' },
  });
  sse(response, {
    type: 'response.output_item.added',
    output_index: 0,
    item: {
      id: itemId,
      type: 'message',
      role: 'assistant',
      status: 'in_progress',
      content: [],
    },
  });
  sse(response, {
    type: 'response.content_part.added',
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '' },
  });
  sse(response, {
    type: 'response.output_text.delta',
    output_index: 0,
    content_index: 0,
    item_id: itemId,
    delta: text.slice(0, 10),
  });
  sse(response, {
    type: 'response.output_text.delta',
    output_index: 0,
    content_index: 0,
    item_id: itemId,
    delta: text.slice(10),
  });
  sse(response, {
    type: 'response.output_text.done',
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    text,
  });
  sse(response, {
    type: 'response.content_part.done',
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text },
  });
  const message = {
    id: itemId,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  };
  sse(response, {
    type: 'response.output_item.done',
    output_index: 0,
    item: message,
  });
  sse(response, {
    type: 'response.completed',
    response: {
      id,
      status: 'completed',
      model: 'fixture-model',
      output: [message],
      usage: { input_tokens: 3, output_tokens: 2 },
    },
  });
  response.end();
}

function streamAnthropicTurn(
  response: ServerResponse,
  id: string,
  toolCall: boolean,
) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  sse(response, {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'fixture-model',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 0 },
    },
  });
  if (toolCall) {
    sse(response, {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'lookup_weather',
        input: {},
      },
    });
    sse(response, {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: '{"place":"Paris"}',
      },
    });
    sse(response, { type: 'content_block_stop', index: 0 });
  } else {
    const text = '{"answer":"ready"}';
    sse(response, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    sse(response, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: text.slice(0, 10) },
    });
    sse(response, {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: text.slice(10) },
    });
    sse(response, { type: 'content_block_stop', index: 0 });
  }
  sse(response, {
    type: 'message_delta',
    delta: {
      stop_reason: toolCall ? 'tool_use' : 'end_turn',
      stop_sequence: null,
    },
    usage: { output_tokens: 2 },
  });
  sse(response, { type: 'message_stop' });
  response.end();
}

test('streaming hosted tool turns combine formats and withhold JSON deltas until validation', async () => {
  for (const provider of providers) {
    await withCredential(provider, async () => {
      let requestCount = 0;
      await withServer(
        (_request, response) => {
          const count = requestCount++;
          if (provider === 'openai') {
            if (count === 0) streamToolCall(response, 'resp_tool');
            else streamFinalText(response, 'resp_final', '{"answer":"ready"}');
          } else {
            streamAnthropicTurn(response, `msg_${count}`, count === 0);
          }
        },
        async (baseUrl, requests) => {
          const session = makeAdapter(provider, baseUrl).createToolSession!({
            prompt: 'Check Paris and report the result as JSON.',
            tools,
            responseSchema,
          });
          const firstEvents = [];
          for await (const event of session.stream!(requestOptions))
            firstEvents.push(event);
          assert.deepEqual(
            firstEvents.filter((event) => event.type === 'text-delta'),
            [],
          );
          assert.deepEqual(
            completedTurn(firstEvents as { type: string; turn?: ToolTurn }[])
              ?.structured,
            { status: 'pending', reason: 'tool-calls' },
          );
          assertCombinedRequest(provider, requests[0], true);

          const finalEvents = [];
          for await (const event of session.stream!({
            ...requestOptions,
            results: [
              {
                callId: provider === 'openai' ? 'call_1' : 'toolu_1',
                output: 'sunny',
              },
            ],
          }))
            finalEvents.push(event);
          assert.deepEqual(
            finalEvents.filter((event) => event.type === 'text-delta'),
            [],
          );
          assert.deepEqual(
            completedTurn(finalEvents as { type: string; turn?: ToolTurn }[])
              ?.structured,
            { status: 'valid', data: { answer: 'ready' } },
          );
          assertCombinedRequest(provider, requests[1], true);
        },
      );
    });
  }
});

test('provider rejection of combined output and tools is normalized without fallback', async () => {
  for (const provider of providers) {
    await withCredential(provider, async () => {
      let requestCount = 0;
      await withServer(
        (_request, response) => {
          requestCount++;
          json(
            response,
            { error: 'unsupported combined mode private diagnostic' },
            400,
          );
        },
        async (baseUrl, requests) => {
          const session = makeAdapter(provider, baseUrl).createToolSession!({
            prompt: 'Check Paris.',
            tools,
            responseSchema,
          });
          await assert.rejects(
            session.next(requestOptions),
            (error: unknown) =>
              error instanceof ProviderError &&
              error.code === 'unavailable' &&
              !error.message.includes('private diagnostic'),
          );
          assert.equal(requestCount, 1);
          assert.equal(requests.length, 1);
          assertCombinedRequest(provider, requests[0], false);
        },
      );
    });
  }
});
