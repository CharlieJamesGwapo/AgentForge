import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cliFile = fileURLToPath(new URL('../src/cli/index.ts', import.meta.url));
const temporary = () => mkdtemp(path.join(tmpdir(), 'agentforge-cli-'));
function cli(root: string, args: string[]) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', cliFile, '--cwd', root, '--json', ...args],
    { encoding: 'utf8', timeout: 15000 },
  );
  return {
    ...result,
    data: () =>
      JSON.parse(result.stdout || result.stderr) as Record<string, unknown>,
  };
}

test('help/version are available without project setup', async () => {
  const root = await temporary();
  assert.equal(cli(root, ['--help']).status, 0);
  assert.match(cli(root, ['--version']).stdout, /0\.1\.0-dev\.0/);
  assert.equal(cli(root, ['unknown']).status, 2);
});

test('CLI initializes once, reports status and missing model capability honestly', async () => {
  const root = await temporary();
  assert.equal(cli(root, ['status']).status, 2);
  assert.equal(cli(root, ['init']).data().created, true);
  assert.equal(cli(root, ['init']).data().created, false);
  assert.equal(cli(root, ['status']).status, 0);
  const doctor = cli(root, ['doctor']);
  assert.equal(doctor.status, 0);
  assert.match(doctor.stdout, /unavailable/);
  assert.equal(
    cli(root, ['prompt', '--task', 'Build parser', '--model']).status,
    3,
  );
});

test('CLI config set validates JSON and paths without clobbering configuration', async () => {
  const root = await temporary();
  cli(root, ['init']);
  assert.equal(cli(root, ['config', 'set', 'project', 'my-project']).status, 0);
  assert.equal(
    cli(root, ['config', 'get', 'project']).data().value,
    'my-project',
  );
  assert.equal(
    cli(root, ['config', 'set', 'checkpointDirectory', '../escape']).status,
    2,
  );
  assert.equal(
    cli(root, ['config', 'set', 'permissions.allowProcess', 'true']).status,
    0,
  );
  assert.equal(
    cli(root, ['config', 'set', 'token', 'sk-abcdefghijklmn']).status,
    2,
  );
  assert.ok(
    !cli(root, ['config', 'get', 'sk-abcdefghijklmn']).stderr.includes(
      'sk-abcdefghijklmn',
    ),
  );
});

test('CLI skills, graph, prompt and context work without provider credentials', async () => {
  const root = await temporary();
  cli(root, ['init']);
  const list = cli(root, ['skill', 'list']);
  assert.equal(list.status, 0, list.stderr);
  assert.equal((list.data().skills as unknown[]).length, 13);
  assert.equal(cli(root, ['skill', 'inspect', 'tokensaver']).status, 0);
  assert.equal(cli(root, ['skill', 'validate']).data().valid, true);
  const prompt = cli(root, [
    'prompt',
    '--task',
    'Fix parser; never remove safety checks',
  ]);
  assert.equal(prompt.status, 0);
  assert.match(prompt.stdout, /never remove safety checks/);
  const checkpoint = cli(root, [
    'context',
    'save',
    '--name',
    'parser',
    '--objective',
    'Fix parser',
    '--summary',
    'Ready for tests',
  ]);
  assert.equal(checkpoint.status, 0, checkpoint.stderr);
  const id = checkpoint.data().id as string;
  assert.equal(cli(root, ['context', 'list']).status, 0);
  assert.equal(cli(root, ['context', 'restore', id]).data().applied, false);
  assert.equal(
    cli(root, ['context', 'restore', id, '--apply']).data().applied,
    true,
  );
  const graph = cli(root, ['graph']);
  assert.equal(graph.status, 0, graph.stderr);
  assert.ok(
    (graph.data().files as string[]).includes('agentforge.config.json'),
  );
});

test('verify previews commands; execution requires policy and per-invocation approval', async () => {
  const root = await temporary();
  cli(root, ['init']);
  const checks = [
    {
      name: 'ok',
      command: process.execPath,
      args: ['-e', 'console.log("ok")'],
    },
  ];
  cli(root, ['config', 'set', 'verification.checks', JSON.stringify(checks)]);
  assert.equal(cli(root, ['verify']).data().executed, false);
  assert.equal(cli(root, ['verify', '--execute']).status, 6);
  cli(root, ['config', 'set', 'permissions.allowProcess', 'true']);
  assert.equal(cli(root, ['verify', '--execute']).status, 6);
  assert.equal(cli(root, ['verify', '--execute', '--approve']).status, 0);
  assert.equal(cli(root, ['run', '--execute', '--approve']).status, 0);
  checks[0]!.args = ['-e', 'process.exit(1)'];
  cli(root, ['config', 'set', 'verification.checks', JSON.stringify(checks)]);
  assert.equal(cli(root, ['verify', '--execute', '--approve']).status, 4);
  assert.equal(cli(root, ['run', '--execute', '--approve']).status, 4);
});

test('malformed JSON and error output do not expose input secrets', async () => {
  const root = await temporary();
  await writeFile(
    path.join(root, 'agentforge.config.json'),
    '{"token":"sk-abcdefghijklmn" INVALID}',
  );
  const result = cli(root, ['status']);
  assert.equal(result.status, 2);
  assert.ok(!result.stderr.includes('sk-abcdefghijklmn'));
  assert.match(result.stderr, /Invalid JSON/);
  assert.equal(
    await readFile(path.join(root, 'agentforge.config.json'), 'utf8'),
    '{"token":"sk-abcdefghijklmn" INVALID}',
  );
});

test('doctor identifies unavailable configured binaries without running checks', async () => {
  const root = await temporary();
  cli(root, ['init']);
  const checks = [
    { name: 'missing', command: 'agentforge-binary-not-installed', args: [] },
  ];
  cli(root, ['config', 'set', 'verification.checks', JSON.stringify(checks)]);
  const result = cli(root, ['doctor']);
  assert.equal(result.status, 2);
  assert.equal(result.data().healthy, false);
  assert.ok(
    (result.data().checks as { name: string; status: string }[]).some(
      (check) =>
        check.name === 'executable:missing' && check.status === 'failed',
    ),
  );
});

test('root help distinguishes check execution from per-batch task approval', async () => {
  const root = await temporary();
  const help = cli(root, ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /task --provider/);
  assert.match(help.stdout, /Tool execution requires permissions.allowTools/);
  assert.match(
    help.stdout,
    /Verification execution requires permissions.allowProcess/,
  );
});
