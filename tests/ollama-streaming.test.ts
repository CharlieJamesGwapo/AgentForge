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

function assistantFrame(
  content: string,
  options: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    model: 'fixture-model',
    message: { role: 'assistant', content },
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
const responseSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    labels: { type: 'array', items: { type: 'string' } },
  },
  required: ['name', 'labels'],
  additionalProperties: false,
};

test('Ollama streams fragmented UTF-8 and complete newlines before the response ends', async () => {
  const firstFrameWritten = deferred();
  const continueStream = deferred();
  let seenBody: unknown;
  await withServer(
    async (request, response) => {
      seenBody = await readJson(request);
      response.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
      });
      const initial = Buffer.from(
        frame({
          ...assistantFrame('First café\n', {
            prompt_eval_count: 900,
            eval_count: 901,
          }),
        }),
      );
      const accent = initial.indexOf(Buffer.from('é'));
      response.write(initial.subarray(0, accent + 1));
      response.write(initial.subarray(accent + 1));
      firstFrameWritten.resolve();
      await continueStream.promise;
      response.write(
        frame(assistantFrame('second ', { eval_count: 800 })) +
          frame({
            ...assistantFrame('answer', {
              done: true,
              done_reason: 'stop',
              prompt_eval_count: 11,
              eval_count: 5,
            }),
          }),
      );
      response.end();
    },
    async (baseUrl) => {
      const adapter = new OllamaAdapter({
        model: 'fixture-model',
        baseUrl,
        maxOutputTokens: 17,
      });
      const iterator = adapter.streamPrompt!({
        ...requestOptions,
        prompt: 'Stream a short answer.',
      })[Symbol.asyncIterator]();
      try {
        const firstEvent = iterator.next();
        await firstFrameWritten.promise;
        const first = await firstEvent;
        assert.equal(first.done, false);
        assert.deepEqual(first.value, {
          type: 'text-delta',
          text: 'First café\n',
          provisional: true,
        });
        assert.deepEqual(seenBody, {
          model: 'fixture-model',
          messages: [{ role: 'user', content: 'Stream a short answer.' }],
          stream: true,
          options: { num_predict: 17 },
        });

        continueStream.resolve();
        const remaining = [];
        for await (const event of {
          [Symbol.asyncIterator]: () => iterator,
        })
          remaining.push(event);
        const events = [first.value, ...remaining];
        const deltas = events.filter((event) => event.type === 'text-delta');
        const complete = events.at(-1);
        assert.equal(
          deltas.map((event) => event.text).join(''),
          'First café\nsecond answer',
        );
        assert.equal(complete?.type, 'complete');
        if (complete?.type !== 'complete') assert.fail('Missing completion.');
        assert.deepEqual(complete.result.usage, {
          status: 'available',
          inputTokens: 11,
          outputTokens: 5,
        });
        assert.equal(complete.result.text, 'First café\nsecond answer');
      } finally {
        continueStream.resolve();
        await iterator.return?.();
      }
    },
  );
});

test('Ollama validates structured stream output and forwards the JSON schema', async () => {
  let seenBody: unknown;
  await withServer(
    async (request, response) => {
      seenBody = await readJson(request);
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(
        frame({
          ...assistantFrame('{"name":"Ada","labels":["local"]}', {
            done: true,
            done_reason: 'stop',
          }),
        }),
      );
    },
    async (baseUrl) => {
      const adapter = new OllamaAdapter({ model: 'fixture-model', baseUrl });
      const events = [];
      for await (const event of adapter.streamPrompt!({
        ...requestOptions,
        prompt: 'Return a record.',
        responseSchema,
      }))
        events.push(event);
      assert.deepEqual(seenBody, {
        model: 'fixture-model',
        messages: [{ role: 'user', content: 'Return a record.' }],
        stream: true,
        options: { num_predict: 1024 },
        format: responseSchema,
      });
      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, 'complete');
      if (events[0]?.type !== 'complete') assert.fail('Missing completion.');
      assert.deepEqual(events[0].result.structured, {
        status: 'valid',
        data: { name: 'Ada', labels: ['local'] },
      });
    },
  );
});

test('structured streaming validates with its invocation-time schema snapshot', async () => {
  const mutableSchema = {
    type: 'object',
    properties: { value: { type: 'string', enum: ['allowed'] } },
    required: ['value'],
    additionalProperties: false,
  };
  let seenBody: unknown;
  await withServer(
    async (request, response) => {
      seenBody = await readJson(request);
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(
        frame({
          ...assistantFrame('{"value":"changed"}', {
            done: true,
            done_reason: 'stop',
          }),
        }),
      );
    },
    async (baseUrl) => {
      const stream = new OllamaAdapter({
        model: 'fixture-model',
        baseUrl,
      }).streamPrompt!({
        ...requestOptions,
        prompt: 'Return a record.',
        responseSchema: mutableSchema,
      });
      mutableSchema.properties.value.enum[0] = 'changed';
      await assert.rejects(
        async () => {
          for await (const event of stream)
            assert.fail(`Unexpected stream event: ${event.type}`);
        },
        (error: unknown) =>
          error instanceof ProviderError && error.code === 'validation',
      );
      assert.deepEqual(
        (seenBody as { format: typeof mutableSchema }).format.properties.value
          .enum,
        ['allowed'],
      );
    },
  );
});

test('invalid response schemas fail before streaming requests', async () => {
  let requests = 0;
  await withServer(
    (_request, response) => {
      requests++;
      response.writeHead(200);
      response.end();
    },
    async (baseUrl) => {
      const adapter = new OllamaAdapter({ model: 'fixture-model', baseUrl });
      await assert.rejects(
        async () => {
          for await (const event of adapter.streamPrompt!({
            ...requestOptions,
            prompt: 'Return a record.',
            responseSchema: {
              type: 'object',
              properties: { name: { type: 'string', pattern: '^[A-Z]' } },
              required: ['name'],
              additionalProperties: false,
            },
          })) {
            assert.fail(`Unexpected stream event: ${event.type}`);
          }
        },
        (error: unknown) =>
          error instanceof ProviderError && error.code === 'configuration',
      );
      assert.equal(requests, 0);
    },
  );
});

test('length-limited structured streams return unavailable structured data', async () => {
  await withServer(
    async (request, response) => {
      await readJson(request);
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(
        frame({
          ...assistantFrame('{"name":', {
            done: true,
            done_reason: 'length',
          }),
        }),
      );
    },
    async (baseUrl) => {
      const events = [];
      for await (const event of new OllamaAdapter({
        model: 'fixture-model',
        baseUrl,
      }).streamPrompt!({
        ...requestOptions,
        prompt: 'Return a record.',
        responseSchema,
      }))
        events.push(event);
      assert.equal(events.at(-1)?.type, 'complete');
      const completion = events.at(-1);
      if (completion?.type !== 'complete') assert.fail('Missing completion.');
      assert.equal(completion.result.finishReason, 'length');
      assert.deepEqual(completion.result.structured, {
        status: 'unavailable',
        reason: 'length',
      });
    },
  );
});

test('Ollama does not expose a credential split across streamed text chunks', async () => {
  const keyName = 'AGENTFORGE_OLLAMA_STREAM_TEST_KEY';
  const secret = 'stream-sensitive-secret';
  await withEnv(keyName, secret, async () => {
    await withServer(
      async (request, response) => {
        await readJson(request);
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        response.end(
          frame(assistantFrame('Prefix stream-sensitive-')) +
            frame(assistantFrame('secret suffix\n')) +
            frame({
              ...assistantFrame('', {
                done: true,
                done_reason: 'stop',
                prompt_eval_count: 2,
                eval_count: 2,
              }),
            }),
        );
      },
      async (baseUrl) => {
        const events = [];
        for await (const event of new OllamaAdapter({
          model: 'fixture-model',
          baseUrl,
          apiKeyEnv: keyName,
        }).streamPrompt!({ ...requestOptions, prompt: 'Question' }))
          events.push(event);
        for (const event of events) {
          const visible =
            event.type === 'text-delta' ? event.text : event.result.text;
          assert.ok(!visible.includes(secret));
        }
      },
    );
  });
});

test('Ollama rejects malformed, failed, tool-call, and unterminated streams', async (t) => {
  const invalidFrames: Array<{ name: string; body: string }> = [
    { name: 'malformed frame', body: 'not-json\n' },
    { name: 'provider error', body: frame({ error: 'model missing' }) },
    {
      name: 'unexpected tool call',
      body: frame({
        ...assistantFrame('', { done: true }),
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'unsupported' } }],
        },
      }),
    },
    {
      name: 'model identity changes',
      body:
        frame(assistantFrame('partial')) +
        frame({
          ...assistantFrame(' answer', { done: true }),
          model: 'other-model',
        }),
    },
    { name: 'EOF before done=true', body: frame(assistantFrame('partial')) },
  ];
  for (const { name, body } of invalidFrames) {
    await t.test(name, async () => {
      await withServer(
        async (request, response) => {
          await readJson(request);
          response.writeHead(200, { 'content-type': 'application/x-ndjson' });
          response.end(body);
        },
        async (baseUrl) => {
          await assert.rejects(
            async () => {
              for await (const event of new OllamaAdapter({
                model: 'fixture-model',
                baseUrl,
              }).streamPrompt!({ ...requestOptions, prompt: 'Question' })) {
                assert.fail(`Unexpected stream event: ${event.type}`);
              }
            },
            (error: unknown) =>
              error instanceof ProviderError &&
              error.code === 'invalid-response',
          );
        },
      );
    });
  }
});
