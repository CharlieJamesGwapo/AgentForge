import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultConfig } from '../src/core/config.js';
import { runOrchestration } from '../src/engines/orchestration.js';
import { sendToolReply, type Protocol } from './helpers/tool-protocol.js';

const protocols: Protocol[] = ['openai', 'anthropic', 'ollama'];
for (const planner of protocols)
  for (const executor of protocols) {
    test(`orchestration ${planner} planner and ${executor} executor preserve central read approval and structured finals`, async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), 'agentforge-roles-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      await writeFile(
        path.join(root, 'note.txt'),
        'Explicitly approved fixture data\n',
      );
      let requests = 0,
        workerTurns = 0;
      const models: string[] = [];
      const server = createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', () => {
          requests++;
          const body = JSON.parse(raw);
          const protocol: Protocol =
            req.url === '/v1/responses'
              ? 'openai'
              : req.url === '/v1/messages'
                ? 'anthropic'
                : 'ollama';
          models.push(body.model);
          const isPlanner = !Array.isArray(body.tools);
          assert.equal(protocol, isPlanner ? planner : executor);
          if (isPlanner) {
            assert.equal(body.model, 'planner-fixture');
            void sendToolReply(
              res,
              protocol,
              [],
              false,
              JSON.stringify({
                subtasks: [
                  {
                    id: 'read',
                    task: 'Read note.txt and summarize',
                    context: 'Only the assigned file is relevant',
                    paths: ['note.txt'],
                  },
                ],
              }),
            );
          } else {
            workerTurns++;
            assert.equal(body.model, 'executor-fixture');
            assert.ok(
              !JSON.stringify(body.tools).includes('verification_check'),
            );
            void sendToolReply(
              res,
              protocol,
              workerTurns === 1
                ? [
                    {
                      id: 'read-note',
                      name: 'project_read',
                      arguments: {
                        path: 'note.txt',
                        startLine: 1,
                        lineCount: 2,
                      },
                    },
                  ]
                : [],
              false,
              JSON.stringify({
                status: 'completed',
                summary: 'Read approved note',
                paths: ['note.txt'],
              }),
            );
          }
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      t.after(() => {
        server.closeAllConnections();
        server.close();
      });
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const previous = process.env.ROLES_FIXTURE_KEY;
      process.env.ROLES_FIXTURE_KEY = 'local-roles-fixture';
      t.after(() => {
        if (previous === undefined) delete process.env.ROLES_FIXTURE_KEY;
        else process.env.ROLES_FIXTURE_KEY = previous;
      });
      const config = structuredClone(defaultConfig);
      config.permissions.allowNetwork = true;
      config.permissions.allowTools = true;
      config.permissions.allowProcess = true;
      config.providers = protocols.map((id) => ({
        id,
        model: 'default-fixture',
        baseUrl: `http://127.0.0.1:${address.port}${id === 'ollama' ? '' : '/v1'}`,
        apiKeyEnv: 'ROLES_FIXTURE_KEY',
      }));
      config.orchestration = {
        ...config.orchestration,
        enabled: true,
        planner: { provider: planner, model: 'planner-fixture' },
        executor: { provider: executor, model: 'executor-fixture' },
      };
      await writeFile(
        path.join(root, 'agentforge.config.json'),
        JSON.stringify(config),
      );
      let approvals = 0;
      const result = await runOrchestration({
        root,
        task: 'Inspect the note',
        approveNetwork: true,
        executeTools: true,
        approveToolBatch: async (batch, signal) => {
          assert.equal(signal.aborted, false);
          assert.equal(batch.calls.length, 1);
          assert.equal(batch.calls[0]!.name, 'project_read');
          approvals++;
          return true;
        },
      });
      assert.equal(result.status, 'completed', JSON.stringify(result));
      assert.equal(approvals, 1);
      assert.equal(requests, 3);
      assert.deepEqual(models, [
        'planner-fixture',
        'executor-fixture',
        'executor-fixture',
      ]);
      assert.equal(result.subtasks.length, 1);
    });
  }

test('two simultaneous orchestrations share a process-wide maximum of two active workers', async (t) => {
  const roots: string[] = [];
  t.after(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });
  let active = 0,
    maximum = 0,
    workers = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      void (async () => {
        const body = JSON.parse(raw);
        if (!Array.isArray(body.tools)) {
          await sendToolReply(
            res,
            'ollama',
            [],
            false,
            JSON.stringify({
              subtasks: ['one', 'two'].map((id) => ({
                id,
                task: `Summarize ${id}`,
                context: '',
                paths: [id],
              })),
            }),
          );
          return;
        }
        workers++;
        active++;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 60));
        active--;
        await sendToolReply(
          res,
          'ollama',
          [],
          false,
          JSON.stringify({
            status: 'completed',
            summary: 'Bounded fixture result',
            paths: [],
          }),
        );
      })().catch(() => res.destroy());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  for (let index = 0; index < 2; index++) {
    const root = await mkdtemp(
      path.join(tmpdir(), 'agentforge-global-workers-'),
    );
    roots.push(root);
    const config = structuredClone(defaultConfig);
    config.providers = [
      {
        id: 'ollama',
        model: 'fixture',
        baseUrl: `http://127.0.0.1:${address.port}`,
      },
    ];
    config.permissions.allowNetwork = true;
    config.orchestration = {
      ...config.orchestration,
      enabled: true,
      planner: { provider: 'ollama' },
      executor: { provider: 'ollama' },
      timeoutMs: 1000,
      maxDurationMs: 5000,
    };
    await writeFile(
      path.join(root, 'agentforge.config.json'),
      JSON.stringify(config),
    );
  }
  const results = await Promise.all(
    roots.map((root) =>
      runOrchestration({
        root,
        task: 'Summarize assigned paths',
        approveNetwork: true,
      }),
    ),
  );
  assert.ok(
    results.every((result) => result.status === 'completed'),
    JSON.stringify(results),
  );
  assert.equal(workers, 4);
  assert.equal(maximum, 2);
});

for (const invalidStage of ['planner', 'worker', 'worker-request']) {
  test(`observed native usage survives ${invalidStage} failure`, async (t) => {
    const root = await mkdtemp(
      path.join(tmpdir(), 'agentforge-usage-failure-'),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const subtask = {
      id: 'one',
      task: 'Inspect note',
      context: '',
      paths: ['note.txt'],
    };
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const body = JSON.parse(raw);
        if (invalidStage === 'worker-request' && Array.isArray(body.tools)) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{}');
          return;
        }
        const value = !Array.isArray(body.tools)
          ? {
              subtasks:
                invalidStage === 'planner' ? [subtask, subtask] : [subtask],
            }
          : {
              status: 'completed',
              summary: 'Invalid out of scope claim',
              paths: ['outside.txt'],
            };
        void sendToolReply(res, 'ollama', [], false, JSON.stringify(value));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const config = structuredClone(defaultConfig);
    config.providers = [
      {
        id: 'ollama',
        model: 'fixture',
        baseUrl: `http://127.0.0.1:${address.port}`,
      },
    ];
    config.permissions.allowNetwork = true;
    config.orchestration = {
      ...config.orchestration,
      enabled: true,
      planner: { provider: 'ollama' },
      executor: { provider: 'ollama' },
    };
    await writeFile(
      path.join(root, 'agentforge.config.json'),
      JSON.stringify(config),
    );
    const result = await runOrchestration({
      root,
      task: 'Inspect note',
      approveNetwork: true,
    });
    assert.notEqual(result.status, 'completed');
    assert.equal(
      result.usage.attemptedTurns,
      invalidStage === 'planner' ? 1 : 2,
    );
    assert.equal(
      result.usage.availableTurns,
      invalidStage === 'worker' ? 2 : 1,
    );
    assert.equal(result.usage.inputTokens, invalidStage === 'worker' ? 24 : 12);
    assert.equal(result.usage.outputTokens, invalidStage === 'worker' ? 6 : 3);
    if (invalidStage !== 'planner')
      assert.equal(result.subtasks[0]!.turns.attempted, 1);
    if (invalidStage === 'worker-request')
      assert.equal(result.usage.status, 'partial');
  });
}
