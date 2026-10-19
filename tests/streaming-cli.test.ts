import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject, setConfig } from '../src/core/config.js';
const executable = fileURLToPath(
  new URL('../src/cli/index.ts', import.meta.url),
);
const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};
async function cli(root: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const p = spawn(
        process.execPath,
        ['--import', 'tsx', executable, '--cwd', root, '--json', ...args],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '',
        stderr = '';
      p.stdout.on('data', (x: Buffer) => (stdout += x.toString()));
      p.stderr.on('data', (x: Buffer) => (stderr += x.toString()));
      p.on('error', reject);
      p.on('close', (code) => resolve({ code, stdout, stderr }));
    },
  );
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'agentforge-stream-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const bodies: Record<string, unknown>[] = [];
  const s = createServer((req, res) => {
    let body = '';
    req.on('data', (x: Buffer) => (body += x.toString()));
    req.on('end', () => {
      const data = JSON.parse(body) as Record<string, unknown>;
      bodies.push(data);
      const text = JSON.stringify({ answer: 'validated' });
      if (data.stream) {
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.write(
          JSON.stringify({
            model: 'fixture',
            message: { role: 'assistant', content: text.slice(0, 6) },
            done: false,
          }) + '\n',
        );
        res.end(
          JSON.stringify({
            model: 'fixture',
            message: { role: 'assistant', content: text.slice(6) },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 2,
            eval_count: 3,
          }) + '\n',
        );
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            model: 'fixture',
            message: { role: 'assistant', content: text },
            done: true,
            done_reason: 'stop',
          }),
        );
      }
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
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
  return { root, bodies };
}
test('CLI requests and validates structured output in ordinary and streaming modes', async (t) => {
  const { root, bodies } = await fixture(t);
  await writeFile(
    path.join(root, 'answer.schema.json'),
    JSON.stringify(schema),
  );
  for (const stream of [false, true]) {
    const result = await cli(root, [
      'prompt',
      '--model',
      '--provider',
      'ollama',
      '--task',
      'Explicit text',
      '--schema',
      'answer.schema.json',
      '--approve-network',
      ...(stream ? ['--stream'] : []),
    ]);
    assert.equal(result.code, 0, result.stderr);
    const data = stream
      ? JSON.parse(result.stdout.trim()).result
      : JSON.parse(result.stdout);
    assert.deepEqual(data.structured, {
      status: 'valid',
      data: { answer: 'validated' },
    });
    assert.deepEqual(bodies.at(-1)?.format, schema);
  }
});
test('invalid/unsafe schemas and incompatible local flags fail before requests', async (t) => {
  const { root, bodies } = await fixture(t);
  await writeFile(
    path.join(root, 'bad.json'),
    JSON.stringify({ ...schema, $ref: 'https://untrusted.example' }),
  );
  for (const args of [
    ['prompt', '--task', 'local', '--stream'],
    ['prompt', '--task', 'local', '--schema', 'bad.json'],
    [
      'prompt',
      '--model',
      '--provider',
      'ollama',
      '--task',
      'x',
      '--schema',
      'bad.json',
      '--approve-network',
    ],
    [
      'prompt',
      '--model',
      '--provider',
      'ollama',
      '--task',
      'x',
      '--schema',
      '../escape.json',
      '--approve-network',
    ],
  ]) {
    const output = await cli(root, args);
    assert.ok([2, 6].includes(output.code ?? -1), output.stderr);
  }
  assert.equal(bodies.length, 0);
});
