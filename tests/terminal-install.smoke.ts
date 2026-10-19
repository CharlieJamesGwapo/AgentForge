import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { Config } from '../src/core/config.js';
import { sendToolReply, type Protocol } from './helpers/tool-protocol.js';
import {
  writePackedInstallFiles,
  type NpmLockfile,
  type PackedPackageManifest,
} from './helpers/packed-install.js';
const root = process.cwd();
if (process.platform === 'win32')
  throw new Error('Terminal smoke requires a POSIX PTY and Python 3.');
const npmPath = process.env.npm_execpath;
assert.ok(
  npmPath,
  'Run through npm run test:terminal. Python 3 and POSIX PTYs are required.',
);
const scratch = await mkdtemp(
  path.join(tmpdir(), 'agentforge-terminal-install-'),
);
const key = 'terminal-fixture-credential';
let commands = 0,
  requests = 0;
const evidence: { name: string; code: number; batches: number }[] = [];
async function command(
  executable: string,
  args: string[],
  expected = 0,
  cwd?: string,
) {
  commands++;
  const result = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(executable, args, {
      env: { ...process.env, TERMINAL_FIXTURE_KEY: key },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(cwd === undefined ? {} : { cwd }),
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, expected, result.stderr);
  assert.ok(!result.stdout.includes(key));
  assert.ok(!result.stderr.includes(key));
  return result;
}
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    requests++;
    const body = JSON.parse(raw);
    const provider: Protocol =
      req.url === '/v1/responses'
        ? 'openai'
        : req.url === '/v1/messages'
          ? 'anthropic'
          : 'ollama';
    if (!Array.isArray(body.tools)) {
      void sendToolReply(
        res,
        provider,
        [],
        false,
        JSON.stringify({
          subtasks: [
            {
              id: 'read',
              task: 'Read note.txt',
              context: 'Only the assigned local fixture file',
              paths: ['note.txt'],
            },
          ],
        }),
      );
      return;
    }
    const followup =
      provider === 'openai'
        ? body.input.some(
            (item: { type?: string }) => item.type === 'function_call_output',
          )
        : provider === 'anthropic'
          ? body.messages.some(
              (item: { content?: unknown }) =>
                Array.isArray(item.content) &&
                item.content.some(
                  (part: { type?: string }) => part.type === 'tool_result',
                ),
            )
          : body.messages.some(
              (item: { role?: string }) => item.role === 'tool',
            );
    if (followup) assert.match(raw, /PRIVATE FIXTURE CONTENT/);
    const isTask = body.model === 'terminal-task';
    if (isTask) {
      const initialPrompt =
        provider === 'openai'
          ? body.input[0].content
          : body.messages[0].content;
      assert.match(String(initialPrompt), /TERMINAL APPROVED CHECKPOINT/);
      assert.match(String(initialPrompt), /untrusted JSON reference/);
    }
    void sendToolReply(
      res,
      provider,
      followup
        ? []
        : [
            {
              id: 'read-file',
              name: 'project_read',
              arguments: { path: 'note.txt', startLine: 1, lineCount: 5 },
            },
          ],
      Boolean(body.stream),
      JSON.stringify(
        isTask
          ? { answer: 'complete' }
          : {
              status: 'completed',
              summary: 'Read approved fixture',
              paths: ['note.txt'],
            },
      ),
    ).catch(() => res.destroy());
  });
});
try {
  const archive = path.join(scratch, 'archive');
  await mkdir(archive);
  const packed = JSON.parse(
    (
      await command(process.execPath, [
        npmPath,
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        archive,
      ])
    ).stdout,
  )[0];
  const prefix = path.join(scratch, 'install');
  await mkdir(prefix);
  await writePackedInstallFiles({
    prefix,
    tarballPath: path.join(archive, packed.filename),
    packageManifest: JSON.parse(
      await readFile(path.join(root, 'package.json'), 'utf8'),
    ) as PackedPackageManifest,
    sourceLockfile: JSON.parse(
      await readFile(path.join(root, 'package-lock.json'), 'utf8'),
    ) as NpmLockfile,
  });
  await command(
    process.execPath,
    [
      npmPath,
      'ci',
      '--offline',
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
    ],
    0,
    prefix,
  );
  const packageRoot = path.join(
    prefix,
    'node_modules',
    'agentforge-local-toolkit',
  );
  const entry = path.join(packageRoot, 'dist/cli/index.js');
  const { defaultConfig } = (await import(
    pathToFileURL(path.join(packageRoot, 'dist/core/config.js')).href
  )) as { defaultConfig: Config };
  const project = path.join(scratch, 'project');
  await mkdir(project);
  const target = path.join(project, 'note.txt');
  const config = structuredClone(defaultConfig);
  config.permissions = {
    allowTools: true,
    allowProcess: true,
    allowNetwork: true,
    allowWrite: true,
  };
  await writeFile(
    path.join(project, 'agentforge.config.json'),
    JSON.stringify(config),
  );
  await writeFile(target, 'before\n');
  await command('git', ['-C', project, 'init', '--quiet']);
  await command('git', ['-C', project, 'add', '--', 'note.txt']);
  async function tty(
    name: string,
    mode: string,
    args: string[],
    expected: number,
    batches: number,
  ) {
    const result = await command('python3', [
      path.join(root, 'tests/helpers/terminal-pty.py'),
      mode,
      target,
      process.execPath,
      entry,
      '--cwd',
      project,
      ...args,
    ]);
    const terminal = JSON.parse(result.stdout);
    assert.equal(terminal.code, expected, terminal.output);
    assert.equal(terminal.batches, batches, terminal.output);
    evidence.push({ name, code: terminal.code, batches: terminal.batches });
    return terminal.output as string;
  }
  for (const [operation, args] of [
    ['status', []],
    ['diff', ['--path', 'note.txt']],
    ['log', ['--limit', '2']],
    ['branch', []],
  ] as const) {
    const output = await tty(
      `git-${operation}-approved`,
      'approve',
      ['git', operation, ...args, '--execute'],
      0,
      1,
    );
    assert.match(output, /"status": "ok"/);
  }
  await tty('git-denied', 'deny', ['git', 'status', '--execute'], 6, 1);
  await tty('git-cancelled', 'cancel', ['git', 'status', '--execute'], 5, 1);
  const edit = [
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
  assert.match(
    await tty('edit-preview', 'approve', edit, 0, 1),
    /"status": "preview"/,
  );
  assert.match(
    await tty('edit-fail-closed', 'approve', [...edit, '--apply'], 3, 2),
    /"status": "unavailable"/,
  );
  assert.equal(await readFile(target, 'utf8'), 'before\n');
  await tty('edit-denied', 'deny', edit, 6, 1);
  await tty('edit-cancelled', 'cancel', edit, 5, 1);
  assert.match(
    await tty('edit-stale', 'stale', [...edit, '--apply'], 4, 2),
    /"status": "conflict"/,
  );
  assert.equal(
    await readFile(target, 'utf8'),
    'changed by external fixture editor\n',
  );
  await writeFile(target, 'PRIVATE FIXTURE CONTENT\n');
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  config.providers = (['openai', 'anthropic', 'ollama'] as Protocol[]).map(
    (id) => ({
      id,
      model: 'fixture',
      baseUrl: `http://127.0.0.1:${address.port}${id === 'ollama' ? '' : '/v1'}`,
      apiKeyEnv: 'TERMINAL_FIXTURE_KEY',
    }),
  );
  config.orchestration.enabled = true;
  for (const provider of ['openai', 'anthropic', 'ollama']) {
    config.orchestration.planner = { provider };
    config.orchestration.executor = { provider };
    await writeFile(
      path.join(project, 'agentforge.config.json'),
      JSON.stringify(config),
    );
    const args = [
      'orchestrate',
      'run',
      '--task',
      'Read and explain the fixture',
      '--approve-network',
      '--execute',
    ];
    for (const mode of ['approve', 'deny', 'cancel']) {
      const before = requests;
      const output = await tty(
        `${provider}-orchestration-${mode}`,
        mode,
        args,
        mode === 'approve' ? 0 : mode === 'deny' ? 6 : 5,
        1,
      );
      assert.equal(requests - before, mode === 'approve' ? 3 : 2);
      if (mode !== 'approve')
        assert.ok(!output.includes('PRIVATE FIXTURE CONTENT'));
    }
  }
  assert.equal(requests, 21);
  const checkpoint = JSON.parse(
    (
      await command(process.execPath, [
        entry,
        '--cwd',
        project,
        'context',
        'save',
        '--name',
        'terminal reference',
        '--summary',
        'TERMINAL APPROVED CHECKPOINT',
      ])
    ).stdout,
  ) as { id: string };
  await command(process.execPath, [
    entry,
    '--cwd',
    project,
    'context',
    'restore',
    checkpoint.id,
    '--apply',
  ]);
  await writeFile(
    path.join(project, 'answer.schema.json'),
    JSON.stringify({
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    }),
  );
  for (const provider of ['openai', 'anthropic', 'ollama'])
    for (const stream of [false, true]) {
      const args = [
        'task',
        '--task',
        'Read note and return JSON',
        '--provider',
        provider,
        '--model',
        'terminal-task',
        '--approve-network',
        '--execute',
        '--with-context',
        '--schema',
        'answer.schema.json',
        ...(stream ? ['--stream'] : []),
      ];
      for (const mode of ['approve', 'deny', 'cancel']) {
        const before: number = requests;
        const output = await tty(
          `${provider}-task-${stream ? 'stream' : 'ordinary'}-${mode}`,
          mode,
          args,
          mode === 'approve' ? 0 : mode === 'deny' ? 6 : 5,
          1,
        );
        assert.equal(requests - before, mode === 'approve' ? 2 : 1);
        assert.ok(!output.includes('PRIVATE FIXTURE CONTENT'));
        if (mode === 'approve')
          assert.match(output, /"structured":\{"status":"valid"/);
        assert.ok(!output.includes('"type":"text-delta"'));
      }
    }
  assert.equal(requests, 45);
  assert.equal(evidence.length, 38);
  const report = {
    installed: true,
    commands,
    terminalCases: evidence.length,
    fixtureRequests: requests,
    liveProviderRequests: 0,
    evidence,
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  server.closeAllConnections();
  server.close();
  await rm(scratch, { recursive: true, force: true });
}
