import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { AnthropicAdapter } from '../src/adapters/anthropic.js';
import { ProviderError } from '../src/adapters/errors.js';
import { OllamaAdapter } from '../src/adapters/ollama.js';
import { OpenAIAdapter } from '../src/adapters/openai.js';
import type {
  ProviderAdapter,
  RequestOptions,
  ToolDefinition,
  ToolResult,
  ToolSession,
  ToolStreamEvent,
  ToolTurn,
} from '../src/adapters/types.js';

type ProviderName = 'openai' | 'anthropic' | 'ollama';
type TurnMode = 'next' | 'stream';
type JsonObject = Record<string, unknown>;
type CapturedRequest = {
  url: string | undefined;
  body: JsonObject;
};

const credentialEnv = 'RESULT_PROVIDER_FIXTURE_KEY';
const fixtureCredential = 'xy';
const requestOptions: RequestOptions = { approved: true, timeoutMs: 2_000 };
const argumentSchema: JsonObject = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
  additionalProperties: false,
};
const finalSchema: JsonObject = {
  type: 'object',
  properties: { answer: { type: 'string', enum: ['ready'] } },
  required: ['answer'],
  additionalProperties: false,
};
const calls = [
  { id: 'call_a', name: 'lookup', arguments: { query: 'alpha' } },
  { id: 'call_b', name: 'lookup', arguments: { query: 'beta' } },
];
const finalText = '{"answer":"ready"}';
const tool = (resultSchema: JsonObject): ToolDefinition => ({
  name: 'lookup',
  description: 'Look up a value.',
  parameters: argumentSchema,
  resultSchema,
});

function object(value: unknown): JsonObject {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
  );
  return value as JsonObject;
}

function resultSchema(value: JsonObject = { type: 'string' }): JsonObject {
  return {
    type: 'object',
    properties: { value },
    required: ['value'],
    additionalProperties: false,
  };
}

function adapterFor(provider: ProviderName, baseUrl: string): ProviderAdapter {
  const options = {
    model: `fixture-${provider}-model`,
    baseUrl,
    apiKeyEnv: credentialEnv,
  };
  if (provider === 'openai') return new OpenAIAdapter(options);
  if (provider === 'anthropic') return new AnthropicAdapter(options);
  return new OllamaAdapter(options);
}

function initialResponse(provider: ProviderName): JsonObject {
  if (provider === 'openai') {
    return {
      id: 'resp_tool',
      status: 'completed',
      model: 'fixture-openai-model',
      output: calls.map((call, index) => ({
        id: `fc_item_${index + 1}`,
        type: 'function_call',
        status: 'completed',
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      })),
    };
  }
  if (provider === 'anthropic') {
    return {
      id: 'msg_tool',
      type: 'message',
      model: 'fixture-anthropic-model',
      role: 'assistant',
      content: calls.map((call) => ({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: call.arguments,
      })),
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 4 },
    };
  }
  return {
    model: 'fixture-ollama-model',
    message: {
      role: 'assistant',
      content: '',
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 10,
    eval_count: 4,
  };
}

function finalResponse(provider: ProviderName): JsonObject {
  if (provider === 'openai') {
    return {
      id: 'resp_final',
      status: 'completed',
      model: 'fixture-openai-model',
      output: [
        {
          id: 'msg_final',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: finalText }],
        },
      ],
      usage: { input_tokens: 20, output_tokens: 3 },
    };
  }
  if (provider === 'anthropic') {
    return {
      id: 'msg_final',
      type: 'message',
      model: 'fixture-anthropic-model',
      role: 'assistant',
      content: [{ type: 'text', text: finalText }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 20, output_tokens: 3 },
    };
  }
  return {
    model: 'fixture-ollama-model',
    message: { role: 'assistant', content: finalText },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 20,
    eval_count: 3,
  };
}

function openAIStreamEvents(response: JsonObject): JsonObject[] {
  const responseId = response.id as string;
  const output = response.output as JsonObject[];
  const events: JsonObject[] = [
    {
      type: 'response.created',
      response: { id: responseId, status: 'in_progress' },
    },
  ];
  output.forEach((rawItem, outputIndex) => {
    const item = object(rawItem);
    if (item.type === 'function_call') {
      const rawArguments = item.arguments as string;
      const itemId = item.id as string;
      events.push({
        type: 'response.output_item.added',
        output_index: outputIndex,
        item: {
          id: itemId,
          type: 'function_call',
          status: 'in_progress',
          call_id: item.call_id,
          name: item.name,
          arguments: '',
        },
      });
      events.push({
        type: 'response.function_call_arguments.delta',
        output_index: outputIndex,
        item_id: itemId,
        delta: rawArguments,
      });
      events.push({
        type: 'response.function_call_arguments.done',
        output_index: outputIndex,
        item_id: itemId,
        arguments: rawArguments,
      });
      events.push({
        type: 'response.output_item.done',
        output_index: outputIndex,
        item: { ...item },
      });
      return;
    }

    const part = object((item.content as unknown[])[0]);
    const text = part.text as string;
    const itemId = item.id as string;
    events.push({
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: {
        id: itemId,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    });
    events.push({
      type: 'response.content_part.added',
      output_index: outputIndex,
      content_index: 0,
      item_id: itemId,
      part: { type: 'output_text', text: '' },
    });
    events.push({
      type: 'response.output_text.delta',
      output_index: outputIndex,
      content_index: 0,
      item_id: itemId,
      delta: text,
    });
    events.push({
      type: 'response.output_text.done',
      output_index: outputIndex,
      content_index: 0,
      item_id: itemId,
      text,
    });
    events.push({
      type: 'response.content_part.done',
      output_index: outputIndex,
      content_index: 0,
      item_id: itemId,
      part: { type: 'output_text', text },
    });
    events.push({
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: { ...item },
    });
  });
  events.push({ type: 'response.completed', response });
  return events;
}

function anthropicStreamEvents(response: JsonObject): JsonObject[] {
  const content = response.content as JsonObject[];
  const usage = object(response.usage);
  const events: JsonObject[] = [
    {
      type: 'message_start',
      message: {
        id: response.id,
        type: 'message',
        role: 'assistant',
        model: response.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.input_tokens },
      },
    },
  ];
  content.forEach((block, index) => {
    if (block.type === 'tool_use') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {},
        },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(block.input),
        },
      });
    } else {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      });
    }
    events.push({ type: 'content_block_stop', index });
  });
  events.push({
    type: 'message_delta',
    delta: { stop_reason: response.stop_reason, stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  });
  events.push({ type: 'message_stop' });
  return events;
}

function sendJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function sendStream(
  provider: ProviderName,
  response: ServerResponse,
  value: JsonObject,
): void {
  if (provider === 'ollama') {
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.end(`${JSON.stringify(value)}\n`);
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const events =
    provider === 'openai'
      ? openAIStreamEvents(value)
      : anthropicStreamEvents(value);
  for (const event of events)
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
}

async function withCredential<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env[credentialEnv];
  process.env[credentialEnv] = fixtureCredential;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[credentialEnv];
    else process.env[credentialEnv] = previous;
  }
}

async function withServer<T>(
  provider: ProviderName,
  mode: TurnMode,
  run: (baseUrl: string, requests: CapturedRequest[]) => Promise<T>,
): Promise<T> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(
        Buffer.concat(chunks).toString('utf8'),
      ) as JsonObject;
      requests.push({ url: request.url, body });
      const payload =
        requests.length === 1
          ? initialResponse(provider)
          : finalResponse(provider);
      if (mode === 'stream') sendStream(provider, response, payload);
      else sendJson(response, payload);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function runTurn(
  session: ToolSession,
  mode: TurnMode,
  results?: ToolResult[],
): Promise<ToolTurn> {
  const options = {
    ...requestOptions,
    ...(results === undefined ? {} : { results }),
  };
  if (mode === 'next') return session.next(options);
  assert.ok(session.stream, 'provider must expose tool streaming');
  const events: ToolStreamEvent[] = [];
  for await (const event of session.stream(options)) events.push(event);
  const last = events.at(-1);
  assert.equal(last?.type, 'complete');
  if (last?.type !== 'complete') assert.fail('Missing completed tool turn.');
  return last.turn;
}

function expectedWireTools(provider: ProviderName): JsonObject[] {
  if (provider === 'openai') {
    return [
      {
        type: 'function',
        name: 'lookup',
        description: 'Look up a value.',
        parameters: argumentSchema,
        strict: true,
      },
    ];
  }
  if (provider === 'anthropic') {
    return [
      {
        name: 'lookup',
        description: 'Look up a value.',
        input_schema: argumentSchema,
        strict: true,
      },
    ];
  }
  return [
    {
      type: 'function',
      function: {
        name: 'lookup',
        description: 'Look up a value.',
        parameters: argumentSchema,
      },
    },
  ];
}

function assertNoLocalSchemaOnWire(
  provider: ProviderName,
  request: CapturedRequest,
) {
  assert.doesNotMatch(JSON.stringify(request.body), /"resultSchema"/);
  assert.deepEqual(request.body.tools, expectedWireTools(provider));
}

function assertFinalSchemaOnWire(provider: ProviderName, body: JsonObject) {
  if (provider === 'openai') {
    assert.deepEqual(body.text, {
      format: {
        type: 'json_schema',
        name: 'agentforge_output',
        strict: true,
        schema: finalSchema,
      },
    });
  } else if (provider === 'anthropic') {
    assert.deepEqual(body.output_config, {
      format: { type: 'json_schema', schema: finalSchema },
    });
  } else {
    assert.deepEqual(body.format, finalSchema);
  }
}

function assertSerializedResults(
  provider: ProviderName,
  request: CapturedRequest,
  expected: Array<{ callId: string; output: string; isError?: boolean }>,
) {
  const body = request.body;
  if (provider === 'openai') {
    const input = body.input as JsonObject[];
    assert.deepEqual(
      input.slice(-expected.length),
      expected.map((item) => ({
        type: 'function_call_output',
        call_id: item.callId,
        output: item.output,
      })),
    );
  } else if (provider === 'anthropic') {
    const messages = body.messages as JsonObject[];
    const lastMessage = object(messages.at(-1));
    const content = lastMessage.content as JsonObject[];
    assert.deepEqual(
      content,
      expected.map((item) => ({
        type: 'tool_result',
        tool_use_id: item.callId,
        content: item.output,
        ...(item.isError === undefined ? {} : { is_error: item.isError }),
      })),
    );
  } else {
    const messages = body.messages as JsonObject[];
    assert.deepEqual(
      messages.slice(-expected.length),
      expected.map((item) => ({
        role: 'tool',
        tool_name: 'lookup',
        content: item.output,
      })),
    );
  }
}

for (const provider of ['openai', 'anthropic', 'ollama'] as const) {
  for (const mode of ['next', 'stream'] as const) {
    test(`${provider} ${mode} validates and canonicalizes typed results before sending provider-native messages`, async () => {
      await withCredential(() =>
        withServer(provider, mode, async (baseUrl, requests) => {
          const session = adapterFor(provider, baseUrl).createToolSession!({
            prompt: 'Look up alpha and beta.',
            tools: [tool(resultSchema())],
            responseSchema: finalSchema,
          });
          const first = await runTurn(session, mode);
          assert.equal(first.finishReason, 'tool-calls');
          assert.deepEqual(
            first.calls.map((call) => call.id),
            ['call_a', 'call_b'],
          );
          assert.equal(requests.length, 1);
          assertNoLocalSchemaOnWire(provider, requests[0]!);
          assertFinalSchemaOnWire(provider, requests[0]!.body);

          const final = await runTurn(session, mode, [
            { callId: 'call_b', output: '{ "value" : "second" }' },
            { callId: 'call_a', output: '{ "value" : "xy" }' },
          ]);
          assert.equal(final.finishReason, 'completed');
          assert.equal(final.text, finalText);
          assert.deepEqual(final.structured, {
            status: 'valid',
            data: { answer: 'ready' },
          });
          assert.equal(requests.length, 2);
          assertNoLocalSchemaOnWire(provider, requests[1]!);
          assertFinalSchemaOnWire(provider, requests[1]!.body);
          assertSerializedResults(provider, requests[1]!, [
            { callId: 'call_a', output: '{"value":"[REDACTED]"}' },
            { callId: 'call_b', output: '{"value":"second"}' },
          ]);
        }),
      );
    });

    for (const invalidCase of [
      {
        name: 'malformed JSON',
        schema: resultSchema(),
        output: '{"value":',
      },
      {
        name: 'schema type mismatch',
        schema: resultSchema(),
        output: '{"value":42}',
      },
      {
        name: 'redaction breaks a result enum',
        schema: resultSchema({ type: 'string', enum: ['xy'] }),
        output: '{"value":"xy"}',
      },
      {
        name: 'sensitive property name',
        schema: {
          type: 'object',
          properties: { 'key-xy': { type: 'string' } },
          required: ['key-xy'],
          additionalProperties: false,
        },
        output: '{"key-xy":"safe"}',
      },
    ]) {
      test(`${provider} ${mode} rejects ${invalidCase.name} before opening the follow-up request`, async () => {
        await withCredential(() =>
          withServer(provider, mode, async (baseUrl, requests) => {
            const session = adapterFor(provider, baseUrl).createToolSession!({
              prompt: 'Look up alpha and beta.',
              tools: [tool(invalidCase.schema)],
            });
            const first = await runTurn(session, mode);
            assert.equal(first.finishReason, 'tool-calls');
            await assert.rejects(
              runTurn(session, mode, [
                { callId: 'call_a', output: invalidCase.output },
                {
                  callId: 'call_b',
                  output:
                    invalidCase.name === 'sensitive property name'
                      ? invalidCase.output
                      : '{"value":"safe"}',
                },
              ]),
              (error: unknown) =>
                error instanceof ProviderError && error.code === 'validation',
            );
            assert.equal(requests.length, 1);
          }),
        );
      });
    }

    test(`${provider} ${mode} replaces typed error payloads with the generic provider result`, async () => {
      const privatePayload = 'PRIVATE-ERROR-RESULT-DO-NOT-SEND';
      await withCredential(() =>
        withServer(provider, mode, async (baseUrl, requests) => {
          const session = adapterFor(provider, baseUrl).createToolSession!({
            prompt: 'Look up alpha and beta.',
            tools: [tool(resultSchema())],
          });
          await runTurn(session, mode);
          await runTurn(session, mode, [
            {
              callId: 'call_a',
              output: JSON.stringify({ diagnostic: privatePayload }),
              isError: true,
            },
            { callId: 'call_b', output: '{"value":"safe"}' },
          ]);
          assert.equal(requests.length, 2);
          assertNoLocalSchemaOnWire(provider, requests[1]!);
          assertSerializedResults(provider, requests[1]!, [
            {
              callId: 'call_a',
              output: 'Tool failed or result exceeded limits. Details omitted.',
              isError: true,
            },
            { callId: 'call_b', output: '{"value":"safe"}' },
          ]);
          assert.doesNotMatch(
            JSON.stringify(requests[1]!.body),
            new RegExp(privatePayload),
          );
        }),
      );
    });

    test(`${provider} ${mode} snapshots a caller-owned result schema when creating the session`, async () => {
      await withCredential(() =>
        withServer(provider, mode, async (baseUrl, requests) => {
          const callerSchema = resultSchema({ type: 'string', enum: ['safe'] });
          const session = adapterFor(provider, baseUrl).createToolSession!({
            prompt: 'Look up alpha and beta.',
            tools: [tool(callerSchema)],
          });
          const property = object(callerSchema.properties).value;
          object(property).enum = ['safe', 'unsafe'];

          const first = await runTurn(session, mode);
          assert.equal(first.finishReason, 'tool-calls');
          await assert.rejects(
            runTurn(session, mode, [
              { callId: 'call_a', output: '{"value":"unsafe"}' },
              { callId: 'call_b', output: '{"value":"safe"}' },
            ]),
            (error: unknown) =>
              error instanceof ProviderError && error.code === 'validation',
          );
          assert.equal(requests.length, 1);
        }),
      );
    });
  }
}
