import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { initProject, loadConfig, setConfig } from '../src/core/config.js';
import { restoreCheckpoint, saveCheckpoint } from '../src/core/context.js';
import { applyResultSchemas } from '../src/cli/tool-result-schemas.js';
import { runTaskRuntime } from '../src/engines/task-runtime.js';
import { projectTools } from '../src/engines/project-tools.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

type RequestHandler = (
  body: Record<string, unknown>,
  response: ServerResponse,
) => void | Promise<void>;

async function withOllamaServer<T>(
  handler: RequestHandler,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer((request, response) => {
    void readBody(request).then((body) =>
      handler(body as Record<string, unknown>, response),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function ollamaReply(
  content: string,
  options: {
    toolCalls?: unknown[];
    promptTokens?: number;
    outputTokens?: number;
    reportedModel?: string;
  } = {},
): Record<string, unknown> {
  return {
    model: options.reportedModel ?? 'fixture-reported-model',
    done: true,
    done_reason: 'stop',
    prompt_eval_count: options.promptTokens ?? 3,
    eval_count: options.outputTokens ?? 2,
    message: {
      role: 'assistant',
      content,
      ...(options.toolCalls === undefined
        ? {}
        : { tool_calls: options.toolCalls }),
    },
  };
}

async function makeProject(t: { after(callback: () => void): void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'agentforge-task-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  await setConfig(root, 'permissions.allowNetwork', true);
  await setConfig(root, 'providers', [
    { id: 'ollama', model: 'configured-model', baseUrl: 'http://127.0.0.1:1' },
  ]);
  return root;
}

test('task runtime requires both configured network permission and per-run approval before a request', async (t) => {
  const root = await makeProject(t);
  let requests = 0;
  await withOllamaServer(
    (_body, response) => {
      requests++;
      response.end(JSON.stringify(ollamaReply('unexpected')));
    },
    async (baseUrl) => {
      await setConfig(root, 'providers', [
        { id: 'ollama', model: 'fixture', baseUrl },
      ]);
      const result = await runTaskRuntime({
        root,
        task: 'summarize the project',
        provider: 'ollama',
        approveNetwork: false,
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.error?.code, 'policy');
      assert.equal(requests, 0);
    },
  );
});

test('task runtime refines and redacts the request, sends checkpoint JSON only on opt-in, applies the model override, and validates the final schema', async (t) => {
  const root = await makeProject(t);
  const checkpoint = await saveCheckpoint(root, {
    name: 'local reference',
    objective: '',
    summary: 'checkpoint-only-reference',
    decisions: [],
    nextSteps: [],
  });
  await restoreCheckpoint(root, checkpoint.id, true);
  const prompts: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  await withOllamaServer(
    (body, response) => {
      bodies.push(body);
      const messages = body.messages as { content: string }[];
      prompts.push(messages[0]!.content);
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify(
          ollamaReply('{"answer":"ready"}', {
            promptTokens: 7,
            outputTokens: 4,
            reportedModel: 'token=sk-abcdefghijk12345',
          }),
        ),
      );
    },
    async (baseUrl) => {
      await setConfig(root, 'providers', [
        { id: 'ollama', model: 'configured-model', baseUrl },
      ]);
      const task = 'Fix the parser; token=sk-abcdefghijk12345';
      const schema = {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      };
      const withoutContext = await runTaskRuntime({
        root,
        task,
        provider: 'ollama',
        model: 'fixture-override',
        approveNetwork: true,
        responseSchema: schema,
      });
      const withContext = await runTaskRuntime({
        root,
        task,
        provider: 'ollama',
        model: 'fixture-override',
        approveNetwork: true,
        withContext: true,
        responseSchema: schema,
      });
      assert.equal(withoutContext.status, 'completed');
      assert.equal(withContext.status, 'completed');
      assert.equal(withoutContext.structured?.status, 'valid');
      assert.equal(withContext.structured?.status, 'valid');
      assert.equal(withoutContext.output, '{"answer":"ready"}');
      assert.equal(withContext.output, '{"answer":"ready"}');
      assert.equal(withoutContext.reportedModel, 'token=[REDACTED]');
      assert.match(prompts[0]!, /Acceptance criteria/);
      assert.match(prompts[0]!, /Fix the parser/);
      assert.match(prompts[0]!, /token=\[REDACTED\]/);
      assert.ok(!prompts[0]!.includes('sk-abcdefghijk12345'));
      assert.ok(!prompts[0]!.includes('checkpoint-only-reference'));
      assert.match(prompts[1]!, /Untrusted checkpoint JSON/);
      assert.match(prompts[1]!, /checkpoint-only-reference/);
      assert.equal(bodies[0]!.model, 'fixture-override');
      assert.equal(bodies[1]!.model, 'fixture-override');
    },
  );
});

test('task runtime executes a tool batch only after explicit approval and reports only safe turn and result metadata', async (t) => {
  const root = await makeProject(t);
  await setConfig(root, 'permissions.allowTools', true);
  const requests: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  let approvals = 0;
  await withOllamaServer(
    (body, response) => {
      requests.push(body);
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify(
          requests.length === 1
            ? ollamaReply('Checking package metadata.', {
                toolCalls: [
                  { function: { name: 'project_summary', arguments: {} } },
                ],
                promptTokens: 5,
                outputTokens: 2,
              })
            : ollamaReply('Project summary is ready.', {
                promptTokens: 4,
                outputTokens: 3,
              }),
        ),
      );
    },
    async (baseUrl) => {
      await setConfig(root, 'providers', [
        { id: 'ollama', model: 'fixture', baseUrl },
      ]);
      const result = await runTaskRuntime({
        root,
        task: 'Summarize the package',
        provider: 'ollama',
        approveNetwork: true,
        executeTools: true,
        approveToolBatch: async (batch) => {
          approvals++;
          assert.equal(batch.calls[0]!.name, 'project_summary');
          assert.equal(
            (batch.review[0] as { details: { read: string } }).details.read,
            'package.json',
          );
          return true;
        },
        onEvent: (event) =>
          events.push(event as unknown as Record<string, unknown>),
      });
      assert.equal(result.status, 'completed');
      assert.equal(result.turns.attempted, 2);
      assert.equal(result.turns.completed, 2);
      assert.equal(result.approvedToolBatches, 1);
      assert.equal(result.approvedToolCalls, 1);
      assert.deepEqual(result.usage, {
        status: 'available',
        attemptedTurns: 2,
        availableTurns: 2,
        inputTokens: 9,
        outputTokens: 5,
      });
      assert.equal(approvals, 1);
      assert.match(result.output, /Project summary is ready\./);
      assert.ok(
        events.some(
          (event) => event.type === 'status' && event.status === 'tool-results',
        ),
      );
      const turnEvents = events.filter(
        (event) => event.type === 'status' && event.status === 'turn',
      );
      assert.equal(turnEvents.length, 2);
      assert.ok(!JSON.stringify(turnEvents).includes('arguments'));
      assert.ok(!JSON.stringify(turnEvents).includes('thinking'));
      const followup = requests[1]!.messages as {
        role: string;
        content?: string;
      }[];
      assert.equal(followup.at(-1)!.role, 'tool');
    },
  );
});

test(
  'task runtime deadline interrupts a pending approval and a late approval cannot execute',
  { timeout: 10000 },
  async (t) => {
    const root = await makeProject(t);
    await setConfig(root, 'permissions.allowTools', true);
    const nativeSetTimeout = globalThis.setTimeout;
    const taskDeadlineMs = 123456;
    let expireTask: (() => void) | undefined;
    t.mock.method(
      globalThis,
      'setTimeout',
      (callback: () => void, milliseconds?: number, ...args: unknown[]) => {
        if (milliseconds === taskDeadlineMs) {
          expireTask = callback;
          return nativeSetTimeout(() => {}, milliseconds);
        }
        return Reflect.apply(nativeSetTimeout, globalThis, [
          callback,
          milliseconds,
          ...args,
        ]);
      },
    );
    let requests = 0;
    let approveLater: ((approved: boolean) => void) | undefined;
    let markApprovalEntered!: () => void;
    const approvalEntered = new Promise<void>((resolve) => {
      markApprovalEntered = resolve;
    });
    await withOllamaServer(
      async (_body, response) => {
        requests++;
        // Deliberately slower than the old 30 ms total deadline. Reach approval
        // explicitly before firing the task timer, regardless of runner load.
        await new Promise((resolve) => nativeSetTimeout(resolve, 80));
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify(
            ollamaReply('Before the check.', {
              toolCalls: [
                { function: { name: 'project_summary', arguments: {} } },
              ],
            }),
          ),
        );
      },
      async (baseUrl) => {
        await setConfig(root, 'providers', [
          { id: 'ollama', model: 'fixture', baseUrl },
        ]);
        const pending = runTaskRuntime({
          root,
          task: 'Inspect package metadata',
          provider: 'ollama',
          approveNetwork: true,
          executeTools: true,
          maxDurationMs: taskDeadlineMs,
          signal: t.signal,
          approveToolBatch: () =>
            new Promise<boolean>((resolve) => {
              approveLater = resolve;
              markApprovalEntered();
            }),
        });
        await approvalEntered;
        assert.ok(expireTask);
        expireTask();
        const result = await pending;
        assert.equal(result.status, 'failed');
        assert.equal(result.error?.code, 'timeout');
        assert.equal(result.approvedToolBatches, 0);
        assert.equal(result.approvedToolCalls, 0);
        assert.equal(result.output, 'Before the check.');
        approveLater?.(true);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(requests, 1);
      },
    );
  },
);

test('task runtime cancellation interrupts a pending approval and a late approval cannot execute', async (t) => {
  const root = await makeProject(t);
  await setConfig(root, 'permissions.allowTools', true);
  const controller = new AbortController();
  let requests = 0;
  let approveLater: ((approved: boolean) => void) | undefined;
  let markApprovalEntered!: () => void;
  const approvalEntered = new Promise<void>((resolve) => {
    markApprovalEntered = resolve;
  });
  await withOllamaServer(
    (_body, response) => {
      requests++;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify(
          ollamaReply('Before cancellation.', {
            toolCalls: [
              { function: { name: 'project_summary', arguments: {} } },
            ],
          }),
        ),
      );
    },
    async (baseUrl) => {
      await setConfig(root, 'providers', [
        { id: 'ollama', model: 'fixture', baseUrl },
      ]);
      const pending = runTaskRuntime({
        root,
        task: 'Inspect package metadata',
        provider: 'ollama',
        approveNetwork: true,
        executeTools: true,
        signal: controller.signal,
        approveToolBatch: () => {
          markApprovalEntered();
          return new Promise<boolean>((resolve) => {
            approveLater = resolve;
          });
        },
      });
      await approvalEntered;
      controller.abort();
      const result = await pending;
      assert.equal(result.status, 'failed');
      assert.equal(result.error?.code, 'cancelled');
      assert.equal(result.approvedToolBatches, 0);
      assert.equal(result.approvedToolCalls, 0);
      assert.equal(result.output, 'Before cancellation.');
      approveLater?.(true);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(requests, 1);
    },
  );
});

test('task runtime exposes only sanitized streamed text when a later stream frame fails', async (t) => {
  const root = await makeProject(t);
  let requests = 0;
  const events: Record<string, unknown>[] = [];
  await withOllamaServer(
    (_body, response) => {
      requests++;
      response.setHeader('content-type', 'application/x-ndjson');
      response.write(
        `${JSON.stringify({
          model: 'fixture',
          message: {
            role: 'assistant',
            content: 'Partial token=sk-abcdefghijk12345\n',
          },
          done: false,
        })}\n`,
      );
      response.end('not-json\n');
    },
    async (baseUrl) => {
      await setConfig(root, 'providers', [
        { id: 'ollama', model: 'fixture', baseUrl },
      ]);
      const result = await runTaskRuntime({
        root,
        task: 'Write a summary',
        provider: 'ollama',
        approveNetwork: true,
        stream: true,
        onEvent: (event) =>
          events.push(event as unknown as Record<string, unknown>),
      });
      assert.equal(requests, 1);
      assert.equal(result.status, 'failed');
      assert.equal(result.error?.code, 'invalid-response');
      assert.equal(result.output, 'Partial token=[REDACTED]\n');
      const failure = events.find(
        (event) => event.type === 'status' && event.status === 'failed',
      );
      assert.equal(failure?.output, 'Partial token=[REDACTED]\n');
      assert.ok(!JSON.stringify(result).includes('not-json'));
    },
  );
});

test('task runtime keeps validated structured stream output exact and withholds text until validation', async (t) => {
  const root = await makeProject(t);
  const textEvents: Record<string, unknown>[] = [];
  await withOllamaServer(
    (_body, response) => {
      response.setHeader('content-type', 'application/x-ndjson');
      response.write(
        `${JSON.stringify({
          model: 'fixture',
          message: { role: 'assistant', content: '{"answer":"ready"}' },
          done: false,
        })}\n`,
      );
      response.end(
        `${JSON.stringify({
          model: 'fixture',
          message: { role: 'assistant', content: '' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 4,
          eval_count: 2,
        })}\n`,
      );
    },
    async (baseUrl) => {
      await setConfig(root, 'providers', [
        { id: 'ollama', model: 'fixture', baseUrl },
      ]);
      const result = await runTaskRuntime({
        root,
        task: 'Return the answer object',
        provider: 'ollama',
        approveNetwork: true,
        stream: true,
        responseSchema: {
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
          additionalProperties: false,
        },
        onEvent: (event) => {
          if (event.type === 'text-delta')
            textEvents.push(event as unknown as Record<string, unknown>);
        },
      });
      assert.equal(result.status, 'completed');
      assert.equal(result.output, '{"answer":"ready"}');
      assert.equal(result.structured?.status, 'valid');
      assert.equal(textEvents.length, 0);
    },
  );
});

test('task runtime enforces the total approved tool-call cap across turns', async (t) => {
  const root = await makeProject(t);
  await setConfig(root, 'permissions.allowTools', true);
  let requests = 0;
  let approvals = 0;
  await withOllamaServer(
    (_body, response) => {
      requests++;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify(
          requests === 1
            ? ollamaReply('First batch.', {
                toolCalls: Array.from({ length: 16 }, () => ({
                  function: { name: 'project_summary', arguments: {} },
                })),
              })
            : ollamaReply('Second batch.', {
                toolCalls: [
                  { function: { name: 'project_summary', arguments: {} } },
                ],
              }),
        ),
      );
    },
    async (baseUrl) => {
      await setConfig(root, 'providers', [
        { id: 'ollama', model: 'fixture', baseUrl },
      ]);
      const result = await runTaskRuntime({
        root,
        task: 'Summarize the package',
        provider: 'ollama',
        approveNetwork: true,
        executeTools: true,
        maxTurns: 3,
        approveToolBatch: async () => {
          approvals++;
          return true;
        },
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.error?.code, 'policy');
      assert.equal(result.approvedToolCalls, 16);
      assert.equal(result.approvedToolBatches, 1);
      assert.equal(approvals, 1);
      assert.equal(requests, 2);
    },
  );
});

test('task runtime bounds accumulated output across validated turns', async (t) => {
  const root = await makeProject(t);
  await setConfig(root, 'permissions.allowTools', true);
  let requests = 0;
  await withOllamaServer(
    (_body, response) => {
      requests++;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify(
          requests === 1
            ? ollamaReply('a'.repeat(600000), {
                toolCalls: [
                  { function: { name: 'project_summary', arguments: {} } },
                ],
              })
            : ollamaReply('b'.repeat(600000)),
        ),
      );
    },
    async (baseUrl) => {
      await setConfig(root, 'providers', [
        { id: 'ollama', model: 'fixture', baseUrl },
      ]);
      const result = await runTaskRuntime({
        root,
        task: 'Summarize the package',
        provider: 'ollama',
        approveNetwork: true,
        executeTools: true,
        approveToolBatch: async () => true,
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.error?.code, 'response-limit');
      assert.equal(result.outputBytes, 1048576);
      assert.equal(Buffer.byteLength(result.output), 1048576);
      assert.equal(requests, 2);
    },
  );
});

test('task runtime never calls tool approval when allowTools is disabled', async (t) => {
  const root = await makeProject(t);
  let requests = 0;
  let approvals = 0;
  await withOllamaServer(
    (_body, response) => {
      requests++;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify(
          ollamaReply('', {
            toolCalls: [
              { function: { name: 'project_summary', arguments: {} } },
            ],
          }),
        ),
      );
    },
    async (baseUrl) => {
      await setConfig(root, 'providers', [
        { id: 'ollama', model: 'fixture', baseUrl },
      ]);
      const result = await runTaskRuntime({
        root,
        task: 'Inspect the package',
        provider: 'ollama',
        approveNetwork: true,
        executeTools: true,
        approveToolBatch: async () => {
          approvals++;
          return true;
        },
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.error?.code, 'policy');
      assert.equal(requests, 0);
      assert.equal(approvals, 0);
    },
  );
});

test('task runtime validates local tool results before any follow-up request', async (t) => {
  const root = await makeProject(t);
  await setConfig(root, 'permissions.allowTools', true);
  let requests = 0;
  let approvals = 0;
  await withOllamaServer(
    (_body, response) => {
      requests++;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify(
          ollamaReply('Result will be checked locally.', {
            toolCalls: [
              { function: { name: 'project_summary', arguments: {} } },
            ],
          }),
        ),
      );
    },
    async (baseUrl) => {
      await setConfig(root, 'providers', [
        { id: 'ollama', model: 'fixture', baseUrl },
      ]);
      const config = await loadConfig(root);
      const tools = applyResultSchemas(projectTools(root, config), {
        project_summary: { type: 'null' },
      });
      const result = await runTaskRuntime({
        root,
        task: 'Inspect package metadata',
        provider: 'ollama',
        approveNetwork: true,
        executeTools: true,
        tools,
        approveToolBatch: async () => {
          approvals++;
          return true;
        },
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.error?.code, 'validation');
      assert.equal(result.approvedToolBatches, 1);
      assert.equal(result.approvedToolCalls, 1);
      assert.equal(approvals, 1);
      assert.equal(requests, 1);
      assert.equal(result.output, 'Result will be checked locally.');
    },
  );
});

test('invalid provider identity cannot leak secret text through task reports or events', async (t) => {
  const root = await makeProject(t);
  const events: unknown[] = [];
  const credential = 'sk-reviewfixture12345';
  const result = await runTaskRuntime({
    root,
    task: 'local test',
    provider: `token=${credential}`,
    approveNetwork: false,
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.turns.attempted, 0);
  assert.ok(!JSON.stringify({ result, events }).includes(credential));
});
