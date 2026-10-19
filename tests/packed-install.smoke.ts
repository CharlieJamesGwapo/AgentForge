import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  access,
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sendToolReply, type Protocol } from './helpers/tool-protocol.js';
const scratch = await mkdtemp(path.join(tmpdir(), 'agentforge-packed-'));
let commands = 0,
  requests = 0;
const key = 'packed-fixture-credential';
const env = { ...process.env, PACKED_FIXTURE_KEY: key };
async function execute(command: string, args: string[], expected = 0) {
  commands++;
  const result = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
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
const npmPath = process.env.npm_execpath;
assert.ok(npmPath, 'Run this smoke check through npm run test:packed.');
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    try {
      requests++;
      const body = JSON.parse(raw);
      const provider: Protocol =
        req.url === '/v1/responses'
          ? 'openai'
          : req.url === '/v1/messages'
            ? 'anthropic'
            : 'ollama';
      if (body.model === 'packed-planner') {
        assert.ok(!Array.isArray(body.tools));
        void sendToolReply(
          res,
          provider,
          [],
          false,
          JSON.stringify({
            subtasks: [
              {
                id: 'explain',
                task: 'Explain the supplied fixture context',
                context: 'Explicit fixture material',
                paths: ['README.md'],
              },
            ],
          }),
        ).catch(() => res.destroy());
        return;
      }
      if (body.model === 'packed-executor') {
        assert.ok(Array.isArray(body.tools));
        assert.ok(!JSON.stringify(body.tools).includes('verification_check'));
        void sendToolReply(
          res,
          provider,
          [],
          false,
          JSON.stringify({
            status: 'completed',
            summary: 'Validated fixture conversation',
            paths: ['README.md'],
          }),
        ).catch(() => res.destroy());
        return;
      }
      assert.ok(Array.isArray(body.tools));
      assert.ok(!JSON.stringify(body.tools).includes('resultSchema'));
      const task =
        provider === 'openai'
          ? body.input[0].content
          : body.messages[0].content;
      const preview = String(task).includes('preview-file-tools');
      if (!preview) assert.match(String(task), /Acceptance criteria/);
      void sendToolReply(
        res,
        provider,
        preview
          ? [
              {
                id: 'read',
                name: 'project_read',
                arguments: { path: 'README.md', startLine: 1, lineCount: 2 },
              },
            ]
          : [],
        Boolean(body.stream),
      ).catch(() => res.destroy());
    } catch {
      res.writeHead(500);
      res.end('{}');
    }
  });
});
try {
  const archiveDir = path.join(scratch, 'archive');
  await mkdir(archiveDir);
  const pack = await execute(process.execPath, [
    npmPath,
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    archiveDir,
  ]);
  const metadata = JSON.parse(pack.stdout)[0] as {
    filename: string;
    files: { path: string }[];
  };
  const paths = new Set(metadata.files.map((file) => file.path));
  for (const file of [
    'package.json',
    'LICENSE',
    'README.md',
    'dist/cli/index.js',
    'dist/cli/index.d.ts',
    'dist/cli/index.js.map',
    'src/cli/index.ts',
    'schemas/config.schema.json',
    'schemas/checkpoint.schema.json',
    'schemas/skill.schema.json',
    'examples/answer.schema.json',
    'docs/development/testing.md',
    'docs/development/dependency-management.md',
    'docs/development/release-process.md',
  ])
    assert.ok(paths.has(file), `Missing packaged asset: ${file}`);
  assert.equal(
    metadata.files.filter((file) =>
      /^skills\/[^/]+\/SKILL\.md$/.test(file.path),
    ).length,
    13,
  );
  assert.equal(
    metadata.files.filter((file) =>
      /^skills\/[^/]+\/skill\.json$/.test(file.path),
    ).length,
    13,
  );
  assert.deepEqual(
    metadata.files.filter(
      (file) =>
        file.path.startsWith('docs/development/') &&
        ![
          'docs/development/testing.md',
          'docs/development/dependency-management.md',
          'docs/development/release-process.md',
        ].includes(file.path),
    ),
    [],
    'Historical implementation plans entered the archive',
  );
  assert.deepEqual(
    metadata.files.filter((file) =>
      /^(?:tests|work|outputs|node_modules|\.git|\.github|\.agentforge)\/|(?:^|\/)\.env(?:\.|$)|\.(?:log|tgz)$/.test(
        file.path,
      ),
    ),
    [],
    'Development state or local artifacts entered the archive',
  );
  for (const file of [
    'dist/engines/task-runtime.js',
    'dist/engines/project-files.js',
    'dist/cli/task.js',
    'dist/engines/git-inspection.js',
    'dist/engines/project-edit.js',
    'dist/engines/orchestration.js',
    'dist/cli/git.js',
    'dist/cli/edit.js',
    'dist/cli/orchestrate.js',
  ])
    assert.ok(
      metadata.files.some((entry) => entry.path === file),
      file,
    );
  const prefix = path.join(scratch, 'install');
  await mkdir(prefix);
  await execute(process.execPath, [
    npmPath,
    'install',
    '--prefix',
    prefix,
    '--offline',
    '--ignore-scripts',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    path.join(archiveDir, metadata.filename),
  ]);
  const entry = path.join(
    prefix,
    'node_modules/agentforge-local-toolkit/dist/cli/index.js',
  );
  const installedMetadata = JSON.parse(
    await readFile(
      path.join(prefix, 'node_modules/agentforge-local-toolkit/package.json'),
      'utf8',
    ),
  );
  assert.equal(installedMetadata.private, true);
  assert.equal(installedMetadata.bin.agentforge, 'dist/cli/index.js');
  assert.equal(installedMetadata.exports, undefined);
  const installedBin = path.join(
    prefix,
    'node_modules/.bin',
    process.platform === 'win32' ? 'agentforge.cmd' : 'agentforge',
  );
  await access(installedBin);
  if (process.platform !== 'win32') await execute(installedBin, ['--help']);
  const project = path.join(scratch, 'project');
  await mkdir(project);
  await writeFile(path.join(project, 'README.md'), 'PACKED PRIVATE CONTENT\n');
  async function cli(args: string[], code = 0) {
    return execute(process.execPath, [entry, '--cwd', project, ...args], code);
  }
  await cli(['--help']);
  await cli(['--version']);
  await cli(['init']);
  await cli(['status']);
  await cli(['skill', 'list']);
  await cli(['skill', 'validate']);
  await cli(['provider', 'list']);
  await cli(['tools', 'list']);
  await cli(['task', '--help']);
  await cli(['git', '--help']);
  await cli(['edit', '--help']);
  await cli(['orchestrate', '--help']);
  const gitPreview = await cli(['git', 'status']);
  assert.equal(JSON.parse(gitPreview.stdout).executed, false);
  const editCapabilities = await cli(['edit', 'capabilities']);
  assert.equal(
    JSON.parse(editCapabilities.stdout).atomicConflictSafeReplace,
    false,
  );
  const editPreview = await cli([
    'edit',
    'replace',
    '--path',
    'README.md',
    '--old',
    'PRIVATE',
    '--new',
    'PUBLIC',
  ]);
  assert.equal(JSON.parse(editPreview.stdout).executed, false);
  await cli(['git', 'status', '--execute'], 6);
  await cli(
    [
      'edit',
      'replace',
      '--path',
      'README.md',
      '--old',
      'PRIVATE',
      '--new',
      'PUBLIC',
      '--execute',
    ],
    6,
  );
  assert.equal(
    await readFile(path.join(project, 'README.md'), 'utf8'),
    'PACKED PRIVATE CONTENT\n',
  );
  const orchestrationStatus = await cli(['orchestrate', 'status']);
  assert.equal(JSON.parse(orchestrationStatus.stdout).enabled, false);
  await cli(
    [
      'orchestrate',
      'run',
      '--task',
      'Disabled orchestration',
      '--approve-network',
    ],
    6,
  );
  await cli(['task', '--task', 'No network', '--provider', 'ollama'], 6);
  assert.equal(requests, 0);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await cli([
    'config',
    'set',
    'providers',
    JSON.stringify(
      ['openai', 'anthropic', 'ollama'].map((id) => ({
        id,
        model: 'fixture',
        baseUrl: `http://127.0.0.1:${address.port}${id === 'ollama' ? '' : '/v1'}`,
        apiKeyEnv: 'PACKED_FIXTURE_KEY',
      })),
    ),
  ]);
  await cli(['config', 'set', 'permissions.allowNetwork', 'true']);
  await writeFile(
    path.join(project, 'answer.json'),
    JSON.stringify({
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    }),
  );
  for (const provider of ['openai', 'anthropic', 'ollama'])
    for (const stream of [false, true]) {
      const result = await cli([
        'task',
        '--task',
        'Return JSON',
        '--provider',
        provider,
        '--approve-network',
        '--schema',
        'answer.json',
        ...(stream ? ['--stream'] : []),
      ]);
      assert.ok(!result.stdout.includes('"type":"text-delta"'));
      assert.match(result.stdout, /"status":"valid"/);
      const pending = await cli(
        [
          'tools',
          'run',
          '--task',
          'preview-file-tools',
          '--provider',
          provider,
          '--approve-network',
          ...(stream ? ['--stream'] : []),
        ],
        6,
      );
      assert.match(pending.stdout, /approval-required/);
      assert.ok(!pending.stdout.includes('PACKED PRIVATE CONTENT'));
    }
  assert.equal(requests, 12);
  await cli(['config', 'set', 'orchestration.enabled', 'true']);
  for (const provider of ['openai', 'anthropic', 'ollama']) {
    await cli([
      'config',
      'set',
      'orchestration.planner',
      JSON.stringify({ provider, model: 'packed-planner' }),
    ]);
    await cli([
      'config',
      'set',
      'orchestration.executor',
      JSON.stringify({ provider, model: 'packed-executor' }),
    ]);
    const result = await cli([
      'orchestrate',
      'run',
      '--task',
      'Explain the explicit fixture context',
      '--approve-network',
    ]);
    const terminal = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((event) => event.type === 'orchestration-result');
    assert.ok(terminal);
    assert.equal(terminal.result.status, 'completed');
    assert.equal(terminal.result.subtasks.length, 1);
  }
  assert.equal(requests, 18);
  console.log(
    JSON.stringify(
      {
        installed: true,
        archiveFiles: metadata.files.length,
        commands,
        fixtureRequests: requests,
        providers: 3,
        modes: 2,
        liveProviderRequests: 0,
      },
      null,
      2,
    ),
  );
} finally {
  server.closeAllConnections();
  server.close();
  await rm(scratch, { recursive: true, force: true });
}
