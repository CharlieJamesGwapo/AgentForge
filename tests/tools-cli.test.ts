import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject, setConfig } from '../src/core/config.js';
const cliFile = fileURLToPath(new URL('../src/cli/index.ts', import.meta.url));
async function cli(root: string, args: string[], input = '') {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const p = spawn(
        process.execPath,
        ['--import', 'tsx', cliFile, '--cwd', root, ...args],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let stdout = '',
        stderr = '';
      p.stdout.on('data', (c) => {
        stdout += c;
      });
      p.stderr.on('data', (c) => {
        stderr += c;
      });
      p.stdin.end(input);
      p.on('close', (code) => resolve({ code, stdout, stderr }));
    },
  );
}
test('tool CLI lists declarations offline, requires network approval, and never accepts piped execution approval', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentforge-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  let requests = 0;
  const s = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      requests++;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          model: 'fixture',
          done: true,
          done_reason: 'stop',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { function: { name: 'project_summary', arguments: {} } },
            ],
          },
        }),
      );
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => s.close(() => r())));
  const address = s.address();
  assert.ok(address && typeof address === 'object');
  await setConfig(root, 'providers', [
    {
      id: 'ollama',
      model: 'fixture',
      baseUrl: `http://127.0.0.1:${address.port}`,
    },
  ]);
  const listed = await cli(root, ['tools', 'list']);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /project_summary/);
  assert.equal(requests, 0);
  const args = ['tools', 'run', '--task', 'inspect', '--provider', 'ollama'];
  assert.equal((await cli(root, args)).code, 6);
  assert.equal(requests, 0);
  await setConfig(root, 'permissions.allowNetwork', true);
  const pending = await cli(root, [...args, '--approve-network']);
  assert.equal(pending.code, 6, pending.stderr);
  assert.match(pending.stdout, /approval-required/);
  assert.equal(requests, 1);
  assert.equal(
    (await cli(root, [...args, '--approve-network', '--execute'])).code,
    6,
  );
  assert.equal(requests, 1);
  await setConfig(root, 'permissions.allowTools', true);
  const piped = await cli(
    root,
    [...args, '--approve-network', '--execute'],
    'approve anything\n',
  );
  assert.equal(piped.code, 6, piped.stderr);
  assert.match(piped.stdout, /approval-required/);
  assert.equal(requests, 2);
});
