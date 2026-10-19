import assert from 'node:assert/strict';
import {
  link,
  mkdtemp,
  mkdir,
  open,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { scanRepository } from '../src/engines/graph.js';

async function makeRepository(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentforge-graph-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('scanRepository respects ignore rules, skips secrets and symlinks, and resolves local imports', async (t) => {
  const root = await makeRepository(t);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'ignored'), { recursive: true });
  await mkdir(path.join(root, 'nested'), { recursive: true });
  const outside = await mkdtemp(
    path.join(os.tmpdir(), 'agentforge-graph-link-'),
  );
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(root, '.gitignore'), 'ignored/\n*.secret.ts\n');
  await writeFile(path.join(root, 'nested', '.gitignore'), 'skip.ts\n');
  await writeFile(
    path.join(root, 'src', 'main.ts'),
    "import { helper } from './helper.js';\nexport { shared } from '../shared';\nimport 'external-package';\n",
  );
  await writeFile(
    path.join(root, 'src', 'helper.ts'),
    'export const helper = 1;\n',
  );
  await writeFile(path.join(root, 'shared.ts'), 'export const shared = 2;\n');
  await writeFile(
    path.join(root, 'ignored', 'hidden.ts'),
    'export const hidden = 0;\n',
  );
  await writeFile(
    path.join(root, 'nested', 'skip.ts'),
    'export const ignored = 0;\n',
  );
  await writeFile(
    path.join(root, 'nested', 'keep.ts'),
    'export const kept = 1;\n',
  );
  await writeFile(
    path.join(root, 'credential.secret.ts'),
    'const credential = "do-not-report";\n',
  );
  await writeFile(path.join(root, '.env.local'), 'API_KEY=do-not-report\n');
  await writeFile(
    path.join(outside, 'linked.ts'),
    'export const outside = 0;\n',
  );
  await symlink(outside, path.join(root, 'src', 'linked'), 'dir');

  const result = await scanRepository(root);

  assert.ok(result.files.includes('src/main.ts'));
  assert.ok(result.files.includes('nested/keep.ts'));
  assert.deepEqual(
    result.files.filter((file) =>
      /ignored|skip\.ts|secret|\.env|linked/.test(file),
    ),
    [],
  );
  assert.deepEqual(result.edges, [
    { from: 'src/main.ts', to: 'shared.ts', specifier: '../shared' },
    { from: 'src/main.ts', to: 'src/helper.ts', specifier: './helper.js' },
  ]);
  assert.ok(!JSON.stringify(result).includes('do-not-report'));
  assert.equal(result.truncated, false);
});

test('scanRepository reports when maxFiles bounds the scan', async (t) => {
  const root = await makeRepository(t);
  for (const name of ['a.ts', 'b.ts', 'c.ts']) {
    await writeFile(path.join(root, name), 'export {};\n');
  }

  const result = await scanRepository(root, { maxFiles: 2 });

  assert.equal(result.files.length, 2);
  assert.equal(result.truncated, true);
  assert.ok(result.limitations.length > 0);
});

test('scanRepository reports when its directory depth bound stops traversal', async (t) => {
  const root = await makeRepository(t);
  const segments = Array.from({ length: 102 }, (_, index) => `d${index}`);
  const deepDirectory = path.join(root, ...segments);
  await mkdir(deepDirectory, { recursive: true });
  await writeFile(path.join(deepDirectory, 'deep.ts'), 'export {};\n');

  const result = await scanRepository(root);

  assert.equal(result.truncated, true);
  assert.ok(
    result.limitations.some((limitation) => /depth limit/.test(limitation)),
  );
  assert.ok(!result.files.includes(`${segments.join('/')}/deep.ts`));
});

test('scanRepository loops until source files have been fully read', async (t) => {
  const root = await makeRepository(t);
  await writeFile(path.join(root, 'main.ts'), "import './helper.js';\n");
  await writeFile(path.join(root, 'helper.ts'), 'export const helper = 1;\n');

  const probe = await open(path.join(root, 'main.ts'), 'r');
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
  prototype.read = function (buffer, offset, length, position) {
    return originalRead.call(
      this,
      buffer,
      offset,
      Math.min(length, 2),
      position,
    );
  };
  try {
    const result = await scanRepository(root);
    assert.deepEqual(result.edges, [
      { from: 'main.ts', to: 'helper.ts', specifier: './helper.js' },
    ]);
    assert.equal(result.truncated, false);
  } finally {
    prototype.read = originalRead;
  }
});

test('scanRepository skips source files hard-linked from outside the root', async (t) => {
  const root = await makeRepository(t);
  const outside = await mkdtemp(
    path.join(os.tmpdir(), 'agentforge-graph-hardlink-'),
  );
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(root, 'target.ts'), 'export const target = 1;\n');
  await writeFile(
    path.join(outside, 'outside.ts'),
    "import './target.js';\nexport const outside = 1;\n",
  );
  await link(path.join(outside, 'outside.ts'), path.join(root, 'linked.ts'));

  const result = await scanRepository(root);

  assert.deepEqual(result.edges, []);
  assert.equal(result.truncated, true);
});

test('nested gitignore negations override parent ignore rules', async (t) => {
  const root = await makeRepository(t);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, '.gitignore'), '*.ts\n');
  await writeFile(path.join(root, 'src', '.gitignore'), '!keep.ts\n');
  await writeFile(path.join(root, 'src', 'keep.ts'), 'export {};\n');
  await writeFile(path.join(root, 'src', 'skip.ts'), 'export {};\n');

  const result = await scanRepository(root);

  assert.ok(result.files.includes('src/keep.ts'));
  assert.ok(!result.files.includes('src/skip.ts'));
});
