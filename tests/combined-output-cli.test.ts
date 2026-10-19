import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { initProject, setConfig } from '../src/core/config.js';
const entry = fileURLToPath(new URL('../src/cli/index.ts', import.meta.url));
const schema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};
const args = [
  'tools',
  'run',
  '--provider',
  'ollama',
  '--task',
  'Inspect',
  '--approve-network',
  '--schema',
  'answer.json',
  '--timeout-ms',
  '2000',
];
async function cli(root: string, options: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      const p = spawn(
        process.execPath,
        ['--import', 'tsx', entry, '--cwd', root, ...options],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '',
        stderr = '';
      p.stdout.on('data', (x) => (stdout += x));
      p.stderr.on('data', (x) => (stderr += x));
      p.on('close', (code) => resolve({ code, stdout, stderr }));
    },
  );
}
async function fixture(
  t: TestContext,
  respond: (body: Record<string, unknown>, res: ServerResponse) => void,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'agentforge-combined-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  await writeFile(path.join(root, 'answer.json'), JSON.stringify(schema));
  let count = 0;
  const s = createServer((req, res) => {
    let input = '';
    req.on('data', (x) => (input += x));
    req.on('end', () => {
      count++;
      respond(JSON.parse(input), res);
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
  return { root, count: () => count };
}
function respond(
  res: ServerResponse,
  body: Record<string, unknown>,
  text: string,
  reason = 'stop',
) {
  const native = {
    model: 'fixture',
    done: true,
    done_reason: reason,
    message: { role: 'assistant', content: text },
  };
  if (body.stream) {
    res.setHeader('content-type', 'application/x-ndjson');
    res.write(
      JSON.stringify({
        ...native,
        done: false,
        done_reason: undefined,
        message: { role: 'assistant', content: text.slice(0, 2) },
      }) + '\n',
    );
    res.end(
      JSON.stringify({
        ...native,
        message: { role: 'assistant', content: text.slice(2) },
      }) + '\n',
    );
  } else {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(native));
  }
}
test('CLI combined schemas validate direct finals in both modes and hide JSON deltas', async (t) => {
  const f = await fixture(t, (body, res) => {
    assert.deepEqual(body.format, schema);
    assert.ok(Array.isArray(body.tools));
    respond(res, body, '{\n"answer":"validated"}');
  });
  for (const stream of [false, true]) {
    const result = await cli(f.root, [
      ...args,
      ...(stream ? ['--stream'] : []),
    ]);
    assert.equal(result.code, 0, result.stderr);
    const events = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(events.every((event) => event.type !== 'text-delta'));
    assert.deepEqual(events.at(-1)?.turn.structured, {
      status: 'valid',
      data: { answer: 'validated' },
    });
  }
});
test('CLI invalid/unsafe schemas fail before provider requests', async (t) => {
  const f = await fixture(t, () => assert.fail('No request expected'));
  await writeFile(
    path.join(f.root, 'answer.json'),
    JSON.stringify({ ...schema, $ref: 'https://untrusted.invalid' }),
  );
  assert.equal((await cli(f.root, args)).code, 2);
  for (const name of ['../outside.json', path.join(f.root, 'answer.json')]) {
    const options = [...args];
    options[options.indexOf('answer.json')] = name;
    assert.equal((await cli(f.root, options)).code, 6);
  }
  await symlink('answer.json', path.join(f.root, 'linked.json'));
  const linked = [...args];
  linked[linked.indexOf('answer.json')] = 'linked.json';
  assert.equal((await cli(f.root, linked)).code, 6);
  assert.equal(f.count(), 0);
});
test('CLI invalid structured final exits 4 without leaking payload or provisional data', async (t) => {
  const f = await fixture(t, (body, res) =>
    respond(res, body, '{\n"answer":5,"private":"omit-this-payload"}'),
  );
  for (const stream of [false, true]) {
    const result = await cli(f.root, [
      ...args,
      ...(stream ? ['--stream'] : []),
    ]);
    assert.equal(result.code, 4, result.stderr);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes('omit-this-payload'));
  }
});
test('CLI combined refusal and length return unavailable with exit 4', async (t) => {
  for (const reason of ['refusal', 'length']) {
    const f = await fixture(t, (body, res) =>
      respond(res, body, 'not complete JSON', reason),
    );
    for (const stream of [false, true]) {
      const result = await cli(f.root, [
        ...args,
        ...(stream ? ['--stream'] : []),
      ]);
      assert.equal(result.code, 4, result.stderr);
      const final = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
      assert.deepEqual(final.turn.structured, {
        status: 'unavailable',
        reason,
      });
    }
  }
});
