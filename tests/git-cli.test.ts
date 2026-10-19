import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { Command } from 'commander';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { initProject, setConfig } from '../src/core/config.js';
import { registerGitCommands } from '../src/cli/git.js';

async function makeRoot(t: {
  after(callback: () => void | Promise<void>): void;
}) {
  const root = await mkdtemp(path.join(tmpdir(), 'agentforge-git-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  const initialized = spawnSync('git', ['-C', root, 'init', '--quiet'], {
    encoding: 'utf8',
  });
  assert.equal(initialized.status, 0, initialized.stderr);
  await writeFile(path.join(root, 'one.txt'), 'local file\n');
  return root;
}

async function runCommand(
  root: string,
  args: string[],
  options: { terminal?: boolean; answer?: 'exact' | 'wrong' } = {},
) {
  const output: string[] = [];
  const previousLog = console.log;
  const previousExitCode = process.exitCode;
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
  const stderrDescriptor = Object.getOwnPropertyDescriptor(process, 'stderr');
  let fakeInput: PassThrough | undefined;
  let fakeError: PassThrough | undefined;
  if (options.terminal) {
    fakeInput = new PassThrough();
    fakeError = new PassThrough();
    Object.defineProperty(fakeInput, 'isTTY', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(fakeError, 'isTTY', {
      configurable: true,
      value: true,
    });
    fakeError.on('data', (chunk: Buffer) => {
      const prompt = chunk.toString('utf8');
      const match = /Type approve ([a-f0-9]+) to execute this batch/.exec(
        prompt,
      );
      if (match) {
        const answer = options.answer === 'wrong' ? '0'.repeat(64) : match[1];
        setImmediate(() => fakeInput?.end(`approve ${answer}\n`));
      }
    });
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: fakeInput,
    });
    Object.defineProperty(process, 'stderr', {
      configurable: true,
      value: fakeError,
    });
  }
  console.log = (...values: unknown[]) => output.push(values.join(' '));
  process.exitCode = 0;
  try {
    const program = new Command()
      .exitOverride()
      .configureOutput({ writeErr: () => {}, outputError: () => {} });
    registerGitCommands(
      program,
      async () => root,
      new AbortController().signal,
    );
    await program.parseAsync(['node', 'agentforge', ...args]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    return {
      output: output.map(
        (value) => JSON.parse(value) as Record<string, unknown>,
      ),
      exitCode: process.exitCode ?? 0,
    };
  } finally {
    console.log = previousLog;
    process.exitCode = previousExitCode;
    if (stdinDescriptor)
      Object.defineProperty(process, 'stdin', stdinDescriptor);
    if (stderrDescriptor)
      Object.defineProperty(process, 'stderr', stderrDescriptor);
    fakeInput?.destroy();
    fakeError?.destroy();
  }
}

test('Git CLI previews offline without executing and includes the exact operation scope', async (t) => {
  const root = await makeRoot(t);
  const preview = await runCommand(root, ['git', 'diff', '--path', 'one.txt']);
  assert.equal(preview.exitCode, 0);
  assert.equal(preview.output.length, 1);
  const report = preview.output[0]!;
  assert.equal(report.executed, false);
  assert.equal(report.operation, 'diff');
  assert.equal(
    (report.calls as { arguments: Record<string, unknown> }[])[0]!.arguments
      .path,
    'one.txt',
  );
  assert.equal(typeof report.approvalId, 'string');
  assert.ok(Array.isArray(report.review));
});

test('Git CLI requires both process permissions and a terminal exact approval before execution', async (t) => {
  const root = await makeRoot(t);

  const processDenied = await runCommand(root, ['git', 'status', '--execute']);
  assert.equal(processDenied.exitCode, 6);
  assert.equal(processDenied.output[0]?.executed, false);
  assert.match(String(processDenied.output[0]?.blocked), /allowProcess/);

  await setConfig(root, 'permissions.allowProcess', true);
  const toolsDenied = await runCommand(root, ['git', 'status', '--execute']);
  assert.equal(toolsDenied.exitCode, 6);
  assert.match(String(toolsDenied.output[0]?.blocked), /allowTools/);

  await setConfig(root, 'permissions.allowTools', true);
  const nonInteractive = await runCommand(root, ['git', 'status', '--execute']);
  assert.equal(nonInteractive.exitCode, 6);
  assert.equal(nonInteractive.output[0]?.executed, false);

  const wrong = await runCommand(root, ['git', 'status', '--execute'], {
    terminal: true,
    answer: 'wrong',
  });
  assert.equal(wrong.exitCode, 6);
  assert.equal(wrong.output[0]?.executed, false);

  const approved = await runCommand(root, ['git', 'status', '--execute'], {
    terminal: true,
    answer: 'exact',
  });
  assert.equal(approved.exitCode, 0);
  assert.equal(approved.output.at(-1)?.executed, true);
  assert.equal(approved.output.at(-1)?.status, 'ok');
});
