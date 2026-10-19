import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { initProject } from '../src/core/config.js';
import { runOrchestration } from '../src/engines/orchestration.js';

type RequestBody = Record<string, unknown>;
type CapturedRequest = {
  body: RequestBody;
  url: string | undefined;
};
type PlannerSubtask = {
  id: string;
  task: string;
  context: string;
  paths: string[];
};
type OrchestrationConfig = {
  enabled: boolean;
  maxConcurrency: number;
  maxDepth: number;
  maxSubtasks: number;
  maxContextBytes: number;
  maxOutputBytes: number;
  timeoutMs: number;
  maxDurationMs: number;
  planner: { provider: string; model?: string } | null;
  executor: { provider: string; model?: string } | null;
};

const defaultOrchestration: OrchestrationConfig = {
  enabled: true,
  maxConcurrency: 2,
  maxDepth: 1,
  maxSubtasks: 8,
  maxContextBytes: 16384,
  maxOutputBytes: 32768,
  timeoutMs: 1000,
  maxDurationMs: 5000,
  planner: { provider: 'ollama', model: 'planner-configured' },
  executor: { provider: 'ollama', model: 'executor-configured' },
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<RequestBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as RequestBody;
}

async function withOllamaServer<T>(
  handler: (
    request: CapturedRequest,
    response: ServerResponse,
  ) => void | Promise<void>,
  run: (baseUrl: string, requests: CapturedRequest[]) => Promise<T>,
): Promise<T> {
  const requests: CapturedRequest[] = [];
  const server = createServer((incoming, response) => {
    void readBody(incoming)
      .then(async (body) => {
        const captured = { body, url: incoming.url };
        requests.push(captured);
        await handler(captured, response);
      })
      .catch(() => {
        if (!response.headersSent)
          json(response, { error: 'fixture error' }, 500);
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

function plannerResult(subtasks: unknown[]): unknown {
  return {
    model: 'planner-reported-model',
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 4,
    eval_count: 5,
    message: {
      role: 'assistant',
      content: JSON.stringify({ subtasks }),
    },
  };
}

function workerResult(
  summary: string,
  paths: string[] = [],
  status: 'completed' | 'blocked' = 'completed',
): unknown {
  return {
    model: 'executor-reported-model',
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 7,
    eval_count: 8,
    message: {
      role: 'assistant',
      content: JSON.stringify({ status, summary, paths }),
    },
  };
}

function isPlanner(request: CapturedRequest): boolean {
  return !Array.isArray(request.body.tools);
}

function makeSubtask(
  id: string,
  task = `Work on ${id}`,
  paths: string[] = ['src'],
  context = `Context for ${id}`,
): PlannerSubtask {
  return { id, task, context, paths };
}

async function makeProject(
  t: { after(callback: () => void): void },
  baseUrl: string,
  overrides: Partial<OrchestrationConfig> = {},
  permissions: { allowTools?: boolean; allowProcess?: boolean } = {},
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'agentforge-orchestration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initialized = await initProject(root);
  const config = {
    ...initialized.config,
    providers: [{ id: 'ollama', model: 'provider-default', baseUrl }],
    permissions: {
      ...initialized.config.permissions,
      allowNetwork: true,
      allowTools: true,
      allowProcess: false,
      ...permissions,
    },
    orchestration: {
      ...defaultOrchestration,
      ...overrides,
    },
  };
  await writeFile(
    path.join(root, 'agentforge.config.json'),
    JSON.stringify(config),
  );
  return root;
}

function runOptions(
  root: string,
  task = 'Inspect and summarize the repository',
) {
  return { root, task, approveNetwork: true };
}

function subtasksFrom(result: unknown): Record<string, unknown>[] {
  assert.ok(result && typeof result === 'object');
  const subtasks = (result as { subtasks?: unknown }).subtasks;
  assert.ok(Array.isArray(subtasks));
  return subtasks as Record<string, unknown>[];
}

test('orchestration uses configured role providers and model overrides with a strict planner schema', async (t) => {
  await withOllamaServer(
    (request, response) => {
      if (isPlanner(request)) {
        const schema = request.body.format as Record<string, unknown>;
        assert.equal(schema.additionalProperties, false);
        assert.equal(
          (schema.properties as Record<string, Record<string, unknown>>)
            .subtasks?.type,
          'array',
        );
        json(response, plannerResult([makeSubtask('one')]));
        return;
      }
      assert.equal(request.body.model, 'executor-override');
      assert.equal(request.url, '/api/chat');
      json(response, workerResult('done', ['src/one.ts']));
    },
    async (baseUrl, requests) => {
      const root = await makeProject(t, baseUrl);
      const result = await runOrchestration({
        ...runOptions(root),
        plannerModel: 'planner-override',
        executorModel: 'executor-override',
      });
      assert.equal(result.status, 'completed');
      assert.equal(requests[0]?.body.model, 'planner-override');
      assert.equal(requests.filter(isPlanner).length, 1);
      assert.equal(requests.filter((request) => !isPlanner(request)).length, 1);
      assert.equal(subtasksFrom(result).length, 1);
    },
  );
});

test('orchestration rejects disabled, unapproved, and oversized requests before network use', async (t) => {
  await withOllamaServer(
    (_request, response) => json(response, plannerResult([])),
    async (baseUrl, requests) => {
      const disabledRoot = await makeProject(t, baseUrl, { enabled: false });
      const disabled = await runOrchestration(runOptions(disabledRoot));
      assert.equal(disabled.status, 'failed');
      assert.equal(requests.length, 0);

      const unapprovedRoot = await makeProject(t, baseUrl);
      const unapproved = await runOrchestration({
        ...runOptions(unapprovedRoot),
        approveNetwork: false,
      });
      assert.equal(unapproved.status, 'failed');
      assert.equal(requests.length, 0);

      const oversized = await runOrchestration({
        ...runOptions(unapprovedRoot, 'x'.repeat(32769)),
      });
      assert.equal(oversized.status, 'failed');
      assert.equal(requests.length, 0);
    },
  );
});

test('orchestration requires configured planner and executor roles before requesting a plan', async (t) => {
  await withOllamaServer(
    (_request, response) => json(response, plannerResult([])),
    async (baseUrl, requests) => {
      for (const role of ['planner', 'executor'] as const) {
        const root = await makeProject(t, baseUrl, { [role]: null });
        const result = await runOrchestration(runOptions(root));
        assert.equal(result.status, 'failed');
      }
      assert.equal(requests.length, 0);
    },
  );
});

test('planner output is validated and bounded before any executor starts', async (t) => {
  const invalidPlans = [
    [makeSubtask('duplicate'), makeSubtask('duplicate')],
    [makeSubtask('unsafe', 'task', ['../outside'])],
    [
      makeSubtask('extra', 'task', ['src'], 'context'),
      { ...makeSubtask('extra-field'), surprise: true },
    ],
    Array.from({ length: 9 }, (_, index) => makeSubtask(`too-many-${index}`)),
  ];
  for (const invalid of invalidPlans) {
    await withOllamaServer(
      (request, response) =>
        json(
          response,
          isPlanner(request)
            ? plannerResult(invalid)
            : workerResult('unexpected'),
        ),
      async (baseUrl, requests) => {
        const root = await makeProject(t, baseUrl);
        const result = await runOrchestration(runOptions(root));
        assert.notEqual(result.status, 'completed');
        assert.equal(
          requests.filter((request) => !isPlanner(request)).length,
          0,
        );
      },
    );
  }

  await withOllamaServer(
    (_request, response) =>
      json(
        response,
        plannerResult([
          makeSubtask('too-big', 'x', ['src'], 'c'.repeat(17000)),
        ]),
      ),
    async (baseUrl, requests) => {
      const root = await makeProject(t, baseUrl);
      const result = await runOrchestration(runOptions(root));
      assert.notEqual(result.status, 'completed');
      assert.equal(requests.filter((request) => !isPlanner(request)).length, 0);
    },
  );

  await withOllamaServer(
    (_request, response) =>
      json(
        response,
        plannerResult([
          makeSubtask('large-plan', 'x', ['src'], 'c'.repeat(300)),
        ]),
      ),
    async (baseUrl, requests) => {
      const root = await makeProject(t, baseUrl, { maxOutputBytes: 256 });
      const result = await runOrchestration(runOptions(root));
      assert.notEqual(result.status, 'completed');
      assert.equal(requests.filter((request) => !isPlanner(request)).length, 0);
    },
  );
});

test('orchestration keeps active workers at the configured concurrency limit', async (t) => {
  let active = 0;
  let maximum = 0;
  await withOllamaServer(
    async (request, response) => {
      if (isPlanner(request)) {
        json(
          response,
          plannerResult([
            makeSubtask('one'),
            makeSubtask('two'),
            makeSubtask('three'),
            makeSubtask('four'),
          ]),
        );
        return;
      }
      active++;
      maximum = Math.max(maximum, active);
      await delay(25);
      active--;
      json(response, workerResult('finished'));
    },
    async (baseUrl) => {
      const root = await makeProject(t, baseUrl, { maxConcurrency: 2 });
      const result = await runOrchestration(runOptions(root));
      assert.equal(result.status, 'completed');
      assert.equal(subtasksFrom(result).length, 4);
      assert.ok(maximum <= 2, `observed ${maximum} active workers`);
      assert.equal(
        maximum,
        2,
        'the worker queue should use both available slots',
      );
    },
  );
});

test('worker failure preserves successful sibling results as partial completion', async (t) => {
  await withOllamaServer(
    (request, response) => {
      if (isPlanner(request)) {
        json(
          response,
          plannerResult([makeSubtask('good'), makeSubtask('bad')]),
        );
        return;
      }
      const messages = request.body.messages as { content?: string }[];
      const initial = messages?.[0]?.content ?? '';
      if (initial.includes('Work on bad')) {
        json(response, {
          model: 'executor-reported-model',
          done: true,
          done_reason: 'stop',
          message: { role: 'assistant', content: 'not-json' },
        });
        return;
      }
      json(response, workerResult('good result', ['src/good.ts']));
    },
    async (baseUrl) => {
      const root = await makeProject(t, baseUrl);
      const result = await runOrchestration(runOptions(root));
      assert.equal(result.status, 'partial');
      const workers = subtasksFrom(result);
      assert.ok(
        workers.some(
          (worker) => worker.id === 'good' && worker.status === 'completed',
        ),
      );
      assert.ok(
        workers.some(
          (worker) => worker.id === 'bad' && worker.status !== 'completed',
        ),
      );
    },
  );
});

test('worker-reported paths outside the assigned scope are rejected and overlaps are reported', async (t) => {
  await withOllamaServer(
    (request, response) => {
      if (isPlanner(request)) {
        json(
          response,
          plannerResult([
            makeSubtask('parent', 'inspect src', ['src']),
            makeSubtask('child', 'inspect one source file', ['src/file.ts']),
          ]),
        );
        return;
      }
      json(response, workerResult('claims work in docs', ['docs/private.md']));
    },
    async (baseUrl) => {
      const root = await makeProject(t, baseUrl);
      const result = await runOrchestration(runOptions(root));
      const workers = subtasksFrom(result);
      assert.ok(workers.every((worker) => worker.status !== 'completed'));
      const conflicts = (result as { conflicts?: unknown }).conflicts;
      assert.ok(Array.isArray(conflicts));
      assert.ok(conflicts.length > 0);
      assert.match(JSON.stringify(conflicts), /src/);
    },
  );
});

test('safe out-of-scope path claims remain visible as rejected conflicts', async (t) => {
  await withOllamaServer(
    (request, response) => {
      if (isPlanner(request)) {
        json(
          response,
          plannerResult([
            makeSubtask('one', 'Inspect the note', ['note.txt']),
            makeSubtask('two', 'Inspect the other file', ['other.txt']),
          ]),
        );
        return;
      }
      const messages = request.body.messages as { content?: string }[];
      const prompt = messages
        .map((message) => message.content ?? '')
        .join('\n');
      assert.ok(prompt.includes('Assigned subtask JSON:'));
      json(response, workerResult('Inspection finished', ['other.txt']));
    },
    async (baseUrl) => {
      const root = await makeProject(t, baseUrl);
      const result = await runOrchestration(runOptions(root));
      assert.equal(result.status, 'partial');
      const workers = subtasksFrom(result);
      const rejected = workers.find((worker) => worker.id === 'one');
      const accepted = workers.find((worker) => worker.id === 'two');
      assert.equal(rejected?.status, 'failed');
      assert.deepEqual(rejected?.reportedPaths, []);
      assert.deepEqual(rejected?.rejectedPaths, ['other.txt']);
      assert.equal(accepted?.status, 'completed');
      const conflicts = result.conflicts;
      assert.ok(
        conflicts.some(
          (conflict) =>
            conflict.kind === 'out-of-scope-report' &&
            conflict.path === 'other.txt' &&
            conflict.subtasks[0] === 'one',
        ),
      );
      assert.ok(
        conflicts.some(
          (conflict) =>
            conflict.kind === 'reported-path-overlap' &&
            conflict.path === 'other.txt',
        ),
      );
    },
  );
});

test('worker tool requests remain inside assigned scopes and require serialized exact approval', async (t) => {
  let approvalActive = 0;
  let maximumApprovalActive = 0;
  let approvals = 0;
  await withOllamaServer(
    (request, response) => {
      if (isPlanner(request)) {
        json(
          response,
          plannerResult([
            makeSubtask('one', 'Read first file', ['src/one.ts']),
            makeSubtask('two', 'Read second file', ['src/two.ts']),
          ]),
        );
        return;
      }
      const messages = request.body.messages as { role?: string }[];
      if (messages.some((message) => message.role === 'tool')) {
        json(response, workerResult('read completed'));
        return;
      }
      json(response, {
        model: 'executor-reported-model',
        done: true,
        done_reason: 'stop',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              function: {
                name: 'project_read',
                arguments: {
                  path:
                    request.body.messages &&
                    JSON.stringify(request.body.messages).includes('one.ts')
                      ? 'src/one.ts'
                      : 'src/two.ts',
                  startLine: 1,
                  lineCount: 10,
                },
              },
            },
          ],
        },
      });
    },
    async (baseUrl) => {
      const root = await makeProject(t, baseUrl);
      await writeFile(path.join(root, 'src-one.tmp'), 'first');
      const result = await runOrchestration({
        ...runOptions(root),
        executeTools: true,
        approveToolBatch: async (batch, signal) => {
          assert.equal(signal.aborted, false);
          approvals++;
          approvalActive++;
          maximumApprovalActive = Math.max(
            maximumApprovalActive,
            approvalActive,
          );
          assert.ok(batch.calls.length > 0);
          await delay(20);
          approvalActive--;
          return true;
        },
      });
      assert.equal(result.status, 'completed');
      assert.equal(approvals, 2);
      assert.equal(maximumApprovalActive, 1);
    },
  );
});

test('an out-of-scope tool call is withheld before central approval', async (t) => {
  let approvals = 0;
  await withOllamaServer(
    (request, response) => {
      if (isPlanner(request)) {
        json(
          response,
          plannerResult([
            makeSubtask('one', 'Read only one.ts', ['src/one.ts']),
          ]),
        );
        return;
      }
      json(response, {
        model: 'executor-reported-model',
        done: true,
        done_reason: 'stop',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              function: {
                name: 'project_read',
                arguments: { path: 'src/two.ts', startLine: 1, lineCount: 10 },
              },
            },
          ],
        },
      });
    },
    async (baseUrl) => {
      const root = await makeProject(t, baseUrl);
      await mkdir(path.join(root, 'src'), { recursive: true });
      await writeFile(path.join(root, 'src', 'two.ts'), 'must not be read');
      const result = await runOrchestration({
        ...runOptions(root),
        executeTools: true,
        approveToolBatch: async () => {
          approvals++;
          return true;
        },
      });
      assert.notEqual(result.status, 'completed');
      assert.equal(approvals, 0);
    },
  );
});

test('a config edit after planning cannot widen the worker tool registry', async (t) => {
  let rootForMutation = '';
  let workerToolNames: string[] = [];
  await withOllamaServer(
    async (request, response) => {
      if (isPlanner(request)) {
        if (rootForMutation) {
          const file = path.join(rootForMutation, 'agentforge.config.json');
          const parsed = JSON.parse(await readFile(file, 'utf8')) as {
            permissions: { allowProcess: boolean };
          };
          parsed.permissions.allowProcess = true;
          await writeFile(file, JSON.stringify(parsed));
        }
        json(response, plannerResult([makeSubtask('one')]));
        return;
      }
      workerToolNames = (
        request.body.tools as { function?: { name?: string } }[]
      )
        .map((tool) => tool.function?.name ?? '')
        .filter(Boolean);
      json(response, workerResult('done'));
    },
    async (baseUrl) => {
      const root = await makeProject(t, baseUrl, {}, { allowProcess: false });
      rootForMutation = root;
      const result = await runOrchestration(runOptions(root));
      assert.equal(result.status, 'completed');
      assert.ok(workerToolNames.includes('project_summary'));
      assert.ok(!workerToolNames.some((name) => name.startsWith('git_')));
      assert.ok(!workerToolNames.includes('verification_check'));
    },
  );
});

test('global cancellation stops queued workers and retains a bounded partial report', async (t) => {
  const controller = new AbortController();
  let workerRequests = 0;
  await withOllamaServer(
    async (request, response) => {
      if (isPlanner(request)) {
        json(
          response,
          plannerResult([
            makeSubtask('one'),
            makeSubtask('two'),
            makeSubtask('three'),
            makeSubtask('four'),
          ]),
        );
        return;
      }
      workerRequests++;
      await delay(1000);
      json(response, workerResult('late result'));
    },
    async (baseUrl) => {
      const root = await makeProject(t, baseUrl, { maxConcurrency: 2 });
      setTimeout(() => controller.abort(), 60);
      const result = await runOrchestration({
        ...runOptions(root),
        signal: controller.signal,
      });
      assert.ok(['partial', 'cancelled'].includes(result.status));
      assert.ok(
        workerRequests <= 2,
        `queued workers started: ${workerRequests}`,
      );
    },
  );
});

test('late approval after cancellation cannot execute a tool or send a follow-up request', async (t) => {
  const controller = new AbortController();
  let approvalFinished = false;
  await withOllamaServer(
    (request, response) => {
      if (isPlanner(request)) {
        json(
          response,
          plannerResult([makeSubtask('one', 'Read one.ts', ['src/one.ts'])]),
        );
        return;
      }
      const messages = request.body.messages as { role?: string }[];
      if (messages.some((message) => message.role === 'tool')) {
        json(response, workerResult('late result should not exist'));
        return;
      }
      json(response, {
        model: 'executor-reported-model',
        done: true,
        done_reason: 'stop',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              function: {
                name: 'project_read',
                arguments: { path: 'src/one.ts', startLine: 1, lineCount: 10 },
              },
            },
          ],
        },
      });
    },
    async (baseUrl, requests) => {
      const root = await makeProject(t, baseUrl);
      await mkdir(path.join(root, 'src'), { recursive: true });
      await writeFile(path.join(root, 'src', 'one.ts'), 'read would succeed');
      const result = await runOrchestration({
        ...runOptions(root),
        executeTools: true,
        signal: controller.signal,
        approveToolBatch: async () => {
          await delay(30);
          controller.abort();
          await delay(30);
          approvalFinished = true;
          return true;
        },
      });
      await delay(40);
      assert.ok(['partial', 'cancelled'].includes(result.status));
      assert.equal(approvalFinished, true);
      assert.equal(requests.filter((request) => !isPlanner(request)).length, 1);
    },
  );
});

test('worker deadlines and output budgets are enforced independently', async (t) => {
  await withOllamaServer(
    async (request, response) => {
      if (isPlanner(request)) {
        json(response, plannerResult([makeSubtask('slow')]));
        return;
      }
      await delay(200);
      if (!response.destroyed) json(response, workerResult('late'));
    },
    async (baseUrl) => {
      const root = await makeProject(t, baseUrl, {
        timeoutMs: 50,
        maxDurationMs: 1000,
      });
      const result = await runOrchestration(runOptions(root));
      assert.equal(subtasksFrom(result)[0]?.status, 'timedout');
    },
  );

  await withOllamaServer(
    (request, response) => {
      if (isPlanner(request)) {
        json(response, plannerResult([makeSubtask('large-output')]));
        return;
      }
      json(response, workerResult('x'.repeat(1000)));
    },
    async (baseUrl) => {
      const root = await makeProject(t, baseUrl, { maxOutputBytes: 256 });
      const result = await runOrchestration(runOptions(root));
      assert.notEqual(subtasksFrom(result)[0]?.status, 'completed');
    },
  );
});

test('depth limits reject nested delegation and depth zero prevents executor requests', async (t) => {
  await withOllamaServer(
    (request, response) => {
      if (isPlanner(request)) {
        json(response, plannerResult([makeSubtask('one')]));
        return;
      }
      json(response, workerResult('done'));
    },
    async (baseUrl, requests) => {
      const root = await makeProject(t, baseUrl, { maxDepth: 0 });
      const result = await runOrchestration(runOptions(root));
      assert.equal(result.status, 'planned');
      assert.equal(requests.filter(isPlanner).length, 1);
      assert.equal(requests.filter((request) => !isPlanner(request)).length, 0);

      const nestedRoot = await makeProject(t, baseUrl, { maxDepth: 1 });
      const nested = await runOrchestration({
        ...runOptions(nestedRoot),
        depth: 1,
      });
      assert.equal(nested.status, 'failed');
      assert.equal(requests.length, 1);
    },
  );
});

test('disabling subagents prevents executor requests', async (t) => {
  await withOllamaServer(
    (request, response) => {
      if (isPlanner(request))
        json(response, plannerResult([makeSubtask('one')]));
      else json(response, workerResult('must not run'));
    },
    async (baseUrl, requests) => {
      const root = await makeProject(t, baseUrl);
      const result = await runOrchestration({
        ...runOptions(root),
        subagents: false,
      });
      assert.equal(result.status, 'planned');
      assert.equal(requests.filter(isPlanner).length, 1);
      assert.equal(requests.filter((request) => !isPlanner(request)).length, 0);
    },
  );
});
