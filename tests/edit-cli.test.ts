import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Command } from 'commander';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { initProject, setConfig } from '../src/core/config.js';
import { registerEditCommands } from '../src/cli/edit.js';

async function makeRoot(t: {
  after(callback: () => void | Promise<void>): void;
}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'agentforge-edit-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  await writeFile(path.join(root, 'note.txt'), 'before\n');
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
  let promptText = '';
  let answeredPrompts = 0;
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
      promptText += chunk.toString('utf8');
      const prompts = [
        ...promptText.matchAll(/Type approve ([a-f0-9-]{16,})/g),
      ];
      while (answeredPrompts < prompts.length) {
        const matchedId = prompts[answeredPrompts]?.[1];
        answeredPrompts += 1;
        if (matchedId) {
          const answer =
            options.answer === 'wrong' ? '0'.repeat(64) : matchedId;
          setImmediate(() => fakeInput?.write(`approve ${answer}\n`));
        }
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
    registerEditCommands(
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
      prompts: answeredPrompts,
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

test('edit capabilities report the local apply limit without contacting providers', async (t) => {
  const root = await makeRoot(t);
  const result = await runCommand(root, ['edit', 'capabilities']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.length, 1);
  assert.equal(result.output[0]?.backend, 'node');
  assert.equal(result.output[0]?.atomicConflictSafeReplace, false);
  assert.equal(result.output[0]?.status, 'unavailable');
  assert.equal(typeof result.output[0]?.reason, 'string');
});

test('replace CLI shows an inert exact operation preview and never reads or changes the target before approval', async (t) => {
  const root = await makeRoot(t);
  const original = await readFile(path.join(root, 'note.txt'));
  const result = await runCommand(root, [
    'edit',
    'replace',
    '--path',
    'note.txt',
    '--old',
    'before',
    '--new',
    'after',
  ]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.output.length, 1);
  const preview = result.output[0]!;
  assert.equal(preview.executed, false);
  assert.equal(preview.operation, 'replace');
  assert.equal(preview.path, 'note.txt');
  assert.equal(typeof preview.approvalId, 'string');
  assert.match(JSON.stringify(preview.review), /before/);
  assert.match(JSON.stringify(preview.review), /after/);
  assert.deepEqual(await readFile(path.join(root, 'note.txt')), original);
});

test('patch CLI loads the named patch and keeps its first batch inert until typed approval', async (t) => {
  const root = await makeRoot(t);
  const original = await readFile(path.join(root, 'note.txt'));
  await writeFile(
    path.join(root, 'change.patch'),
    [
      '--- a/note.txt',
      '+++ b/note.txt',
      '@@ -1 +1 @@',
      '-before',
      '+after',
      '',
    ].join('\n'),
  );
  const result = await runCommand(root, [
    'edit',
    'patch',
    '--path',
    'note.txt',
    '--patch-file',
    'change.patch',
  ]);

  assert.equal(result.exitCode, 0);
  assert.equal(result.output[0]?.executed, false);
  assert.equal(result.output[0]?.operation, 'patch');
  assert.equal(result.output[0]?.path, 'note.txt');
  assert.deepEqual(await readFile(path.join(root, 'note.txt')), original);
});

test('execution needs tool permission and terminal approval, and a wrong or piped answer has no effect', async (t) => {
  const root = await makeRoot(t);
  const original = await readFile(path.join(root, 'note.txt'));
  const args = [
    'edit',
    'replace',
    '--path',
    'note.txt',
    '--old',
    'before',
    '--new',
    'after',
    '--execute',
  ];

  const permissionDenied = await runCommand(root, args);
  assert.equal(permissionDenied.exitCode, 6);
  assert.equal(permissionDenied.output[0]?.executed, false);

  await setConfig(root, 'permissions.allowTools', true);
  const nonInteractive = await runCommand(root, args);
  assert.equal(nonInteractive.exitCode, 6);
  assert.equal(nonInteractive.output[0]?.executed, false);

  const wrong = await runCommand(root, args, {
    terminal: true,
    answer: 'wrong',
  });
  assert.equal(wrong.exitCode, 6);
  assert.equal(wrong.output[0]?.executed, false);

  const approved = await runCommand(root, args, { terminal: true });
  assert.equal(approved.exitCode, 0);
  assert.ok(
    approved.output.some((event) => String(event.diff).includes('-before')),
  );
  assert.ok(
    approved.output.some((event) => String(event.diff).includes('+after')),
  );
  assert.deepEqual(await readFile(path.join(root, 'note.txt')), original);
});

test('apply needs allowWrite and a second fresh exact approval, then reports unsupported without writing', async (t) => {
  const root = await makeRoot(t);
  const original = await readFile(path.join(root, 'note.txt'));
  const args = [
    'edit',
    'replace',
    '--path',
    'note.txt',
    '--old',
    'before',
    '--new',
    'after',
    '--execute',
    '--apply',
  ];
  await setConfig(root, 'permissions.allowTools', true);

  const writeDenied = await runCommand(root, args);
  assert.equal(writeDenied.exitCode, 6);
  assert.equal(writeDenied.prompts, 0);
  assert.deepEqual(await readFile(path.join(root, 'note.txt')), original);

  await setConfig(root, 'permissions.allowWrite', true);
  const applied = await runCommand(root, args, { terminal: true });
  assert.equal(applied.exitCode, 3);
  assert.equal(applied.prompts, 2);
  assert.ok(
    applied.output.some((event) => String(event.diff).includes('-before')),
  );
  assert.equal(applied.output.at(-1)?.status, 'unavailable');
  assert.deepEqual(await readFile(path.join(root, 'note.txt')), original);
});
