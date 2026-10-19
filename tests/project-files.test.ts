import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { ProviderError } from '../src/adapters/errors.js';
import {
  parseReadArguments,
  parseSearchArguments,
  readProjectFile,
  searchProjectFiles,
} from '../src/engines/project-files.js';

const execFileAsync = promisify(execFile);

async function makeProject(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), 'agentforge-project-files-'),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function searchArgs(
  overrides: Partial<{
    query: unknown;
    mode: unknown;
    directory: unknown;
    maxResults: unknown;
  }> = {},
): Record<string, unknown> {
  return {
    query: 'needle',
    mode: 'content',
    directory: '.',
    maxResults: 20,
    ...overrides,
  };
}

function readArgs(
  overrides: Partial<{
    path: unknown;
    startLine: unknown;
    lineCount: unknown;
  }> = {},
): Record<string, unknown> {
  return { path: 'src/file.txt', startLine: 1, lineCount: 20, ...overrides };
}

function hasCode(code: ProviderError['code']) {
  return (error: unknown): boolean =>
    error instanceof ProviderError && error.code === code;
}

function abortAfterChecks(limit: number): AbortSignal {
  const controller = new AbortController();
  let checks = 0;
  return new Proxy(controller.signal, {
    get(target, property) {
      if (property === 'aborted') {
        checks += 1;
        return checks >= limit;
      }
      return Reflect.get(target, property, target);
    },
  });
}

test('argument parsers require exact fields and reject malformed values without coercion', () => {
  assert.deepEqual(parseSearchArguments(searchArgs()), {
    query: 'needle',
    mode: 'content',
    directory: '.',
    maxResults: 20,
  });
  assert.deepEqual(parseReadArguments(readArgs()), {
    path: 'src/file.txt',
    startLine: 1,
    lineCount: 20,
  });

  for (const args of [
    null,
    [],
    { ...searchArgs(), extra: true },
    { query: 'needle', mode: 'content', directory: '.' },
    searchArgs({ query: 7 }),
    searchArgs({ query: '' }),
    searchArgs({ query: 'x'.repeat(201) }),
    searchArgs({ query: '🙂'.repeat(51) }),
    searchArgs({ query: 'line\nbreak' }),
    searchArgs({ mode: 'regex' }),
    searchArgs({ directory: 7 }),
    searchArgs({ maxResults: '20' }),
    searchArgs({ maxResults: 0 }),
    searchArgs({ maxResults: 101 }),
    { ...readArgs(), extra: true },
    { path: 'src/file.txt', startLine: 1 },
    readArgs({ path: 3 }),
    readArgs({ startLine: '1' }),
    readArgs({ startLine: 0 }),
    readArgs({ startLine: 1_000_001 }),
    readArgs({ lineCount: 201 }),
  ]) {
    assert.throws(
      () => parseSearchArguments(args as Record<string, unknown>),
      hasCode('validation'),
    );
  }
  assert.throws(
    () => parseReadArguments({ ...readArgs(), extra: true }),
    hasCode('validation'),
  );
  assert.throws(
    () => parseReadArguments({ path: 'src/file.txt', startLine: 1 }),
    hasCode('validation'),
  );
  assert.throws(
    () => parseReadArguments(readArgs({ path: 3 })),
    hasCode('validation'),
  );
  assert.throws(
    () => parseReadArguments(readArgs({ startLine: '1' })),
    hasCode('validation'),
  );
  assert.throws(
    () => parseReadArguments(readArgs({ startLine: 0 })),
    hasCode('validation'),
  );
  assert.throws(
    () => parseReadArguments(readArgs({ startLine: 1_000_001 })),
    hasCode('validation'),
  );
  assert.throws(
    () => parseReadArguments(readArgs({ lineCount: 201 })),
    hasCode('validation'),
  );
});

test('argument parsers reject unsafe relative paths and blocked names as policy errors', () => {
  for (const directory of ['../outside', '/etc', 'src/../other', 'C:\\temp']) {
    assert.throws(
      () => parseSearchArguments(searchArgs({ directory })),
      hasCode('policy'),
    );
  }
  for (const filePath of [
    '.',
    '../outside.txt',
    '/etc/passwd',
    'src/../outside.txt',
    'src/file:stream',
    '.env',
    'config/.env.local',
    '.GIT/config',
    'node_modules/pkg/index.js',
    'credentials/credentials.json',
    'backup/credentials',
    'backup/credentials.json',
    'certs/private.PEM',
  ]) {
    assert.throws(
      () => parseReadArguments(readArgs({ path: filePath })),
      hasCode('policy'),
    );
  }
});

test('search is literal, case-sensitive, sorted, and returns one hit per matching line', async (t) => {
  const root = await makeProject(t);
  await mkdir(path.join(root, 'src', 'z'), { recursive: true });
  await mkdir(path.join(root, 'src', 'a'), { recursive: true });
  await writeFile(
    path.join(root, 'src', 'z', 'b.txt'),
    'needle\nNeedle\nneedle needle\n',
  );
  await writeFile(
    path.join(root, 'src', 'a', 'a.txt'),
    'needle* literal\nno match\n',
  );

  const content = await searchProjectFiles(
    root,
    parseSearchArguments(searchArgs({ query: 'needle*', directory: 'src' })),
    new AbortController().signal,
  );
  assert.deepEqual(content.matches, [
    { path: 'src/a/a.txt', line: 1, text: 'needle* literal' },
  ]);
  assert.equal(content.truncated, false);

  const repeated = await searchProjectFiles(
    root,
    parseSearchArguments(searchArgs({ query: 'needle', directory: 'src' })),
    new AbortController().signal,
  );
  assert.deepEqual(repeated.matches, [
    { path: 'src/a/a.txt', line: 1, text: 'needle* literal' },
    { path: 'src/z/b.txt', line: 1, text: 'needle' },
    { path: 'src/z/b.txt', line: 3, text: 'needle needle' },
  ]);
  assert.equal(repeated.scannedFiles, 2);
  assert.equal(repeated.skippedFiles, 0);
});

test('content search clips previews at a UTF-8 boundary and reports truncation', async (t) => {
  const root = await makeProject(t);
  await writeFile(
    path.join(root, 'long-line.txt'),
    `needle${'🙂'.repeat(600)}`,
  );

  const result = await searchProjectFiles(
    root,
    parseSearchArguments(searchArgs({ query: 'needle' })),
    new AbortController().signal,
  );
  assert.equal(Buffer.byteLength(result.matches[0]!.text!), 1022);
  assert.equal(result.truncated, true);
});

test('path search returns relative paths without reading file contents', async (t) => {
  const root = await makeProject(t);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'needle-one.ts'), 'secret body');
  await writeFile(path.join(root, 'src', 'NEEDLE-two.ts'), 'secret body');

  const result = await searchProjectFiles(
    root,
    parseSearchArguments(
      searchArgs({ query: 'needle', mode: 'path', directory: 'src' }),
    ),
    new AbortController().signal,
  );
  assert.deepEqual(result.matches, [
    { path: 'src/needle-one.ts', line: null, text: null },
  ]);
  assert.equal(JSON.stringify(result).includes('secret body'), false);

  const listing = await searchProjectFiles(
    root,
    parseSearchArguments(
      searchArgs({ query: '', mode: 'path', directory: 'src', maxResults: 10 }),
    ),
    new AbortController().signal,
  );
  assert.deepEqual(listing.matches, [
    { path: 'src/NEEDLE-two.ts', line: null, text: null },
    { path: 'src/needle-one.ts', line: null, text: null },
  ]);
});

test('search and direct reads honor layered gitignore rules and ignored parent directories', async (t) => {
  const root = await makeProject(t);
  await mkdir(path.join(root, 'nested'));
  await mkdir(path.join(root, 'ignored'));
  await writeFile(path.join(root, '.gitignore'), 'ignored/\n*.txt\n');
  await writeFile(path.join(root, 'nested', '.gitignore'), '!keep.txt\n');
  await writeFile(path.join(root, 'nested', 'keep.txt'), 'needle survives');
  await writeFile(path.join(root, 'nested', 'skip.txt'), 'needle hidden');
  await writeFile(path.join(root, 'ignored', '.gitignore'), '!keep.txt\n');
  await writeFile(path.join(root, 'ignored', 'keep.txt'), 'needle hidden');

  const results = await searchProjectFiles(
    root,
    parseSearchArguments(searchArgs()),
    new AbortController().signal,
  );
  assert.deepEqual(results.matches, [
    { path: 'nested/keep.txt', line: 1, text: 'needle survives' },
  ]);
  await assert.rejects(
    readProjectFile(
      root,
      parseReadArguments(readArgs({ path: 'nested/skip.txt' })),
      new AbortController().signal,
    ),
    hasCode('policy'),
  );
  await assert.rejects(
    readProjectFile(
      root,
      parseReadArguments(readArgs({ path: 'ignored/keep.txt' })),
      new AbortController().signal,
    ),
    hasCode('policy'),
  );
});

test('malformed, unreadable, or oversized gitignore files fail closed', async (t) => {
  const root = await makeProject(t);
  await writeFile(path.join(root, '.gitignore'), Buffer.from([0xff]));
  await assert.rejects(
    searchProjectFiles(
      root,
      parseSearchArguments(searchArgs()),
      new AbortController().signal,
    ),
    hasCode('policy'),
  );
  await writeFile(path.join(root, '.gitignore'), 'broken\\\n');
  await writeFile(path.join(root, 'visible.txt'), 'needle data');
  await assert.rejects(
    searchProjectFiles(
      root,
      parseSearchArguments(searchArgs()),
      new AbortController().signal,
    ),
    hasCode('policy'),
  );
  await writeFile(
    path.join(root, '.gitignore'),
    Buffer.alloc(64 * 1024 + 1, 0x61),
  );
  await assert.rejects(
    searchProjectFiles(
      root,
      parseSearchArguments(searchArgs()),
      new AbortController().signal,
    ),
    hasCode('policy'),
  );
  await assert.rejects(
    readProjectFile(
      root,
      parseReadArguments(readArgs()),
      new AbortController().signal,
    ),
    hasCode('policy'),
  );
  const symlinkRoot = await makeProject(t);
  await symlink('outside.gitignore', path.join(symlinkRoot, '.gitignore'));
  await assert.rejects(
    searchProjectFiles(
      symlinkRoot,
      parseSearchArguments(searchArgs()),
      new AbortController().signal,
    ),
    hasCode('policy'),
  );
});

test('search and direct reads fail closed when ignore rules are hard-linked from outside the root', async (t) => {
  const root = await makeProject(t);
  const outside = await mkdtemp(
    path.join(os.tmpdir(), 'agentforge-external-ignore-'),
  );
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'ignore-rules'), 'private.txt\n');
  await link(path.join(outside, 'ignore-rules'), path.join(root, '.gitignore'));
  await writeFile(path.join(root, 'private.txt'), 'needle private-data');

  await assert.rejects(
    searchProjectFiles(
      root,
      parseSearchArguments(searchArgs()),
      new AbortController().signal,
    ),
    hasCode('policy'),
  );
  await assert.rejects(
    readProjectFile(
      root,
      parseReadArguments(readArgs({ path: 'private.txt' })),
      new AbortController().signal,
    ),
    hasCode('policy'),
  );
});

test('static secret files and blocked directories never appear in search results or direct reads', async (t) => {
  const root = await makeProject(t);
  await mkdir(path.join(root, 'credentials'));
  await mkdir(path.join(root, '.ssh'));
  const secretFiles: [string, string][] = [
    ['.env', 'needle env-secret'],
    ['.env.local', 'needle env-secret'],
    ['.npmrc', 'needle npm-secret'],
    ['.netrc', 'needle netrc-secret'],
    ['id_rsa', 'needle rsa-secret'],
    ['id_ed25519', 'needle ed25519-secret'],
    ['signing.PEM', 'needle pem-secret'],
    ['signing.key', 'needle key-secret'],
    ['archive.p12', 'needle p12-secret'],
    ['archive.pfx', 'needle pfx-secret'],
    ['archive.keystore', 'needle keystore-secret'],
  ];
  for (const [name, value] of secretFiles) {
    await writeFile(path.join(root, name), value);
  }
  await writeFile(
    path.join(root, 'credentials', 'credentials.json'),
    'needle credentials-secret',
  );
  await mkdir(path.join(root, 'backup'));
  await writeFile(
    path.join(root, 'backup', 'credentials'),
    'needle credential-name-secret',
  );
  await writeFile(
    path.join(root, 'backup', 'credentials.json'),
    'needle credential-json-secret',
  );
  await writeFile(path.join(root, '.ssh', 'config'), 'needle ssh-secret');
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(
    path.join(root, 'node_modules', 'package.js'),
    'needle generated-secret',
  );
  await writeFile(path.join(root, 'safe.txt'), 'needle safe');

  const results = await searchProjectFiles(
    root,
    parseSearchArguments(searchArgs()),
    new AbortController().signal,
  );
  assert.deepEqual(results.matches, [
    { path: 'safe.txt', line: 1, text: 'needle safe' },
  ]);
  const output = JSON.stringify(results);
  for (const secret of [
    'env-secret',
    'npm-secret',
    'netrc-secret',
    'rsa-secret',
    'ed25519-secret',
    'pem-secret',
    'key-secret',
    'p12-secret',
    'pfx-secret',
    'keystore-secret',
    'credentials-secret',
    'ssh-secret',
    'generated-secret',
  ]) {
    assert.equal(output.includes(secret), false);
  }
  for (const filePath of [
    '.env',
    '.env.local',
    '.npmrc',
    '.netrc',
    'id_rsa',
    'id_ed25519',
    'signing.PEM',
    'signing.key',
    'archive.p12',
    'archive.pfx',
    'archive.keystore',
    'credentials/credentials.json',
    'backup/credentials',
    'backup/credentials.json',
    'backup/credentials',
    'backup/credentials.json',
    '.ssh/config',
    'node_modules/package.js',
  ]) {
    assert.throws(
      () => parseReadArguments(readArgs({ path: filePath })),
      hasCode('policy'),
    );
  }
});

test('search skips binary, invalid UTF-8, control-bearing, and hard-linked content', async (t) => {
  const root = await makeProject(t);
  await writeFile(
    path.join(root, 'binary.dat'),
    Buffer.from([0x6e, 0x00, 0x65]),
  );
  await writeFile(path.join(root, 'invalid.dat'), Buffer.from([0xff, 0xfe]));
  await writeFile(path.join(root, 'control.dat'), 'needle\u0001hidden');
  await writeFile(path.join(root, 'linked.dat'), 'needle linked-secret');
  await link(path.join(root, 'linked.dat'), path.join(root, 'linked-copy.dat'));

  const result = await searchProjectFiles(
    root,
    parseSearchArguments(searchArgs()),
    new AbortController().signal,
  );
  assert.deepEqual(result.matches, []);
  assert.equal(result.scannedFiles, 5);
  assert.equal(result.skippedFiles, 5);
  assert.equal(result.truncated, true);
});

test('search and read reject symlinks and skip special files without opening them', async (t) => {
  const root = await makeProject(t);
  await writeFile(path.join(root, 'target.txt'), 'needle target');
  await symlink('target.txt', path.join(root, 'linked.txt'));
  await symlink('.', path.join(root, 'linked-dir'));

  const fifoPath = path.join(root, 'pipe');
  if (process.platform !== 'win32') {
    try {
      await execFileAsync('mkfifo', [fifoPath]);
    } catch {
      t.skip('mkfifo is unavailable on this platform');
    }
  } else {
    t.skip('named pipes are not created by this fixture on Windows');
  }

  const result = await searchProjectFiles(
    root,
    parseSearchArguments(searchArgs()),
    new AbortController().signal,
  );
  assert.deepEqual(result.matches, [
    { path: 'target.txt', line: 1, text: 'needle target' },
  ]);
  assert.equal(result.skippedFiles, 3);
  assert.equal(result.truncated, true);
  for (const filePath of ['linked.txt', 'linked-dir/target.txt', 'pipe']) {
    await assert.rejects(
      readProjectFile(
        root,
        parseReadArguments(readArgs({ path: filePath })),
        new AbortController().signal,
      ),
      hasCode('policy'),
    );
  }
});

test('read returns exact one-based line windows, strips CRLF, and adds no phantom trailing line', async (t) => {
  const root = await makeProject(t);
  await mkdir(path.join(root, 'src'));
  await writeFile(
    path.join(root, 'src', 'file.txt'),
    'first\r\nsecond\r\nthird\r\n',
  );

  assert.deepEqual(
    await readProjectFile(
      root,
      parseReadArguments(readArgs({ startLine: 2, lineCount: 2 })),
      new AbortController().signal,
    ),
    {
      path: 'src/file.txt',
      startLine: 2,
      lines: [
        { number: 2, text: 'second', truncated: false },
        { number: 3, text: 'third', truncated: false },
      ],
      truncated: false,
    },
  );
  const eof = await readProjectFile(
    root,
    parseReadArguments(readArgs({ startLine: 4 })),
    new AbortController().signal,
  );
  assert.deepEqual(eof.lines, []);
  assert.equal(eof.truncated, false);
});

test('read safely clips long UTF-8 lines and keeps the response below 48 KiB', async (t) => {
  const root = await makeProject(t);
  const longLine = '🙂'.repeat(1300);
  const manyLines = Array.from({ length: 200 }, () => 'x'.repeat(1000)).join(
    '\n',
  );
  await writeFile(path.join(root, 'long.txt'), `${longLine}\n`);
  await writeFile(path.join(root, 'many.txt'), manyLines);

  const longResult = await readProjectFile(
    root,
    parseReadArguments(readArgs({ path: 'long.txt', lineCount: 1 })),
    new AbortController().signal,
  );
  assert.equal(Buffer.byteLength(longResult.lines[0]!.text), 4096);
  assert.equal(longResult.lines[0]!.truncated, true);
  assert.equal(longResult.truncated, true);

  const manyResult = await readProjectFile(
    root,
    parseReadArguments(readArgs({ path: 'many.txt', lineCount: 200 })),
    new AbortController().signal,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(manyResult)) <= 48 * 1024);
  assert.equal(manyResult.truncated, true);
});

test('read rejects invalid UTF-8, binary controls, hard links, and unavailable files generically', async (t) => {
  const root = await makeProject(t);
  await writeFile(path.join(root, 'invalid.txt'), Buffer.from([0xff]));
  await writeFile(path.join(root, 'control.txt'), 'private\u0007data');
  await writeFile(path.join(root, 'linked.txt'), 'linked-private-data');
  await link(path.join(root, 'linked.txt'), path.join(root, 'linked-copy.txt'));

  for (const filePath of [
    'invalid.txt',
    'control.txt',
    'linked.txt',
    'missing.txt',
  ]) {
    await assert.rejects(
      readProjectFile(
        root,
        parseReadArguments(readArgs({ path: filePath })),
        new AbortController().signal,
      ),
      (error: unknown) =>
        error instanceof ProviderError &&
        error.code === 'policy' &&
        !error.message.includes(filePath) &&
        !error.message.includes('linked-private-data'),
    );
  }
});

test('search marks max-results and file-size limits as truncated', async (t) => {
  const root = await makeProject(t);
  await writeFile(path.join(root, 'a.txt'), 'needle one');
  await writeFile(path.join(root, 'b.txt'), 'needle two');
  await writeFile(
    path.join(root, 'large.txt'),
    Buffer.alloc(256 * 1024 + 1, 0x61),
  );

  const result = await searchProjectFiles(
    root,
    parseSearchArguments(searchArgs({ maxResults: 1 })),
    new AbortController().signal,
  );
  assert.equal(result.matches.length, 1);
  assert.equal(result.skippedFiles, 0);
  assert.equal(result.truncated, true);

  const oversized = await searchProjectFiles(
    root,
    parseSearchArguments(searchArgs({ query: 'not-present' })),
    new AbortController().signal,
  );
  assert.equal(oversized.matches.length, 0);
  assert.equal(oversized.skippedFiles, 1);
  assert.equal(oversized.truncated, true);
});

test('search enforces the total read budget and per-invocation file cap', async (t) => {
  const root = await makeProject(t);
  const fileContents = Buffer.alloc(256 * 1024, 0x61);
  for (let index = 0; index < 33; index += 1) {
    await writeFile(
      path.join(root, `budget-${String(index).padStart(2, '0')}.txt`),
      fileContents,
    );
  }

  const byteBounded = await searchProjectFiles(
    root,
    parseSearchArguments(searchArgs({ query: 'not-present' })),
    new AbortController().signal,
  );
  assert.equal(byteBounded.skippedFiles, 1);
  assert.equal(byteBounded.scannedFiles, 33);
  assert.equal(byteBounded.truncated, true);

  const fileRoot = await makeProject(t);
  for (let index = 0; index < 2001; index += 1) {
    await writeFile(
      path.join(fileRoot, `file-${String(index).padStart(4, '0')}`),
      'x',
    );
  }
  const fileBounded = await searchProjectFiles(
    fileRoot,
    parseSearchArguments(
      searchArgs({ query: 'absent', mode: 'path', maxResults: 1 }),
    ),
    new AbortController().signal,
  );
  assert.equal(fileBounded.scannedFiles, 2000);
  assert.equal(fileBounded.truncated, true);
});

test('search reports truncation when the project depth limit is reached', async (t) => {
  const root = await makeProject(t);
  const segments = Array.from({ length: 41 }, (_, index) => `d${index}`);
  const deepDirectory = path.join(root, ...segments);
  await mkdir(deepDirectory, { recursive: true });
  await writeFile(path.join(deepDirectory, 'needle.txt'), 'needle');

  const result = await searchProjectFiles(
    root,
    parseSearchArguments(searchArgs()),
    new AbortController().signal,
  );
  assert.deepEqual(result.matches, []);
  assert.equal(result.truncated, true);
});

test('search caps serialized output while preserving a valid result', async (t) => {
  const root = await makeProject(t);
  const line = `${'x'.repeat(1020)} needle`;
  for (let index = 0; index < 100; index += 1) {
    await writeFile(
      path.join(root, `file-${String(index).padStart(3, '0')}.txt`),
      line,
    );
  }

  const result = await searchProjectFiles(
    root,
    parseSearchArguments(searchArgs({ maxResults: 100 })),
    new AbortController().signal,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 48 * 1024);
  assert.equal(result.truncated, true);
  assert.ok(result.matches.length < 100);
});

test('search and read honor cancellation before work begins', async (t) => {
  const root = await makeProject(t);
  await writeFile(path.join(root, 'file.txt'), 'needle');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    searchProjectFiles(
      root,
      parseSearchArguments(searchArgs()),
      controller.signal,
    ),
    hasCode('cancelled'),
  );
  await assert.rejects(
    readProjectFile(
      root,
      parseReadArguments(readArgs({ path: 'file.txt' })),
      controller.signal,
    ),
    hasCode('cancelled'),
  );
});

test('search and read honor cancellation during filesystem work', async (t) => {
  const root = await makeProject(t);
  for (let index = 0; index < 20; index += 1) {
    await writeFile(path.join(root, `file-${index}.txt`), 'needle');
  }
  await assert.rejects(
    searchProjectFiles(
      root,
      parseSearchArguments(searchArgs()),
      abortAfterChecks(8),
    ),
    hasCode('cancelled'),
  );
  await assert.rejects(
    readProjectFile(
      root,
      parseReadArguments(readArgs({ path: 'file-0.txt' })),
      abortAfterChecks(5),
    ),
    hasCode('cancelled'),
  );
});

test('discovered file names obey the same safe path bounds as explicit reads', async (t) => {
  const root = await makeProject(t);
  const deepest = Array.from({ length: 40 }, () => 'a').join('/');
  await mkdir(path.join(root, deepest), { recursive: true });
  await writeFile(
    path.join(root, deepest, 'leaf.txt'),
    'needle disallowed-depth',
  );
  await writeFile(
    path.join(root, 'unsafe:stream.txt'),
    'needle disallowed-colon',
  );
  await writeFile(path.join(root, 'safe.txt'), 'needle allowed');
  for (const mode of ['path', 'content'] as const) {
    const result = await searchProjectFiles(
      root,
      parseSearchArguments(
        searchArgs({ mode, query: mode === 'path' ? '' : 'needle' }),
      ),
      new AbortController().signal,
    );
    assert.deepEqual(
      result.matches.map((match) => match.path),
      ['safe.txt'],
    );
    assert.equal(result.truncated, true);
    assert.ok(result.skippedFiles >= 2);
    assert.ok(!JSON.stringify(result).includes('disallowed'));
  }
});
