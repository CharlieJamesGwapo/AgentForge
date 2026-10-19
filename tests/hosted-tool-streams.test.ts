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
import type { ToolStreamEvent } from '../src/adapters/types.js';

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
  value: string,
  run: () => Promise<void>,
) {
  const previous = process.env[key];
  process.env[key] = value;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

function sse(response: ServerResponse, value: unknown) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

const requestOptions = { approved: true, timeoutMs: 2_000 };
const schema = {
  type: 'object',
  properties: { place: { type: 'string' } },
  required: ['place'],
  additionalProperties: false,
};
const tools = [
  {
    name: 'lookup_weather',
    description: 'Look up weather for a place.',
    parameters: schema,
  },
];

function openAICompletion() {
  return {
    type: 'response.completed',
    response: {
      id: 'resp_1',
      status: 'completed',
      model: 'fixture-openai-model',
      output: [
        {
          id: 'rs_1',
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'private summary' }],
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
          id: 'msg_1',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Checking\nboth places.' }],
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
    },
  };
}

function anthropicCompletion() {
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
      { type: 'text', text: 'Checking Paris.' },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'lookup_weather',
        input: { place: 'Paris' },
      },
    ],
    stop_reason: 'tool_use',
    usage: {
      input_tokens: 15,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 3,
      output_tokens: 6,
    },
  };
}

async function collect(events: AsyncIterable<ToolStreamEvent>) {
  const output: ToolStreamEvent[] = [];
  for await (const event of events) output.push(event);
  return output;
}

async function collectRemaining(
  iterator: AsyncIterator<ToolStreamEvent>,
): Promise<ToolStreamEvent[]> {
  const output: ToolStreamEvent[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) return output;
    output.push(next.value);
  }
}

function completedTurn(events: ToolStreamEvent[]) {
  const last = events.at(-1);
  assert.equal(last?.type, 'complete');
  return last?.type === 'complete' ? last.turn : undefined;
}

function streamError(error: unknown) {
  return error instanceof ProviderError && error.code === 'invalid-response';
}

test('OpenAI streams text while keeping call arguments and reasoning private, then replays terminal items', async () => {
  await withCredential(
    'OPENAI_API_KEY',
    'openai-tool-stream-secret',
    async () => {
      let requestCount = 0;
      let releaseTerminal!: () => void;
      const terminalGate = new Promise<void>((resolve) => {
        releaseTerminal = resolve;
      });
      let firstTextSent!: () => void;
      const firstText = new Promise<void>((resolve) => {
        firstTextSent = resolve;
      });
      let terminalSent = false;
      await withServer(
        async (request, response) => {
          if (requestCount++ === 0) {
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            sse(response, {
              type: 'response.created',
              response: { id: 'resp_1', status: 'in_progress' },
            });
            sse(response, {
              type: 'response.output_item.added',
              output_index: 0,
              item: {
                id: 'rs_1',
                type: 'reasoning',
                summary: [],
              },
            });
            sse(response, {
              type: 'response.reasoning_summary_text.delta',
              item_id: 'rs_1',
              output_index: 0,
              summary_index: 0,
              delta: 'private summary delta',
            });
            sse(response, {
              type: 'response.output_item.added',
              output_index: 1,
              item: {
                id: 'fc_item_1',
                type: 'function_call',
                call_id: 'call_1',
                name: 'lookup_weather',
                arguments: '',
              },
            });
            sse(response, {
              type: 'response.function_call_arguments.delta',
              output_index: 1,
              item_id: 'fc_item_1',
              delta: '{"place":"',
            });
            sse(response, {
              type: 'response.output_item.added',
              output_index: 2,
              item: {
                id: 'msg_1',
                type: 'message',
                role: 'assistant',
                status: 'in_progress',
                content: [],
              },
            });
            sse(response, {
              type: 'response.content_part.added',
              item_id: 'msg_1',
              output_index: 2,
              content_index: 0,
              part: { type: 'output_text', text: '' },
            });
            sse(response, {
              type: 'response.output_text.delta',
              output_index: 2,
              content_index: 0,
              item_id: 'msg_1',
              delta: 'Checking\n',
            });
            firstTextSent();
            await terminalGate;
            sse(response, {
              type: 'response.output_item.added',
              output_index: 3,
              item: {
                id: 'fc_item_2',
                type: 'function_call',
                call_id: 'call_2',
                name: 'lookup_weather',
                arguments: '',
              },
            });
            sse(response, {
              type: 'response.function_call_arguments.delta',
              output_index: 3,
              item_id: 'fc_item_2',
              delta: '{"place":"Manila"}',
            });
            sse(response, {
              type: 'response.function_call_arguments.delta',
              output_index: 1,
              item_id: 'fc_item_1',
              delta: 'Paris"}',
            });
            sse(response, {
              type: 'response.function_call_arguments.done',
              output_index: 1,
              item_id: 'fc_item_1',
              arguments: '{"place":"Paris"}',
            });
            sse(response, {
              type: 'response.output_item.done',
              output_index: 1,
              item: {
                id: 'fc_item_1',
                type: 'function_call',
                status: 'completed',
                call_id: 'call_1',
                name: 'lookup_weather',
                arguments: '{"place":"Paris"}',
              },
            });
            sse(response, {
              type: 'response.function_call_arguments.done',
              output_index: 3,
              item_id: 'fc_item_2',
              arguments: '{"place":"Manila"}',
            });
            sse(response, {
              type: 'response.output_item.done',
              output_index: 3,
              item: {
                id: 'fc_item_2',
                type: 'function_call',
                status: 'completed',
                call_id: 'call_2',
                name: 'lookup_weather',
                arguments: '{"place":"Manila"}',
              },
            });
            sse(response, {
              type: 'response.output_text.delta',
              output_index: 2,
              content_index: 0,
              item_id: 'msg_1',
              delta: 'both places.',
            });
            sse(response, {
              type: 'response.output_text.done',
              item_id: 'msg_1',
              output_index: 2,
              content_index: 0,
              text: 'Checking\nboth places.',
            });
            sse(response, {
              type: 'response.content_part.done',
              item_id: 'msg_1',
              output_index: 2,
              content_index: 0,
              part: { type: 'output_text', text: 'Checking\nboth places.' },
            });
            sse(response, {
              type: 'response.output_item.done',
              output_index: 2,
              item: {
                id: 'msg_1',
                type: 'message',
                status: 'completed',
                role: 'assistant',
                content: [
                  { type: 'output_text', text: 'Checking\nboth places.' },
                ],
              },
            });
            sse(response, {
              type: 'response.output_item.done',
              output_index: 0,
              item: {
                id: 'rs_1',
                type: 'reasoning',
                summary: [{ type: 'summary_text', text: 'private summary' }],
                encrypted_content: 'opaque-reasoning-envelope',
              },
            });
            sse(response, openAICompletion());
            terminalSent = true;
            response.end();
            return;
          }
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              status: 'completed',
              model: 'fixture-openai-model',
              output: [
                {
                  id: 'msg_final',
                  type: 'message',
                  status: 'completed',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'Done.' }],
                },
              ],
              usage: { input_tokens: 25, output_tokens: 2 },
            }),
          );
        },
        async (baseUrl, requests) => {
          const adapter = new OpenAIAdapter({
            model: 'requested-model',
            baseUrl,
            maxOutputTokens: 77,
          });
          const session = adapter.createToolSession!({
            prompt: 'Check both places.',
            tools,
          });
          const iterator =
            session.stream!(requestOptions)[Symbol.asyncIterator]();
          const first = await Promise.race([
            iterator.next(),
            new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error('first tool text line was delayed')),
                1_500,
              ),
            ),
          ]);
          assert.equal(first.done, false);
          assert.deepEqual(first.value, {
            type: 'text-delta',
            text: 'Checking\n',
            provisional: true,
          });
          await firstText;
          assert.equal(terminalSent, false);
          releaseTerminal();
          const events = [first.value!, ...(await collectRemaining(iterator))];

          assert.deepEqual(
            events.filter((event) => event.type === 'text-delta'),
            [
              { type: 'text-delta', text: 'Checking\n', provisional: true },
              { type: 'text-delta', text: 'both places.', provisional: true },
            ],
          );
          assert.equal(
            JSON.stringify(events).includes('private'),
            false,
            'reasoning must remain private',
          );
          const turn = completedTurn(events);
          assert.deepEqual(turn?.calls, [
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
          ]);
          assert.equal(turn?.text, 'Checking\nboth places.');
          assert.equal(turn?.finishReason, 'tool-calls');
          assert.equal(requests[0]?.url, '/responses');
          assert.deepEqual(requests[0]?.body, {
            model: 'requested-model',
            input: [{ role: 'user', content: 'Check both places.' }],
            max_output_tokens: 77,
            store: false,
            stream: true,
            include: ['reasoning.encrypted_content'],
            tools: [
              {
                type: 'function',
                name: 'lookup_weather',
                description: 'Look up weather for a place.',
                parameters: schema,
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
          assert.equal(final.text, 'Done.');
          assert.deepEqual(requests[1]?.body, {
            model: 'requested-model',
            input: [
              { role: 'user', content: 'Check both places.' },
              openAICompletion().response.output[0],
              openAICompletion().response.output[1],
              openAICompletion().response.output[2],
              openAICompletion().response.output[3],
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
                parameters: schema,
                strict: true,
              },
            ],
          });
        },
      );
    },
  );
});

test('Anthropic streams public text and replays signed thinking and parsed tool input', async () => {
  await withCredential(
    'ANTHROPIC_API_KEY',
    'anthropic-tool-stream-secret',
    async () => {
      let requestCount = 0;
      await withServer(
        (request, response) => {
          if (requestCount++ === 0) {
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            sse(response, {
              type: 'message_start',
              message: {
                id: 'msg_1',
                type: 'message',
                role: 'assistant',
                model: 'fixture-anthropic-model',
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: {
                  input_tokens: 15,
                  cache_read_input_tokens: 2,
                  cache_creation_input_tokens: 3,
                  output_tokens: 0,
                },
              },
            });
            sse(response, {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'thinking', thinking: '', signature: '' },
            });
            sse(response, {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'thinking_delta',
                thinking: 'private continuation state',
              },
            });
            sse(response, {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'signature_delta',
                signature: 'signed-thinking-state',
              },
            });
            sse(response, { type: 'content_block_stop', index: 0 });
            sse(response, {
              type: 'content_block_start',
              index: 1,
              content_block: { type: 'text', text: '' },
            });
            sse(response, {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'text_delta', text: 'Checking Paris.' },
            });
            sse(response, { type: 'content_block_stop', index: 1 });
            sse(response, {
              type: 'content_block_start',
              index: 2,
              content_block: {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'lookup_weather',
                input: {},
              },
            });
            sse(response, {
              type: 'content_block_delta',
              index: 2,
              delta: { type: 'input_json_delta', partial_json: '{"place":' },
            });
            sse(response, {
              type: 'content_block_delta',
              index: 2,
              delta: { type: 'input_json_delta', partial_json: '"Paris"}' },
            });
            sse(response, { type: 'content_block_stop', index: 2 });
            sse(response, {
              type: 'message_delta',
              delta: { stop_reason: null, stop_sequence: null },
              usage: { output_tokens: 4 },
            });
            sse(response, {
              type: 'message_delta',
              delta: { stop_reason: 'tool_use', stop_sequence: null },
              usage: { output_tokens: 6 },
            });
            sse(response, { type: 'message_stop' });
            response.end();
            return;
          }
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              type: 'message',
              model: 'fixture-anthropic-model',
              role: 'assistant',
              content: [{ type: 'text', text: 'Done.' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 2, output_tokens: 1 },
            }),
          );
        },
        async (baseUrl, requests) => {
          const adapter = new AnthropicAdapter({
            model: 'requested-model',
            baseUrl,
          });
          const session = adapter.createToolSession!({
            prompt: 'Check Paris.',
            tools,
          });
          const events = await collect(session.stream!(requestOptions));
          assert.deepEqual(
            events.filter((event) => event.type === 'text-delta'),
            [
              {
                type: 'text-delta',
                text: 'Checking Paris.',
                provisional: true,
              },
            ],
          );
          assert.equal(JSON.stringify(events).includes('private'), false);
          assert.equal(JSON.stringify(events).includes('signature'), false);
          const turn = completedTurn(events);
          assert.deepEqual(turn?.calls, [
            {
              id: 'toolu_1',
              name: 'lookup_weather',
              arguments: { place: 'Paris' },
            },
          ]);
          assert.deepEqual(turn?.usage, {
            status: 'available',
            inputTokens: 20,
            outputTokens: 6,
            cachedInputTokens: 2,
            cacheCreationInputTokens: 3,
          });
          assert.deepEqual(requests[0]?.body, {
            model: 'requested-model',
            messages: [{ role: 'user', content: 'Check Paris.' }],
            max_tokens: 1024,
            stream: true,
            tools: [
              {
                name: 'lookup_weather',
                description: 'Look up weather for a place.',
                input_schema: schema,
                strict: true,
              },
            ],
          });

          await session.next({
            ...requestOptions,
            results: [{ callId: 'toolu_1', output: 'sunny' }],
          });
          assert.deepEqual(requests[1]?.body, {
            model: 'requested-model',
            messages: [
              { role: 'user', content: 'Check Paris.' },
              {
                role: 'assistant',
                content: anthropicCompletion().content,
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'toolu_1',
                    content: 'sunny',
                  },
                ],
              },
            ],
            max_tokens: 1024,
            stream: false,
            tools: [
              {
                name: 'lookup_weather',
                description: 'Look up weather for a place.',
                input_schema: schema,
                strict: true,
              },
            ],
          });
        },
      );
    },
  );
});

test('OpenAI withholds completion when terminal arguments disagree with streamed fragments', async () => {
  await withCredential(
    'OPENAI_API_KEY',
    'openai-tool-stream-secret',
    async () => {
      await withServer(
        (_request, response) => {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          sse(response, {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              id: 'fc_1',
              type: 'function_call',
              call_id: 'call_1',
              name: 'lookup_weather',
              arguments: '',
            },
          });
          sse(response, {
            type: 'response.function_call_arguments.delta',
            output_index: 0,
            item_id: 'fc_1',
            delta: '{"place":"Paris"}',
          });
          sse(response, {
            type: 'response.function_call_arguments.done',
            output_index: 0,
            item_id: 'fc_1',
            arguments: '{"place":"Paris"}',
          });
          sse(response, {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'fc_1',
              type: 'function_call',
              status: 'completed',
              call_id: 'call_1',
              name: 'lookup_weather',
              arguments: '{"place":"Paris"}',
            },
          });
          const terminal = openAICompletion();
          terminal.response.output = [
            {
              id: 'fc_1',
              type: 'function_call',
              status: 'completed',
              call_id: 'call_1',
              name: 'lookup_weather',
              arguments: '{"place":"Manila"}',
            },
          ];
          sse(response, terminal);
          response.end();
        },
        async (baseUrl) => {
          const adapter = new OpenAIAdapter({
            model: 'requested-model',
            baseUrl,
          });
          const session = adapter.createToolSession!({
            prompt: 'Check.',
            tools,
          });
          await assert.rejects(
            async () => collect(session.stream!(requestOptions)),
            streamError,
          );
        },
      );
    },
  );
});

test('OpenAI rejects a truncated tool stream without a terminal response', async () => {
  await withCredential(
    'OPENAI_API_KEY',
    'openai-tool-stream-secret',
    async () => {
      await withServer(
        (_request, response) => {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          sse(response, {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              id: 'fc_partial',
              type: 'function_call',
              call_id: 'call_partial',
              name: 'lookup_weather',
              arguments: '',
            },
          });
          sse(response, {
            type: 'response.function_call_arguments.delta',
            output_index: 0,
            item_id: 'fc_partial',
            delta: '{"place":"Paris"}',
          });
          response.end();
        },
        async (baseUrl) => {
          const adapter = new OpenAIAdapter({
            model: 'requested-model',
            baseUrl,
          });
          const session = adapter.createToolSession!({
            prompt: 'Check.',
            tools,
          });
          await assert.rejects(
            async () => collect(session.stream!(requestOptions)),
            streamError,
          );
        },
      );
    },
  );
});

test('OpenAI rejects a response_id that changes during a tool stream', async () => {
  await withCredential(
    'OPENAI_API_KEY',
    'openai-tool-stream-secret',
    async () => {
      const argumentsJson = '{"place":"Paris"}';
      await withServer(
        (_request, response) => {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          sse(response, {
            type: 'response.created',
            response: { id: 'resp_identity', status: 'in_progress' },
          });
          sse(response, {
            type: 'response.output_item.added',
            response_id: 'resp_identity',
            output_index: 0,
            item: {
              id: 'fc_identity',
              type: 'function_call',
              call_id: 'call_identity',
              name: 'lookup_weather',
              arguments: '',
            },
          });
          sse(response, {
            type: 'response.function_call_arguments.delta',
            response_id: 'resp_other',
            output_index: 0,
            item_id: 'fc_identity',
            delta: argumentsJson,
          });
          sse(response, {
            type: 'response.function_call_arguments.done',
            response_id: 'resp_identity',
            output_index: 0,
            item_id: 'fc_identity',
            arguments: argumentsJson,
          });
          sse(response, {
            type: 'response.output_item.done',
            response_id: 'resp_identity',
            output_index: 0,
            item: {
              id: 'fc_identity',
              type: 'function_call',
              status: 'completed',
              call_id: 'call_identity',
              name: 'lookup_weather',
              arguments: argumentsJson,
            },
          });
          sse(response, {
            type: 'response.completed',
            response: {
              id: 'resp_identity',
              status: 'completed',
              model: 'fixture-openai-model',
              output: [
                {
                  id: 'fc_identity',
                  type: 'function_call',
                  status: 'completed',
                  call_id: 'call_identity',
                  name: 'lookup_weather',
                  arguments: argumentsJson,
                },
              ],
              usage: { input_tokens: 4, output_tokens: 2 },
            },
          });
          response.end();
        },
        async (baseUrl) => {
          const adapter = new OpenAIAdapter({
            model: 'requested-model',
            baseUrl,
          });
          const session = adapter.createToolSession!({
            prompt: 'Check.',
            tools,
          });
          await assert.rejects(
            async () => collect(session.stream!(requestOptions)),
            streamError,
          );
        },
      );
    },
  );
});

test('OpenAI withholds calls that fail the registered tool schema', async () => {
  await withCredential(
    'OPENAI_API_KEY',
    'openai-tool-stream-secret',
    async () => {
      const argumentsJson = '{"place":42}';
      await withServer(
        (_request, response) => {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          sse(response, {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              id: 'fc_schema',
              type: 'function_call',
              call_id: 'call_schema',
              name: 'lookup_weather',
              arguments: '',
            },
          });
          sse(response, {
            type: 'response.function_call_arguments.delta',
            output_index: 0,
            item_id: 'fc_schema',
            delta: argumentsJson,
          });
          sse(response, {
            type: 'response.function_call_arguments.done',
            output_index: 0,
            item_id: 'fc_schema',
            arguments: argumentsJson,
          });
          sse(response, {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'fc_schema',
              type: 'function_call',
              status: 'completed',
              call_id: 'call_schema',
              name: 'lookup_weather',
              arguments: argumentsJson,
            },
          });
          sse(response, {
            type: 'response.completed',
            response: {
              id: 'resp_schema',
              status: 'completed',
              model: 'fixture-openai-model',
              output: [
                {
                  id: 'fc_schema',
                  type: 'function_call',
                  status: 'completed',
                  call_id: 'call_schema',
                  name: 'lookup_weather',
                  arguments: argumentsJson,
                },
              ],
              usage: { input_tokens: 4, output_tokens: 2 },
            },
          });
          response.end();
        },
        async (baseUrl) => {
          const adapter = new OpenAIAdapter({
            model: 'requested-model',
            baseUrl,
          });
          const session = adapter.createToolSession!({
            prompt: 'Check.',
            tools,
          });
          await assert.rejects(
            async () => collect(session.stream!(requestOptions)),
            (error: unknown) =>
              error instanceof ProviderError && error.code === 'validation',
          );
        },
      );
    },
  );
});

test('OpenAI rejects a trailing event after a valid terminal response', async () => {
  await withCredential(
    'OPENAI_API_KEY',
    'openai-tool-stream-secret',
    async () => {
      await withServer(
        (_request, response) => {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          sse(response, {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              id: 'msg_tail',
              type: 'message',
              role: 'assistant',
              status: 'in_progress',
              content: [],
            },
          });
          sse(response, {
            type: 'response.content_part.added',
            output_index: 0,
            item_id: 'msg_tail',
            content_index: 0,
            part: { type: 'output_text', text: '' },
          });
          sse(response, {
            type: 'response.output_text.delta',
            output_index: 0,
            item_id: 'msg_tail',
            content_index: 0,
            delta: 'Done.',
          });
          sse(response, {
            type: 'response.output_text.done',
            output_index: 0,
            item_id: 'msg_tail',
            content_index: 0,
            text: 'Done.',
          });
          sse(response, {
            type: 'response.content_part.done',
            output_index: 0,
            item_id: 'msg_tail',
            content_index: 0,
            part: { type: 'output_text', text: 'Done.' },
          });
          sse(response, {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'msg_tail',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'Done.' }],
            },
          });
          sse(response, {
            type: 'response.completed',
            response: {
              id: 'resp_tail',
              status: 'completed',
              model: 'fixture-openai-model',
              output: [
                {
                  id: 'msg_tail',
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'Done.' }],
                },
              ],
              usage: { input_tokens: 4, output_tokens: 2 },
            },
          });
          sse(response, { type: 'response.in_progress' });
          response.end();
        },
        async (baseUrl) => {
          const adapter = new OpenAIAdapter({
            model: 'requested-model',
            baseUrl,
          });
          const session = adapter.createToolSession!({
            prompt: 'Check.',
            tools,
          });
          await assert.rejects(
            async () => collect(session.stream!(requestOptions)),
            streamError,
          );
        },
      );
    },
  );
});

test('Anthropic rejects an unterminated tool block and does not expose a complete turn', async () => {
  await withCredential(
    'ANTHROPIC_API_KEY',
    'anthropic-tool-stream-secret',
    async () => {
      await withServer(
        (_request, response) => {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          sse(response, {
            type: 'message_start',
            message: {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              model: 'fixture-anthropic-model',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 3, output_tokens: 0 },
            },
          });
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
          sse(response, {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use', stop_sequence: null },
            usage: { output_tokens: 4 },
          });
          sse(response, { type: 'message_stop' });
          response.end();
        },
        async (baseUrl) => {
          const adapter = new AnthropicAdapter({
            model: 'requested-model',
            baseUrl,
          });
          const session = adapter.createToolSession!({
            prompt: 'Check.',
            tools,
          });
          await assert.rejects(
            async () => collect(session.stream!(requestOptions)),
            streamError,
          );
        },
      );
    },
  );
});

test('Anthropic preserves an empty tool input when the stream has no JSON deltas', async () => {
  await withCredential(
    'ANTHROPIC_API_KEY',
    'anthropic-tool-stream-secret',
    async () => {
      const emptyTool = [
        {
          name: 'empty_tool',
          description: 'A tool with no arguments.',
          parameters: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ];
      await withServer(
        (_request, response) => {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          sse(response, {
            type: 'message_start',
            message: {
              id: 'msg_empty',
              type: 'message',
              role: 'assistant',
              model: 'fixture-anthropic-model',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 3, output_tokens: 0 },
            },
          });
          sse(response, {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'toolu_empty',
              name: 'empty_tool',
              input: {},
            },
          });
          sse(response, { type: 'content_block_stop', index: 0 });
          sse(response, {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use', stop_sequence: null },
            usage: { output_tokens: 2 },
          });
          sse(response, { type: 'message_stop' });
          response.end();
        },
        async (baseUrl) => {
          const adapter = new AnthropicAdapter({
            model: 'requested-model',
            baseUrl,
          });
          const session = adapter.createToolSession!({
            prompt: 'Run the empty tool.',
            tools: emptyTool,
          });
          const events = await collect(session.stream!(requestOptions));
          assert.deepEqual(completedTurn(events)?.calls, [
            { id: 'toolu_empty', name: 'empty_tool', arguments: {} },
          ]);
        },
      );
    },
  );
});

test('tool streams require approval and cancellation never yields a complete turn', async () => {
  await withCredential(
    'OPENAI_API_KEY',
    'openai-tool-stream-secret',
    async () => {
      await withServer(
        (_request, response) => {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write('');
          response.end();
        },
        async (baseUrl, requests) => {
          const adapter = new OpenAIAdapter({
            model: 'requested-model',
            baseUrl,
          });
          const denied = adapter.createToolSession!({
            prompt: 'Check.',
            tools,
          });
          await assert.rejects(
            async () =>
              collect(denied.stream!({ approved: false, timeoutMs: 2_000 })),
            (error: unknown) =>
              error instanceof ProviderError && error.code === 'policy',
          );
          assert.equal(requests.length, 0);

          const controller = new AbortController();
          controller.abort();
          const cancelled = adapter.createToolSession!({
            prompt: 'Check.',
            tools,
          });
          await assert.rejects(
            async () =>
              collect(
                cancelled.stream!({
                  ...requestOptions,
                  signal: controller.signal,
                }),
              ),
            (error: unknown) =>
              error instanceof ProviderError && error.code === 'cancelled',
          );
          assert.equal(requests.length, 0);
        },
      );
    },
  );
});

test('cancelling an active tool stream after a text fragment exposes no complete turn', async () => {
  await withCredential(
    'OPENAI_API_KEY',
    'openai-tool-stream-secret',
    async () => {
      await withServer(
        async (_request, response) => {
          const closed = new Promise<void>((resolve) => {
            response.once('close', resolve);
          });
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          sse(response, {
            type: 'response.created',
            response: { id: 'resp_cancel', status: 'in_progress' },
          });
          sse(response, {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              id: 'msg_cancel',
              type: 'message',
              role: 'assistant',
              status: 'in_progress',
              content: [],
            },
          });
          sse(response, {
            type: 'response.content_part.added',
            output_index: 0,
            item_id: 'msg_cancel',
            content_index: 0,
            part: { type: 'output_text', text: '' },
          });
          sse(response, {
            type: 'response.output_text.delta',
            output_index: 0,
            item_id: 'msg_cancel',
            content_index: 0,
            delta: 'Partial\n',
          });
          await closed;
        },
        async (baseUrl) => {
          const adapter = new OpenAIAdapter({
            model: 'requested-model',
            baseUrl,
          });
          const session = adapter.createToolSession!({
            prompt: 'Check.',
            tools,
          });
          const controller = new AbortController();
          const iterator = session.stream!({
            ...requestOptions,
            signal: controller.signal,
          })[Symbol.asyncIterator]();
          const first = await iterator.next();
          assert.deepEqual(first.value, {
            type: 'text-delta',
            text: 'Partial\n',
            provisional: true,
          });
          controller.abort();
          await assert.rejects(
            iterator.next(),
            (error: unknown) =>
              error instanceof ProviderError && error.code === 'cancelled',
          );
        },
      );
    },
  );
});
