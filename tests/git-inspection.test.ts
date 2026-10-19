import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { prepareToolBatch } from '../src/engines/tools.js';
import { gitTools } from '../src/engines/git-tools.js';
import { inspectGit } from '../src/engines/git-inspection.js';

async function makeRoot(t: {
  after(callback: () => void | Promise<void>): void;
}) {
  const root = await mkdtemp(path.join(tmpdir(), 'agentforge-git-inspection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function initRepo(root: string): void {
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.name', 'Fixture Maintainer');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
}

function toolResult(output: string) {
  return JSON.parse(output) as {
    status: string;
    operation: string;
    branch: string | null;
    headState: string;
    staged: { path: string; status: string }[];
    unstaged: { path: string; status: string }[];
    untracked: string[];
    diff: string;
    commits: { hash: string; date: string; subject: string }[];
    branches: { name: string; current: boolean }[];
    truncated: boolean;
    message: string | null;
  };
}

test('Git status waits for exact batch approval and preserves unusual filenames', async (t) => {
  const root = await makeRoot(t);
  initRepo(root);
  await writeFile(path.join(root, 'base.txt'), 'before\n');
  git(root, 'add', 'base.txt');
  git(root, 'commit', '--quiet', '-m', 'fixture base');
  await writeFile(path.join(root, 'base.txt'), 'staged\n');
  git(root, 'add', 'base.txt');
  await writeFile(path.join(root, 'base.txt'), 'unstaged\n');
  await writeFile(path.join(root, 'tab\tname.txt'), 'tab');
  await writeFile(path.join(root, 'line\nname.txt'), 'line');
  await writeFile(path.join(root, 'control\u0001name.txt'), 'control');
  await writeFile(path.join(root, '.env'), 'secret');
  await mkdir(path.join(root, 'dist'));
  await writeFile(path.join(root, 'dist', 'bundle.js'), 'generated');

  const registry = gitTools(root);
  assert.deepEqual(
    registry.map((tool) => tool.definition.name),
    ['git_status', 'git_diff', 'git_log', 'git_branch'],
  );
  for (const tool of registry) {
    assert.equal(tool.definition.parameters.additionalProperties, false);
    assert.equal(tool.definition.resultSchema?.additionalProperties, false);
  }
  const batch = prepareToolBatch(registry, [
    { id: 'status-call', name: 'git_status', arguments: {} },
  ]);
  await assert.rejects(
    batch.execute({ approved: false, approvalId: batch.approvalId }),
    /approval/i,
  );
  const result = await batch.execute({
    approved: true,
    approvalId: batch.approvalId,
  });
  const status = toolResult(result[0]!.output);
  assert.equal(status.status, 'ok');
  assert.equal(status.operation, 'status');
  assert.equal(status.headState, 'attached');
  assert.ok(status.branch);
  assert.deepEqual(
    status.staged.map((entry) => entry.path),
    ['base.txt'],
  );
  assert.deepEqual(
    status.unstaged.map((entry) => entry.path),
    ['base.txt'],
  );
  assert.ok(status.staged[0]!.status[0] !== '.');
  assert.ok(status.unstaged[0]!.status[1] !== '.');
  assert.deepEqual(status.untracked.sort(), [
    'line\nname.txt',
    'tab\tname.txt',
  ]);
  assert.ok(!JSON.stringify(status).includes('.env'));
  assert.ok(!JSON.stringify(status).includes('dist/bundle.js'));
  assert.ok(!JSON.stringify(status).includes('\u0001'));
  await assert.rejects(
    batch.execute({ approved: true, approvalId: batch.approvalId }),
    /already been consumed/i,
  );
});

test('Git diff accepts one allowed file and rejects root, traversal, and credentials during review', async (t) => {
  const root = await makeRoot(t);
  initRepo(root);
  await writeFile(path.join(root, 'one.txt'), 'old line\n');
  git(root, 'add', 'one.txt');
  git(root, 'commit', '--quiet', '-m', 'fixture base');
  await writeFile(path.join(root, 'one.txt'), 'new line\n');
  await writeFile(path.join(root, 'other.txt'), 'unrelated\n');

  const tool = gitTools(root).find(
    (candidate) => candidate.definition.name === 'git_diff',
  )!;
  for (const args of [
    { path: '.', staged: false },
    { path: '../outside.txt', staged: false },
    { path: '.env', staged: false },
    { path: 'one.txt', staged: false, revision: 'HEAD~1' },
  ]) {
    assert.throws(() => tool.review!(args), /invalid|unavailable|path/i);
  }
  const batch = prepareToolBatch(
    [tool],
    [
      {
        id: 'diff-call',
        name: 'git_diff',
        arguments: { path: 'one.txt', staged: false },
      },
    ],
  );
  const result = await batch.execute({
    approved: true,
    approvalId: batch.approvalId,
  });
  const diff = toolResult(result[0]!.output);
  assert.equal(diff.status, 'ok');
  assert.equal(diff.operation, 'diff');
  assert.match(diff.diff, /-old line/);
  assert.match(diff.diff, /\+new line/);
  assert.ok(!diff.diff.includes('unrelated'));
});

test('Git log and branch report local history, and detached HEAD has no branch name', async (t) => {
  const root = await makeRoot(t);
  initRepo(root);
  await writeFile(path.join(root, 'one.txt'), 'fixture\n');
  git(root, 'add', 'one.txt');
  git(root, 'commit', '--quiet', '-m', 'local fixture commit');
  await writeFile(path.join(root, 'two.txt'), 'second fixture\n');
  git(root, 'add', 'two.txt');
  git(root, 'commit', '--quiet', '-m', 'second fixture commit');

  const registry = gitTools(root);
  const logBatch = prepareToolBatch(registry, [
    { id: 'log-call', name: 'git_log', arguments: { limit: 1 } },
  ]);
  const log = toolResult(
    (
      await logBatch.execute({
        approved: true,
        approvalId: logBatch.approvalId,
      })
    )[0]!.output,
  );
  assert.equal(log.status, 'ok');
  assert.equal(log.commits.length, 1);
  assert.match(log.commits[0]!.hash, /^[a-f0-9]{40,64}$/);
  assert.equal(log.commits[0]!.subject, 'second fixture commit');
  const twoCommitLog = await inspectGit(
    root,
    { operation: 'log', limit: 2 },
    { approved: true },
  );
  assert.equal(twoCommitLog.status, 'ok');
  assert.deepEqual(
    twoCommitLog.commits.map((commit) => commit.subject),
    ['second fixture commit', 'local fixture commit'],
  );

  const branchBatch = prepareToolBatch(registry, [
    { id: 'branch-call', name: 'git_branch', arguments: {} },
  ]);
  const branches = toolResult(
    (
      await branchBatch.execute({
        approved: true,
        approvalId: branchBatch.approvalId,
      })
    )[0]!.output,
  );
  assert.equal(branches.status, 'ok');
  assert.equal(branches.branches.filter((branch) => branch.current).length, 1);
  assert.equal(
    branches.branch,
    branches.branches.find((branch) => branch.current)!.name,
  );

  git(root, 'checkout', '--quiet', '--detach');
  const detached = await inspectGit(
    root,
    { operation: 'status' },
    { approved: true },
  );
  assert.equal(detached.headState, 'detached');
  assert.equal(detached.branch, null);
});

test('Git status distinguishes an unborn repository from a nested non-repository root', async (t) => {
  const parent = await makeRoot(t);
  initRepo(parent);
  const unborn = await inspectGit(
    parent,
    { operation: 'status' },
    { approved: true },
  );
  assert.equal(unborn.status, 'ok');
  assert.equal(unborn.headState, 'unborn');
  assert.ok(unborn.branch);
  assert.deepEqual(unborn.commits, []);
  assert.deepEqual(unborn.branches, []);
  const unbornLog = await inspectGit(
    parent,
    { operation: 'log', limit: 1 },
    { approved: true },
  );
  assert.equal(unbornLog.status, 'ok');
  assert.equal(unbornLog.headState, 'unborn');
  assert.equal(unbornLog.branch, unborn.branch);
  assert.deepEqual(unbornLog.commits, []);

  const nested = path.join(parent, 'nested');
  await mkdir(nested);
  const nestedStatus = await inspectGit(
    nested,
    { operation: 'status' },
    { approved: true },
  );
  assert.equal(nestedStatus.status, 'not-repository');
  assert.deepEqual(nestedStatus.staged, []);
  assert.deepEqual(nestedStatus.untracked, []);
});

test('Git inspection rejects symlink roots, Git metadata symlinks, and worktree metadata files', async (t) => {
  const root = await makeRoot(t);
  initRepo(root);
  const symlinkRoot = `${root}-link`;
  await symlink(root, symlinkRoot);
  t.after(() => rm(symlinkRoot, { force: true }));
  assert.equal(
    (await inspectGit(symlinkRoot, { operation: 'status' }, { approved: true }))
      .status,
    'unsafe-root',
  );

  const metadataTarget = path.join(root, 'metadata-target');
  await mkdir(metadataTarget);
  const symlinkMetadata = path.join(root, 'symlink-metadata');
  await mkdir(symlinkMetadata);
  await symlink(metadataTarget, path.join(symlinkMetadata, '.git'));
  assert.equal(
    (
      await inspectGit(
        symlinkMetadata,
        { operation: 'status' },
        { approved: true },
      )
    ).status,
    'unsafe-root',
  );

  const worktreeMetadata = path.join(root, 'worktree-metadata');
  await mkdir(worktreeMetadata);
  await writeFile(
    path.join(worktreeMetadata, '.git'),
    'gitdir: ../.git/worktrees/fixture\n',
  );
  assert.equal(
    (
      await inspectGit(
        worktreeMetadata,
        { operation: 'status' },
        { approved: true },
      )
    ).status,
    'unsupported-worktree',
  );
  assert.ok((await lstat(path.join(worktreeMetadata, '.git'))).isFile());
});

test('Git inspection rejects linked metadata and external object alternates before running Git', async (t) => {
  const base = await makeRoot(t);
  const external = path.join(base, 'external-metadata');
  await mkdir(external);

  const configRoot = path.join(base, 'config-repo');
  await mkdir(configRoot);
  initRepo(configRoot);
  const configPath = path.join(configRoot, '.git', 'config');
  const savedConfig = path.join(base, 'saved-config');
  await rename(configPath, savedConfig);
  await writeFile(
    path.join(external, 'config'),
    '[core]\nrepositoryformatversion = 0\n',
  );
  await symlink(path.join(external, 'config'), configPath);
  assert.equal(
    (await inspectGit(configRoot, { operation: 'status' }, { approved: true }))
      .status,
    'unsafe-root',
  );

  const indexRoot = path.join(base, 'index-repo');
  await mkdir(indexRoot);
  initRepo(indexRoot);
  const externalIndex = path.join(external, 'index');
  await writeFile(externalIndex, 'external index data');
  await symlink(externalIndex, path.join(indexRoot, '.git', 'index'));
  assert.equal(
    (await inspectGit(indexRoot, { operation: 'status' }, { approved: true }))
      .status,
    'unsafe-root',
  );

  const refsRoot = path.join(base, 'refs-repo');
  await mkdir(refsRoot);
  initRepo(refsRoot);
  const refsPath = path.join(refsRoot, '.git', 'refs');
  const savedRefs = path.join(base, 'saved-refs');
  await rename(refsPath, savedRefs);
  const externalRefs = path.join(external, 'refs');
  await mkdir(path.join(externalRefs, 'heads'), { recursive: true });
  await symlink(externalRefs, refsPath);
  assert.equal(
    (await inspectGit(refsRoot, { operation: 'branch' }, { approved: true }))
      .status,
    'unsafe-root',
  );

  const objectsRoot = path.join(base, 'objects-repo');
  await mkdir(objectsRoot);
  initRepo(objectsRoot);
  const objects = path.join(objectsRoot, '.git', 'objects');
  const savedObjects = path.join(base, 'saved-objects');
  await rename(objects, savedObjects);
  await symlink(external, objects);
  assert.equal(
    (await inspectGit(objectsRoot, { operation: 'status' }, { approved: true }))
      .status,
    'unsafe-root',
  );

  const alternatesRoot = path.join(base, 'alternates-repo');
  await mkdir(alternatesRoot);
  initRepo(alternatesRoot);
  const alternates = path.join(
    alternatesRoot,
    '.git',
    'objects',
    'info',
    'alternates',
  );
  await mkdir(path.dirname(alternates), { recursive: true });
  await writeFile(alternates, `${external}\n`);
  assert.equal(
    (
      await inspectGit(
        alternatesRoot,
        { operation: 'status' },
        { approved: true },
      )
    ).status,
    'unsafe-root',
  );
});

test('Git inspection reports missing Git, timeouts, cancellation, and output limits explicitly', async (t) => {
  const root = await makeRoot(t);
  initRepo(root);
  const missing = await inspectGit(
    root,
    { operation: 'status' },
    { approved: true, gitExecutable: path.join(root, 'missing-git') },
  );
  assert.equal(missing.status, 'missing-git');
  assert.equal(missing.message, 'Git executable is unavailable.');

  const sleeper = path.join(root, 'git-sleeper');
  await writeFile(sleeper, '#!/bin/sh\nsleep 5\n');
  await chmod(sleeper, 0o755);
  const timedOut = await inspectGit(
    root,
    { operation: 'status' },
    { approved: true, gitExecutable: sleeper, timeoutMs: 30 },
  );
  assert.equal(timedOut.status, 'timed-out');

  const controller = new AbortController();
  const cancellation = inspectGit(
    root,
    { operation: 'status' },
    { approved: true, gitExecutable: sleeper, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 30);
  assert.equal((await cancellation).status, 'cancelled');

  const noisy = path.join(root, 'git-noisy');
  await writeFile(noisy, "#!/bin/sh\nwhile :; do printf '1234567890'; done\n");
  await chmod(noisy, 0o755);
  const tooMuch = await inspectGit(
    root,
    { operation: 'status' },
    { approved: true, gitExecutable: noisy, maxOutputBytes: 1024 },
  );
  assert.equal(tooMuch.status, 'output-limit');
  assert.equal(tooMuch.truncated, true);
});

test('Git diff excludes ignored files and symlink paths', async (t) => {
  const root = await makeRoot(t);
  initRepo(root);
  await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
  await writeFile(path.join(root, 'ignored.txt'), 'ignored change\n');
  const target = path.join(root, 'target.txt');
  await writeFile(target, 'safe change\n');
  await symlink(target, path.join(root, 'linked.txt'));
  const external = `${root}-hardlink-target`;
  t.after(() => rm(external, { force: true }));
  await writeFile(external, 'outside project data\n');
  await link(external, path.join(root, 'hardlinked.txt'));

  const ignored = await inspectGit(
    root,
    { operation: 'diff', path: 'ignored.txt', staged: false },
    { approved: true },
  );
  assert.equal(ignored.status, 'path-unavailable');
  const linked = await inspectGit(
    root,
    { operation: 'diff', path: 'linked.txt', staged: false },
    { approved: true },
  );
  assert.equal(linked.status, 'path-unavailable');
  const hardlinked = await inspectGit(
    root,
    { operation: 'diff', path: 'hardlinked.txt', staged: false },
    { approved: true },
  );
  assert.equal(hardlinked.status, 'path-unavailable');
});

test('Git diff does not use nested ignore rules under an ignored parent', async (t) => {
  const root = await makeRoot(t);
  initRepo(root);
  await writeFile(path.join(root, '.gitignore'), 'ignored/\n');
  await mkdir(path.join(root, 'ignored'));
  await writeFile(path.join(root, 'ignored', '.gitignore'), '!note.txt\n');
  await writeFile(
    path.join(root, 'ignored', 'note.txt'),
    'secret ignored text\n',
  );
  git(root, 'add', '-f', 'ignored/note.txt');
  git(root, 'commit', '--quiet', '-m', 'ignored nested fixture');
  await writeFile(
    path.join(root, 'ignored', 'note.txt'),
    'secret changed text\n',
  );

  const result = await inspectGit(
    root,
    { operation: 'diff', path: 'ignored/note.txt', staged: false },
    { approved: true },
  );
  assert.equal(result.status, 'path-unavailable');
  assert.equal(result.diff, '');
});

test('Git subprocess stderr never enters a successful diff and invalid UTF-8 is withheld', async (t) => {
  const root = await makeRoot(t);
  initRepo(root);
  await writeFile(path.join(root, 'one.txt'), 'one line\n');
  const noisyGit = path.join(root, 'git-noisy-stderr');
  await writeFile(
    noisyGit,
    '#!/bin/sh\ncase " $* " in *" rev-parse "*) pwd ;; *) printf \'safe diff\\n\'; printf \'private warning\\n\' >&2 ;; esac\n',
  );
  await chmod(noisyGit, 0o755);
  const result = await inspectGit(
    root,
    { operation: 'diff', path: 'one.txt', staged: false },
    { approved: true, gitExecutable: noisyGit },
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.diff, 'safe diff\n');
  assert.ok(!result.diff.includes('private warning'));

  const invalidUtf8 = path.join(root, 'git-invalid-utf8');
  await writeFile(
    invalidUtf8,
    '#!/bin/sh\ncase " $* " in *" config --local "*) printf \'core.repositoryformatversion\\0\' ;; *" rev-parse --show-toplevel "*) pwd ;; *) printf \'\\377\\n\' ;; esac\n',
  );
  await chmod(invalidUtf8, 0o755);
  const invalid = await inspectGit(
    root,
    { operation: 'status' },
    { approved: true, gitExecutable: invalidUtf8 },
  );
  assert.equal(invalid.status, 'failed');
  assert.deepEqual(invalid.staged, []);
  assert.deepEqual(invalid.untracked, []);
});

test('Git status and diff never execute configured clean filters', async (t) => {
  const root = await makeRoot(t);
  initRepo(root);
  await writeFile(
    path.join(root, '.gitattributes'),
    'filtered.txt filter=probe\n',
  );
  await writeFile(path.join(root, 'filtered.txt'), 'before\n');
  git(root, 'add', '.gitattributes', 'filtered.txt');
  git(root, 'commit', '--quiet', '-m', 'filtered fixture');
  const marker = path.join(root, 'filter-marker');
  const filter = path.join(root, 'clean-filter.sh');
  await writeFile(filter, `#!/bin/sh\nprintf executed > '${marker}'\ncat\n`);
  await chmod(filter, 0o755);
  git(root, 'config', '--local', 'filter.probe.clean', `sh ${filter}`);
  await writeFile(path.join(root, 'filtered.txt'), 'after\n');

  const status = await inspectGit(
    root,
    { operation: 'status' },
    { approved: true },
  );
  assert.equal(status.status, 'ok');
  await assert.rejects(lstat(marker));

  const diff = await inspectGit(
    root,
    { operation: 'diff', path: 'filtered.txt', staged: false },
    { approved: true },
  );
  assert.equal(diff.status, 'ok');
  await assert.rejects(lstat(marker));
});

test('Git inspection rejects local config includes before they can activate external filters', async (t) => {
  const base = await makeRoot(t);
  const root = path.join(base, 'repo');
  await mkdir(root);
  initRepo(root);
  await writeFile(
    path.join(root, '.gitattributes'),
    'filtered.txt filter=probe\n',
  );
  await writeFile(path.join(root, 'filtered.txt'), 'before\n');
  git(root, 'add', '.gitattributes', 'filtered.txt');
  git(root, 'commit', '--quiet', '-m', 'included filter fixture');
  const marker = path.join(base, 'include-filter-marker');
  const filter = path.join(base, 'included-clean-filter.sh');
  const config = path.join(base, 'included-git-config');
  await writeFile(filter, `#!/bin/sh\nprintf executed > '${marker}'\ncat\n`);
  await chmod(filter, 0o755);
  await writeFile(config, `[filter "probe"]\n clean = sh ${filter}\n`);
  git(root, 'config', '--local', 'include.path', config);
  await writeFile(path.join(root, 'filtered.txt'), 'after\n');

  const result = await inspectGit(
    root,
    { operation: 'status' },
    { approved: true },
  );
  assert.equal(result.status, 'unsafe-configuration');
  await assert.rejects(lstat(marker));
});

test('Git inspection rejects partial clone and promisor metadata instead of risking fetches', async (t) => {
  const base = await makeRoot(t);
  const configured = path.join(base, 'configured-promisor');
  await mkdir(configured);
  initRepo(configured);
  git(configured, 'config', '--local', 'extensions.partialClone', 'origin');
  assert.equal(
    (await inspectGit(configured, { operation: 'status' }, { approved: true }))
      .status,
    'unsafe-configuration',
  );

  const remoteConfigured = path.join(base, 'remote-promisor');
  await mkdir(remoteConfigured);
  initRepo(remoteConfigured);
  git(remoteConfigured, 'config', '--local', 'remote.origin.promisor', 'true');
  assert.equal(
    (
      await inspectGit(
        remoteConfigured,
        { operation: 'log', limit: 1 },
        { approved: true },
      )
    ).status,
    'unsafe-configuration',
  );

  const packPromisor = path.join(base, 'pack-promisor');
  await mkdir(packPromisor);
  initRepo(packPromisor);
  const packDirectory = path.join(packPromisor, '.git', 'objects', 'pack');
  await mkdir(packDirectory, { recursive: true });
  await writeFile(path.join(packDirectory, 'pack-fixture.promisor'), '');
  assert.equal(
    (
      await inspectGit(
        packPromisor,
        { operation: 'status' },
        { approved: true },
      )
    ).status,
    'unsafe-root',
  );
});

test('Git inspection requires approval before process access and bounds results', async (t) => {
  const root = await makeRoot(t);
  initRepo(root);
  await writeFile(path.join(root, 'large.txt'), 'x'.repeat(70_000));
  git(root, 'add', 'large.txt');
  const marker = path.join(root, 'unapproved-execution');
  const markerGit = path.join(root, 'git-marker');
  await writeFile(markerGit, `#!/bin/sh\nprintf yes > '${marker}'\n`);
  await chmod(markerGit, 0o755);
  const denied = await inspectGit(
    root,
    { operation: 'status' },
    { gitExecutable: markerGit },
  ).catch((error: unknown) => error);
  assert.ok(denied instanceof Error);
  assert.match(denied.message, /approval/i);
  await assert.rejects(lstat(marker));

  const result = await inspectGit(
    root,
    { operation: 'diff', path: 'large.txt', staged: true },
    { approved: true },
  );
  assert.equal(result.status, 'ok');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 48 * 1024);
  assert.equal(result.truncated, true);
});
