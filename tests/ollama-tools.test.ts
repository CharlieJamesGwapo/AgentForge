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

function sendJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
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

function chatResponse(
  message: Record<string, unknown>,
  options: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    model: 'fixture-model',
    message: { role: 'assistant', content: '', ...message },
    done: true,
    done_reason: 'stop',
    ...options,
  };
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

test('Ollama tool conversation sends declarations and replays parallel calls, thinking, and ordered results', async () => {
  const requests: unknown[] = [];
  const localEffects = 0;
  const responses = [
    chatResponse(
      {
        content: 'I will calculate both sums.',
        thinking: 'private reasoning for the first turn',
        tool_calls: [
          {
            type: 'function',
            function: { index: 0, name: 'add', arguments: { a: 19, b: 23 } },
          },
          {
            type: 'function',
            function: { index: 1, name: 'add', arguments: { a: 8, b: 13 } },
          },
        ],
      },
      { prompt_eval_count: 17, eval_count: 5 },
    ),
    chatResponse(
      {
        content: 'The sums are 42 and 21.',
        thinking: 'private final reasoning',
      },
      { prompt_eval_count: 26, eval_count: 7 },
    ),
  ];

  await withServer(
    async (request, response) => {
      requests.push(await readJson(request));
      sendJson(response, responses[requests.length - 1]);
    },
    async (baseUrl) => {
      const adapter = new OllamaAdapter({
        model: 'fixture-model',
        baseUrl,
        maxOutputTokens: 31,
      });
      assert.equal(adapter.capabilities().toolInvocation, true);
      const session = adapter.createToolSession!({
        prompt: 'Add 19 and 23, and add 8 and 13.',
        tools,
      });

      const first = await session.next(requestOptions);
      assert.equal(first.finishReason, 'tool-calls');
      assert.equal(first.text, 'I will calculate both sums.');
      assert.deepEqual(first.usage, {
        status: 'available',
        inputTokens: 17,
        outputTokens: 5,
      });
      assert.deepEqual(
        first.calls.map(({ name, arguments: args }) => ({ name, args })),
        [
          { name: 'add', args: { a: 19, b: 23 } },
          { name: 'add', args: { a: 8, b: 13 } },
        ],
      );
      assert.deepEqual(
        first.calls.map(({ id }) => id),
        ['ollama-call-1', 'ollama-call-2'],
      );
      assert.equal(localEffects, 0);
      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0], {
        model: 'fixture-model',
        messages: [
          {
            role: 'user',
            content: 'Add 19 and 23, and add 8 and 13.',
          },
        ],
        stream: false,
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

      const final = await session.next({
        ...requestOptions,
        results: [
          { callId: first.calls[1]!.id, output: '21' },
          { callId: first.calls[0]!.id, output: '42' },
        ],
      });
      assert.equal(final.finishReason, 'completed');
      assert.equal(final.text, 'The sums are 42 and 21.');
      assert.deepEqual(requests[1], {
        model: 'fixture-model',
        messages: [
          {
            role: 'user',
            content: 'Add 19 and 23, and add 8 and 13.',
          },
          {
            role: 'assistant',
            content: 'I will calculate both sums.',
            thinking: 'private reasoning for the first turn',
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
        stream: false,
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
      assert.equal(localEffects, 0);
      assert.equal(requests.length, 2);
    },
  );
});

test('Ollama preserves a valid native call id and rejects malformed call data', async () => {
  const valid = chatResponse({
    tool_calls: [
      {
        id: 'native-call-7',
        type: 'function',
        function: { name: 'add', arguments: { a: 1, b: 2 } },
      },
    ],
  });
  await withServer(
    async (_request, response) => sendJson(response, valid),
    async (baseUrl) => {
      const turn = await new OllamaAdapter({
        model: 'fixture-model',
        baseUrl,
      }).createToolSession!({ prompt: 'Add 1 and 2.', tools }).next(
        requestOptions,
      );
      assert.equal(turn.calls[0]?.id, 'native-call-7');
    },
  );

  const malformedResponses = [
    chatResponse({ tool_calls: [{ function: { name: 'add' } }] }),
    chatResponse({
      tool_calls: [{ function: { name: 'add', arguments: [{ a: 1, b: 2 }] } }],
    }),
    chatResponse({
      tool_calls: [
        { id: '', function: { name: 'add', arguments: { a: 1, b: 2 } } },
      ],
    }),
    chatResponse({
      tool_calls: [
        { id: 'bad id', function: { name: 'add', arguments: { a: 1, b: 2 } } },
      ],
    }),
    chatResponse({ tool_calls: 'not-an-array' }),
    { ...chatResponse({ content: 'unfinished' }), done: false },
  ];

  for (const malformed of malformedResponses) {
    await withServer(
      async (_request, response) => sendJson(response, malformed),
      async (baseUrl) => {
        const session = new OllamaAdapter({
          model: 'fixture-model',
          baseUrl,
        }).createToolSession!({ prompt: 'Add 1 and 2.', tools });
        await assert.rejects(
          session.next(requestOptions),
          (error: unknown) =>
            error instanceof ProviderError && error.code === 'invalid-response',
        );
      },
    );
  }
});

test('Ollama never exposes tool calls from length or refusal responses', async () => {
  for (const doneReason of ['length', 'refusal']) {
    await withServer(
      async (_request, response) =>
        sendJson(
          response,
          chatResponse(
            {
              thinking: 'partial private reasoning',
              tool_calls: [
                {
                  function: {
                    name: 'add',
                    arguments: { a: 19, b: 23 },
                  },
                },
              ],
            },
            { done_reason: doneReason },
          ),
        ),
      async (baseUrl) => {
        const session = new OllamaAdapter({
          model: 'fixture-model',
          baseUrl,
        }).createToolSession!({ prompt: 'Add 19 and 23.', tools });
        await assert.rejects(
          session.next(requestOptions),
          (error: unknown) =>
            error instanceof ProviderError && error.code === 'invalid-response',
        );
      },
    );
  }
});

test('Ollama tool requests require approval, honor cancellation, and use the captured credential', async () => {
  const keyName = 'AGENTFORGE_OLLAMA_TOOLS_TEST_KEY';
  await withEnv(keyName, 'ollama-tools-fixture-secret', async () => {
    let requests = 0;
    let authorization: string | undefined;
    await withServer(
      async (request, response) => {
        requests++;
        authorization = request.headers.authorization;
        await readJson(request);
        sendJson(response, chatResponse({ content: 'ready' }));
      },
      async (baseUrl) => {
        const session = new OllamaAdapter({
          model: 'fixture-model',
          baseUrl,
          apiKeyEnv: keyName,
        }).createToolSession!({ prompt: 'Say ready.', tools });
        await assert.rejects(
          session.next({ ...requestOptions, approved: false }),
          /approval/i,
        );
        await assert.rejects(
          session.next({ ...requestOptions, signal: AbortSignal.abort() }),
          /cancel/i,
        );
        assert.equal(requests, 0);

        const turn = await session.next(requestOptions);
        assert.equal(turn.text, 'ready');
        assert.equal(authorization, 'Bearer ollama-tools-fixture-secret');
        assert.equal(requests, 1);
      },
    );
  });
});
