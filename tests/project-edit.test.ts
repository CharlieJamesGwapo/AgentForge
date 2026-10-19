import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  link,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ProviderError } from '../src/adapters/errors.js';
import { prepareToolBatch } from '../src/engines/tools.js';
import {
  PROJECT_FILE_LIMITS,
  readProjectFileSnapshot,
} from '../src/engines/project-files.js';
import { getProjectEditCapabilities } from '../src/engines/project-edit.js';
import { projectEditTools } from '../src/engines/project-edit-tools.js';

async function makeRoot(t: {
  after(callback: () => void | Promise<void>): void;
}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'agentforge-project-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function call(name: string, args: Record<string, unknown>, id = 'edit-call') {
  return { id, name, arguments: args };
}

function batch(
  registry: ReturnType<typeof projectEditTools>,
  name: string,
  args: Record<string, unknown>,
  id = 'edit-call',
) {
  return prepareToolBatch(registry, [call(name, args, id)]);
}

async function runApproved(
  registry: ReturnType<typeof projectEditTools>,
  name: string,
  args: Record<string, unknown>,
  id = 'edit-call',
) {
  const pending = batch(registry, name, args, id);
  const results = await pending.execute({
    approved: true,
    approvalId: pending.approvalId,
  });
  return { pending, result: results[0]! };
}

function output(result: { output: string; isError?: boolean }) {
  return JSON.parse(result.output) as Record<string, unknown>;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

test('raw edit snapshots preserve bytes and capture a complete file identity', async (t) => {
  const root = await makeRoot(t);
  const bytes = Buffer.from('\uFEFFalpha\r\nold\r\nomega\r\n', 'utf8');
  await writeFile(path.join(root, 'note.txt'), bytes);

  const snapshot = await readProjectFileSnapshot(
    root,
    'note.txt',
    new AbortController().signal,
  );

  assert.equal(snapshot.path, 'note.txt');
  assert.deepEqual(snapshot.content, bytes);
  assert.equal(snapshot.identity.size, bytes.byteLength);
  assert.ok(Number.isInteger(snapshot.identity.dev));
  assert.ok(Number.isInteger(snapshot.identity.ino));
  assert.equal(typeof snapshot.identity.mtimeMs, 'number');
  assert.equal(typeof snapshot.identity.ctimeMs, 'number');
  assert.equal(typeof snapshot.identity.mode, 'number');
});

test('raw snapshots enforce project ignore, UTF-8, size, link and cancellation policy', async (t) => {
  const root = await makeRoot(t);
  await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
  await writeFile(path.join(root, 'ignored.txt'), 'hidden by ignore policy\n');
  await writeFile(path.join(root, 'invalid.txt'), Buffer.from([0xff, 0xfe]));
  await writeFile(
    path.join(root, 'large.txt'),
    Buffer.alloc(PROJECT_FILE_LIMITS.maxFileBytes + 1, 0x61),
  );
  const target = path.join(root, 'target.txt');
  await writeFile(target, 'outside edit target\n');
  await symlink(target, path.join(root, 'linked.txt'));
  await link(target, path.join(root, 'hard-linked.txt'));

  for (const relativePath of [
    'ignored.txt',
    'invalid.txt',
    'large.txt',
    'linked.txt',
    'hard-linked.txt',
  ]) {
    await assert.rejects(
      readProjectFileSnapshot(root, relativePath, new AbortController().signal),
      (error: unknown) =>
        error instanceof ProviderError && error.code === 'policy',
      relativePath,
    );
  }
  await assert.rejects(
    readProjectFileSnapshot(root, 'target.txt', AbortSignal.abort()),
    (error: unknown) =>
      error instanceof ProviderError && error.code === 'cancelled',
  );
});

test('a unique replacement returns a complete diff and raw hashes without changing the file', async (t) => {
  const root = await makeRoot(t);
  const before = Buffer.from('\uFEFFalpha\r\nold\r\nomega\r\n', 'utf8');
  const after = Buffer.from('\uFEFFalpha\r\nnew\r\nomega\r\n', 'utf8');
  await writeFile(path.join(root, 'note.txt'), before);
  const registry = projectEditTools(root, { allowWrite: false });

  const { result } = await runApproved(registry, 'project_edit_replace', {
    path: 'note.txt',
    oldText: 'old',
    newText: 'new',
  });
  const preview = output(result);

  assert.equal(result.isError, undefined);
  assert.equal(preview.status, 'preview');
  assert.equal(preview.operation, 'replace');
  assert.equal(preview.path, 'note.txt');
  assert.equal(preview.beforeHash, sha256(before));
  assert.equal(preview.afterHash, sha256(after));
  assert.match(String(preview.proposalId), /^[a-f0-9-]{16,}$/);
  assert.match(String(preview.diff), /-old/);
  assert.match(String(preview.diff), /\+new/);
  assert.deepEqual(await readFile(path.join(root, 'note.txt')), before);

  const applyTool = registry.find(
    (tool) => tool.definition.name === 'project_edit_apply',
  );
  assert.equal(applyTool, undefined);
});

test('replacement rejects duplicate matches, empty matches, no-ops and oversize diffs without writing', async (t) => {
  const root = await makeRoot(t);
  const original = Buffer.from('old\nold\n');
  await writeFile(path.join(root, 'note.txt'), original);
  const registry = projectEditTools(root, { allowWrite: true });

  const duplicate = await runApproved(registry, 'project_edit_replace', {
    path: 'note.txt',
    oldText: 'old',
    newText: 'new',
  });
  assert.equal(duplicate.result.isError, true);
  assert.ok(!duplicate.result.output.includes('old\nold'));

  for (const args of [
    { path: 'note.txt', oldText: '', newText: 'new' },
    { path: 'note.txt', oldText: 'old', newText: 'old' },
    { path: 'note.txt', oldText: 'old', newText: 'x'.repeat(33_000) },
  ]) {
    assert.throws(() => batch(registry, 'project_edit_replace', args));
  }
  assert.deepEqual(await readFile(path.join(root, 'note.txt')), original);
});

test('strict single-file patches preserve exact context and reject malformed headers before approval', async (t) => {
  const root = await makeRoot(t);
  const original = Buffer.from('alpha\nold\nomega\n');
  await writeFile(path.join(root, 'note.txt'), original);
  const registry = projectEditTools(root, { allowWrite: false });
  const patch = [
    '--- a/note.txt',
    '+++ b/note.txt',
    '@@ -1,3 +1,3 @@',
    ' alpha',
    '-old',
    '+new',
    ' omega',
    '',
  ].join('\n');

  const { result } = await runApproved(registry, 'project_edit_patch', {
    path: 'note.txt',
    patch,
  });
  const preview = output(result);
  assert.equal(result.isError, undefined);
  assert.equal(preview.status, 'preview');
  assert.equal(preview.operation, 'patch');
  assert.match(String(preview.diff), /-old/);
  assert.match(String(preview.diff), /\+new/);
  assert.deepEqual(await readFile(path.join(root, 'note.txt')), original);

  for (const invalidPatch of [
    patch.replace('a/note.txt', 'a/../outside.txt'),
    `${patch}--- a/second.txt\n+++ b/second.txt\n`,
    `${patch}\\ No newline at end of file\n`,
    '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+created\n',
    'x'.repeat(32_769),
  ]) {
    assert.throws(() =>
      batch(registry, 'project_edit_patch', {
        path: 'note.txt',
        patch: invalidPatch,
      }),
    );
  }
  const wrongContext = await runApproved(registry, 'project_edit_patch', {
    path: 'note.txt',
    patch: patch.replace(' alpha', ' wrong context'),
  });
  assert.equal(wrongContext.result.isError, true);
  assert.deepEqual(await readFile(path.join(root, 'note.txt')), original);
});

test('small patches handle large bounded files without spreading unbounded line arrays', async (t) => {
  const root = await makeRoot(t);
  const original = Buffer.from(`old\n${'\n'.repeat(150_000)}`);
  await writeFile(path.join(root, 'note.txt'), original);
  const registry = projectEditTools(root, { allowWrite: false });
  const { result } = await runApproved(registry, 'project_edit_patch', {
    path: 'note.txt',
    patch: [
      '--- a/note.txt',
      '+++ b/note.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n'),
  });

  assert.equal(output(result).status, 'preview');
  assert.deepEqual(await readFile(path.join(root, 'note.txt')), original);
});

test('previews that exceed the serialized result envelope are withheld before storage', async (t) => {
  const root = await makeRoot(t);
  const original = Buffer.from(`${'\t'.repeat(16_330)}old\n`);
  await writeFile(path.join(root, 'note.txt'), original);
  const registry = projectEditTools(root, { allowWrite: true });

  const { result } = await runApproved(registry, 'project_edit_replace', {
    path: 'note.txt',
    oldText: 'old',
    newText: 'new',
  });

  assert.equal(result.isError, true);
  assert.ok(!result.output.includes('old'));
  assert.ok(!result.output.includes('new'));
  assert.deepEqual(await readFile(path.join(root, 'note.txt')), original);
});

test('edit tool declarations and path validation stay offline and reject protected targets', async () => {
  const registry = projectEditTools('/missing-edit-root', {
    allowWrite: false,
  });
  assert.deepEqual(
    registry.map((tool) => tool.definition.name),
    ['project_edit_replace', 'project_edit_patch'],
  );
  assert.ok(
    registry.every(
      (tool) =>
        tool.definition.parameters.additionalProperties === false &&
        tool.definition.resultSchema?.additionalProperties === false,
    ),
  );
  const inert = batch(registry, 'project_edit_replace', {
    path: 'note.txt',
    oldText: 'old',
    newText: 'new',
  });
  assert.match(JSON.stringify(inert.review), /note\.txt/);
  await assert.rejects(
    inert.execute({ approved: false, approvalId: inert.approvalId }),
    { code: 'policy' },
  );
  await assert.rejects(
    inert.execute({ approved: true, approvalId: '0'.repeat(64) }),
    { code: 'policy' },
  );

  const writableRegistry = projectEditTools('/missing-edit-root', {
    allowWrite: true,
  });
  assert.ok(
    writableRegistry.some(
      (tool) => tool.definition.name === 'project_edit_apply',
    ),
  );
  for (const pathValue of [
    '../outside.txt',
    '/tmp/outside.txt',
    'folder/../note.txt',
    'folder\\note.txt',
    '.env',
    'agentforge.config.json',
    '.gitignore',
    '.agentforge/state.json',
    'node_modules/pkg/index.js',
  ]) {
    assert.throws(
      () =>
        batch(writableRegistry, 'project_edit_replace', {
          path: pathValue,
          oldText: 'old',
          newText: 'new',
        }),
      pathValue,
    );
  }
});

test('cancelling the approved proposal read leaves the target unchanged', async (t) => {
  const root = await makeRoot(t);
  const file = path.join(root, 'note.txt');
  const original = Buffer.from('before\n');
  await writeFile(file, original);
  const registry = projectEditTools(root, { allowWrite: false });
  const pending = batch(registry, 'project_edit_replace', {
    path: 'note.txt',
    oldText: 'before',
    newText: 'after',
  });

  await assert.rejects(
    pending.execute({
      approved: true,
      approvalId: pending.approvalId,
      signal: AbortSignal.abort(),
    }),
    { code: 'cancelled' },
  );
  assert.deepEqual(await readFile(file), original);
});

test('approved edits reject symlink targets without touching the linked file', async (t) => {
  const root = await makeRoot(t);
  const outside = `${root}-outside.txt`;
  await writeFile(outside, 'protected\n');
  t.after(() => rm(outside, { force: true }));
  await symlink(outside, path.join(root, 'linked.txt'));
  const registry = projectEditTools(root, { allowWrite: true });

  const { result } = await runApproved(registry, 'project_edit_replace', {
    path: 'linked.txt',
    oldText: 'protected',
    newText: 'changed',
  });

  assert.equal(result.isError, true);
  assert.deepEqual(await readFile(outside, 'utf8'), 'protected\n');
});

test('approved proposals remain session-bound and stale bytes produce a conflict before any write', async (t) => {
  const root = await makeRoot(t);
  const file = path.join(root, 'note.txt');
  const original = Buffer.from('before\n');
  await writeFile(file, original);
  const registry = projectEditTools(root, { allowWrite: true });
  const { result: proposalResult } = await runApproved(
    registry,
    'project_edit_replace',
    { path: 'note.txt', oldText: 'before', newText: 'after' },
  );
  const proposal = output(proposalResult);
  const proposalId = String(proposal.proposalId);

  const otherSession = projectEditTools(root, { allowWrite: true });
  assert.throws(() =>
    batch(otherSession, 'project_edit_apply', { proposalId }),
  );

  await writeFile(file, 'changed\n');
  const staleApply = await runApproved(registry, 'project_edit_apply', {
    proposalId,
  });
  const conflict = output(staleApply.result);
  assert.equal(conflict.status, 'conflict');
  assert.deepEqual(await readFile(file), Buffer.from('changed\n'));
  assert.throws(() => batch(registry, 'project_edit_apply', { proposalId }));
});

test('Node reports apply unavailable and leaves bytes untouched after a fresh exact apply approval', async (t) => {
  const root = await makeRoot(t);
  const file = path.join(root, 'note.txt');
  const original = Buffer.from('before\n');
  await writeFile(file, original);
  const capability = getProjectEditCapabilities();
  assert.equal(capability.backend, 'node');
  assert.equal(capability.atomicConflictSafeReplace, false);
  assert.equal(capability.status, 'unavailable');
  assert.equal(typeof capability.reason, 'string');
  assert.ok(capability.reason.length > 0);

  const registry = projectEditTools(root, { allowWrite: true });
  const { result: previewResult } = await runApproved(
    registry,
    'project_edit_replace',
    { path: 'note.txt', oldText: 'before', newText: 'after' },
    'preview-call',
  );
  const preview = output(previewResult);
  const apply = batch(
    registry,
    'project_edit_apply',
    { proposalId: preview.proposalId },
    'apply-call',
  );
  assert.match(JSON.stringify(apply.review), /before/);
  assert.match(JSON.stringify(apply.review), /after/);
  const applied = await apply.execute({
    approved: true,
    approvalId: apply.approvalId,
  });
  const outcome = output(applied[0]!);

  assert.equal(outcome.status, 'unavailable');
  assert.match(String(outcome.reason), /atomic|replace|platform/i);
  assert.deepEqual(await readFile(file), original);
  assert.throws(() =>
    batch(registry, 'project_edit_apply', {
      proposalId: preview.proposalId,
    }),
  );
  await assert.rejects(
    apply.execute({ approved: true, approvalId: apply.approvalId }),
    { code: 'policy' },
  );
});

test('edit sessions evict the oldest proposal after the bounded cache fills', async (t) => {
  const root = await makeRoot(t);
  await writeFile(path.join(root, 'note.txt'), 'before\n');
  const registry = projectEditTools(root, { allowWrite: true });
  const proposals: string[] = [];

  for (let index = 0; index < 9; index += 1) {
    const { result } = await runApproved(
      registry,
      'project_edit_replace',
      { path: 'note.txt', oldText: 'before', newText: `after-${index}` },
      `proposal-${index}`,
    );
    proposals.push(String(output(result).proposalId));
  }

  assert.throws(() =>
    batch(registry, 'project_edit_apply', { proposalId: proposals[0] }),
  );
  const newest = batch(registry, 'project_edit_apply', {
    proposalId: proposals.at(-1),
  });
  assert.match(JSON.stringify(newest.review), /after-8/);
});

test('edit proposals expire at the five-minute session TTL', async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const root = await makeRoot(t);
  await writeFile(path.join(root, 'note.txt'), 'before\n');
  const registry = projectEditTools(root, { allowWrite: true });
  const { result } = await runApproved(registry, 'project_edit_replace', {
    path: 'note.txt',
    oldText: 'before',
    newText: 'after',
  });
  const proposalId = String(output(result).proposalId);

  now += 5 * 60 * 1000 - 1;
  assert.doesNotThrow(() =>
    batch(registry, 'project_edit_apply', { proposalId }),
  );
  now += 1;
  assert.throws(() => batch(registry, 'project_edit_apply', { proposalId }));
});

test('sensitive diffs are withheld instead of returning redacted or raw file text', async (t) => {
  const root = await makeRoot(t);
  const secret = 'secret=private-edit-fixture-9374';
  await writeFile(path.join(root, 'note.txt'), `${secret}\n`);
  const registry = projectEditTools(root, { allowWrite: false });

  const { result } = await runApproved(registry, 'project_edit_replace', {
    path: 'note.txt',
    oldText: 'private-edit-fixture-9374',
    newText: 'safe-value',
  });

  assert.equal(result.isError, true);
  assert.ok(!result.output.includes('private-edit-fixture-9374'));
  assert.ok(!result.output.includes(secret));
  assert.deepEqual(
    await readFile(path.join(root, 'note.txt'), 'utf8'),
    `${secret}\n`,
  );
});
