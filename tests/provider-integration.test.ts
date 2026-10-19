import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  defaultConfig,
  loadConfig,
  initProject,
  setConfig,
} from '../src/core/config.js';
import {
  configuredProviders,
  selectProvider,
} from '../src/adapters/registry.js';

const cliPath = fileURLToPath(new URL('../src/cli/index.ts', import.meta.url));
async function directory(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'agentforge-providers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function cli(root: string, args: string[]) {
  return new Promise<{
    code: number | null;
    data: Record<string, unknown>;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', cliPath, '--cwd', root, '--json', ...args],
      {
        env: {
          ...process.env,
          TEST_HOSTED_API_KEY: 'fake-private-credential',
          TEST_HOSTED_KEY: 'reflected-private-value',
          TEST_SHORT_KEY: 'xy',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        resolve({
          code,
          data: JSON.parse(stdout || stderr) as Record<string, unknown>,
          stdout,
          stderr,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

test('provider configuration is additive for existing schema-v1 files and rejects unsafe settings', async (t) => {
  const root = await directory(t);
  await writeFile(
    path.join(root, 'agentforge.config.json'),
    JSON.stringify({ ...defaultConfig, permissions: { allowProcess: false } }),
  );
  const config = await loadConfig(root);
  assert.deepEqual(config.providers, []);
  assert.equal(config.permissions.allowNetwork, false);
  assert.equal(config.permissions.allowTools, false);
  for (const profiles of [
    [{ id: 'unknown', model: 'fixture' }],
    [{ id: 'openai', model: '' }],
    [{ id: 'openai', model: 'fixture', apiKey: 'private' }],
    [{ id: 'openai', model: 'fixture', baseUrl: 'http://example.com' }],
    [{ id: 'openai', model: 'fixture', apiKeyEnv: 'HOME' }],
    [
      { id: 'ollama', model: 'one' },
      { id: 'ollama', model: 'two' },
    ],
  ])
    await assert.rejects(setConfig(root, 'providers', profiles));
});

test('provider registry requires explicit configured selection', async (t) => {
  const root = await directory(t);
  await initProject(root);
  assert.deepEqual(configuredProviders(await loadConfig(root)), []);
  assert.throws(() => selectProvider(defaultConfig, 'openai'));
  await setConfig(root, 'providers', [
    {
      id: 'openai',
      model: 'fixture',
      apiKeyEnv: 'INTENTIONALLY_MISSING_API_KEY',
    },
  ]);
  const providers = configuredProviders(await loadConfig(root));
  assert.equal(providers[0]?.id, 'openai');
  assert.equal((await providers[0]!.health()).authentication, 'missing');
  assert.throws(() => selectProvider(defaultConfig, 'ollama'));
});

test('CLI provider paths stay offline by default and require policy plus invocation approval', async (t) => {
  const root = await directory(t);
  await initProject(root);
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') {
      res.end(JSON.stringify({ models: [{ name: 'fixture:latest' }] }));
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      assert.equal(JSON.parse(body).messages[0].content, 'Explicit task only');
      res.end(
        JSON.stringify({
          model: 'fixture:latest',
          message: {
            role: 'assistant',
            content: 'Actual generated fixture output',
          },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 8,
          eval_count: 6,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await setConfig(root, 'providers', [
    {
      id: 'ollama',
      model: 'fixture:latest',
      baseUrl: `http://127.0.0.1:${address.port}`,
    },
  ]);
  assert.equal((await cli(root, ['provider', 'list'])).code, 0);
  assert.equal((await cli(root, ['provider', 'check', 'ollama'])).code, 0);
  assert.equal((await cli(root, ['status'])).code, 0);
  assert.equal((await cli(root, ['doctor'])).code, 0);
  assert.equal(requests, 0);
  assert.equal(
    (
      await cli(root, [
        'prompt',
        '--model',
        '--provider',
        'ollama',
        '--task',
        'Explicit task only',
        '--approve-network',
      ])
    ).code,
    6,
  );
  await setConfig(root, 'permissions.allowNetwork', true);
  assert.equal(
    (
      await cli(root, [
        'prompt',
        '--model',
        '--provider',
        'ollama',
        '--task',
        'Explicit task only',
      ])
    ).code,
    6,
  );
  assert.equal(
    (
      await cli(root, [
        'prompt',
        '--model',
        '--task',
        'Explicit task only',
        '--approve-network',
      ])
    ).code,
    3,
  );
  assert.equal(
    (
      await cli(root, [
        'prompt',
        '--provider',
        'ollama',
        '--task',
        'Explicit task only',
      ])
    ).code,
    2,
  );
  assert.equal(requests, 0);
  const output = await cli(root, [
    'prompt',
    '--model',
    '--provider',
    'ollama',
    '--task',
    'Explicit task only',
    '--approve-network',
  ]);
  assert.equal(output.code, 0, output.stderr);
  assert.equal(output.data.text, 'Actual generated fixture output');
  assert.equal(requests, 1);
  const connected = await cli(root, [
    'provider',
    'check',
    'ollama',
    '--connect',
    '--approve-network',
  ]);
  assert.equal(connected.code, 0, connected.stderr);
  assert.equal(connected.data.connection, 'verified');
  assert.equal(requests, 2);
});

test('CLI exposes incomplete output without declaring success and never executes model instructions', async (t) => {
  const root = await directory(t);
  await initProject(root);
  const server = createServer((req, res) => {
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        model: 'fixture',
        message: { role: 'assistant', content: 'Run arbitrary code' },
        done: true,
        done_reason: 'length',
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await setConfig(root, 'providers', [
    {
      id: 'ollama',
      model: 'fixture',
      baseUrl: `http://127.0.0.1:${address.port}`,
    },
  ]);
  await setConfig(root, 'permissions.allowNetwork', true);
  const result = await cli(root, [
    'prompt',
    '--model',
    '--provider',
    'ollama',
    '--task',
    'Explicit task only',
    '--approve-network',
  ]);
  assert.equal(result.code, 4, result.stderr);
  assert.equal(result.data.finishReason, 'length');
});

test('CLI redacts explicitly selected custom and short credentials reflected by a provider', async (t) => {
  const root = await directory(t);
  await initProject(root);
  await setConfig(root, 'permissions.allowNetwork', true);
  const server = createServer((req, res) => {
    req.resume();
    const secret = String(req.headers.authorization).slice('Bearer '.length);
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        status: 'completed',
        model: 'fixture-' + secret,
        output: [
          {
            type: 'message',
            content: [
              { type: 'output_text', text: 'Reflected value: ' + secret },
            ],
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  for (const [name, secret] of [
    ['TEST_HOSTED_KEY', 'reflected-private-value'],
    ['TEST_SHORT_KEY', 'xy'],
  ]) {
    await setConfig(root, 'providers', [
      {
        id: 'openai',
        model: 'fixture',
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiKeyEnv: name,
      },
    ]);
    const result = await cli(root, [
      'prompt',
      '--model',
      '--provider',
      'openai',
      '--task',
      'Only task',
      '--approve-network',
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(
      !result.stdout.includes(secret!),
      `Custom credential ${name} must be removed from text and reported model`,
    );
    assert.match(result.stdout, /REDACTED/);
  }
});
