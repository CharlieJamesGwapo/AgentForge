import assert from 'node:assert/strict';
import { Command } from 'commander';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { initProject } from '../src/core/config.js';
import { sendToolReply } from './helpers/tool-protocol.js';
import { registerOrchestrationCommands } from '../src/cli/orchestrate.js';

type RequestBody = Record<string, unknown>;

async function readBody(request: IncomingMessage): Promise<RequestBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as RequestBody;
}

function json(response: ServerResponse, value: unknown): void {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
}

async function withServer<T>(
  handler: (
    body: RequestBody,
    url: string | undefined,
    response: ServerResponse,
  ) => void | Promise<void>,
  run: (baseUrl: string, requests: RequestBody[]) => Promise<T>,
): Promise<T> {
  const requests: RequestBody[] = [];
  const server = createServer((request, response) => {
    void readBody(request)
      .then(async (body) => {
        requests.push(body);
        await handler(body, request.url, response);
      })
      .catch(() => {
        if (!response.headersSent) json(response, { error: 'fixture failed' });
        else response.destroy();
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function makeProject(
  t: { after(callback: () => void): void },
  baseUrl: string,
  enabled = true,
): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), 'agentforge-orchestrate-cli-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const initialized = await initProject(root);
  const config = {
    ...initialized.config,
    providers: [{ id: 'ollama', model: 'provider-default', baseUrl }],
    permissions: {
      ...initialized.config.permissions,
      allowNetwork: true,
      allowTools: true,
    },
    orchestration: {
      enabled,
      maxConcurrency: 2,
      maxDepth: 1,
      maxSubtasks: 8,
      maxContextBytes: 16384,
      maxOutputBytes: 32768,
      timeoutMs: 1000,
      maxDurationMs: 5000,
      planner: { provider: 'ollama', model: 'planner-configured' },
      executor: { provider: 'ollama', model: 'executor-configured' },
    },
  };
  await writeFile(
    path.join(root, 'agentforge.config.json'),
    JSON.stringify(config),
  );
  return root;
}

async function invoke(
  root: string,
  args: string[],
  options: { signal?: AbortSignal; cancelTerminalApproval?: boolean } = {},
) {
  const program = new Command().exitOverride();
  const controller =
    options.signal === undefined ? new AbortController() : undefined;
  registerOrchestrationCommands(
    program,
    async () => root,
    options.signal ?? controller!.signal,
  );
  const lines: string[] = [];
  const originalLog = console.log;
  const previousExitCode = process.exitCode;
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  const stderrDescriptor = Object.getOwnPropertyDescriptor(process, 'stderr');
  let fakeInput: PassThrough | undefined;
  let fakeError: PassThrough | undefined;
  let approvalPrompts = 0;
  if (options.cancelTerminalApproval) {
    fakeInput = new PassThrough();
    fakeError = new PassThrough();
    Object.defineProperty(fakeInput, 'isTTY', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(fakeError, 'isTTY', {
      configurable: true,
      value: true,
    });
    fakeError.on('data', (chunk: Buffer) => {
      if (
        /Type approve [a-f0-9]{64} to execute this exact batch/u.test(
          chunk.toString('utf8'),
        )
      ) {
        approvalPrompts++;
        setImmediate(() => fakeInput?.write('\x03'));
      }
    });
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: fakeInput,
    });
    Object.defineProperty(process, 'stderr', {
      configurable: true,
      value: fakeError,
    });
  }
  process.exitCode = 0;
  console.log = (line?: unknown) => lines.push(String(line ?? ''));
  let thrown: unknown;
  let code: number;
  try {
    await program.parseAsync(['node', 'agentforge', 'orchestrate', ...args]);
  } catch (error) {
    thrown = error;
  } finally {
    code = process.exitCode ?? 0;
    console.log = originalLog;
    process.exitCode = previousExitCode;
    if (stdinDescriptor)
      Object.defineProperty(process, 'stdin', stdinDescriptor);
    if (stderrDescriptor)
      Object.defineProperty(process, 'stderr', stderrDescriptor);
    fakeInput?.destroy();
    fakeError?.destroy();
  }
  return {
    code,
    thrown,
    approvalPrompts,
    events: lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function isPlanner(body: RequestBody): boolean {
  return !Array.isArray(body.tools);
}

function plannerReply(): unknown {
  return {
    model: 'planner-model-reported',
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 1,
    eval_count: 1,
    message: {
      role: 'assistant',
      content: JSON.stringify({
        subtasks: [
          {
            id: 'one',
            task: 'Inspect one file',
            context: 'The file is in the source tree.',
            paths: ['src'],
          },
        ],
      }),
    },
  };
}

function workerReply(): unknown {
  return {
    model: 'executor-model-reported',
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 1,
    eval_count: 1,
    message: {
      role: 'assistant',
      content: JSON.stringify({
        status: 'completed',
        summary: 'Inspection finished.',
        paths: ['src/one.ts'],
      }),
    },
  };
}

test('orchestrate status prints configured roles and limits without contacting a provider', async (t) => {
  await withServer(
    (_body, _url, response) => json(response, plannerReply()),
    async (baseUrl, requests) => {
      const root = await makeProject(t, baseUrl);
      const result = await invoke(root, ['status']);
      assert.equal(result.thrown, undefined);
      assert.equal(requests.length, 0);
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0]?.enabled, true);
      assert.equal(result.events[0]?.maxConcurrency, 2);
      assert.deepEqual(result.events[0]?.planner, {
        provider: 'ollama',
        model: 'planner-configured',
      });
      assert.deepEqual(result.events[0]?.executor, {
        provider: 'ollama',
        model: 'executor-configured',
      });
    },
  );
});

test('orchestrate plan sends a validated planner request and never starts workers', async (t) => {
  await withServer(
    (body, _url, response) => {
      assert.ok(body.format && typeof body.format === 'object');
      json(response, plannerReply());
    },
    async (baseUrl, requests) => {
      const root = await makeProject(t, baseUrl);
      const result = await invoke(root, [
        'plan',
        '--task',
        'Inspect source files',
        '--approve-network',
        '--planner',
        'ollama',
        '--planner-model',
        'planner-override',
      ]);
      assert.equal(result.thrown, undefined);
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.model, 'planner-override');
      assert.equal(result.code, 0);
      assert.ok(!result.events.some((event) => event.type === 'worker-result'));
    },
  );
});

test('orchestrate run --no-subagents keeps the plan and skips worker requests', async (t) => {
  await withServer(
    (body, _url, response) => {
      if (isPlanner(body)) json(response, plannerReply());
      else json(response, workerReply());
    },
    async (baseUrl, requests) => {
      const root = await makeProject(t, baseUrl);
      const result = await invoke(root, [
        'run',
        '--task',
        'Inspect source files',
        '--approve-network',
        '--no-subagents',
      ]);
      assert.equal(result.thrown, undefined);
      assert.equal(result.code, 0);
      assert.equal(requests.filter(isPlanner).length, 1);
      assert.equal(requests.filter((body) => !isPlanner(body)).length, 0);
      const final = result.events.find(
        (event) => event.type === 'orchestration-result',
      );
      assert.equal(
        final?.result && (final.result as Record<string, unknown>).status,
        'planned',
      );
    },
  );
});

test('orchestrate run requires explicit network approval and configured enablement', async (t) => {
  await withServer(
    (_body, _url, response) => json(response, plannerReply()),
    async (baseUrl, requests) => {
      const enabledRoot = await makeProject(t, baseUrl);
      const missingApproval = await invoke(enabledRoot, [
        'run',
        '--task',
        'Inspect source files',
      ]);
      assert.ok(missingApproval.thrown || missingApproval.code !== 0);
      assert.equal(requests.length, 0);

      const disabledRoot = await makeProject(t, baseUrl, false);
      const disabled = await invoke(disabledRoot, [
        'run',
        '--task',
        'Inspect source files',
        '--approve-network',
      ]);
      assert.ok(disabled.thrown || disabled.code !== 0);
      assert.equal(requests.length, 0);
    },
  );
});

test('orchestrate run honors configured planner and executor roles', async (t) => {
  await withServer(
    (body, _url, response) => {
      if (isPlanner(body)) {
        assert.equal(body.model, 'planner-override');
        json(response, plannerReply());
      } else {
        assert.equal(body.model, 'executor-override');
        json(response, workerReply());
      }
    },
    async (baseUrl, requests) => {
      const root = await makeProject(t, baseUrl);
      const result = await invoke(root, [
        'run',
        '--task',
        'Inspect source files',
        '--approve-network',
        '--planner-model',
        'planner-override',
        '--executor-model',
        'executor-override',
      ]);
      assert.equal(result.thrown, undefined);
      assert.equal(result.code, 0);
      assert.equal(requests.filter(isPlanner).length, 1);
      assert.equal(requests.filter((body) => !isPlanner(body)).length, 1);
      assert.ok(
        result.events.some((event) => event.type === 'orchestration-result'),
      );
    },
  );
});

test('Ctrl+C during a central approval cancels queued orchestration workers', async (t) => {
  await withServer(
    async (body, _url, response) => {
      if (isPlanner(body)) {
        json(response, {
          ...(plannerReply() as Record<string, unknown>),
          message: {
            role: 'assistant',
            content: JSON.stringify({
              subtasks: [
                {
                  id: 'one',
                  task: 'Read the first source file',
                  context: 'Only the first file is relevant.',
                  paths: ['src/one.ts'],
                },
                {
                  id: 'two',
                  task: 'Read the second source file',
                  context: 'Only the second file is relevant.',
                  paths: ['src/two.ts'],
                },
              ],
            }),
          },
        });
        return;
      }
      const messages = body.messages as { content?: string }[];
      const prompt = messages
        .map((message) => message.content ?? '')
        .join('\n');
      const first = prompt.includes('"id":"one"');
      await sendToolReply(
        response as ServerResponse,
        'ollama',
        [
          {
            id: first ? 'read-one' : 'read-two',
            name: 'project_read',
            arguments: {
              path: first ? 'src/one.ts' : 'src/two.ts',
              startLine: 1,
              lineCount: 1,
            },
          },
        ],
        false,
      );
    },
    async (baseUrl, requests) => {
      const root = await makeProject(t, baseUrl);
      const result = await invoke(
        root,
        [
          'run',
          '--task',
          'Read both source files',
          '--approve-network',
          '--execute',
        ],
        { cancelTerminalApproval: true },
      );
      assert.equal(result.thrown, undefined);
      assert.equal(result.code, 5);
      assert.equal(result.approvalPrompts, 1);
      assert.equal(requests.length, 3);
      const final = result.events.find(
        (event) => event.type === 'orchestration-result',
      );
      const orchestrationResult = final?.result as
        Record<string, unknown> | undefined;
      assert.equal(orchestrationResult?.status, 'cancelled');
      assert.equal((orchestrationResult?.subtasks as unknown[])?.length, 2);
      assert.ok(
        (
          (orchestrationResult?.subtasks as Record<string, unknown>[]) ?? []
        ).every((worker) => worker.status === 'cancelled'),
      );
    },
  );
});
