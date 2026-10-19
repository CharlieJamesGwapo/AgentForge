import assert from 'node:assert/strict';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { test } from 'node:test';
import { OllamaAdapter } from '../src/adapters/ollama.js';
import { validateProviderOptions } from '../src/adapters/http.js';
import { finishPrompt } from '../src/adapters/output.js';
import { validateToolCalls } from '../src/adapters/tools.js';
import { validateToolResult } from '../src/adapters/tool-results.js';
import {
  defaultConfig,
  initProject,
  validateConfig,
} from '../src/core/config.js';
import { registerOrchestrationCommands } from '../src/cli/orchestrate.js';

const objectSchema = {
  type: 'object',
  properties: { value: { type: 'integer' } },
  required: ['value'],
  additionalProperties: false,
};
const cliPath = fileURLToPath(new URL('../src/cli/index.ts', import.meta.url));

async function runCli(root: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', cliPath, '--cwd', root, '--json', ...args],
        {
          env: { ...process.env, AUDIT_ACCESS_KEY: 'xy' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    },
  );
}

test('provider model validation rejects terminal control characters before trimming', () => {
  for (const control of ['\u0009', '\u001b', '\u007f', '\u0085', '\u009b']) {
    assert.throws(() =>
      validateProviderOptions(
        { model: `model${control}` },
        'https://example.com/v1',
      ),
    );
    assert.throws(() =>
      validateConfig({
        ...defaultConfig,
        providers: [{ id: 'ollama', model: `model${control}` }],
      }),
    );
  }
  assert.equal(
    validateProviderOptions(
      { model: '  selected-model  ' },
      'https://example.com/v1',
    ).model,
    'selected-model',
  );
});

test('checked-in config schema matches runtime model-control validation', async () => {
  const schema = JSON.parse(
    await readFile(
      new URL('../schemas/config.schema.json', import.meta.url),
      'utf8',
    ),
  ) as object;
  const validateSchema = new Ajv2020({ strict: false }).compile(schema);
  for (const control of ['\u0009', '\u001b', '\u007f', '\u0085', '\u009b']) {
    const config = {
      ...defaultConfig,
      providers: [{ id: 'ollama' as const, model: `model${control}` }],
    };
    assert.equal(
      validateSchema(config),
      false,
      `Schema accepted U+${control.codePointAt(0)!.toString(16)}`,
    );
    assert.throws(() => validateConfig(config));
  }

  const config = {
    ...defaultConfig,
    providers: [{ id: 'ollama' as const, model: '  selected-model  ' }],
  };
  assert.equal(validateSchema(config), true);
  assert.equal(validateConfig(config).providers[0]?.model, 'selected-model');
});

test('typed final output withholds a numeric leaf equal to the credential', () => {
  assert.throws(
    () =>
      finishPrompt(
        {
          text: '{"value":1234}',
          model: 'fixture',
          finishReason: 'completed',
          usage: { status: 'unavailable' },
        },
        {
          prompt: 'task',
          approved: false,
          timeoutMs: 1,
          responseSchema: objectSchema,
        },
        '1234',
      ),
    { code: 'validation' },
  );
});

test('typed tool result withholds a numeric leaf equal to the credential', () => {
  assert.throws(
    () =>
      validateToolResult(
        { callId: 'one', output: '{"value":1234}' },
        objectSchema,
        ['1234'],
      ),
    { code: 'validation' },
  );
});

test('tool calls with credential-bearing property names are withheld before approval', () => {
  assert.throws(
    () =>
      validateToolCalls(
        [
          {
            name: 'inspect',
            description: 'Inspect data',
            parameters: {
              type: 'object',
              properties: { 'field-xy': { type: 'string' } },
              required: ['field-xy'],
              additionalProperties: false,
            },
          },
        ],
        [
          {
            id: 'one',
            name: 'inspect',
            arguments: { 'field-xy': 'ordinary value' },
          },
        ],
        'xy',
      ),
    { code: 'validation' },
  );
});

test('Ollama connection diagnostics redact the configured short credential from the model name', async (t) => {
  const oldValue = process.env.AUDIT_ACCESS_KEY;
  process.env.AUDIT_ACCESS_KEY = 'xy';
  t.after(() => {
    if (oldValue === undefined) delete process.env.AUDIT_ACCESS_KEY;
    else process.env.AUDIT_ACCESS_KEY = oldValue;
  });
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ models: [{ name: 'model-xy' }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const health = await new OllamaAdapter({
    model: 'model-xy',
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKeyEnv: 'AUDIT_ACCESS_KEY',
  }).checkConnection!({ approved: true, timeoutMs: 1000 });
  assert.equal(requests, 1);
  assert.equal(health.status, 'available');
  assert.ok(!health.detail.includes('xy'));
  assert.match(health.detail, /\[REDACTED\]/);
});

test('orchestration CLI rejects a terminal-control model override before HTTP or approval display', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentforge-model-control-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config: initial } = await initProject(root);
  const server = createServer((_request, response) => {
    requests++;
    response.statusCode = 503;
    response.end();
  });
  let requests = 0;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const config = {
    ...initial,
    providers: [
      {
        id: 'ollama' as const,
        model: 'provider-default',
        baseUrl: `http://127.0.0.1:${address.port}`,
      },
    ],
    permissions: {
      ...initial.permissions,
      allowNetwork: true,
      allowTools: true,
    },
    orchestration: {
      ...initial.orchestration,
      enabled: true,
      planner: { provider: 'ollama', model: 'planner-model' },
      executor: { provider: 'ollama', model: 'executor-model' },
    },
  };
  await writeFile(
    path.join(root, 'agentforge.config.json'),
    JSON.stringify(config),
  );

  const program = new Command().exitOverride();
  registerOrchestrationCommands(program, root, new AbortController().signal);
  const originalLog = console.log;
  const originalInput = Object.getOwnPropertyDescriptor(process, 'stdin');
  const originalError = Object.getOwnPropertyDescriptor(process, 'stderr');
  const originalExitCode = process.exitCode;
  const input = new PassThrough();
  const error = new PassThrough();
  Object.defineProperty(input, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(error, 'isTTY', { configurable: true, value: true });
  let terminal = '';
  let output = '';
  error.on('data', (chunk: Buffer) => {
    terminal += chunk.toString('utf8');
  });
  console.log = (line?: unknown) => {
    output += String(line ?? '') + '\n';
  };
  Object.defineProperty(process, 'stdin', { configurable: true, value: input });
  Object.defineProperty(process, 'stderr', {
    configurable: true,
    value: error,
  });
  process.exitCode = 0;
  try {
    await program.parseAsync([
      'node',
      'agentforge',
      'orchestrate',
      'run',
      '--task',
      'Inspect the project',
      '--approve-network',
      '--execute',
      '--executor-model',
      'executor\u001b[2J\u009b31mFAKE APPROVAL',
    ]);
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
    if (originalInput) Object.defineProperty(process, 'stdin', originalInput);
    if (originalError) Object.defineProperty(process, 'stderr', originalError);
    input.destroy();
    error.destroy();
  }
  assert.equal(requests, 0);
  assert.ok(!terminal.includes('Type approve '));
  assert.ok(!terminal.includes('\u001b'));
  assert.ok(!terminal.includes('FAKE APPROVAL'));
  assert.ok(!output.includes('\u001b'));
  assert.ok(!output.includes('FAKE APPROVAL'));
});

test('config and orchestration status redact credentials referenced by configured providers', async (t) => {
  const root = await mkdtemp(
    path.join(tmpdir(), 'agentforge-config-redaction-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config: initial } = await initProject(root);
  const config = {
    ...initial,
    providers: [
      {
        id: 'ollama' as const,
        model: 'model-xy',
        apiKeyEnv: 'AUDIT_ACCESS_KEY',
      },
    ],
    orchestration: {
      ...initial.orchestration,
      planner: { provider: 'ollama', model: 'planner-xy' },
      executor: { provider: 'ollama', model: 'executor-xy' },
    },
  };
  await writeFile(
    path.join(root, 'agentforge.config.json'),
    JSON.stringify(config),
  );

  const status = await runCli(root, ['orchestrate', 'status']);
  const displayedConfig = await runCli(root, ['config']);
  const projectStatus = await runCli(root, ['status']);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(displayedConfig.code, 0, displayedConfig.stderr);
  assert.equal(projectStatus.code, 0, projectStatus.stderr);
  assert.ok(!status.stdout.includes('xy'));
  assert.ok(!displayedConfig.stdout.includes('xy'));
  assert.ok(!projectStatus.stdout.includes('xy'));
  assert.match(status.stdout, /\[REDACTED\]/);
  assert.match(displayedConfig.stdout, /\[REDACTED\]/);
  assert.match(projectStatus.stdout, /\[REDACTED\]/);
});
