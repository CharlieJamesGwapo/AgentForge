import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Readable } from 'node:stream';

export type VerificationCheck = {
  name: string;
  command: string;
  args: string[];
};
export type VerificationOptions = {
  approved: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
};
export type CheckResult = {
  name: string;
  status:
    | 'passed'
    | 'failed'
    | 'timed-out'
    | 'cancelled'
    | 'unavailable'
    | 'output-limit';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};
export type WorkflowResult = {
  status: 'passed' | 'failed' | 'cancelled' | 'stalled' | 'time-limit';
  iterations: CheckResult[][];
};

export type WorkflowOptions = VerificationOptions & {
  maxIterations: number;
  maxDurationMs: number;
};

const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_CHECKS = 100;
const MAX_ARGUMENTS_PER_CHECK = 256;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_ITERATIONS = 10;
const MAX_WORKFLOW_DURATION_MS = 600_000;
const SENSITIVE_ENVIRONMENT_NAME =
  /(?:KEY|TOKEN|SECRET|PASS|CREDENTIAL|AUTH|COOKIE|PRIVATE|DATABASE_URL|CONNECTION_STRING)/i;
const ALLOWED_ENVIRONMENT_NAMES = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
]);
type RunningProcess = ChildProcessByStdio<null, Readable, Readable>;

function validateChecks(checks: VerificationCheck[]): void {
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new Error('At least one verification check is required.');
  }
  if (checks.length > MAX_CHECKS) {
    throw new RangeError(
      `No more than ${MAX_CHECKS} verification checks may run at once.`,
    );
  }
  for (const [index, check] of checks.entries()) {
    if (typeof check !== 'object' || check === null)
      throw new TypeError(`Check ${index + 1} must be an object.`);
    if (
      typeof check.name !== 'string' ||
      check.name.trim().length === 0 ||
      check.name.includes('\0')
    ) {
      throw new TypeError(`Check ${index + 1} must have a non-empty name.`);
    }
    if (Buffer.byteLength(check.name) > 256) {
      throw new RangeError(
        `Check ${index + 1} name must be at most 256 bytes.`,
      );
    }
    if (
      typeof check.command !== 'string' ||
      check.command.trim().length === 0 ||
      check.command.includes('\0')
    ) {
      throw new TypeError(`Check ${index + 1} must have a non-empty command.`);
    }
    if (Buffer.byteLength(check.command) > 4096) {
      throw new RangeError(
        `Check ${index + 1} command must be at most 4096 bytes.`,
      );
    }
    if (
      !Array.isArray(check.args) ||
      check.args.some(
        (argument) => typeof argument !== 'string' || argument.includes('\0'),
      )
    ) {
      throw new TypeError(
        `Check ${index + 1} args must be an array of strings without null bytes.`,
      );
    }
    if (check.args.length > MAX_ARGUMENTS_PER_CHECK) {
      throw new RangeError(
        `Check ${index + 1} may have at most ${MAX_ARGUMENTS_PER_CHECK} args.`,
      );
    }
    const argumentBytes = check.args.reduce(
      (total, argument) => total + Buffer.byteLength(argument),
      Buffer.byteLength(check.command),
    );
    if (argumentBytes > MAX_ARGUMENT_BYTES) {
      throw new RangeError(
        `Check ${index + 1} command and args must be at most ${MAX_ARGUMENT_BYTES} bytes.`,
      );
    }
  }
}

function validateOptions(options: VerificationOptions): void {
  if (typeof options !== 'object' || options === null)
    throw new TypeError('Verification options are required.');
  if (options.approved !== true)
    throw new Error(
      'Approval is required before verification commands can run.',
    );
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new RangeError(
      `timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`,
    );
  }
  if (
    !Number.isInteger(options.maxOutputBytes) ||
    options.maxOutputBytes < 1 ||
    options.maxOutputBytes > MAX_OUTPUT_BYTES
  ) {
    throw new RangeError(
      `maxOutputBytes must be an integer between 1 and ${MAX_OUTPUT_BYTES}.`,
    );
  }
  if (
    options.signal !== undefined &&
    (typeof options.signal.aborted !== 'boolean' ||
      typeof options.signal.addEventListener !== 'function')
  ) {
    throw new TypeError('signal must be an AbortSignal.');
  }
}

function validateWorkflowOptions(options: WorkflowOptions): void {
  validateOptions(options);
  if (
    !Number.isInteger(options.maxIterations) ||
    options.maxIterations < 1 ||
    options.maxIterations > MAX_ITERATIONS
  ) {
    throw new RangeError(
      `maxIterations must be an integer between 1 and ${MAX_ITERATIONS}.`,
    );
  }
  if (
    !Number.isInteger(options.maxDurationMs) ||
    options.maxDurationMs < 1 ||
    options.maxDurationMs > MAX_WORKFLOW_DURATION_MS
  ) {
    throw new RangeError(
      `maxDurationMs must be an integer between 1 and ${MAX_WORKFLOW_DURATION_MS}.`,
    );
  }
}

async function validateWorkingDirectory(root: string): Promise<string> {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new TypeError('Verification root must be an absolute path.');
  }
  let resolved: string;
  try {
    resolved = await realpath(root);
  } catch {
    throw new Error('Verification root must be an accessible directory.');
  }
  const info = await stat(resolved).catch(() => null);
  if (info === null || !info.isDirectory())
    throw new Error('Verification root must be an accessible directory.');
  return resolved;
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      ALLOWED_ENVIRONMENT_NAMES.has(name.toUpperCase())
    )
      environment[name] = value;
  }
  return environment;
}

function knownSecrets(): string[] {
  return Object.entries(process.env)
    .filter(
      ([name, value]) =>
        SENSITIVE_ENVIRONMENT_NAME.test(name) && Boolean(value),
    )
    .map(([, value]) => value as string)
    .sort((left, right) => right.length - left.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redact(text: string, secrets: string[]): string {
  let redacted = text
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|AKIA[0-9A-Z]{16})\b/g,
      '[REDACTED]',
    )
    .replace(
      /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      '[REDACTED]',
    )
    .replace(
      /(["']?)\b(api[_-]?(?:key|token)|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|password|passwd|token|secret(?:[_-]?key)?|credential|private[_-]?key)\1(\s*[:=]\s*)(["'])([^"'\r\n]*)\4/gi,
      '$1$2$1$3[REDACTED]',
    )
    .replace(
      /(["']?)\b(api[_-]?(?:key|token)|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|password|passwd|token|secret(?:[_-]?key)?|credential|private[_-]?key)\1(\s*[:=]\s*)([^\s"'`,;}{]+)/gi,
      '$1$2$1$3[REDACTED]',
    );
  for (const secret of secrets) {
    if (secret.length > 0)
      redacted = redacted.replace(
        new RegExp(escapeRegExp(secret), 'g'),
        '[REDACTED]',
      );
  }
  return redacted;
}

function truncateUtf8(text: string, maximumBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= maximumBytes) return text;
  let end = maximumBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function terminateProcessTree(
  child: RunningProcess,
  signal: NodeJS.Signals,
): void {
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) {
      process.kill(-child.pid, signal);
    } else {
      // Windows does not expose POSIX process groups through node:child_process;
      // this stops the direct child, while grandchildren may require OS job objects.
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may have exited between the timeout and the signal.
    }
  }
}

function runOneCheck(
  cwd: string,
  check: VerificationCheck,
  options: VerificationOptions,
  secrets: string[],
): Promise<CheckResult> {
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let forcedStatus: CheckResult['status'] | null = null;
    let spawnFailed = false;
    let settled = false;
    let child: RunningProcess;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onAbort);

      const rawStdout = Buffer.concat(stdout).toString('utf8');
      const rawStderr = Buffer.concat(stderr).toString('utf8');
      let safeStdout = redact(rawStdout, secrets);
      let safeStderr = redact(rawStderr, secrets);
      if (spawnFailed && rawStderr.length === 0) {
        safeStderr = 'Could not start the configured executable.';
      }
      const safeByteLimit = options.maxOutputBytes;
      if (
        Buffer.byteLength(safeStdout) + Buffer.byteLength(safeStderr) >
        safeByteLimit
      ) {
        const stdoutLimit = Math.min(
          Buffer.byteLength(safeStdout),
          safeByteLimit,
        );
        safeStdout = truncateUtf8(safeStdout, stdoutLimit);
        safeStderr = truncateUtf8(
          safeStderr,
          Math.max(0, safeByteLimit - Buffer.byteLength(safeStdout)),
        );
      }
      resolve({
        name: check.name,
        status:
          forcedStatus ??
          (spawnFailed ? 'unavailable' : code === 0 ? 'passed' : 'failed'),
        exitCode: spawnFailed || forcedStatus !== null ? null : code,
        stdout: safeStdout,
        stderr: safeStderr,
        durationMs: performance.now() - startedAt,
      });
    };

    const forceStop = (status: CheckResult['status']): void => {
      if (forcedStatus !== null) return;
      forcedStatus = status;
      clearTimeout(timeout);
      terminateProcessTree(child, 'SIGTERM');
      // Descendants can outlive this process and retain its inherited pipe
      // descriptors, keeping `close` pending. The result only needs output
      // collected so far, so close our pipe ends and impose a hard settlement
      // bound while still sending the process-group hard kill.
      child.stdout.destroy();
      child.stderr.destroy();
      setTimeout(() => {
        terminateProcessTree(child, 'SIGKILL');
        finish(null);
      }, 150);
    };

    try {
      child = spawn(check.command, check.args, {
        cwd,
        env: sanitizedEnvironment(),
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      resolve({
        name: check.name,
        status: 'unavailable',
        exitCode: null,
        stdout: '',
        stderr: truncateUtf8(
          'Could not start the configured executable.',
          options.maxOutputBytes,
        ),
        durationMs: performance.now() - startedAt,
      });
      return;
    }

    const collect = (target: Buffer[], chunk: Buffer): void => {
      if (forcedStatus !== null) return;
      const remaining = options.maxOutputBytes - outputBytes;
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      outputBytes += Math.min(chunk.byteLength, Math.max(remaining, 0));
      if (chunk.byteLength > remaining) forceStop('output-limit');
    };

    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.on('error', () => {
      spawnFailed = true;
    });
    const timeout = setTimeout(() => forceStop('timed-out'), options.timeoutMs);
    timeout.unref();
    const onAbort = (): void => forceStop('cancelled');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    child.on('close', (code) => finish(code));
  });
}

function cancelledResult(check: VerificationCheck): CheckResult {
  return {
    name: check.name,
    status: 'cancelled',
    exitCode: null,
    stdout: '',
    stderr: '',
    durationMs: 0,
  };
}

function failureFingerprint(results: CheckResult[]): string {
  return JSON.stringify(
    results.map(({ name, status, exitCode, stdout, stderr }) => ({
      name,
      status,
      exitCode,
      stdout,
      stderr,
    })),
  );
}

/** Run approved checks as argument arrays, without a shell, under output and time bounds. */
export async function runChecks(
  root: string,
  checks: VerificationCheck[],
  options: VerificationOptions,
): Promise<CheckResult[]> {
  validateOptions(options);
  validateChecks(checks);
  const cwd = await validateWorkingDirectory(root);
  if (options.signal?.aborted) return checks.map(cancelledResult);
  const secrets = knownSecrets();
  const results: CheckResult[] = [];
  for (const check of checks) {
    if (options.signal?.aborted) {
      results.push(...checks.slice(results.length).map(cancelledResult));
      break;
    }
    results.push(await runOneCheck(cwd, check, options, secrets));
  }
  return results;
}

/** Rerun declared checks within fixed iteration and wall-clock limits. */
export async function runWorkflow(
  root: string,
  checks: VerificationCheck[],
  options: WorkflowOptions,
): Promise<WorkflowResult> {
  validateWorkflowOptions(options);
  validateChecks(checks);
  const cwd = await validateWorkingDirectory(root);
  const startedAt = performance.now();
  const secrets = knownSecrets();
  const iterations: CheckResult[][] = [];
  let previousFailure: string | null = null;

  for (let iteration = 0; iteration < options.maxIterations; iteration += 1) {
    if (options.signal?.aborted) return { status: 'cancelled', iterations };
    const current: CheckResult[] = [];
    for (const check of checks) {
      const elapsed = performance.now() - startedAt;
      const remaining = Math.floor(options.maxDurationMs - elapsed);
      if (remaining <= 0) {
        if (current.length > 0) iterations.push(current);
        return { status: 'time-limit', iterations };
      }
      const checkOptions: VerificationOptions = {
        ...options,
        timeoutMs: Math.max(1, Math.min(options.timeoutMs, remaining)),
      };
      current.push(await runOneCheck(cwd, check, checkOptions, secrets));
      if (options.signal?.aborted || current.at(-1)?.status === 'cancelled') {
        iterations.push(current);
        return { status: 'cancelled', iterations };
      }
      if (performance.now() - startedAt >= options.maxDurationMs) {
        iterations.push(current);
        return { status: 'time-limit', iterations };
      }
    }
    iterations.push(current);
    if (current.every((result) => result.status === 'passed'))
      return { status: 'passed', iterations };

    const fingerprint = failureFingerprint(current);
    if (fingerprint === previousFailure)
      return { status: 'stalled', iterations };
    previousFailure = fingerprint;
  }

  return { status: 'failed', iterations };
}
