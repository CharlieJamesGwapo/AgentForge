import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject, setConfig } from '../src/core/config.js';
const entry = fileURLToPath(new URL('../src/cli/index.ts', import.meta.url));
const args = [
  'tools',
  'run',
  '--provider',
  'ollama',
  '--task',
  'Inspect',
  '--approve-network',
  '--stream',
  '--timeout-ms',
  '2000',
  '--execute',
];
test('CLI streams text while tool calls remain private until terminal validation and explicit approval', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentforge-stream-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  let finish: () => void = () => {};
  let requests = 0;
  let body: Record<string, unknown> = {};
  const s = createServer((req, res) => {
    let input = '';
    req.on('data', (c) => (input += c));
    req.on('end', () => {
      requests++;
      body = JSON.parse(input);
      res.setHeader('content-type', 'application/x-ndjson');
      res.write(
        JSON.stringify({
          model: 'fixture',
          message: { role: 'assistant', content: 'Progress\n' },
          done: false,
        }) + '\n',
      );
      res.write(
        JSON.stringify({
          model: 'fixture',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { function: { name: 'project_summary', arguments: {} } },
            ],
          },
          done: false,
        }) + '\n',
      );
      finish = () =>
        res.end(
          JSON.stringify({
            model: 'fixture',
            message: { role: 'assistant', content: '' },
            done: true,
            done_reason: 'stop',
          }) + '\n',
        );
    });
  });
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    s.closeAllConnections();
    s.close();
  });
  const address = s.address();
  assert.ok(address && typeof address === 'object');
  await setConfig(root, 'providers', [
    {
      id: 'ollama',
      model: 'fixture',
      baseUrl: `http://127.0.0.1:${address.port}`,
    },
  ]);
  await setConfig(root, 'permissions.allowNetwork', true);
  await setConfig(root, 'permissions.allowTools', true);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', entry, '--cwd', root, ...args],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  t.after(() => child.kill());
  child.stdin.end('approve anything\n');
  let stdout = '',
    stderr = '';
  let observed = false;
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (!observed && stdout.includes('text-delta')) {
      observed = true;
      assert.ok(!stdout.includes('project_summary'));
      assert.ok(!stdout.includes('approval-required'));
      finish();
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve) =>
    child.on('close', resolve),
  );
  assert.equal(code, 6, stderr);
  assert.equal(observed, true);
  assert.equal(requests, 1);
  assert.equal(body.stream, true);
  assert.match(stdout, /approval-required/);
});
test('CLI rejects a truncated tool stream without emitting approval or executable calls', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentforge-stream-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const s = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/x-ndjson');
      res.end(
        JSON.stringify({
          model: 'fixture',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { function: { name: 'project_summary', arguments: {} } },
            ],
          },
          done: false,
        }) + '\n',
      );
    });
  });
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    s.closeAllConnections();
    s.close();
  });
  const address = s.address();
  assert.ok(address && typeof address === 'object');
  await setConfig(root, 'providers', [
    {
      id: 'ollama',
      model: 'fixture',
      baseUrl: `http://127.0.0.1:${address.port}`,
    },
  ]);
  await setConfig(root, 'permissions.allowNetwork', true);
  await setConfig(root, 'permissions.allowTools', true);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', entry, '--cwd', root, ...args],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  const code = await new Promise<number | null>((resolve) =>
    child.on('close', resolve),
  );
  assert.equal(code, 1, stderr);
  assert.ok(!stdout.includes('approval-required'));
  assert.ok(!stdout.includes('project_summary'));
});
