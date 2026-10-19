import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  runChecks,
  runWorkflow,
  type VerificationCheck,
  type VerificationOptions,
} from '../src/engines/verification.js';

const baseOptions: VerificationOptions = {
  approved: true,
  timeoutMs: 2_000,
  maxOutputBytes: 16_384,
};

async function makeRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentforge-verify-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function nodeCheck(
  name: string,
  code: string,
  args: string[] = [],
): VerificationCheck {
  return { name, command: process.execPath, args: ['-e', code, ...args] };
}

test('runChecks distinguishes passing, failing, and unavailable executables', async (t) => {
  const root = await makeRoot(t);
  const results = await runChecks(
    root,
    [
      nodeCheck('pass', "process.stdout.write('ok')"),
      nodeCheck('fail', "process.stderr.write('bad'); process.exit(7)"),
      {
        name: 'missing',
        command: 'agentforge-command-that-does-not-exist',
        args: [],
      },
    ],
    baseOptions,
  );

  assert.deepEqual(
    results.map(({ status, exitCode }) => [status, exitCode]),
    [
      ['passed', 0],
      ['failed', 7],
      ['unavailable', null],
    ],
  );
  assert.equal(results[0]?.stdout, 'ok');
  assert.equal(results[1]?.stderr, 'bad');

  const [boundedUnavailable] = await runChecks(
    root,
    [
      {
        name: 'short diagnostic',
        command: 'agentforge-command-that-does-not-exist',
        args: [],
      },
    ],
    { ...baseOptions, maxOutputBytes: 1 },
  );
  assert.equal(boundedUnavailable?.status, 'unavailable');
  assert.ok(
    Buffer.byteLength(boundedUnavailable?.stdout ?? '') +
      Buffer.byteLength(boundedUnavailable?.stderr ?? '') <=
      1,
  );
});

test('runChecks passes shell metacharacters as literal arguments', async (t) => {
  const root = await makeRoot(t);
  const marker = path.join(root, 'created-by-shell');
  const literal = `$(touch ${marker})`;
  const [result] = await runChecks(
    root,
    [
      nodeCheck(
        'literal argument',
        'process.stdout.write(process.argv[1] ?? "")',
        [literal],
      ),
    ],
    baseOptions,
  );

  assert.equal(result?.status, 'passed');
  assert.equal(result?.stdout, literal);
  await assert.rejects(stat(marker), { code: 'ENOENT' });
});

test('runChecks requires approval and validates every check before starting any process', async (t) => {
  const root = await makeRoot(t);
  const marker = path.join(root, 'must-not-exist');
  const first = nodeCheck(
    'would run',
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
  );

  await assert.rejects(
    runChecks(root, [first], { ...baseOptions, approved: false }),
    /approval/i,
  );
  await assert.rejects(
    runChecks(
      root,
      [first, { name: 'bad', command: '', args: [] }],
      baseOptions,
    ),
    /command/i,
  );
  await assert.rejects(
    runChecks(root, [first], { ...baseOptions, timeoutMs: 300_001 }),
    /timeoutMs/i,
  );
  await assert.rejects(
    runChecks(root, [first], {
      ...baseOptions,
      maxOutputBytes: 1024 * 1024 + 1,
    }),
    /maxOutputBytes/i,
  );
  await assert.rejects(
    runChecks(
      root,
      [
        first,
        nodeCheck('oversized args', 'process.exit(0)', ['x'.repeat(64 * 1024)]),
      ],
      baseOptions,
    ),
    /65536 bytes/i,
  );
  await assert.rejects(stat(marker), { code: 'ENOENT' });
});

test('runChecks stops a process at its timeout and output limit', async (t) => {
  const root = await makeRoot(t);
  const [timeoutResult] = await runChecks(
    root,
    [nodeCheck('slow', 'setTimeout(() => {}, 10_000)')],
    { ...baseOptions, timeoutMs: 30 },
  );
  const [outputResult] = await runChecks(
    root,
    [nodeCheck('large output', 'process.stdout.write("x".repeat(100_000))')],
    { ...baseOptions, maxOutputBytes: 100 },
  );

  assert.equal(timeoutResult?.status, 'timed-out');
  assert.equal(outputResult?.status, 'output-limit');
  assert.ok(
    Buffer.byteLength(outputResult?.stdout ?? '') +
      Buffer.byteLength(outputResult?.stderr ?? '') <=
      100,
  );
});

test('runChecks kills the POSIX process group, including grandchildren, on timeout', async (t) => {
  if (process.platform === 'win32') {
    t.skip(
      'node:child_process does not expose POSIX process group control on Windows.',
    );
    return;
  }
  const root = await makeRoot(t);
  const marker = path.join(root, 'grandchild-survived');
  const childCode = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 300)`;
  const parentCode = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' }); setTimeout(() => {}, 10_000)`;
  const [result] = await runChecks(
    root,
    [nodeCheck('process tree', parentCode)],
    { ...baseOptions, timeoutMs: 30 },
  );

  assert.equal(result?.status, 'timed-out');
  await new Promise((resolve) => setTimeout(resolve, 350));
  await assert.rejects(stat(marker), { code: 'ENOENT' });
});

test('runChecks returns on timeout when a detached descendant inherits output pipes', async (t) => {
  if (process.platform === 'win32') {
    t.skip('The detached process regression relies on POSIX process groups.');
    return;
  }
  const root = await makeRoot(t);
  const descendantCode = 'setTimeout(() => {}, 1_500)';
  const parentCode = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], { detached: true, stdio: 'inherit' })`;
  const startedAt = Date.now();
  const [result] = await runChecks(
    root,
    [nodeCheck('detached inherited pipes', parentCode)],
    { ...baseOptions, timeoutMs: 100 },
  );
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result?.status, 'timed-out');
  assert.ok(elapsedMs < 800, `check took ${elapsedMs}ms to return`);
});

test('runChecks handles cancellation and redacts credential text', async (t) => {
  const root = await makeRoot(t);
  const controller = new AbortController();
  const pending = runChecks(
    root,
    [nodeCheck('cancelled', 'setTimeout(() => {}, 10_000)')],
    { ...baseOptions, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 25);
  const [cancelled] = await pending;

  const secret = 'agentforge_test_key_123456789';
  process.env.AGENTFORGE_TEST_SECRET = secret;
  try {
    const [redacted] = await runChecks(
      root,
      [
        nodeCheck(
          'redaction',
          `console.log('api_key=${secret}'); console.log(JSON.stringify({ token: '${secret}' })); console.log(process.env.AGENTFORGE_TEST_SECRET ?? 'missing')`,
        ),
      ],
      baseOptions,
    );
    assert.equal(cancelled?.status, 'cancelled');
    assert.equal(redacted?.status, 'passed');
    assert.ok(!redacted?.stdout.includes(secret));
    assert.match(redacted?.stdout ?? '', /\[REDACTED\]/);
    assert.match(redacted?.stdout ?? '', /missing/);
  } finally {
    delete process.env.AGENTFORGE_TEST_SECRET;
  }
});

test('runChecks redacts an unterminated private-key block from diagnostics', async (t) => {
  const root = await makeRoot(t);
  const secret = 'LEAKED_PRIVATE_MATERIAL';
  const output = `-----BEGIN PRIVATE KEY-----\n${secret}`;
  const [result] = await runChecks(
    root,
    [
      nodeCheck(
        'partial private key',
        `process.stdout.write(${JSON.stringify(output)})`,
      ),
    ],
    baseOptions,
  );

  assert.equal(result?.status, 'passed');
  assert.ok(!result?.stdout.includes(secret));
  assert.equal(result?.stdout, '[REDACTED PRIVATE KEY]');
});

test('runWorkflow stops on success and bounds reruns after identical failures', async (t) => {
  const root = await makeRoot(t);
  const success = await runWorkflow(
    root,
    [nodeCheck('pass', 'process.exit(0)')],
    {
      ...baseOptions,
      maxIterations: 5,
      maxDurationMs: 5_000,
    },
  );
  const stalled = await runWorkflow(
    root,
    [nodeCheck('repeat', "console.error('same'); process.exit(1)")],
    {
      ...baseOptions,
      maxIterations: 5,
      maxDurationMs: 5_000,
    },
  );

  assert.equal(success.status, 'passed');
  assert.equal(success.iterations.length, 1);
  assert.equal(stalled.status, 'stalled');
  assert.equal(stalled.iterations.length, 2);
});

test('runWorkflow enforces iteration and total-duration limits', async (t) => {
  const root = await makeRoot(t);
  const varyingFailure = nodeCheck(
    'changes each run',
    "const fs = require('node:fs'); const file = process.argv[1]; const n = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) + 1 : 1; fs.writeFileSync(file, String(n)); console.log(n); process.exit(1)",
    [path.join(root, 'count')],
  );
  const bounded = await runWorkflow(root, [varyingFailure], {
    ...baseOptions,
    maxIterations: 3,
    maxDurationMs: 5_000,
  });
  const limited = await runWorkflow(
    root,
    [nodeCheck('slow', 'setTimeout(() => {}, 10_000)')],
    {
      ...baseOptions,
      timeoutMs: 2_000,
      maxIterations: 5,
      maxDurationMs: 30,
    },
  );

  assert.equal(bounded.status, 'failed');
  assert.equal(bounded.iterations.length, 3);
  assert.equal(limited.status, 'time-limit');
  assert.equal(limited.iterations.length, 1);
});

test('runWorkflow rejects empty check lists and invalid loop bounds', async (t) => {
  const root = await makeRoot(t);
  const options = { ...baseOptions, maxIterations: 1, maxDurationMs: 100 };

  await assert.rejects(runWorkflow(root, [], options), /at least one/i);
  await assert.rejects(
    runWorkflow(root, [nodeCheck('pass', 'process.exit(0)')], {
      ...options,
      maxIterations: 11,
    }),
    /maxIterations/i,
  );
  await assert.rejects(
    runWorkflow(root, [nodeCheck('pass', 'process.exit(0)')], {
      ...options,
      maxDurationMs: 600_001,
    }),
    /maxDurationMs/i,
  );
});

test('runWorkflow stops its current check when its signal is aborted', async (t) => {
  const root = await makeRoot(t);
  const controller = new AbortController();
  const pending = runWorkflow(
    root,
    [nodeCheck('long', 'setTimeout(() => {}, 10_000)')],
    {
      ...baseOptions,
      signal: controller.signal,
      maxIterations: 5,
      maxDurationMs: 5_000,
    },
  );
  setTimeout(() => controller.abort(), 25);
  const result = await pending;

  assert.equal(result.status, 'cancelled');
  assert.equal(result.iterations.length, 1);
  assert.equal(result.iterations[0]?.[0]?.status, 'cancelled');
});
