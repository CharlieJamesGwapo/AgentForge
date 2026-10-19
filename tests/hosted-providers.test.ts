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

async function withServer(
  respond: (request: CapturedRequest, response: ServerResponse) => void,
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
      respond(captured, response);
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

function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
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

test('OpenAI submits the exact prompt to Responses and returns all native text blocks and usage', async () => {
  await withCredential('OPENAI_API_KEY', 'openai-contract-secret', async () => {
    await withServer(
      (_request, response) =>
        json(response, {
          id: 'resp_test',
          object: 'response',
          status: 'completed',
          model: 'fixture-model-2026',
          output: [
            {
              id: 'msg_test',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [
                { type: 'output_text', text: 'first block ' },
                { type: 'output_text', text: 'second block' },
              ],
            },
          ],
          usage: {
            input_tokens: 17,
            output_tokens: 5,
            input_tokens_details: { cached_tokens: 9 },
          },
        }),
      async (baseUrl, requests) => {
        const adapter = new OpenAIAdapter({
          model: 'fixture-model-requested',
          baseUrl,
          maxOutputTokens: 77,
        });
        const result = await adapter.submitPrompt!({
          prompt: 'Keep every character.\nSecond line.',
          ...requestOptions,
        });

        assert.equal(requests.length, 1);
        assert.equal(requests[0]?.method, 'POST');
        assert.equal(requests[0]?.url, '/responses');
        assert.equal(
          requests[0]?.headers.authorization,
          'Bearer openai-contract-secret',
        );
        assert.equal(requests[0]?.headers['content-type'], 'application/json');
        assert.deepEqual(requests[0]?.body, {
          model: 'fixture-model-requested',
          input: 'Keep every character.\nSecond line.',
          max_output_tokens: 77,
          store: false,
          stream: false,
        });
        assert.deepEqual(result, {
          text: 'first block second block',
          model: 'fixture-model-2026',
          finishReason: 'completed',
          usage: {
            status: 'available',
            inputTokens: 17,
            outputTokens: 5,
            cachedInputTokens: 9,
          },
        });
      },
    );
  });
});

test('OpenAI sends a portable strict JSON schema and returns validated structured data', async () => {
  const responseSchema = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  };
  await withCredential(
    'OPENAI_API_KEY',
    'openai-structured-secret',
    async () => {
      await withServer(
        (_request, response) =>
          json(response, {
            status: 'completed',
            model: 'fixture-model',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: '{"answer":"ready"}' }],
              },
            ],
            usage: { input_tokens: 2, output_tokens: 2 },
          }),
        async (baseUrl, requests) => {
          const result = await new OpenAIAdapter({
            model: 'fixture-model',
            baseUrl,
          }).submitPrompt!({
            prompt: 'Return an answer.',
            responseSchema,
            ...requestOptions,
          });
          assert.deepEqual(requests[0]?.body, {
            model: 'fixture-model',
            input: 'Return an answer.',
            max_output_tokens: 1024,
            store: false,
            stream: false,
            text: {
              format: {
                type: 'json_schema',
                name: 'agentforge_output',
                strict: true,
                schema: responseSchema,
              },
            },
          });
          assert.deepEqual(result.structured, {
            status: 'valid',
            data: { answer: 'ready' },
          });
        },
      );
    },
  );
});

test('OpenAI offline health reports a missing key without making a request', async () => {
  await withCredential('OPENAI_API_KEY', undefined, async () => {
    let requestCount = 0;
    await withServer(
      (_request, response) => {
        requestCount += 1;
        json(response, { data: [] });
      },
      async (baseUrl) => {
        const health = await new OpenAIAdapter({
          model: 'fixture-model',
          baseUrl,
        }).health();
        assert.equal(health.status, 'unavailable');
        assert.equal(health.authentication, 'missing');
        assert.equal(requestCount, 0);
      },
    );
  });
});

test('configured offline health reports readiness without claiming a connection', async () => {
  await withCredential('OPENAI_API_KEY', 'openai-health-secret', async () => {
    await withCredential(
      'ANTHROPIC_API_KEY',
      'anthropic-health-secret',
      async () => {
        let requestCount = 0;
        await withServer(
          (_request, response) => {
            requestCount += 1;
            json(response, { data: [] });
          },
          async (baseUrl) => {
            const openai = await new OpenAIAdapter({
              model: 'fixture-model',
              baseUrl,
            }).health();
            const anthropic = await new AnthropicAdapter({
              model: 'fixture-model',
              baseUrl,
            }).health();
            for (const health of [openai, anthropic]) {
              assert.equal(health.status, 'available');
              assert.equal(health.authentication, 'configured');
              assert.equal(health.connection, 'not-checked');
              assert.match(health.detail, /not connected/i);
            }
            assert.equal(requestCount, 0);
          },
        );
      },
    );
  });
});

test('OpenAI connection check verifies the models response without claiming inference access', async () => {
  await withCredential('OPENAI_API_KEY', 'openai-check-secret', async () => {
    await withServer(
      (_request, response) =>
        json(response, { data: [{ id: 'fixture-model' }] }),
      async (baseUrl, requests) => {
        const adapter = new OpenAIAdapter({ model: 'fixture-model', baseUrl });
        const health = await adapter.checkConnection!(requestOptions);
        assert.equal(requests[0]?.method, 'GET');
        assert.equal(requests[0]?.url, '/models');
        assert.equal(
          requests[0]?.headers.authorization,
          'Bearer openai-check-secret',
        );
        assert.equal(health.status, 'available');
        assert.equal(health.authentication, 'configured');
        assert.equal(health.connection, 'verified');
        assert.match(
          health.detail,
          /does not guarantee inference or model access/i,
        );
      },
    );
  });
});

test('Anthropic connection check validates model-list data and sends the required headers', async () => {
  await withCredential(
    'ANTHROPIC_API_KEY',
    'anthropic-check-secret',
    async () => {
      await withServer(
        (_request, response) =>
          json(response, { data: [{ id: 'fixture-model' }] }),
        async (baseUrl, requests) => {
          const adapter = new AnthropicAdapter({
            model: 'fixture-model',
            baseUrl,
          });
          const health = await adapter.checkConnection!(requestOptions);
          assert.equal(requests[0]?.method, 'GET');
          assert.equal(requests[0]?.url, '/models');
          assert.equal(
            requests[0]?.headers['x-api-key'],
            'anthropic-check-secret',
          );
          assert.equal(requests[0]?.headers['anthropic-version'], '2023-06-01');
          assert.equal(health.status, 'available');
          assert.equal(health.connection, 'verified');
          assert.match(
            health.detail,
            /does not guarantee inference or model access/i,
          );
        },
      );
    },
  );
});

test('OpenAI maps incomplete output and refusals to their explicit finish reasons', async () => {
  await withCredential('OPENAI_API_KEY', 'openai-output-secret', async () => {
    let index = 0;
    await withServer(
      (_request, response) => {
        index += 1;
        json(
          response,
          index === 1
            ? {
                status: 'incomplete',
                incomplete_details: { reason: 'max_output_tokens' },
                model: 'fixture-model',
                output: [],
                usage: { input_tokens: 3, output_tokens: 4 },
              }
            : {
                status: 'completed',
                model: 'fixture-model',
                output: [
                  {
                    type: 'message',
                    content: [
                      { type: 'refusal', refusal: 'I cannot help with that.' },
                    ],
                  },
                ],
                usage: { input_tokens: 3, output_tokens: 2 },
              },
        );
      },
      async (baseUrl) => {
        const adapter = new OpenAIAdapter({ model: 'fixture-model', baseUrl });
        const partial = await adapter.submitPrompt!({
          prompt: 'long prompt',
          ...requestOptions,
        });
        const refusal = await adapter.submitPrompt!({
          prompt: 'another prompt',
          ...requestOptions,
        });
        assert.deepEqual([partial.text, partial.finishReason], ['', 'length']);
        assert.deepEqual(
          [refusal.text, refusal.finishReason],
          ['I cannot help with that.', 'refusal'],
        );
      },
    );
  });
});

test('OpenAI malformed output and missing usage are reported without fabricated results', async () => {
  await withCredential('OPENAI_API_KEY', 'openai-invalid-secret', async () => {
    let index = 0;
    await withServer(
      (_request, response) => {
        index += 1;
        json(
          response,
          index === 1
            ? {
                status: 'completed',
                model: 'fixture-model',
                output: [{ type: 'tool_call' }],
              }
            : {
                status: 'completed',
                model: 'fixture-model',
                output: [
                  {
                    type: 'message',
                    content: [{ type: 'output_text', text: 'answer' }],
                  },
                ],
              },
        );
      },
      async (baseUrl) => {
        const adapter = new OpenAIAdapter({ model: 'fixture-model', baseUrl });
        await assert.rejects(
          adapter.submitPrompt!({ prompt: 'prompt', ...requestOptions }),
          (error: unknown) =>
            error instanceof ProviderError && error.code === 'invalid-response',
        );
        const missingUsage = await adapter.submitPrompt!({
          prompt: 'prompt',
          ...requestOptions,
        });
        assert.equal(missingUsage.text, 'answer');
        assert.deepEqual(missingUsage.usage, { status: 'unavailable' });
      },
    );
  });
});

test('Anthropic sends the Messages contract and adds cached input tokens to raw input usage', async () => {
  await withCredential(
    'ANTHROPIC_API_KEY',
    'anthropic-contract-secret',
    async () => {
      await withServer(
        (_request, response) =>
          json(response, {
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            model: 'fixture-claude-model',
            content: [
              { type: 'text', text: 'first block ' },
              { type: 'text', text: 'second block' },
            ],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
              input_tokens: 10,
              output_tokens: 6,
              cache_read_input_tokens: 4,
              cache_creation_input_tokens: 2,
            },
          }),
        async (baseUrl, requests) => {
          const adapter = new AnthropicAdapter({
            model: 'fixture-claude-requested',
            baseUrl,
            maxOutputTokens: 81,
          });
          const result = await adapter.submitPrompt!({
            prompt: 'Send this verbatim.\nAnd this line.',
            ...requestOptions,
          });
          assert.equal(requests[0]?.method, 'POST');
          assert.equal(requests[0]?.url, '/messages');
          assert.equal(
            requests[0]?.headers['x-api-key'],
            'anthropic-contract-secret',
          );
          assert.equal(requests[0]?.headers['anthropic-version'], '2023-06-01');
          assert.deepEqual(requests[0]?.body, {
            model: 'fixture-claude-requested',
            messages: [
              { role: 'user', content: 'Send this verbatim.\nAnd this line.' },
            ],
            max_tokens: 81,
            stream: false,
          });
          assert.deepEqual(result, {
            text: 'first block second block',
            model: 'fixture-claude-model',
            finishReason: 'completed',
            usage: {
              status: 'available',
              inputTokens: 16,
              outputTokens: 6,
              cachedInputTokens: 4,
              cacheCreationInputTokens: 2,
            },
          });
        },
      );
    },
  );
});

test('Anthropic sends a portable JSON schema and returns validated structured data', async () => {
  const responseSchema = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  };
  await withCredential(
    'ANTHROPIC_API_KEY',
    'anthropic-structured-secret',
    async () => {
      await withServer(
        (_request, response) =>
          json(response, {
            type: 'message',
            model: 'fixture-model',
            content: [{ type: 'text', text: '{"answer":"ready"}' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 2, output_tokens: 2 },
          }),
        async (baseUrl, requests) => {
          const result = await new AnthropicAdapter({
            model: 'fixture-model',
            baseUrl,
          }).submitPrompt!({
            prompt: 'Return an answer.',
            responseSchema,
            ...requestOptions,
          });
          assert.deepEqual(requests[0]?.body, {
            model: 'fixture-model',
            messages: [{ role: 'user', content: 'Return an answer.' }],
            max_tokens: 1024,
            stream: false,
            output_config: {
              format: { type: 'json_schema', schema: responseSchema },
            },
          });
          assert.deepEqual(result.structured, {
            status: 'valid',
            data: { answer: 'ready' },
          });
        },
      );
    },
  );
});

test('hosted adapters reject unsupported schemas before sending a request', async () => {
  await withCredential(
    'OPENAI_API_KEY',
    'openai-schema-preflight-secret',
    async () => {
      await withCredential(
        'ANTHROPIC_API_KEY',
        'anthropic-schema-preflight-secret',
        async () => {
          let requestCount = 0;
          await withServer(
            (_request, response) => {
              requestCount += 1;
              json(response, {});
            },
            async (baseUrl) => {
              const adapters = [
                new OpenAIAdapter({ model: 'fixture-model', baseUrl }),
                new AnthropicAdapter({ model: 'fixture-model', baseUrl }),
              ];
              for (const adapter of adapters) {
                await assert.rejects(
                  adapter.submitPrompt!({
                    prompt: 'Return JSON.',
                    responseSchema: {
                      $ref: 'https://example.test/schema.json',
                    },
                    ...requestOptions,
                  }),
                  (error: unknown) =>
                    error instanceof ProviderError &&
                    error.code === 'configuration',
                );
                assert.throws(
                  () =>
                    adapter.streamPrompt!({
                      prompt: 'Return JSON.',
                      responseSchema: {
                        $ref: 'https://example.test/schema.json',
                      },
                      ...requestOptions,
                    }),
                  (error: unknown) =>
                    error instanceof ProviderError &&
                    error.code === 'configuration',
                );
              }
              assert.equal(requestCount, 0);
            },
          );
        },
      );
    },
  );
});

test('Anthropic offline health reports missing credentials without making a request', async () => {
  await withCredential('ANTHROPIC_API_KEY', undefined, async () => {
    let requestCount = 0;
    await withServer(
      (_request, response) => {
        requestCount += 1;
        json(response, { data: [] });
      },
      async (baseUrl) => {
        const health = await new AnthropicAdapter({
          model: 'fixture-model',
          baseUrl,
        }).health();
        assert.equal(health.status, 'unavailable');
        assert.equal(health.authentication, 'missing');
        assert.equal(requestCount, 0);
      },
    );
  });
});

test('Anthropic maps max-token stops and refusal blocks with valid usage', async () => {
  await withCredential(
    'ANTHROPIC_API_KEY',
    'anthropic-output-secret',
    async () => {
      let index = 0;
      await withServer(
        (_request, response) => {
          index += 1;
          json(
            response,
            index === 1
              ? {
                  type: 'message',
                  model: 'fixture-model',
                  content: [{ type: 'text', text: 'partial answer' }],
                  stop_reason: 'max_tokens',
                  usage: { input_tokens: 3, output_tokens: 8 },
                }
              : {
                  type: 'message',
                  model: 'fixture-model',
                  content: [{ type: 'text', text: 'I cannot help with that.' }],
                  stop_reason: 'refusal',
                  usage: { input_tokens: 3, output_tokens: 5 },
                },
          );
        },
        async (baseUrl) => {
          const adapter = new AnthropicAdapter({
            model: 'fixture-model',
            baseUrl,
          });
          const partial = await adapter.submitPrompt!({
            prompt: 'long prompt',
            ...requestOptions,
          });
          const refusal = await adapter.submitPrompt!({
            prompt: 'another prompt',
            ...requestOptions,
          });
          assert.deepEqual(
            [partial.text, partial.finishReason],
            ['partial answer', 'length'],
          );
          assert.deepEqual(
            [refusal.text, refusal.finishReason],
            ['I cannot help with that.', 'refusal'],
          );
        },
      );
    },
  );
});

test('Anthropic rejects unexpected tool-use content and marks missing usage unavailable', async () => {
  await withCredential(
    'ANTHROPIC_API_KEY',
    'anthropic-invalid-secret',
    async () => {
      let index = 0;
      await withServer(
        (_request, response) => {
          index += 1;
          json(
            response,
            index === 1
              ? {
                  type: 'message',
                  model: 'fixture-model',
                  content: [
                    {
                      type: 'tool_use',
                      id: 'toolu_test',
                      name: 'unexpected',
                      input: {},
                    },
                  ],
                  stop_reason: 'tool_use',
                  usage: { input_tokens: 3, output_tokens: 2 },
                }
              : {
                  type: 'message',
                  model: 'fixture-model',
                  content: [{ type: 'text', text: 'answer' }],
                  stop_reason: 'end_turn',
                },
          );
        },
        async (baseUrl) => {
          const adapter = new AnthropicAdapter({
            model: 'fixture-model',
            baseUrl,
          });
          await assert.rejects(
            adapter.submitPrompt!({ prompt: 'prompt', ...requestOptions }),
            (error: unknown) =>
              error instanceof ProviderError &&
              error.code === 'invalid-response',
          );
          const missingUsage = await adapter.submitPrompt!({
            prompt: 'prompt',
            ...requestOptions,
          });
          assert.equal(missingUsage.text, 'answer');
          assert.deepEqual(missingUsage.usage, { status: 'unavailable' });
        },
      );
    },
  );
});

test('provider errors retain safe categories for authentication and rate limits', async () => {
  await withCredential(
    'OPENAI_API_KEY',
    'error-classification-secret',
    async () => {
      for (const [status, code] of [
        [401, 'authentication'],
        [403, 'authentication'],
        [429, 'rate-limit'],
        [503, 'unavailable'],
      ] as const) {
        await withServer(
          (_request, response) =>
            json(
              response,
              { error: { message: 'sensitive provider detail' } },
              status,
            ),
          async (baseUrl) => {
            const adapter = new OpenAIAdapter({
              model: 'fixture-model',
              baseUrl,
            });
            await assert.rejects(
              adapter.submitPrompt!({ prompt: 'prompt', ...requestOptions }),
              (error: unknown) => {
                assert.ok(error instanceof ProviderError);
                assert.equal(error.code, code);
                assert.ok(!error.message.includes('sensitive provider detail'));
                assert.ok(
                  !error.message.includes('error-classification-secret'),
                );
                return true;
              },
            );
          },
        );
      }
    },
  );
});

test('hosted adapters advertise only implemented capabilities', () => {
  for (const adapter of [
    new OpenAIAdapter({ model: 'fixture-model' }),
    new AnthropicAdapter({ model: 'fixture-model' }),
  ]) {
    assert.equal(adapter.kind, 'model-provider');
    assert.equal(adapter.version, '1.0.0');
    assert.deepEqual(adapter.capabilities(), {
      promptSubmission: true,
      structuredResponses: true,
      streaming: true,
      toolInvocation: true,
      toolStreaming: true,
      usageTelemetry: true,
      cancellation: true,
    });
  }
  assert.equal(new OpenAIAdapter({ model: 'fixture-model' }).id, 'openai');
  assert.equal(
    new AnthropicAdapter({ model: 'fixture-model' }).id,
    'anthropic',
  );
});

test('an adapter uses the configured credential environment name', async () => {
  await withCredential(
    'OPENAI_TEST_TOKEN',
    'custom-environment-secret',
    async () => {
      await withServer(
        (_request, response) =>
          json(response, {
            status: 'completed',
            model: 'fixture-model',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'answer' }],
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        async (baseUrl, requests) => {
          const adapter = new OpenAIAdapter({
            model: 'fixture-model',
            baseUrl,
            apiKeyEnv: 'OPENAI_TEST_TOKEN',
          });
          await adapter.submitPrompt!({ prompt: 'prompt', ...requestOptions });
          assert.equal(
            requests[0]?.headers.authorization,
            'Bearer custom-environment-secret',
          );
        },
      );
    },
  );
});

test('malformed Responses payloads never become successful empty answers', async () => {
  await withCredential(
    'OPENAI_API_KEY',
    'malformed-response-secret',
    async () => {
      await withServer(
        (_request, response) =>
          json(response, { status: 'completed', model: 3, output: [] }),
        async (baseUrl) => {
          const adapter = new OpenAIAdapter({
            model: 'fixture-model',
            baseUrl,
          });
          await assert.rejects(
            adapter.submitPrompt!({ prompt: 'prompt', ...requestOptions }),
            (error: unknown) =>
              error instanceof ProviderError &&
              error.code === 'invalid-response',
          );
        },
      );
    },
  );
});

test('malformed Anthropic payloads never become successful empty answers', async () => {
  await withCredential(
    'ANTHROPIC_API_KEY',
    'malformed-response-secret',
    async () => {
      await withServer(
        (_request, response) =>
          json(response, {
            type: 'message',
            model: 'fixture-model',
            content: [{ type: 'text', text: '' }],
            stop_reason: 'some_future_reason',
            usage: { input_tokens: 1, output_tokens: 0 },
          }),
        async (baseUrl) => {
          const adapter = new AnthropicAdapter({
            model: 'fixture-model',
            baseUrl,
          });
          await assert.rejects(
            adapter.submitPrompt!({ prompt: 'prompt', ...requestOptions }),
            (error: unknown) =>
              error instanceof ProviderError &&
              error.code === 'invalid-response',
          );
        },
      );
    },
  );
});

test('connection options cannot override the configured endpoint or authentication headers', async () => {
  await withCredential(
    'OPENAI_API_KEY',
    'selected-endpoint-secret',
    async () => {
      await withServer(
        (_request, response) => json(response, { data: [] }),
        async (untrustedUrl, untrustedRequests) => {
          await withServer(
            (_request, response) => json(response, { data: [] }),
            async (baseUrl, requests) => {
              const adapter = new OpenAIAdapter({
                model: 'fixture-model',
                baseUrl,
              });
              const extraOptions = {
                ...requestOptions,
                url: untrustedUrl,
                method: 'POST' as const,
              };
              await adapter.checkConnection(extraOptions);
              assert.equal(requests.length, 1);
              assert.equal(requests[0]?.method, 'GET');
              assert.equal(untrustedRequests.length, 0);
            },
          );
        },
      );
    },
  );
});
