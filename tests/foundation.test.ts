import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  readdir,
  symlink,
  link,
  open,
  mkdir,
  rm,
  writeFile,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  initProject,
  loadConfig,
  setConfig,
  defaultConfig,
} from '../src/core/config.js';
import { safePath, redact } from '../src/shared/safety.js';
import {
  saveCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
  inspectCheckpoint,
} from '../src/core/context.js';
import { readJson, writeJson } from '../src/core/storage.js';

const temp = () => mkdtemp(path.join(tmpdir(), 'agentforge-test-'));

test('init is idempotent, strict config edits preserve other values', async () => {
  const root = await temp();
  assert.equal((await initProject(root)).created, true);
  assert.equal((await initProject(root)).created, false);
  await setConfig(root, 'project', 'custom');
  await setConfig(root, 'workflow.maxIterations', 2);
  assert.equal((await loadConfig(root)).project, 'custom');
  assert.equal((await loadConfig(root)).workflow.maxIterations, 2);
  await assert.rejects(setConfig(root, 'workflow.maxIterations', 999));
  await assert.rejects(setConfig(root, '__proto__.polluted', true));
  const content = await readFile(
    path.join(root, 'agentforge.config.json'),
    'utf8',
  );
  assert.ok(!content.includes('polluted'));
});

test('invalid config is rejected without echoing input credentials', async () => {
  const root = await temp();
  await writeFile(
    path.join(root, 'agentforge.config.json'),
    JSON.stringify({ ...defaultConfig, token: 'private-value' }),
  );
  await assert.rejects(
    loadConfig(root),
    (error: Error) => !error.message.includes('private-value'),
  );
});

test('safe paths reject traversal, absolute paths, and symlink ancestors', async () => {
  const root = await temp();
  const outside = await temp();
  await symlink(outside, path.join(root, 'escape'));
  for (const name of [
    '../file',
    '/tmp/file',
    'escape/file',
    'a/../../file',
    'a\\b',
    '.',
  ]) {
    await assert.rejects(safePath(root, name));
  }
  assert.equal(
    await safePath(root, '.agentforge/checkpoints/test.json'),
    path.join(await realpath(root), '.agentforge/checkpoints/test.json'),
  );
});

test('checkpoint save, preview and explicit restore preserve current config', async () => {
  const root = await temp();
  await initProject(root);
  const saved = await saveCheckpoint(root, {
    name: 'initial',
    objective: 'Implement parser',
    summary: 'api_key=sk-demo-secret',
    decisions: ['JSON'],
    nextSteps: ['Test errors'],
  });
  assert.equal(saved.name, 'initial');
  assert.equal((await listCheckpoints(root)).length, 1);
  assert.ok(
    !(await inspectCheckpoint(root, saved.id)).summary.includes(
      'sk-demo-secret',
    ),
  );
  assert.equal((await restoreCheckpoint(root, saved.id, false)).applied, false);
  await assert.rejects(readFile(path.join(root, '.agentforge/context.json')));
  assert.equal((await restoreCheckpoint(root, saved.id, true)).applied, true);
  const current = JSON.parse(
    await readFile(path.join(root, '.agentforge/context.json'), 'utf8'),
  );
  assert.equal(current.objective, 'Implement parser');
  assert.equal((await loadConfig(root)).project, path.basename(root));
  await assert.rejects(inspectCheckpoint(root, '../escape'));
});

test('corrupted checkpoints fail explicitly and linked config is rejected', async () => {
  const root = await temp();
  await initProject(root);
  await mkdir(path.join(root, '.agentforge/checkpoints'), { recursive: true });
  await writeFile(path.join(root, '.agentforge/checkpoints/broken.json'), '{}');
  await assert.rejects(listCheckpoints(root));
  const other = await temp();
  await symlink(
    path.join(root, 'agentforge.config.json'),
    path.join(other, 'agentforge.config.json'),
  );
  await assert.rejects(loadConfig(other));
});

test('checkpoint inspection rejects a hard link to a file outside the project', async () => {
  const root = await temp();
  await initProject(root);
  const outside = await temp();
  await mkdir(path.join(root, '.agentforge/checkpoints'), { recursive: true });
  const externalFile = path.join(outside, 'checkpoint.json');
  const linkedFile = path.join(
    root,
    '.agentforge/checkpoints/linked-checkpoint.json',
  );
  const checkpoint = {
    schemaVersion: 1,
    id: 'linked-checkpoint',
    name: 'linked',
    createdAt: new Date().toISOString(),
    objective: 'OUTSIDE_INODE_READ',
    summary: 'external checkpoint content',
    decisions: [],
    nextSteps: [],
  };
  await writeFile(externalFile, JSON.stringify(checkpoint));
  await link(externalFile, linkedFile);

  await assert.rejects(inspectCheckpoint(root, 'linked-checkpoint'));
  assert.deepEqual(
    JSON.parse(await readFile(externalFile, 'utf8')),
    checkpoint,
  );
});

test('readJson rejects malformed UTF-8 instead of replacing invalid bytes', async () => {
  const root = await temp();
  await initProject(root);
  const directory = path.join(root, '.agentforge');
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'invalid.json'),
    Buffer.from([
      0x7b, 0x22, 0x6e, 0x61, 0x6d, 0x65, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d,
    ]),
  );

  await assert.rejects(readJson(root, '.agentforge/invalid.json'), /UTF-8/i);
});

test('readJson loops until a regular file has been fully read', async () => {
  const root = await temp();
  await initProject(root);
  const directory = path.join(root, '.agentforge');
  await mkdir(directory, { recursive: true });
  const relative = '.agentforge/chunked.json';
  const file = path.join(root, relative);
  const expected = { message: 'read in short chunks' };
  await writeFile(file, JSON.stringify(expected));

  const probe = await open(file, 'r');
  const prototype = Object.getPrototypeOf(probe) as {
    read: (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => Promise<{ bytesRead: number }>;
  };
  const originalRead = prototype.read;
  await probe.close();
  prototype.read = async function (buffer, offset, length, position) {
    return originalRead.call(
      this,
      buffer,
      offset,
      Math.min(length, 2),
      position,
    );
  };
  try {
    assert.deepEqual(await readJson(root, relative), expected);
  } finally {
    prototype.read = originalRead;
  }
});

test(
  'readJson rejects a FIFO without blocking on open',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await temp();
    try {
      const fifoPath = path.join(root, 'config.json');
      execFileSync('mkfifo', [fifoPath]);

      const storageModule = new URL('../src/core/storage.ts', import.meta.url)
        .href;
      const script = `
        import { readJson } from ${JSON.stringify(storageModule)};
        try {
          await readJson(${JSON.stringify(root)}, 'config.json');
          process.exitCode = 2;
        } catch (error) {
          process.exitCode = error instanceof Error &&
            error.message.startsWith('Expected a single-link JSON file') ? 0 : 3;
        }
      `;
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          killSignal: 'SIGKILL',
          timeout: 1_000,
        },
      );

      assert.equal(
        result.error,
        undefined,
        'FIFO read must finish before timeout',
      );
      assert.equal(
        result.status,
        0,
        result.stderr || 'FIFO should be rejected',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('readJson rejects a file modified while it is being read', async () => {
  const root = await temp();
  await initProject(root);
  const directory = path.join(root, '.agentforge');
  await mkdir(directory, { recursive: true });
  const relative = '.agentforge/racing.json';
  const file = path.join(root, relative);
  await writeFile(file, '{"state":"before"}\n');

  const probe = await open(file, 'r');
  const prototype = Object.getPrototypeOf(probe) as {
    read: (
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => Promise<{ bytesRead: number }>;
  };
  const originalRead = prototype.read;
  await probe.close();
  let modified = false;
  prototype.read = async function (buffer, offset, length, position) {
    const result = await originalRead.call(
      this,
      buffer,
      offset,
      length,
      position,
    );
    if (!modified) {
      modified = true;
      await new Promise((resolve) => setTimeout(resolve, 10));
      await writeFile(file, '{"state":"after!"}\n');
    }
    return result;
  };
  try {
    await assert.rejects(
      readJson(root, relative),
      /changed while it was being read/i,
    );
  } finally {
    prototype.read = originalRead;
  }
});

test('writeJson removes its temporary file after a sync failure and preserves the target', async () => {
  const root = await temp();
  await initProject(root);
  const directory = path.join(root, '.agentforge');
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, 'state.json');
  const original = '{"existing":true}\n';
  await writeFile(target, original);

  const probe = await open(path.join(root, 'sync-probe'), 'w');
  const prototype = Object.getPrototypeOf(probe) as {
    sync: () => Promise<void>;
  };
  const originalSync = prototype.sync;
  await probe.close();
  prototype.sync = async () => {
    throw new Error('injected sync failure');
  };
  try {
    await assert.rejects(
      writeJson(root, '.agentforge/state.json', { replacement: true }),
      /injected sync failure/,
    );
  } finally {
    prototype.sync = originalSync;
  }

  assert.equal(await readFile(target, 'utf8'), original);
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

test('redaction handles credential assignments, bearer headers, private keys and env secrets', () => {
  const previous = process.env.DEMO_API_KEY;
  process.env.DEMO_API_KEY = 'unique-sensitive-value';
  try {
    const redacted = redact(
      'token="abc def" Authorization: Bearer abc.def unique-sensitive-value\n-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
    );
    for (const secret of [
      'abc def',
      'abc.def',
      'unique-sensitive-value',
      '\nsecret\n',
    ])
      assert.ok(!redacted.includes(secret));
  } finally {
    if (previous === undefined) delete process.env.DEMO_API_KEY;
    else process.env.DEMO_API_KEY = previous;
  }
});

test('JSON schema and runtime reject traversal and control characters in configured paths', async () => {
  const root = await temp();
  await initProject(root);
  for (const value of [
    '../escape',
    'a/../escape',
    'a//b',
    'a/./b',
    'a/',
    'a\nb',
    'C:/escape',
  ]) {
    await assert.rejects(setConfig(root, 'skillDirectories', [value]));
  }
});

test('restoring valid JSON with invalid current-context metadata is rejected', async () => {
  const root = await temp();
  await initProject(root);
  await mkdir(path.join(root, '.agentforge'), { recursive: true });
  await writeFile(path.join(root, '.agentforge/context.json'), '{}');
  const { loadCurrentContext } = await import('../src/core/context.js');
  await assert.rejects(loadCurrentContext(root), /Invalid checkpoint metadata/);
});
