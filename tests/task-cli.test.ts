import assert from 'node:assert/strict';
import { Command } from 'commander';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { initProject, setConfig } from '../src/core/config.js';
import { restoreCheckpoint, saveCheckpoint } from '../src/core/context.js';
import { registerTaskCommand } from '../src/cli/task.js';

async function readBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
    string,
    unknown
  >;
}

async function withServer<T>(
  handler: (
    body: Record<string, unknown>,
    response: ServerResponse,
  ) => void | Promise<void>,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer((request, response) => {
    void readBody(request).then((body) => handler(body, response));
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

async function invokeTask(root: string, args: string[]) {
  const program = new Command().exitOverride();
  registerTaskCommand(program, async () => root, new AbortController().signal);
  const lines: string[] = [];
  const originalLog = console.log;
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  console.log = (line?: unknown) => lines.push(String(line ?? ''));
  try {
    await program.parseAsync(['node', 'agentforge', 'task', ...args]);
    return {
      code: process.exitCode,
      events: lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    };
  } finally {
    console.log = originalLog;
    process.exitCode = previousExitCode;
  }
}

function reply(content: string, calls?: unknown[]) {
  return {
    model: 'fixture-model',
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 6,
    eval_count: 3,
    message: {
      role: 'assistant',
      content,
      ...(calls === undefined ? {} : { tool_calls: calls }),
    },
  };
}

async function project(t: { after(callback: () => void): void }) {
  const root = await mkdtemp(path.join(tmpdir(), 'agentforge-task-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  return root;
}

test('task CLI blocks network before request, then honors provider, model, context and schema options', async (t) => {
  const root = await project(t);
  let requests = 0;
  await withServer(
    (body, response) => {
      requests++;
      assert.equal(body.model, 'fixture-override');
      assert.equal(body.format && typeof body.format, 'object');
      const messages = body.messages as { content: string }[];
      assert.match(messages[0]!.content, /Untrusted checkpoint JSON/);
      assert.match(messages[0]!.content, /cli-checkpoint-only/);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(reply('{"answer":"ready"}')));
    },
    async (baseUrl) => {
      await setConfig(root, 'providers', [
        { id: 'ollama', model: 'configured-model', baseUrl },
      ]);
      await setConfig(root, 'permissions.allowNetwork', true);
      await restoreCheckpoint(
        root,
        (
          await saveCheckpoint(root, {
            name: 'CLI reference',
            objective: '',
            summary: 'cli-checkpoint-only',
            decisions: [],
            nextSteps: [],
          })
        ).id,
        true,
      );
      await writeFile(
        path.join(root, 'answer-schema.json'),
        JSON.stringify({
          type: 'object',
          properties: { answer: { type: 'string' } },
          required: ['answer'],
          additionalProperties: false,
        }),
      );
      await writeFile(
        path.join(root, 'tool-schemas.json'),
        JSON.stringify({
          project_summary: {
            type: 'object',
            properties: {
              project: { type: 'string' },
              package: {
                type: 'object',
                properties: {
                  name: { type: ['string', 'null'] },
                  version: { type: ['string', 'null'] },
                  scripts: { type: 'array', items: { type: 'string' } },
                },
                required: ['name', 'version', 'scripts'],
                additionalProperties: false,
              },
            },
            required: ['project', 'package'],
            additionalProperties: false,
          },
        }),
      );
      const baseArgs = [
        '--task',
        'Summarize the project',
        '--provider',
        'ollama',
      ];
      const blocked = await invokeTask(root, baseArgs);
      assert.equal(blocked.code, 6);
      assert.equal(requests, 0);
      const allowed = await invokeTask(root, [
        ...baseArgs,
        '--approve-network',
        '--model',
        'fixture-override',
        '--with-context',
        '--schema',
        'answer-schema.json',
        '--result-schemas',
        'tool-schemas.json',
        '--max-turns',
        '3',
        '--timeout-ms',
        '2000',
        '--max-duration-ms',
        '5000',
      ]);
      assert.equal(allowed.code, 0);
      assert.equal(requests, 1);
      assert.ok(
        allowed.events.some(
          (event) => event.type === 'status' && event.status === 'completed',
        ),
      );
    },
  );
});

test('task CLI cannot use piped input to approve a tool batch', async (t) => {
  const root = await project(t);
  await setConfig(root, 'permissions.allowNetwork', true);
  await setConfig(root, 'permissions.allowTools', true);
  let requests = 0;
  await withServer(
    (_body, response) => {
      requests++;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify(
          reply('', [{ function: { name: 'project_summary', arguments: {} } }]),
        ),
      );
    },
    async (baseUrl) => {
      await setConfig(root, 'providers', [
        { id: 'ollama', model: 'fixture', baseUrl },
      ]);
      const result = await invokeTask(root, [
        '--task',
        'Inspect package metadata',
        '--provider',
        'ollama',
        '--approve-network',
        '--execute',
      ]);
      assert.equal(result.code, 6);
      assert.equal(requests, 1);
      const pending = result.events.find(
        (event) => event.type === 'approval-required',
      );
      assert.ok(pending);
      assert.equal(
        pending.disclosure,
        'Approved tool results will be sent to this provider.',
      );
      assert.ok(
        !result.events.some(
          (event) => event.type === 'status' && event.status === 'tool-results',
        ),
      );
    },
  );
});
