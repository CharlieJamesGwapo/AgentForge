import { spawn } from 'node:child_process';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { devNull } from 'node:os';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { readProjectFile } from './project-files.js';

export type GitOperation = 'status' | 'diff' | 'log' | 'branch';
export type GitInspectionStatus =
  | 'ok'
  | 'missing-git'
  | 'not-repository'
  | 'unsupported-worktree'
  | 'unsafe-root'
  | 'unsafe-configuration'
  | 'path-unavailable'
  | 'failed'
  | 'timed-out'
  | 'cancelled'
  | 'output-limit';

export type GitInspectionRequest =
  | { operation: 'status' }
  | { operation: 'diff'; path: string; staged: boolean }
  | { operation: 'log'; limit: number }
  | { operation: 'branch' };

export type GitStatusEntry = { path: string; status: string };
export type GitCommit = { hash: string; date: string; subject: string };
export type GitBranch = { name: string; current: boolean };

export type GitInspectionResult = {
  status: GitInspectionStatus;
  operation: GitOperation;
  branch: string | null;
  headState: 'attached' | 'detached' | 'unborn' | 'unknown';
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
  untracked: string[];
  diff: string;
  commits: GitCommit[];
  branches: GitBranch[];
  truncated: boolean;
  message: string | null;
};

/** Trusted host-only overrides used by tests; never map them from tool or CLI input. */
export type GitInspectionOptions = {
  approved?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  gitExecutable?: string;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_PROCESS_OUTPUT_BYTES = 256 * 1024;
const MAX_PROCESS_OUTPUT_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 48 * 1024;
const MAX_PATH_BYTES = 4096;
const MAX_PATH_DEPTH = 40;
const MAX_LOG_LIMIT = 50;
const MAX_GIT_METADATA_ENTRIES = 100_000;
const MAX_GIT_METADATA_DEPTH = 16;
const BLOCKED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.agentforge',
  'work',
  'outputs',
  '.ssh',
  '.aws',
  '.gnupg',
]);
const STATUS_MESSAGES: Record<Exclude<GitInspectionStatus, 'ok'>, string> = {
  'missing-git': 'Git executable is unavailable.',
  'not-repository': 'The project root is not a Git repository.',
  'unsupported-worktree': 'Git worktree metadata files are unsupported.',
  'unsafe-root': 'Git metadata is unavailable under inspection policy.',
  'unsafe-configuration': 'Git configuration cannot be inspected safely.',
  'path-unavailable':
    'The requested path is unavailable under project file policy.',
  failed: 'Git inspection failed.',
  'timed-out': 'Git inspection timed out.',
  cancelled: 'Git inspection was cancelled.',
  'output-limit': 'Git output exceeded the configured limit.',
};

type ProcessStatus =
  'ok' | 'missing-git' | 'failed' | 'timed-out' | 'cancelled' | 'output-limit';
type ProcessResult = {
  status: ProcessStatus;
  stdout: Buffer;
  exitCode: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function hasControls(value: string, allowPathControls: boolean): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      if (
        allowPathControls &&
        (code === 0x09 || code === 0x0a || code === 0x0d)
      )
        continue;
      return true;
    }
  }
  return false;
}

function blockedFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === '.env' ||
    lower.startsWith('.env.') ||
    lower === '.npmrc' ||
    lower === '.netrc' ||
    lower === 'credentials' ||
    lower === 'credentials.json' ||
    lower === 'id_rsa' ||
    lower === 'id_ed25519' ||
    ['.pem', '.key', '.p12', '.pfx', '.keystore'].some((suffix) =>
      lower.endsWith(suffix),
    )
  );
}

function hasCredentialJson(segments: readonly string[]): boolean {
  return segments.some(
    (segment, index) =>
      segment.toLowerCase() === 'credentials' &&
      segments[index + 1]?.toLowerCase() === 'credentials.json',
  );
}

function safeRelativePath(value: string, allowPathControls: boolean): boolean {
  if (
    value.length === 0 ||
    value === '.' ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES ||
    value.includes('\\') ||
    value.includes(':') ||
    value.includes('\0') ||
    hasControls(value, allowPathControls) ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  const segments = value.split('/');
  if (
    segments.length > MAX_PATH_DEPTH ||
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    ) ||
    segments.some(
      (segment) =>
        BLOCKED_DIRECTORIES.has(segment.toLowerCase()) ||
        blockedFileName(segment),
    ) ||
    hasCredentialJson(segments)
  ) {
    return false;
  }
  return true;
}

export function parseGitRequest(value: unknown): GitInspectionRequest {
  if (!isRecord(value) || typeof value.operation !== 'string')
    throw new TypeError('Git inspection arguments are invalid.');
  if (value.operation === 'status' || value.operation === 'branch') {
    const keys = ['operation'];
    if (!hasExactKeys(value, keys))
      throw new TypeError('Git inspection arguments are invalid.');
    return { operation: value.operation };
  }
  if (value.operation === 'diff') {
    const keys = ['operation', 'path', 'staged'];
    if (
      !hasExactKeys(value, keys) ||
      typeof value.path !== 'string' ||
      !safeRelativePath(value.path, false) ||
      typeof value.staged !== 'boolean'
    ) {
      throw new TypeError(
        'Git diff arguments are invalid or the path is unavailable.',
      );
    }
    return { operation: 'diff', path: value.path, staged: value.staged };
  }
  if (value.operation === 'log') {
    const keys = ['operation', 'limit'];
    if (
      !hasExactKeys(value, keys) ||
      !Number.isInteger(value.limit) ||
      (value.limit as number) < 1 ||
      (value.limit as number) > MAX_LOG_LIMIT
    ) {
      throw new TypeError('Git log limit must be an integer between 1 and 50.');
    }
    return { operation: 'log', limit: value.limit as number };
  }
  throw new TypeError('Git inspection operation is unsupported.');
}

function baseResult(operation: GitOperation): GitInspectionResult {
  return {
    status: 'failed',
    operation,
    branch: null,
    headState: 'unknown',
    staged: [],
    unstaged: [],
    untracked: [],
    diff: '',
    commits: [],
    branches: [],
    truncated: false,
    message: STATUS_MESSAGES.failed,
  };
}

function resultWithStatus(
  operation: GitOperation,
  status: Exclude<GitInspectionStatus, 'ok'>,
  truncated = status === 'output-limit',
): GitInspectionResult {
  return {
    ...baseResult(operation),
    status,
    truncated,
    message: STATUS_MESSAGES[status],
  };
}

function setSuccess(result: GitInspectionResult): GitInspectionResult {
  result.status = 'ok';
  result.message = null;
  return fitResult(result);
}

function validateOptions(options: GitInspectionOptions): {
  timeoutMs: number;
  maxOutputBytes: number;
  gitExecutable: string;
} {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_PROCESS_OUTPUT_BYTES;
  const gitExecutable = options.gitExecutable ?? 'git';
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS ||
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > MAX_PROCESS_OUTPUT_BYTES ||
    typeof gitExecutable !== 'string' ||
    gitExecutable.length === 0 ||
    gitExecutable.includes('\0')
  ) {
    throw new TypeError('Git inspection limits or executable are invalid.');
  }
  return { timeoutMs, maxOutputBytes, gitExecutable };
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  const allowed = new Set([
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
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && allowed.has(name.toUpperCase()))
      environment[name] = value;
  }
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
    GIT_EDITOR: '',
    VISUAL: '',
    EDITOR: '',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
  });
  return environment;
}

function terminate(child: ReturnType<typeof spawn>): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      /* The child may have exited before its process group could be signalled. */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* close/error events settle the process result. */
  }
}

function runProcess(
  executable: string,
  args: string[],
  cwd: string,
  options: {
    signal?: AbortSignal;
    timeoutMs: number;
    maxOutputBytes: number;
  },
): Promise<ProcessResult> {
  if (options.signal?.aborted)
    return Promise.resolve({
      status: 'cancelled',
      stdout: Buffer.alloc(0),
      exitCode: null,
    });
  return new Promise((resolve) => {
    const output: Buffer[] = [];
    let outputBytes = 0;
    let forcedStatus: ProcessStatus | undefined;
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    const timer = setTimeout(() => {
      forcedStatus = 'timed-out';
      if (child) terminate(child);
    }, options.timeoutMs);
    const settle = (status: ProcessStatus, exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolve({ status, stdout: Buffer.concat(output), exitCode });
    };
    const abort = () => {
      forcedStatus = 'cancelled';
      if (child) terminate(child);
    };
    try {
      child = spawn(executable, args, {
        cwd,
        env: cleanEnvironment(),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch {
      settle('failed', null);
      return;
    }
    const accountOutput = (chunk: Buffer | string) => {
      if (forcedStatus || settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > options.maxOutputBytes) {
        forcedStatus = 'output-limit';
        if (child) terminate(child);
      }
    };
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      terminate(child);
      settle('failed', null);
      return;
    }
    stdout.on('data', (chunk: Buffer | string) => {
      const previousBytes = outputBytes;
      accountOutput(chunk);
      if (!forcedStatus && outputBytes > previousBytes)
        output.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stderr.on('data', accountOutput);
    child.once('error', (error: NodeJS.ErrnoException) => {
      settle(error.code === 'ENOENT' ? 'missing-git' : 'failed', null);
    });
    child.once('close', (code) => {
      settle(forcedStatus ?? (code === 0 ? 'ok' : 'failed'), code);
    });
    options.signal?.addEventListener('abort', abort, { once: true });
  });
}

function gitArguments(
  args: string[],
  filterOverrides: string[] = [],
): string[] {
  return [
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.untrackedCache=false',
    '-c',
    'core.hooksPath=',
    '-c',
    'core.pager=cat',
    '-c',
    'pager.diff=false',
    '-c',
    'diff.external=',
    '-c',
    'core.attributesFile=',
    '-c',
    'core.excludesFile=',
    '-c',
    'submodule.recurse=false',
    ...filterOverrides,
    ...args,
  ];
}

function decodeUtf8(buffer: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function stripOneLineEnding(value: string): string {
  if (value.endsWith('\r\n')) return value.slice(0, -2);
  if (value.endsWith('\n')) return value.slice(0, -1);
  return value;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

type RootCheck =
  | { status: 'ok'; root: string; filterOverrides: string[] }
  | { status: Exclude<GitInspectionStatus, 'ok' | 'path-unavailable'> };
type RootFailureStatus = Exclude<
  GitInspectionStatus,
  'ok' | 'path-unavailable'
>;

async function validateGitMetadata(
  gitPath: string,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<'ok' | 'unsafe-root' | 'timed-out' | 'cancelled'> {
  let entriesVisited = 0;
  const pending: Array<{ directory: string; depth: number }> = [
    { directory: gitPath, depth: 0 },
  ];
  while (pending.length > 0) {
    if (signal?.aborted) return 'cancelled';
    if (performance.now() >= deadline) return 'timed-out';
    const current = pending.pop()!;
    if (current.depth > MAX_GIT_METADATA_DEPTH) return 'unsafe-root';
    try {
      const directoryInfo = await lstat(current.directory);
      if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory())
        return 'unsafe-root';
      if ((await realpath(current.directory)) !== current.directory)
        return 'unsafe-root';
      const handle = await opendir(current.directory);
      try {
        for await (const entry of handle) {
          if (signal?.aborted) return 'cancelled';
          if (performance.now() >= deadline) return 'timed-out';
          entriesVisited += 1;
          if (entriesVisited > MAX_GIT_METADATA_ENTRIES) return 'unsafe-root';
          const childPath = path.join(current.directory, entry.name);
          const relative = path
            .relative(gitPath, childPath)
            .split(path.sep)
            .join('/');
          if (
            relative === 'commondir' ||
            relative === 'objects/info/alternates' ||
            relative === 'objects/info/http-alternates' ||
            relative === 'info/grafts' ||
            (relative.startsWith('objects/pack/') &&
              relative.endsWith('.promisor'))
          ) {
            return 'unsafe-root';
          }
          const childInfo = await lstat(childPath);
          if (childInfo.isSymbolicLink()) return 'unsafe-root';
          if (childInfo.isDirectory()) {
            pending.push({ directory: childPath, depth: current.depth + 1 });
          } else if (!childInfo.isFile()) {
            return 'unsafe-root';
          }
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch {
      return 'unsafe-root';
    }
  }
  return 'ok';
}

async function readLocalConfigFilterOverrides(
  canonicalRoot: string,
  options: {
    signal?: AbortSignal;
    deadline: number;
    maxOutputBytes: number;
    gitExecutable: string;
  },
): Promise<
  { status: 'ok'; overrides: string[] } | { status: RootFailureStatus }
> {
  if (options.signal?.aborted) return { status: 'cancelled' };
  if (performance.now() >= options.deadline) return { status: 'timed-out' };
  const localConfig = await runProcess(
    options.gitExecutable,
    gitArguments([
      'config',
      '--local',
      '--no-includes',
      '--null',
      '--name-only',
      '--get-regexp',
      '.*',
    ]),
    canonicalRoot,
    {
      signal: options.signal,
      timeoutMs: Math.min(
        Math.max(1, options.deadline - performance.now()),
        MAX_TIMEOUT_MS,
      ),
      maxOutputBytes: options.maxOutputBytes,
    },
  );
  let configKeys: string[];
  if (localConfig.status === 'ok') {
    const decodedConfig = decodeUtf8(localConfig.stdout);
    if (decodedConfig === null) return { status: 'unsafe-configuration' };
    configKeys = splitNul(decodedConfig).map((key) => key.toLowerCase());
  } else if (
    localConfig.status === 'failed' &&
    localConfig.exitCode === 1 &&
    localConfig.stdout.length === 0
  ) {
    configKeys = [];
  } else {
    return {
      status:
        localConfig.status === 'output-limit'
          ? 'output-limit'
          : localConfig.status === 'missing-git' ||
              localConfig.status === 'timed-out' ||
              localConfig.status === 'cancelled'
            ? localConfig.status
            : 'unsafe-configuration',
    };
  }
  if (
    configKeys.some(
      (key) =>
        key.startsWith('include.') ||
        key.startsWith('includeif.') ||
        key === 'extensions.worktreeconfig' ||
        key === 'extensions.partialclone' ||
        /^remote\..+\.(?:promisor|partialclonefilter)$/.test(key) ||
        key === 'core.worktree',
    )
  ) {
    return { status: 'unsafe-configuration' };
  }
  const filterDrivers = new Set<string>();
  for (const key of configKeys) {
    if (!key.startsWith('filter.')) continue;
    const match =
      /^filter\.([a-z0-9_-]{1,128})\.(?:clean|smudge|process|required)$/.exec(
        key,
      );
    if (!match) return { status: 'unsafe-configuration' };
    filterDrivers.add(match[1]!);
  }
  const overrides = [...filterDrivers].flatMap((driver) => [
    '-c',
    `filter.${driver}.clean=`,
    '-c',
    `filter.${driver}.smudge=`,
    '-c',
    `filter.${driver}.process=`,
    '-c',
    `filter.${driver}.required=false`,
  ]);
  return { status: 'ok', overrides };
}

async function validateRepositoryRoot(
  root: string,
  options: {
    signal?: AbortSignal;
    deadline: number;
    maxOutputBytes: number;
    gitExecutable: string;
  },
): Promise<RootCheck> {
  if (options.signal?.aborted) return { status: 'cancelled' };
  if (typeof root !== 'string' || root.length === 0 || !path.isAbsolute(root))
    return { status: 'unsafe-root' };
  let absoluteRoot: string;
  let rootStats;
  try {
    absoluteRoot = path.resolve(root);
    if (hasControls(absoluteRoot, false)) return { status: 'unsafe-root' };
    rootStats = await lstat(absoluteRoot);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory())
      return { status: 'unsafe-root' };
  } catch {
    return { status: 'unsafe-root' };
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(absoluteRoot);
  } catch {
    return { status: 'unsafe-root' };
  }

  const gitPath = path.join(canonicalRoot, '.git');
  let gitStats;
  try {
    gitStats = await lstat(gitPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { status: 'not-repository' };
    return { status: 'unsafe-root' };
  }
  if (gitStats.isSymbolicLink()) return { status: 'unsafe-root' };
  if (gitStats.isFile()) return { status: 'unsupported-worktree' };
  if (!gitStats.isDirectory()) return { status: 'unsafe-root' };
  try {
    const canonicalGitPath = await realpath(gitPath);
    if (
      !isWithinRoot(canonicalRoot, canonicalGitPath) ||
      canonicalGitPath !== gitPath
    )
      return { status: 'unsafe-root' };
  } catch {
    return { status: 'unsafe-root' };
  }

  const metadataStatus = await validateGitMetadata(
    gitPath,
    options.signal,
    options.deadline,
  );
  if (metadataStatus !== 'ok') return { status: metadataStatus };
  const localConfig = await readLocalConfigFilterOverrides(
    canonicalRoot,
    options,
  );
  if (localConfig.status !== 'ok') return { status: localConfig.status };

  const rootResult = await runProcess(
    options.gitExecutable,
    gitArguments(['rev-parse', '--show-toplevel'], localConfig.overrides),
    canonicalRoot,
    {
      signal: options.signal,
      timeoutMs: Math.min(
        Math.max(1, options.deadline - performance.now()),
        MAX_TIMEOUT_MS,
      ),
      maxOutputBytes: options.maxOutputBytes,
    },
  );
  if (rootResult.status !== 'ok') return { status: rootResult.status };
  const decodedRoot = decodeUtf8(rootResult.stdout);
  if (decodedRoot === null) return { status: 'failed' };
  const reportedRoot = stripOneLineEnding(decodedRoot);
  if (
    !path.isAbsolute(reportedRoot) ||
    path.resolve(reportedRoot) !== canonicalRoot
  )
    return { status: 'unsafe-root' };
  let realReportedRoot: string;
  try {
    realReportedRoot = await realpath(reportedRoot);
  } catch {
    return { status: 'unsafe-root' };
  }
  if (realReportedRoot !== canonicalRoot) return { status: 'unsafe-root' };
  return {
    status: 'ok',
    root: canonicalRoot,
    filterOverrides: localConfig.overrides,
  };
}

function safeStatusPath(value: string): boolean {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES ||
    value.includes('\\') ||
    value.includes(':') ||
    value.includes('\0') ||
    hasControls(value, true)
  ) {
    return false;
  }
  const segments = value.split('/');
  return (
    segments.length <= MAX_PATH_DEPTH &&
    !segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    ) &&
    !segments.some(
      (segment) =>
        BLOCKED_DIRECTORIES.has(segment.toLowerCase()) ||
        blockedFileName(segment),
    ) &&
    !hasCredentialJson(segments)
  );
}

function splitNul(value: string): string[] {
  const fields = value.split('\0');
  if (fields.at(-1) === '') fields.pop();
  return fields;
}

function pathAfterSpaces(record: string, count: number): string | null {
  let index = -1;
  for (let space = 0; space < count; space += 1) {
    index = record.indexOf(' ', index + 1);
    if (index < 0) return null;
  }
  return record.slice(index + 1);
}

function parseStatus(output: string, result: GitInspectionResult): boolean {
  let headOid: string | undefined;
  let headName: string | undefined;
  const records = splitNul(output);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.startsWith('# ')) {
      if (record.startsWith('# branch.oid ')) headOid = record.slice(13);
      if (record.startsWith('# branch.head ')) headName = record.slice(14);
      continue;
    }
    if (record.startsWith('? ')) {
      const relativePath = record.slice(2);
      if (safeStatusPath(relativePath)) result.untracked.push(relativePath);
      continue;
    }
    if (
      record.startsWith('1 ') ||
      record.startsWith('u ') ||
      record.startsWith('2 ')
    ) {
      const prefixSpaces = record.startsWith('u ')
        ? 10
        : record.startsWith('2 ')
          ? 9
          : 8;
      const relativePath = pathAfterSpaces(record, prefixSpaces);
      if (relativePath === null) return false;
      if (record.startsWith('2 ')) index += 1;
      if (!safeStatusPath(relativePath)) continue;
      const fields = record.split(' ');
      const xy = fields[1];
      if (typeof xy !== 'string' || xy.length !== 2) return false;
      if (xy[0] !== '.') result.staged.push({ path: relativePath, status: xy });
      if (xy[1] !== '.')
        result.unstaged.push({ path: relativePath, status: xy });
      continue;
    }
    if (record.length > 0) return false;
  }
  if (headName === undefined) return false;
  if (headName === '(detached)') {
    result.headState = 'detached';
    result.branch = null;
  } else if (headName.length > 0 && headName !== '(unknown)') {
    result.branch = headName;
    if (headOid === undefined || headOid === '(initial)')
      result.headState = 'unborn';
    else result.headState = 'attached';
  } else {
    result.headState = 'unknown';
    result.branch = null;
  }
  return true;
}

function statusFailure(
  operation: GitOperation,
  status: Exclude<ProcessStatus, 'ok'>,
): GitInspectionResult {
  return resultWithStatus(operation, status, status === 'output-limit');
}

function gitStatusArgs(filterOverrides: string[] = []): string[] {
  return gitArguments(
    [
      '--no-pager',
      '--no-optional-locks',
      'status',
      '--porcelain=v2',
      '-z',
      '--branch',
      '--untracked-files=all',
      '--no-renames',
      '--ignore-submodules=all',
    ],
    filterOverrides,
  );
}

function safePrefix(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let output = '';
  let used = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (used + bytes > maxBytes) break;
    output += character;
    used += bytes;
  }
  return output;
}

function fitResult(result: GitInspectionResult): GitInspectionResult {
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESULT_BYTES) {
    result.truncated = true;
    if (result.diff.length > 0) {
      const bytes = Buffer.byteLength(result.diff, 'utf8');
      const next = Math.max(0, bytes - Math.max(1024, Math.ceil(bytes / 4)));
      result.diff = safePrefix(result.diff, next);
      continue;
    }
    if (result.untracked.length > 0) {
      result.untracked.pop();
      continue;
    }
    if (result.unstaged.length > 0) {
      result.unstaged.pop();
      continue;
    }
    if (result.staged.length > 0) {
      result.staged.pop();
      continue;
    }
    if (result.commits.length > 0) {
      result.commits.pop();
      continue;
    }
    if (result.branches.length > 0) {
      result.branches.pop();
      continue;
    }
    if (result.message !== null) {
      result.message = safePrefix(result.message, 128);
      continue;
    }
    break;
  }
  return result;
}

function failureFromProcess(
  operation: GitOperation,
  processResult: ProcessResult,
): GitInspectionResult | null {
  return processResult.status === 'ok'
    ? null
    : statusFailure(operation, processResult.status);
}

async function runGit(
  root: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    deadline: number;
    maxOutputBytes: number;
    gitExecutable: string;
  },
): Promise<ProcessResult> {
  const remaining = Math.max(1, options.deadline - performance.now());
  return runProcess(options.gitExecutable, args, root, {
    signal: options.signal,
    timeoutMs: Math.min(remaining, MAX_TIMEOUT_MS),
    maxOutputBytes: options.maxOutputBytes,
  });
}

function decodeOrFailure(
  operation: GitOperation,
  processResult: ProcessResult,
): { result?: GitInspectionResult; value?: string } {
  const failure = failureFromProcess(operation, processResult);
  if (failure) return { result: failure };
  const value = decodeUtf8(processResult.stdout);
  return value === null
    ? { result: resultWithStatus(operation, 'failed') }
    : { value };
}

async function validateDiffPath(
  root: string,
  relativePath: string,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<'ok' | 'path-unavailable' | 'timed-out' | 'cancelled'> {
  if (signal?.aborted) return 'cancelled';
  const remaining = deadline - performance.now();
  if (remaining <= 0) return 'timed-out';
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  signal?.addEventListener('abort', abortFromParent, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, remaining);
  try {
    await readProjectFile(
      root,
      { path: relativePath, startLine: 1, lineCount: 1 },
      controller.signal,
    );
    if (signal?.aborted) return 'cancelled';
    if (timedOut) return 'timed-out';
    return 'ok';
  } catch {
    if (signal?.aborted) return 'cancelled';
    return timedOut ? 'timed-out' : 'path-unavailable';
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromParent);
  }
}

function parseLog(
  value: string,
  limit: number,
  result: GitInspectionResult,
): boolean {
  if (value.length === 0) return true;
  const parts = value.replace(/(?:\r?\n)+$/, '').split('\0');
  if (parts.at(-1) === '') parts.pop();
  if (parts.length % 3 !== 0) return false;
  for (let index = 0; index < parts.length; index += 3) {
    const hash = parts[index]!.replace(/^\r?\n/, '');
    const date = parts[index + 1]!;
    const subject = parts[index + 2]!;
    if (!/^[a-f0-9]{40,64}$/.test(hash) || date.length === 0) return false;
    result.commits.push({ hash, date, subject });
  }
  if (result.commits.length > limit) result.commits.length = limit;
  return true;
}

function parseBranches(value: string, result: GitInspectionResult): boolean {
  for (const line of value.split('\n')) {
    if (line.length === 0) continue;
    const fields = line.split('\0');
    if (fields.length < 2 || !fields[0]) return false;
    const name = fields[0];
    result.branches.push({ name, current: fields[1] === '*' });
    if (fields[1] === '*') result.branch = name;
  }
  result.headState = result.branch === null ? 'detached' : 'attached';
  return true;
}

export async function inspectGit(
  root: string,
  requestValue: unknown,
  options: GitInspectionOptions = {},
): Promise<GitInspectionResult> {
  const request = parseGitRequest(requestValue);
  const operation = request.operation;
  if (options.approved !== true)
    throw new Error(
      'Exact approval is required before Git inspection can run.',
    );
  const { timeoutMs, maxOutputBytes, gitExecutable } = validateOptions(options);
  if (options.signal?.aborted) return resultWithStatus(operation, 'cancelled');
  const deadline = performance.now() + timeoutMs;
  const rootCheck = await validateRepositoryRoot(root, {
    signal: options.signal,
    deadline,
    maxOutputBytes,
    gitExecutable,
  });
  if (rootCheck.status !== 'ok')
    return resultWithStatus(operation, rootCheck.status);
  const canonicalRoot = rootCheck.root;
  const filterOverrides = rootCheck.filterOverrides;
  if (options.signal?.aborted) return resultWithStatus(operation, 'cancelled');

  if (request.operation === 'diff') {
    const pathStatus = await validateDiffPath(
      canonicalRoot,
      request.path,
      options.signal,
      deadline,
    );
    if (pathStatus !== 'ok') return resultWithStatus(operation, pathStatus);
  }

  let args: string[];
  if (request.operation === 'status') args = gitStatusArgs(filterOverrides);
  else if (request.operation === 'diff') {
    args = gitArguments(
      [
        '--no-pager',
        '--no-optional-locks',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--no-renames',
        '--no-relative',
        '--unified=3',
        ...(request.staged ? ['--cached'] : []),
        '--',
        `:(literal)${request.path}`,
      ],
      filterOverrides,
    );
  } else if (request.operation === 'log') {
    args = gitArguments(
      [
        '--no-pager',
        '--no-optional-locks',
        'log',
        '--no-decorate',
        '--no-show-signature',
        '--no-notes',
        '--date=iso-strict',
        '--format=%H%x00%cI%x00%s%x00',
        '-n',
        String(request.limit),
        'HEAD',
      ],
      filterOverrides,
    );
  } else {
    args = gitArguments(
      [
        '--no-pager',
        '--no-optional-locks',
        'for-each-ref',
        '--format=%(refname:short)%00%(HEAD)%00',
        'refs/heads',
      ],
      filterOverrides,
    );
  }

  const processResult = await runGit(canonicalRoot, args, {
    signal: options.signal,
    deadline,
    maxOutputBytes,
    gitExecutable,
  });
  if (
    request.operation === 'log' &&
    processResult.status === 'failed' &&
    processResult.exitCode === 128
  ) {
    const headRef = await runGit(
      canonicalRoot,
      gitArguments(
        ['symbolic-ref', '--quiet', '--short', 'HEAD'],
        filterOverrides,
      ),
      { signal: options.signal, deadline, maxOutputBytes, gitExecutable },
    );
    if (headRef.status === 'ok') {
      const branch = decodeUtf8(headRef.stdout);
      const headObject = await runGit(
        canonicalRoot,
        gitArguments(
          ['rev-parse', '--verify', '--quiet', 'HEAD'],
          filterOverrides,
        ),
        { signal: options.signal, deadline, maxOutputBytes, gitExecutable },
      );
      if (
        headObject.status === 'failed' &&
        headObject.exitCode === 1 &&
        branch !== null
      ) {
        const unborn = baseResult('log');
        unborn.branch = stripOneLineEnding(branch);
        unborn.headState = 'unborn';
        return setSuccess(unborn);
      }
      if (headObject.status !== 'ok' && headObject.status !== 'failed')
        return statusFailure('log', headObject.status);
    } else if (
      headRef.status === 'timed-out' ||
      headRef.status === 'cancelled' ||
      headRef.status === 'output-limit' ||
      headRef.status === 'missing-git'
    ) {
      return statusFailure('log', headRef.status);
    }
  }
  const decoded = decodeOrFailure(operation, processResult);
  if (decoded.result) return decoded.result;
  const result = baseResult(operation);
  if (request.operation === 'status') {
    if (!parseStatus(decoded.value!, result))
      return resultWithStatus(operation, 'failed');
  } else if (request.operation === 'diff') {
    result.diff = decoded.value!;
  } else if (request.operation === 'log') {
    if (!parseLog(decoded.value!, request.limit, result))
      return resultWithStatus(operation, 'failed');
    const head = await runGit(
      canonicalRoot,
      gitArguments(
        ['symbolic-ref', '--quiet', '--short', 'HEAD'],
        filterOverrides,
      ),
      { signal: options.signal, deadline, maxOutputBytes, gitExecutable },
    );
    if (head.status === 'failed' && head.exitCode === 1) {
      result.headState = 'detached';
      result.branch = null;
    } else {
      const headText = decodeOrFailure(operation, head);
      if (headText.result) return headText.result;
      result.branch = stripOneLineEnding(headText.value!);
      result.headState = result.branch.length === 0 ? 'unknown' : 'attached';
    }
  } else {
    if (!parseBranches(decoded.value!, result))
      return resultWithStatus(operation, 'failed');
    if (result.branches.length === 0) {
      const head = await runGit(
        canonicalRoot,
        gitArguments(
          ['symbolic-ref', '--quiet', '--short', 'HEAD'],
          filterOverrides,
        ),
        { signal: options.signal, deadline, maxOutputBytes, gitExecutable },
      );
      if (head.status === 'ok') {
        const headText = decodeOrFailure(operation, head);
        if (headText.result) return headText.result;
        result.branch = stripOneLineEnding(headText.value!);
        result.headState = result.branch ? 'unborn' : 'unknown';
      } else if (head.status === 'failed' && head.exitCode === 1) {
        result.headState = 'detached';
      } else {
        return statusFailure(operation, head.status);
      }
    }
  }
  return setSuccess(result);
}
