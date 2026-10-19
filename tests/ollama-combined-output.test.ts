import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { OllamaAdapter } from '../src/adapters/ollama.js';
import { ProviderError } from '../src/adapters/errors.js';
import { runToolConversation } from '../src/engines/tools.js';
import type { ToolDefinition } from '../src/adapters/types.js';

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

function sendJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function frame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function chatResponse(
  content: string,
  options: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    model: 'fixture-model',
    message: { role: 'assistant', content },
    done: true,
    done_reason: 'stop',
    ...options,
  };
}

function toolCallResponse(): Record<string, unknown> {
  return {
    model: 'fixture-model',
    message: {
      role: 'assistant',
      content: 'Looking up the requested value.',
      tool_calls: [
        {
          type: 'function',
          function: { name: 'lookup', arguments: { query: 'Paris' } },
        },
      ],
    },
    done: true,
    done_reason: 'stop',
  };
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
const outputSchema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};
const toolDefinition: ToolDefinition = {
  name: 'lookup',
  description: 'Look up a value.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
};
const tools = [toolDefinition];
const nativeTools = [
  {
    type: 'function',
    function: {
      name: toolDefinition.name,
      description: toolDefinition.description,
      parameters: toolDefinition.parameters,
    },
  },
];

function assertCombinedRequest(
  body: unknown,
  stream: boolean,
  schema: Record<string, unknown> = outputSchema,
): asserts body is Record<string, unknown> {
  assert.ok(body && typeof body === 'object' && !Array.isArray(body));
  const request = body as Record<string, unknown>;
  assert.deepEqual(request.format, schema);
  assert.deepEqual(request.tools, nativeTools);
  assert.equal(request.stream, stream);
  assert.deepEqual(request.options, { num_predict: 1024 });
}

test('Ollama combines tool declarations and output format across approved turns', async () => {
  const requests: unknown[] = [];
  const responses = [
    toolCallResponse(),
    toolCallResponse(),
    chatResponse('{"answer":"Paris"}'),
  ];
  let effects = 0;

  await withServer(
    async (request, response) => {
      requests.push(await readJson(request));
      sendJson(response, responses[requests.length - 1]);
    },
    async (baseUrl) => {
      const adapter = new OllamaAdapter({ model: 'fixture-model', baseUrl });
      const registered = [
        {
          definition: toolDefinition,
          async execute() {
            effects++;
            return { result: 'looked up' };
          },
        },
      ];
      const denied = await runToolConversation({
        session: adapter.createToolSession!({
          prompt: 'Look up Paris.',
          tools,
          responseSchema: outputSchema,
        }),
        tools: registered,
        request: requestOptions,
        approve: async () => false,
      });
      assert.equal(denied.status, 'approval-required');
      assert.deepEqual(denied.turn.structured, {
        status: 'pending',
        reason: 'tool-calls',
      });
      assert.equal(effects, 0);
      assert.equal(requests.length, 1);

      const approved = await runToolConversation({
        session: adapter.createToolSession!({
          prompt: 'Look up Paris.',
          tools,
          responseSchema: outputSchema,
        }),
        tools: registered,
        request: requestOptions,
        approve: async () => true,
      });
      assert.equal(approved.status, 'completed');
      assert.equal(effects, 1);
      assert.deepEqual(approved.turn.structured, {
        status: 'valid',
        data: { answer: 'Paris' },
      });
      assert.equal(requests.length, 3);

      for (const body of requests) assertCombinedRequest(body, false);
      assert.deepEqual((requests[0] as Record<string, unknown>).messages, [
        { role: 'user', content: 'Look up Paris.' },
      ]);
      assert.deepEqual((requests[2] as Record<string, unknown>).messages, [
        { role: 'user', content: 'Look up Paris.' },
        {
          role: 'assistant',
          content: 'Looking up the requested value.',
          tool_calls: [
            {
              type: 'function',
              function: {
                name: 'lookup',
                arguments: { query: 'Paris' },
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_name: 'lookup',
          content: '{"result":"looked up"}',
        },
      ]);
    },
  );
});

test('Ollama rejects a final tool answer outside the strict response schema', async () => {
  const requests: unknown[] = [];
  const output = 'private-invalid-payload';
  const responses = [
    toolCallResponse(),
    chatResponse(JSON.stringify({ answer: 'Paris', extra: output })),
  ];

  await withServer(
    async (request, response) => {
      requests.push(await readJson(request));
      sendJson(response, responses[requests.length - 1]);
    },
    async (baseUrl) => {
      const session = new OllamaAdapter({
        model: 'fixture-model',
        baseUrl,
      }).createToolSession!({
        prompt: 'Look up Paris.',
        tools,
        responseSchema: outputSchema,
      });
      const first = await session.next(requestOptions);
      assert.deepEqual(first.structured, {
        status: 'pending',
        reason: 'tool-calls',
      });
      await assert.rejects(
        session.next({
          ...requestOptions,
          results: [{ callId: first.calls[0]!.id, output: 'done' }],
        }),
        (error: unknown) =>
          error instanceof ProviderError &&
          error.code === 'validation' &&
          !error.message.includes(output),
      );
      assert.equal(requests.length, 2);
      for (const body of requests) assertCombinedRequest(body, false);
    },
  );
});

test('Ollama withholds newline-terminated raw JSON during structured tool streaming', async () => {
  const requests: unknown[] = [];

  await withServer(
    async (request, response) => {
      requests.push(await readJson(request));
      if (requests.length === 1) {
        sendJson(response, toolCallResponse());
        return;
      }
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(
        frame({
          model: 'fixture-model',
          message: { role: 'assistant', content: '{"answer":\n' },
          done: false,
        }),
      );
      response.write(
        frame({
          model: 'fixture-model',
          message: { role: 'assistant', content: '"Paris"}\n' },
          done: false,
        }),
      );
      response.end(
        frame({
          model: 'fixture-model',
          message: { role: 'assistant', content: '' },
          done: true,
          done_reason: 'stop',
        }),
      );
    },
    async (baseUrl) => {
      const session = new OllamaAdapter({
        model: 'fixture-model',
        baseUrl,
      }).createToolSession!({
        prompt: 'Look up Paris.',
        tools,
        responseSchema: outputSchema,
      });
      const first = await session.next(requestOptions);
      const events = [];
      for await (const event of session.stream!({
        ...requestOptions,
        results: [{ callId: first.calls[0]!.id, output: 'done' }],
      }))
        events.push(event);

      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, 'complete');
      if (events[0]?.type !== 'complete') assert.fail('Missing completion.');
      assert.equal(events[0].turn.finishReason, 'completed');
      assert.equal(events[0].turn.text, '{"answer":"Paris"}');
      assert.deepEqual(events[0].turn.structured, {
        status: 'valid',
        data: { answer: 'Paris' },
      });
      assertCombinedRequest(requests[0], false);
      assertCombinedRequest(requests[1], true);
    },
  );
});

test('Ollama tool sessions snapshot response schemas and redact short credentials', async () => {
  const keyName = 'AGENTFORGE_COMBINED_OUTPUT_KEY';
  const secret = 'q7';
  const mutableSchema = {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['lookup'] },
      answer: { type: 'string' },
    },
    required: ['kind', 'answer'],
    additionalProperties: false,
  };
  const expectedSchema = structuredClone(mutableSchema);
  const requests: unknown[] = [];
  const responses = [
    toolCallResponse(),
    chatResponse(JSON.stringify({ kind: 'lookup', answer: secret })),
  ];

  await withEnv(keyName, secret, async () =>
    withServer(
      async (request, response) => {
        requests.push(await readJson(request));
        sendJson(response, responses[requests.length - 1]);
      },
      async (baseUrl) => {
        const session = new OllamaAdapter({
          model: 'fixture-model',
          baseUrl,
          apiKeyEnv: keyName,
        }).createToolSession!({
          prompt: 'Look up Paris.',
          tools,
          responseSchema: mutableSchema,
        });
        mutableSchema.properties.kind.enum[0] =
          'changed-after-session-creation';

        const first = await session.next(requestOptions);
        const final = await session.next({
          ...requestOptions,
          results: [{ callId: first.calls[0]!.id, output: 'done' }],
        });

        assert.deepEqual(final.structured, {
          status: 'valid',
          data: { kind: 'lookup', answer: '[REDACTED]' },
        });
        assert.equal(final.text, '{"kind":"lookup","answer":"[REDACTED]"}');
        assert.ok(!JSON.stringify(final).includes(secret));
        assert.equal(requests.length, 2);
        for (const body of requests) {
          assertCombinedRequest(body, false, expectedSchema);
        }
      },
    ),
  );
});

test('Ollama tool final turns report length and refusal as structured unavailable', async (t) => {
  for (const reason of ['length', 'refusal'] as const) {
    await t.test(reason, async () => {
      const requests: unknown[] = [];
      const responses = [
        toolCallResponse(),
        chatResponse('{"answer":', { done_reason: reason }),
      ];
      await withServer(
        async (request, response) => {
          requests.push(await readJson(request));
          sendJson(response, responses[requests.length - 1]);
        },
        async (baseUrl) => {
          const session = new OllamaAdapter({
            model: 'fixture-model',
            baseUrl,
          }).createToolSession!({
            prompt: 'Look up Paris.',
            tools,
            responseSchema: outputSchema,
          });
          const first = await session.next(requestOptions);
          const final = await session.next({
            ...requestOptions,
            results: [{ callId: first.calls[0]!.id, output: 'done' }],
          });
          assert.equal(final.finishReason, reason);
          assert.deepEqual(final.structured, {
            status: 'unavailable',
            reason,
          });
          assert.equal(requests.length, 2);
          for (const body of requests) assertCombinedRequest(body, false);
        },
      );
    });
  }
});
