import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { initProject, setConfig } from '../src/core/config.js';
const entry = fileURLToPath(new URL('../src/cli/index.ts', import.meta.url));
async function cli(root: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', entry, '--cwd', root, ...args],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (x) => (stdout += x));
      child.stderr.on('data', (x) => (stderr += x));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    },
  );
}
test('CLI result schema input is safe, validated before requests and independent from final schemas', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agentforge-result-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  await setConfig(root, 'permissions.allowNetwork', true);
  let requests = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests++;
      const body = JSON.parse(raw);
      assert.ok(!raw.includes('local-only-contract'));
      assert.ok(!raw.includes('resultSchema'));
      assert.equal(body.format, undefined);
      const value = {
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
      };
      if (body.stream) {
        res.setHeader('content-type', 'application/x-ndjson');
        res.end(JSON.stringify(value) + '\n');
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(value));
      }
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
      model: 'fixture',
      baseUrl: `http://127.0.0.1:${address.port}`,
    },
  ]);
  const base = [
    'tools',
    'run',
    '--provider',
    'ollama',
    '--task',
    'inspect',
    '--approve-network',
    '--result-schemas',
  ];
  for (const value of [
    null,
    [],
    {},
    { unknown: { type: 'null' } },
    { project_summary: { type: 'string', pattern: '.*' } },
  ]) {
    await writeFile(path.join(root, 'results.json'), JSON.stringify(value));
    assert.equal((await cli(root, [...base, 'results.json'])).code, 2);
  }
  assert.equal((await cli(root, [...base, 'missing.json'])).code, 2);
  for (const name of ['../outside.json', path.join(root, 'results.json')])
    assert.equal((await cli(root, [...base, name])).code, 6);
  await symlink('results.json', path.join(root, 'link.json'));
  assert.equal((await cli(root, [...base, 'link.json'])).code, 6);
  assert.equal(requests, 0);
  const contract = { type: 'null', description: 'local-only-contract' };
  await writeFile(
    path.join(root, 'results.json'),
    JSON.stringify({ project_summary: contract }),
  );
  const listed = await cli(root, ['tools', 'list']);
  assert.equal(listed.code, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).tools[0].resultSchema.type, 'object');
  for (const stream of [false, true]) {
    const result = await cli(root, [
      ...base,
      'results.json',
      ...(stream ? ['--stream'] : []),
    ]);
    assert.equal(result.code, 6, result.stderr);
    const approval = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((event) => event.type === 'approval-required');
    assert.deepEqual(approval.review[0].resultSchema, contract);
    assert.ok(!result.stdout.includes('tool-results'));
  }
  assert.equal(requests, 2);
});
