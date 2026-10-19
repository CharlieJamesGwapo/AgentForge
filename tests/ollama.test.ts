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

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

async function withServer<T>(
  handler: Handler,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer(handler);
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

function sendJson(
  response: ServerResponse,
  value: unknown,
  status = 200,
): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function tags(...names: string[]) {
  return {
    models: names.map((name) => ({
      name,
      modified_at: '2026-01-01T00:00:00Z',
      size: 1,
    })),
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const requestOptions = { approved: true, timeoutMs: 3000 };

test('Ollama metadata declares prompt, structured, streaming, usage, and cancellation support', () => {
  const adapter = new OllamaAdapter({ model: 'fixture-model' });
  assert.equal(adapter.id, 'ollama');
  assert.equal(adapter.version, '1.0.0');
  assert.equal(adapter.kind, 'model-provider');
  assert.deepEqual(adapter.capabilities(), {
    promptSubmission: true,
    structuredResponses: true,
    streaming: true,
    toolInvocation: true,
    toolStreaming: true,
    usageTelemetry: true,
    cancellation: true,
  });
});

const responseSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    labels: { type: 'array', items: { type: 'string' } },
  },
  required: ['name', 'labels'],
  additionalProperties: false,
};

test('health is offline and reports local readiness without probing the server', async () => {
  let requests = 0;
  await withServer(
    (_request, response) => {
      requests++;
      sendJson(response, tags('fixture-model'));
    },
    async (baseUrl) => {
      const health = await new OllamaAdapter({
        model: 'fixture-model',
        baseUrl,
      }).health();
      assert.equal(health.status, 'available');
      assert.equal(health.authentication, 'not-required');
      assert.equal(health.connection, 'not-checked');
      assert.match(health.detail, /configured|ready/i);
      assert.equal(requests, 0);
    },
  );
});

test('health reports an explicitly configured credential as missing without a request', async () => {
  const keyName = 'AGENTFORGE_OLLAMA_TEST_MISSING_KEY';
  await withEnv(keyName, undefined, async () => {
    let requests = 0;
    await withServer(
      (_request, response) => {
        requests++;
        sendJson(response, tags('fixture-model'));
      },
      async (baseUrl) => {
        const health = await new OllamaAdapter({
          model: 'fixture-model',
          baseUrl,
          apiKeyEnv: keyName,
        }).health();
        assert.equal(health.status, 'unavailable');
        assert.equal(health.authentication, 'missing');
        assert.equal(health.connection, 'not-checked');
        assert.equal(requests, 0);
      },
    );
  });
});

test('health reports an explicitly configured credential as ready without a request', async () => {
  const keyName = 'AGENTFORGE_OLLAMA_TEST_KEY';
  await withEnv(keyName, 'ollama-proxy-secret-for-tests', async () => {
    let requests = 0;
    await withServer(
      (_request, response) => {
        requests++;
        sendJson(response, tags('fixture-model'));
      },
      async (baseUrl) => {
        const health = await new OllamaAdapter({
          model: 'fixture-model',
          baseUrl,
          apiKeyEnv: keyName,
        }).health();
        assert.equal(health.status, 'available');
        assert.equal(health.authentication, 'configured');
        assert.equal(health.connection, 'not-checked');
        assert.match(health.detail, /ready|configured/i);
        assert.equal(requests, 0);
      },
    );
  });
});

test('an explicitly configured missing API key fails closed before connecting', async () => {
  const keyName = 'AGENTFORGE_OLLAMA_TEST_MISSING_KEY';
  await withEnv(keyName, undefined, async () => {
    let requests = 0;
    await withServer(
      (_request, response) => {
        requests++;
        sendJson(response, tags('fixture-model'));
      },
      async (baseUrl) => {
        const adapter = new OllamaAdapter({
          model: 'fixture-model',
          baseUrl,
          apiKeyEnv: keyName,
        });
        await assert.rejects(
          adapter.checkConnection(requestOptions),
          (error: unknown) =>
            error instanceof ProviderError && error.code === 'authentication',
        );
        assert.equal(requests, 0);
      },
    );
  });
});

test('connection check reads tags and accepts the implicit latest tag without pulling a model', async () => {
  const requests: string[] = [];
  await withServer(
    (request, response) => {
      requests.push(`${request.method} ${request.url}`);
      sendJson(response, tags('fixture-model:latest'));
    },
    async (baseUrl) => {
      const health = await new OllamaAdapter({
        model: 'fixture-model',
        baseUrl,
      }).checkConnection(requestOptions);
      assert.equal(health.status, 'available');
      assert.equal(health.authentication, 'not-required');
      assert.equal(health.connection, 'verified');
      assert.match(health.detail, /fixture-model/i);
      assert.deepEqual(requests, ['GET /api/tags']);
    },
  );
});

test('connection check reports an absent model as unavailable after verifying Ollama', async () => {
  const requests: string[] = [];
  await withServer(
    (request, response) => {
      requests.push(`${request.method} ${request.url}`);
      sendJson(response, tags('other-model:latest'));
    },
    async (baseUrl) => {
      const health = await new OllamaAdapter({
        model: 'fixture-model',
        baseUrl,
      }).checkConnection(requestOptions);
      assert.equal(health.status, 'unavailable');
      assert.equal(health.connection, 'verified');
      assert.deepEqual(requests, ['GET /api/tags']);
    },
  );
});

test('connection check rejects malformed model tag responses', async () => {
  await withServer(
    (_request, response) =>
      sendJson(response, { models: [{ model: 'fixture-model' }] }),
    async (baseUrl) => {
      const adapter = new OllamaAdapter({ model: 'fixture-model', baseUrl });
      await assert.rejects(
        adapter.checkConnection(requestOptions),
        (error: unknown) =>
          error instanceof ProviderError && error.code === 'invalid-response',
      );
    },
  );
});

test('prompt submission sends Ollama chat payload, optional bearer auth, and exact reported token usage', async () => {
  const keyName = 'AGENTFORGE_OLLAMA_TEST_KEY';
  const secret = 'ollama-proxy-secret-for-tests';
  await withEnv(keyName, secret, async () => {
    let seenPath = '';
    let seenAuthorization: string | undefined;
    let seenBody: unknown;
    await withServer(
      async (request, response) => {
        seenPath = `${request.method} ${request.url}`;
        seenAuthorization = request.headers.authorization;
        seenBody = await readJson(request);
        sendJson(response, {
          model: 'fixture-model:latest',
          message: { role: 'assistant', content: 'A local answer.' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 13,
          eval_count: 7,
        });
      },
      async (baseUrl) => {
        const result = await new OllamaAdapter({
          model: 'fixture-model',
          baseUrl,
          apiKeyEnv: keyName,
          maxOutputTokens: 42,
        }).submitPrompt({ ...requestOptions, prompt: 'Explain the fixture.' });
        assert.equal(seenPath, 'POST /api/chat');
        assert.equal(seenAuthorization, `Bearer ${secret}`);
        assert.deepEqual(seenBody, {
          model: 'fixture-model',
          messages: [{ role: 'user', content: 'Explain the fixture.' }],
          stream: false,
          options: { num_predict: 42 },
        });
        assert.deepEqual(result, {
          text: 'A local answer.',
          model: 'fixture-model:latest',
          finishReason: 'completed',
          usage: { status: 'available', inputTokens: 13, outputTokens: 7 },
        });
      },
    );
  });
});

test('prompt submission forwards a supported response schema and validates structured output', async () => {
  let seenBody: unknown;
  await withServer(
    async (request, response) => {
      seenBody = await readJson(request);
      sendJson(response, {
        model: 'fixture-model',
        message: {
          role: 'assistant',
          content: '{"name":"Ada","labels":["local"]}',
        },
        done: true,
      });
    },
    async (baseUrl) => {
      const result = await new OllamaAdapter({
        model: 'fixture-model',
        baseUrl,
        maxOutputTokens: 42,
      }).submitPrompt({
        ...requestOptions,
        prompt: 'Return a record.',
        responseSchema,
      });
      assert.deepEqual(seenBody, {
        model: 'fixture-model',
        messages: [{ role: 'user', content: 'Return a record.' }],
        stream: false,
        options: { num_predict: 42 },
        format: responseSchema,
      });
      assert.deepEqual(result.structured, {
        status: 'valid',
        data: { name: 'Ada', labels: ['local'] },
      });
    },
  );
});

test('invalid response schemas fail before non-streaming requests', async () => {
  let requests = 0;
  await withServer(
    (_request, response) => {
      requests++;
      sendJson(response, {});
    },
    async (baseUrl) => {
      const adapter = new OllamaAdapter({ model: 'fixture-model', baseUrl });
      await assert.rejects(
        adapter.submitPrompt({
          ...requestOptions,
          prompt: 'Return a record.',
          responseSchema: {
            type: 'object',
            properties: { name: { type: 'string', pattern: '^[A-Z]' } },
            required: ['name'],
            additionalProperties: false,
          },
        }),
        (error: unknown) =>
          error instanceof ProviderError && error.code === 'configuration',
      );
      assert.equal(requests, 0);
    },
  );
});

test('non-streaming validation uses the schema snapshot sent in the request', async () => {
  const requested = deferred();
  const releaseResponse = deferred();
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
      requested.resolve();
      await releaseResponse.promise;
      sendJson(response, {
        model: 'fixture-model',
        message: { role: 'assistant', content: '{"value":"changed"}' },
        done: true,
      });
    },
    async (baseUrl) => {
      const pending = new OllamaAdapter({
        model: 'fixture-model',
        baseUrl,
      }).submitPrompt({
        ...requestOptions,
        prompt: 'Return a record.',
        responseSchema: mutableSchema,
      });
      await requested.promise;
      assert.deepEqual(
        (seenBody as { format: typeof mutableSchema }).format.properties.value
          .enum,
        ['allowed'],
      );
      mutableSchema.properties.value.enum[0] = 'changed';
      releaseResponse.resolve();
      await assert.rejects(
        pending,
        (error: unknown) =>
          error instanceof ProviderError && error.code === 'validation',
      );
    },
  );
});

test('prompt submission omits authorization when no API key environment variable is configured', async () => {
  let authorization: string | undefined;
  await withServer(
    async (request, response) => {
      authorization = request.headers.authorization;
      await readJson(request);
      sendJson(response, {
        model: 'fixture-model',
        message: { role: 'assistant', content: 'Answer.' },
        done: true,
      });
    },
    async (baseUrl) => {
      const result = await new OllamaAdapter({
        model: 'fixture-model',
        baseUrl,
      }).submitPrompt({
        ...requestOptions,
        prompt: 'Question',
      });
      assert.equal(authorization, undefined);
      assert.deepEqual(result.usage, { status: 'unavailable' });
    },
  );
});

test('prompt submission treats invalid usage counters as unavailable rather than estimating tokens', async () => {
  await withServer(
    async (request, response) => {
      await readJson(request);
      sendJson(response, {
        model: 'fixture-model',
        message: { role: 'assistant', content: 'Answer.' },
        done: true,
        prompt_eval_count: -3,
        eval_count: Number.MAX_SAFE_INTEGER + 1,
      });
    },
    async (baseUrl) => {
      const result = await new OllamaAdapter({
        model: 'fixture-model',
        baseUrl,
      }).submitPrompt({
        ...requestOptions,
        prompt: 'Question',
      });
      assert.deepEqual(result.usage, { status: 'unavailable' });
    },
  );
});

test('prompt submission reports an explicit output length limit', async () => {
  await withServer(
    async (request, response) => {
      await readJson(request);
      sendJson(response, {
        model: 'fixture-model',
        message: { role: 'assistant', content: 'Partial answer' },
        done: true,
        done_reason: 'length',
      });
    },
    async (baseUrl) => {
      const result = await new OllamaAdapter({
        model: 'fixture-model',
        baseUrl,
      }).submitPrompt({
        ...requestOptions,
        prompt: 'Question',
      });
      assert.equal(result.finishReason, 'length');
      assert.equal(result.text, 'Partial answer');
    },
  );
});

test('an explicitly length-limited empty response is returned as a length completion', async () => {
  await withServer(
    async (request, response) => {
      await readJson(request);
      sendJson(response, {
        model: 'fixture-model',
        message: { role: 'assistant', content: '' },
        done: true,
        done_reason: 'length',
      });
    },
    async (baseUrl) => {
      const result = await new OllamaAdapter({
        model: 'fixture-model',
        baseUrl,
      }).submitPrompt({
        ...requestOptions,
        prompt: 'Question',
      });
      assert.equal(result.text, '');
      assert.equal(result.finishReason, 'length');
    },
  );
});

test('a refusal response marks structured output unavailable', async () => {
  await withServer(
    async (request, response) => {
      await readJson(request);
      sendJson(response, {
        model: 'fixture-model',
        message: {
          role: 'assistant',
          content: 'I cannot help with that request.',
        },
        done: true,
        done_reason: 'refusal',
      });
    },
    async (baseUrl) => {
      const result = await new OllamaAdapter({
        model: 'fixture-model',
        baseUrl,
      }).submitPrompt({
        ...requestOptions,
        prompt: 'Return a record.',
        responseSchema,
      });
      assert.equal(result.finishReason, 'refusal');
      assert.deepEqual(result.structured, {
        status: 'unavailable',
        reason: 'refusal',
      });
    },
  );
});

test('prompt submission rejects malformed, partial, empty, and tool-call responses', async (t) => {
  const invalidBodies: unknown[] = [
    { error: 'model not found' },
    {
      model: 'fixture-model',
      message: { role: 'assistant', content: 'Answer.' },
      done: false,
    },
    {
      model: 'fixture-model',
      message: { role: 'user', content: 'Answer.' },
      done: true,
    },
    {
      model: 'fixture-model',
      message: { role: 'assistant', content: '' },
      done: true,
    },
    {
      model: 'fixture-model',
      message: {
        role: 'assistant',
        content: 'Answer.',
        tool_calls: [{ function: { name: 'x' } }],
      },
      done: true,
    },
    {
      model: 'fixture-model',
      message: { role: 'assistant', content: 'Answer.' },
      done: true,
      done_reason: 'other',
    },
  ];
  for (const [index, body] of invalidBodies.entries()) {
    await t.test(`rejects invalid response ${index + 1}`, async () => {
      await withServer(
        async (request, response) => {
          await readJson(request);
          sendJson(response, body);
        },
        async (baseUrl) => {
          const adapter = new OllamaAdapter({
            model: 'fixture-model',
            baseUrl,
          });
          await assert.rejects(
            adapter.submitPrompt({ ...requestOptions, prompt: 'Question' }),
            (error: unknown) =>
              error instanceof ProviderError &&
              error.code === 'invalid-response',
          );
        },
      );
    });
  }
});

test('a redirect is rejected without following it or retrying', async () => {
  let originalRequests = 0;
  let redirectedRequests = 0;
  await withServer(
    (request, response) => {
      if (request.url === '/api/tags') {
        originalRequests++;
        response.writeHead(302, { location: '/redirect-target' });
        response.end();
      } else {
        redirectedRequests++;
        sendJson(response, tags('fixture-model'));
      }
    },
    async (baseUrl) => {
      const adapter = new OllamaAdapter({ model: 'fixture-model', baseUrl });
      await assert.rejects(adapter.checkConnection(requestOptions));
      assert.equal(originalRequests, 1);
      assert.equal(redirectedRequests, 0);
    },
  );
});

test('provider errors redact configured credentials from server response text', async () => {
  const keyName = 'AGENTFORGE_OLLAMA_TEST_KEY';
  const secret = 'ollama-secret-that-must-not-leak';
  await withEnv(keyName, secret, async () => {
    await withServer(
      async (request, response) => {
        await readJson(request);
        sendJson(response, { error: `denied Bearer ${secret}` }, 401);
      },
      async (baseUrl) => {
        const adapter = new OllamaAdapter({
          model: 'fixture-model',
          baseUrl,
          apiKeyEnv: keyName,
        });
        await assert.rejects(
          adapter.submitPrompt({ ...requestOptions, prompt: 'Question' }),
          (error: unknown) => {
            assert.ok(error instanceof ProviderError);
            assert.equal(error.code, 'authentication');
            assert.ok(!error.message.includes(secret));
            return true;
          },
        );
      },
    );
  });
});
