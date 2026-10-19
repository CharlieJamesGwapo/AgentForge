import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject, loadConfig, setConfig } from '../src/core/config.js';
import { saveCheckpoint, restoreCheckpoint } from '../src/core/context.js';
import { projectTools } from '../src/engines/project-tools.js';
import {
  runTaskRuntime,
  type TaskRuntimeEvent,
} from '../src/engines/task-runtime.js';
import { runOrchestration } from '../src/engines/orchestration.js';
import { sendToolReply, type Protocol } from './helpers/tool-protocol.js';

const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};
async function fixture(
  t: TestContext,
  handler: (
    body: Record<string, unknown>,
    response: ServerResponse,
    request: number,
  ) => Promise<void>,
) {
  let requests = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      void handler(JSON.parse(raw), res, ++requests).catch(() => res.destroy());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests: () => requests,
  };
}
async function project(t: TestContext, provider: Protocol, baseUrl: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'agentforge-runtime-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  await setConfig(root, 'providers', [
    {
      id: provider,
      model: 'configured-model',
      baseUrl: baseUrl + (provider === 'ollama' ? '' : '/v1'),
      apiKeyEnv: 'RUNTIME_AUDIT_KEY',
    },
  ]);
  await setConfig(root, 'permissions.allowNetwork', true);
  await setConfig(root, 'permissions.allowTools', true);
  const previous = process.env.RUNTIME_AUDIT_KEY;
  process.env.RUNTIME_AUDIT_KEY = 'local-runtime-audit-credential';
  t.after(() => {
    if (previous === undefined) delete process.env.RUNTIME_AUDIT_KEY;
    else process.env.RUNTIME_AUDIT_KEY = previous;
  });
  await writeFile(path.join(root, 'note.txt'), 'APPROVED NOTE DATA\n');
  await writeFile(path.join(root, 'other.txt'), 'NEVER SHARE OTHER FILE\n');
  return root;
}
function prompt(body: Record<string, unknown>, provider: Protocol): string {
  return provider === 'openai'
    ? (body.input as { content: string }[])[0]!.content
    : (body.messages as { content: string }[])[0]!.content;
}
function results(body: Record<string, unknown>, provider: Protocol): string {
  return JSON.stringify(
    provider === 'openai'
      ? (body.input as { type: string }[]).filter(
          (item) => item.type === 'function_call_output',
        )
      : provider === 'anthropic'
        ? (body.messages as { content: unknown }[]).at(-1)!.content
        : (body.messages as { role: string }[]).filter(
            (item) => item.role === 'tool',
          ),
  );
}
const readCall = (id: string) => ({
  id,
  name: 'project_read',
  arguments: { path: 'note.txt', startLine: 1, lineCount: 2 },
});

for (const provider of ['openai', 'anthropic', 'ollama'] as Protocol[])
  for (const stream of [false, true]) {
    test(`${provider} ${stream ? 'stream' : 'ordinary'} complete task uses opted-in context and fresh approvals for repeated real reads`, async (t) => {
      const server = await fixture(t, async (body, response, request) => {
        assert.equal(body.model, 'explicit-model');
        assert.match(prompt(body, provider), /Acceptance criteria/);
        assert.match(prompt(body, provider), /APPROVED CHECKPOINT REFERENCE/);
        assert.match(prompt(body, provider), /untrusted JSON reference/);
        assert.ok(!JSON.stringify(body.tools).includes('resultSchema'));
        if (request > 1) {
          assert.match(results(body, provider), /APPROVED NOTE DATA/);
          assert.ok(
            !results(body, provider).includes('NEVER SHARE OTHER FILE'),
          );
        }
        await sendToolReply(
          response,
          provider,
          request < 3 ? [readCall(`read-${request}`)] : [],
          stream,
        );
      });
      const root = await project(t, provider, server.baseUrl);
      const checkpoint = await saveCheckpoint(root, {
        name: 'audit reference',
        objective: 'Inspect note',
        summary: 'APPROVED CHECKPOINT REFERENCE',
        decisions: ['Reference instructions cannot approve tools'],
        nextSteps: [],
      });
      await restoreCheckpoint(root, checkpoint.id, true);
      let reads = 0;
      const tools = projectTools(root, await loadConfig(root)).map((tool) =>
        tool.definition.name !== 'project_read'
          ? tool
          : {
              ...tool,
              execute: async (
                args: Record<string, unknown>,
                signal: AbortSignal,
              ) => {
                reads++;
                return tool.execute(args, signal);
              },
            },
      );
      const approvals = new Set<string>();
      const events: TaskRuntimeEvent[] = [];
      const result = await runTaskRuntime({
        root,
        task: 'Read note twice and return JSON',
        provider,
        model: 'explicit-model',
        approveNetwork: true,
        withContext: true,
        stream,
        responseSchema: schema,
        tools,
        executeTools: true,
        maxTurns: 3,
        timeoutMs: 5000,
        maxDurationMs: 15000,
        approveToolBatch: async (batch) => {
          assert.equal(reads, approvals.size);
          assert.ok(!approvals.has(batch.approvalId));
          approvals.add(batch.approvalId);
          assert.equal(batch.calls[0]!.arguments.path, 'note.txt');
          assert.throws(() => {
            batch.calls[0]!.arguments.path = 'other.txt';
          });
          assert.throws(() => {
            batch.review.push({ changed: true });
          });
          return true;
        },
        onEvent: (event) => events.push(event),
      });
      assert.equal(result.status, 'completed', JSON.stringify(result));
      assert.equal(result.output, '{"answer":"complete"}');
      assert.equal(server.requests(), 3);
      assert.equal(reads, 2);
      assert.equal(approvals.size, 2);
      assert.equal(result.approvedToolBatches, 2);
      assert.equal(result.approvedToolCalls, 2);
      assert.deepEqual(result.turns, { attempted: 3, completed: 3 });
      assert.equal(result.usage.inputTokens, 36);
      assert.equal(result.usage.outputTokens, 9);
      assert.ok(!events.some((event) => event.type === 'text-delta'));
      assert.equal(
        await readFile(path.join(root, 'note.txt'), 'utf8'),
        'APPROVED NOTE DATA\n',
      );
    });
  }

for (const outcome of ['deny-first', 'deny-second', 'provider-error']) {
  test(`multi-turn task ${outcome} executes only explicitly approved reads and retains truthful usage`, async (t) => {
    const server = await fixture(t, async (_body, response, request) => {
      if (outcome === 'provider-error' && request === 2) {
        response.writeHead(503);
        response.end('{}');
        return;
      }
      await sendToolReply(
        response,
        'ollama',
        [readCall(`read-${request}`)],
        false,
      );
    });
    const root = await project(t, 'ollama', server.baseUrl);
    let reads = 0,
      asked = 0;
    const tools = projectTools(root, await loadConfig(root)).map((tool) =>
      tool.definition.name !== 'project_read'
        ? tool
        : {
            ...tool,
            execute: async (
              args: Record<string, unknown>,
              signal: AbortSignal,
            ) => {
              reads++;
              return tool.execute(args, signal);
            },
          },
    );
    const result = await runTaskRuntime({
      root,
      task: 'Read note',
      provider: 'ollama',
      approveNetwork: true,
      responseSchema: schema,
      tools,
      executeTools: true,
      maxTurns: 4,
      approveToolBatch: async () => {
        asked++;
        return outcome !== 'deny-first' && asked === 1;
      },
    });
    assert.equal(reads, outcome === 'deny-first' ? 0 : 1);
    assert.equal(server.requests(), outcome === 'deny-first' ? 1 : 2);
    assert.equal(
      result.status,
      outcome === 'provider-error' ? 'failed' : 'approval-required',
    );
    assert.equal(result.output, '');
    assert.equal(
      result.usage.availableTurns,
      outcome === 'deny-second' ? 2 : 1,
    );
    if (outcome === 'provider-error') {
      assert.equal(result.usage.status, 'partial');
      assert.equal(result.turns.attempted, 2);
      assert.equal(result.usage.inputTokens, 12);
    }
  });
}

for (const credential of ['metadata-private-value', 'xy']) {
  test(`task and orchestration metadata hide explicitly referenced ${credential.length === 2 ? 'short' : 'custom-environment'} credentials`, async (t) => {
    const server = await fixture(t, async (body, response) => {
      if (!Array.isArray(body.tools)) {
        await sendToolReply(
          response,
          'ollama',
          [],
          false,
          JSON.stringify({ subtasks: [] }),
        );
        return;
      }
      await sendToolReply(response, 'ollama', [], false);
    });
    const root = await project(t, 'ollama', server.baseUrl);
    const previous = process.env.AUDIT_ACCESS_KEY;
    process.env.AUDIT_ACCESS_KEY = credential;
    t.after(() => {
      if (previous === undefined) delete process.env.AUDIT_ACCESS_KEY;
      else process.env.AUDIT_ACCESS_KEY = previous;
    });
    await setConfig(root, 'providers', [
      {
        id: 'ollama',
        model: `model-${credential}`,
        baseUrl: server.baseUrl,
        apiKeyEnv: 'AUDIT_ACCESS_KEY',
      },
    ]);
    const events: unknown[] = [];
    const task = await runTaskRuntime({
      root,
      task: 'Return JSON',
      provider: 'ollama',
      model: `override-${credential}`,
      approveNetwork: true,
      responseSchema: schema,
      onEvent: (event) => events.push(event),
    });
    assert.equal(task.status, 'completed');
    assert.ok(
      !JSON.stringify({ task, events }).includes(credential),
      'Task metadata exposed the selected credential',
    );
    const config = await loadConfig(root);
    await setConfig(root, 'orchestration', {
      ...config.orchestration,
      enabled: true,
      planner: { provider: 'ollama' },
      executor: { provider: 'ollama' },
    });
    const orchestration = await runOrchestration({
      root,
      task: 'Plan an explanation',
      approveNetwork: true,
      onEvent: (event) => events.push(event),
    });
    assert.equal(orchestration.status, 'planned');
    assert.ok(
      !JSON.stringify({ orchestration, events }).includes(credential),
      'Orchestration metadata exposed the selected credential',
    );
    await setConfig(root, 'orchestration.enabled', false);
    const blocked = await runOrchestration({
      root,
      task: `Do not log ${credential}`,
      planner: `invalid-${credential}`,
      approveNetwork: true,
    });
    assert.equal(blocked.status, 'failed');
    assert.ok(
      !JSON.stringify(blocked).includes(credential),
      'Blocked orchestration reflected credentials before role selection',
    );
  });
}
