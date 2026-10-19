import { constants as fsConstants, type Dirent, type Stats } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { ProviderError } from '../adapters/errors.js';

export type SearchArguments = {
  query: string;
  mode: 'path' | 'content';
  directory: string;
  maxResults: number;
};

export type ReadArguments = {
  path: string;
  startLine: number;
  lineCount: number;
};

export type ProjectFileMatch = {
  path: string;
  line: number | null;
  text: string | null;
};

export type ProjectFileSearchResult = {
  matches: ProjectFileMatch[];
  truncated: boolean;
  scannedFiles: number;
  skippedFiles: number;
};

export type ProjectFileLine = {
  number: number;
  text: string;
  truncated: boolean;
};

export type ProjectFileReadResult = {
  path: string;
  startLine: number;
  lines: ProjectFileLine[];
  truncated: boolean;
};

export type ProjectFileIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
};

export type ProjectFileSnapshot = {
  path: string;
  /** Canonical project root and directory identity are private engine metadata. */
  root: string;
  rootIdentity: { dev: number; ino: number };
  content: Buffer;
  identity: ProjectFileIdentity;
};

export const PROJECT_FILE_LIMITS = Object.freeze({
  maxQueryBytes: 200,
  maxSearchResults: 100,
  maxReadStartLine: 1_000_000,
  maxReadLines: 200,
  maxPathBytes: 4096,
  maxPathDepth: 40,
  maxFileBytes: 256 * 1024,
  maxTotalReadBytes: 8 * 1024 * 1024,
  maxFiles: 2000,
  maxDirectories: 2000,
  maxDepth: 40,
  maxDirectoryEntries: 10_000,
  maxTotalDirectoryEntries: 100_000,
  maxIgnoreFileBytes: 64 * 1024,
  maxResultBytes: 48 * 1024,
  maxSearchPreviewBytes: 1024,
  maxReadLineBytes: 4096,
});

type IgnoreLayer = { base: string; matcher: Ignore };
type ReadBudget = { bytesRead: number };
type SearchState = {
  matches: ProjectFileMatch[];
  truncated: boolean;
  scannedFiles: number;
  skippedFiles: number;
  stopped: boolean;
  directoryEntries: number;
  directoriesVisited: number;
};

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
const RESULT_BYTE_LIMIT = PROJECT_FILE_LIMITS.maxResultBytes;

class FileUnavailable extends Error {}

function validationError(): never {
  throw new ProviderError('validation', 'Project file arguments are invalid.');
}

function policyError(): never {
  throw new ProviderError(
    'policy',
    'The requested project path is unavailable under file policy.',
  );
}

function unavailableFileError(): never {
  throw new ProviderError(
    'policy',
    'The requested file is unavailable under project file policy.',
  );
}

function ignorePolicyError(): never {
  throw new ProviderError(
    'policy',
    'Project ignore rules are unavailable under file policy.',
  );
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new ProviderError('cancelled', 'Project file operation cancelled.');
}

function containsControlCharacters(
  value: string,
  allowTextLineControls: boolean,
): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      if (
        allowTextLineControls &&
        (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d)
      ) {
        continue;
      }
      return true;
    }
  }
  return false;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === required.length &&
    keys.every((key) => typeof key === 'string' && required.includes(key)) &&
    required.every((key) => Object.hasOwn(value, key))
  );
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

function containsCredentialJson(segments: readonly string[]): boolean {
  for (let index = 0; index + 1 < segments.length; index += 1) {
    if (
      segments[index]?.toLowerCase() === 'credentials' &&
      segments[index + 1]?.toLowerCase() === 'credentials.json'
    ) {
      return true;
    }
  }
  return false;
}

function safeRelativePath(
  value: string,
  options: { allowRoot: boolean; rejectBlockedNames: boolean },
): boolean {
  if (value === '.') return options.allowRoot;
  if (
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > PROJECT_FILE_LIMITS.maxPathBytes ||
    value.includes('\\') ||
    value.includes(':') ||
    value.includes('\0') ||
    containsControlCharacters(value, false) ||
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  const segments = value.split('/');
  if (
    segments.length > PROJECT_FILE_LIMITS.maxPathDepth ||
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    return false;
  }
  if (!options.rejectBlockedNames) return true;
  if (
    segments.some(
      (segment) =>
        BLOCKED_DIRECTORIES.has(segment.toLowerCase()) ||
        blockedFileName(segment),
    ) ||
    containsCredentialJson(segments)
  ) {
    return false;
  }
  return true;
}

function assertRecord(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!isObjectRecord(value)) validationError();
}

export function parseSearchArguments(
  value: Record<string, unknown>,
): SearchArguments {
  assertRecord(value);
  const keys = ['query', 'mode', 'directory', 'maxResults'] as const;
  if (!hasExactKeys(value, keys)) validationError();
  const { query, mode, directory, maxResults } = value;
  if (
    typeof query !== 'string' ||
    (query.length === 0 && mode !== 'path') ||
    Buffer.byteLength(query, 'utf8') > PROJECT_FILE_LIMITS.maxQueryBytes ||
    containsControlCharacters(query, false) ||
    (mode !== 'path' && mode !== 'content') ||
    typeof directory !== 'string' ||
    !Number.isInteger(maxResults) ||
    (maxResults as number) < 1 ||
    (maxResults as number) > PROJECT_FILE_LIMITS.maxSearchResults
  ) {
    validationError();
  }
  if (
    !safeRelativePath(directory, { allowRoot: true, rejectBlockedNames: true })
  )
    policyError();
  return {
    query,
    mode,
    directory,
    maxResults: maxResults as number,
  };
}

export function parseReadArguments(
  value: Record<string, unknown>,
): ReadArguments {
  assertRecord(value);
  const keys = ['path', 'startLine', 'lineCount'] as const;
  if (!hasExactKeys(value, keys)) validationError();
  const { path: relativePath, startLine, lineCount } = value;
  if (
    typeof relativePath !== 'string' ||
    !Number.isInteger(startLine) ||
    (startLine as number) < 1 ||
    (startLine as number) > PROJECT_FILE_LIMITS.maxReadStartLine ||
    !Number.isInteger(lineCount) ||
    (lineCount as number) < 1 ||
    (lineCount as number) > PROJECT_FILE_LIMITS.maxReadLines
  ) {
    validationError();
  }
  if (
    !safeRelativePath(relativePath, {
      allowRoot: false,
      rejectBlockedNames: true,
    })
  )
    policyError();
  return {
    path: relativePath,
    startLine: startLine as number,
    lineCount: lineCount as number,
  };
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

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

async function statOrNull(absolutePath: string): Promise<Stats | null> {
  try {
    return await lstat(absolutePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new FileUnavailable();
  }
}

async function realPathIsContained(
  root: string,
  absolutePath: string,
): Promise<boolean> {
  try {
    const resolved = await realpath(absolutePath);
    return (
      isWithinRoot(root, resolved) &&
      path.resolve(resolved) === path.resolve(absolutePath)
    );
  } catch {
    return false;
  }
}

async function resolveRoot(root: string): Promise<string> {
  if (typeof root !== 'string' || root.length === 0) policyError();
  let absolutePath: string;
  try {
    absolutePath = path.resolve(root);
  } catch {
    policyError();
  }
  let info: Stats | null;
  try {
    info = await statOrNull(absolutePath);
  } catch {
    policyError();
  }
  if (info === null || info.isSymbolicLink() || !info.isDirectory())
    policyError();
  try {
    const canonical = await realpath(absolutePath);
    const canonicalInfo = await lstat(canonical);
    if (!canonicalInfo.isDirectory()) policyError();
    return canonical;
  } catch {
    policyError();
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readVerifiedFile(
  root: string,
  relativePath: string,
  expected: Stats,
  maximumBytes: number,
  budget: ReadBudget,
  signal: AbortSignal,
  rejectHardLinks: boolean,
): Promise<Buffer> {
  checkAborted(signal);
  const absolutePath = path.resolve(root, ...relativePath.split('/'));
  if (
    !isWithinRoot(root, absolutePath) ||
    expected.isSymbolicLink() ||
    !expected.isFile()
  )
    throw new FileUnavailable();
  if (expected.size > maximumBytes) throw new FileUnavailable();
  if (rejectHardLinks && expected.nlink > 1) throw new FileUnavailable();
  if (expected.size > PROJECT_FILE_LIMITS.maxTotalReadBytes - budget.bytesRead)
    throw new FileUnavailable();

  const before = await statOrNull(absolutePath);
  if (
    before === null ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    !sameFileIdentity(expected, before) ||
    (rejectHardLinks && before.nlink > 1) ||
    before.size > maximumBytes ||
    before.size > PROJECT_FILE_LIMITS.maxTotalReadBytes - budget.bytesRead ||
    !(await realPathIsContained(root, absolutePath))
  ) {
    throw new FileUnavailable();
  }

  let handle;
  try {
    const flags =
      fsConstants.O_RDONLY |
      (fsConstants.O_NOFOLLOW ?? 0) |
      (fsConstants.O_NONBLOCK ?? 0);
    handle = await open(absolutePath, flags);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      !sameFileIdentity(before, opened) ||
      (rejectHardLinks && opened.nlink > 1) ||
      opened.size > maximumBytes ||
      opened.size > PROJECT_FILE_LIMITS.maxTotalReadBytes - budget.bytesRead
    ) {
      throw new FileUnavailable();
    }
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      checkAborted(signal);
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        opened.size - offset,
        offset,
      );
      if (bytesRead <= 0) throw new FileUnavailable();
      offset += bytesRead;
      budget.bytesRead += bytesRead;
    }
    checkAborted(signal);
    const after = await handle.stat();
    if (
      !sameFileIdentity(opened, after) ||
      after.size !== opened.size ||
      (rejectHardLinks && after.nlink > 1) ||
      !(await realPathIsContained(root, absolutePath))
    ) {
      throw new FileUnavailable();
    }
    return buffer;
  } catch (error) {
    if (error instanceof ProviderError && error.code === 'cancelled')
      throw error;
    if (error instanceof FileUnavailable) throw error;
    throw new FileUnavailable();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isStaticBlocked(relativePath: string): boolean {
  const segments = relativePath.split('/');
  return (
    segments.some(
      (segment) =>
        BLOCKED_DIRECTORIES.has(segment.toLowerCase()) ||
        blockedFileName(segment),
    ) || containsCredentialJson(segments)
  );
}

function shouldIgnore(
  root: string,
  relativePath: string,
  isDirectory: boolean,
  layers: readonly IgnoreLayer[],
): boolean {
  const absolutePath = path.resolve(root, ...relativePath.split('/'));
  let ignored = false;
  for (const layer of layers) {
    const localPath = toPosixPath(path.relative(layer.base, absolutePath));
    if (localPath === '' || localPath.startsWith('../')) continue;
    const result = layer.matcher.test(
      isDirectory ? `${localPath}/` : localPath,
    );
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

function hasMalformedIgnoreRule(contents: string): boolean {
  return contents.split('\n').some((line) => {
    const pattern = line.endsWith('\r') ? line.slice(0, -1) : line;
    let trailingBackslashes = 0;
    for (
      let index = pattern.length - 1;
      index >= 0 && pattern[index] === '\\';
      index -= 1
    ) {
      trailingBackslashes += 1;
    }
    return trailingBackslashes % 2 === 1;
  });
}

async function addIgnoreLayer(
  root: string,
  directory: string,
  relativeDirectory: string,
  previous: readonly IgnoreLayer[],
  budget: ReadBudget,
  signal: AbortSignal,
): Promise<IgnoreLayer[]> {
  checkAborted(signal);
  const ignoreRelative =
    relativeDirectory === '.'
      ? '.gitignore'
      : `${relativeDirectory}/.gitignore`;
  const absolutePath = path.join(directory, '.gitignore');
  const info = await statOrNull(absolutePath).catch(() => {
    ignorePolicyError();
  });
  if (info === null) return [...previous];
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.size > PROJECT_FILE_LIMITS.maxIgnoreFileBytes ||
    !isWithinRoot(root, absolutePath) ||
    !(await realPathIsContained(root, absolutePath))
  ) {
    ignorePolicyError();
  }
  let contents: Buffer;
  try {
    contents = await readVerifiedFile(
      root,
      ignoreRelative,
      info,
      PROJECT_FILE_LIMITS.maxIgnoreFileBytes,
      budget,
      signal,
      true,
    );
  } catch (error) {
    if (error instanceof ProviderError && error.code === 'cancelled')
      throw error;
    ignorePolicyError();
  }
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(contents);
  } catch {
    ignorePolicyError();
  }
  if (containsControlCharacters(decoded, true)) ignorePolicyError();
  if (hasMalformedIgnoreRule(decoded)) ignorePolicyError();
  const matcher = ignore();
  try {
    matcher.add(decoded);
  } catch {
    ignorePolicyError();
  }
  return [...previous, { base: directory, matcher }];
}

function safeUtf8Prefix(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return value;
  let output = '';
  let used = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (used + bytes > maximumBytes) break;
    output += character;
    used += bytes;
  }
  return output;
}

function resultFits(value: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(value), 'utf8') <= RESULT_BYTE_LIMIT;
}

function resultEnvelope(
  matches: ProjectFileMatch[],
  truncated: boolean,
): unknown {
  return {
    matches,
    truncated,
    scannedFiles: PROJECT_FILE_LIMITS.maxFiles,
    skippedFiles: PROJECT_FILE_LIMITS.maxTotalDirectoryEntries,
  };
}

function addSearchMatch(
  state: SearchState,
  match: ProjectFileMatch,
  maxResults: number,
): void {
  if (state.matches.length >= maxResults) {
    state.truncated = true;
    state.stopped = true;
    return;
  }
  const candidate = { ...match };
  if (candidate.text !== null) {
    const originalText = candidate.text;
    candidate.text = safeUtf8Prefix(
      candidate.text,
      PROJECT_FILE_LIMITS.maxSearchPreviewBytes,
    );
    if (candidate.text !== originalText) state.truncated = true;
  }
  if (resultFits(resultEnvelope([...state.matches, candidate], true))) {
    state.matches.push(candidate);
    return;
  }
  if (candidate.text !== null) {
    const fullText = candidate.text;
    let low = 0;
    let high = Buffer.byteLength(fullText, 'utf8');
    let best = '';
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const clipped = safeUtf8Prefix(fullText, middle);
      const tryCandidate = { ...candidate, text: clipped };
      if (resultFits(resultEnvelope([...state.matches, tryCandidate], true))) {
        best = clipped;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (best.length > 0) {
      state.matches.push({ ...candidate, text: best });
      state.truncated = true;
      return;
    }
  }
  state.truncated = true;
  state.stopped = true;
}

function decodeText(contents: Buffer): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(contents);
    return containsControlCharacters(text, true) ? null : text;
  } catch {
    return null;
  }
}

function splitTextLines(text: string): string[] {
  if (text.length === 0) return [];
  const hasTrailingNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (hasTrailingNewline) lines.pop();
  return lines.map((line, index) => {
    const hasLineEnding = index < lines.length - 1 || hasTrailingNewline;
    if (hasLineEnding && line.endsWith('\r')) return line.slice(0, -1);
    return line;
  });
}

async function resolveSearchDirectory(
  root: string,
  relativeDirectory: string,
  budget: ReadBudget,
  signal: AbortSignal,
): Promise<{ absolute: string; layers: IgnoreLayer[]; depth: number }> {
  let absolute = root;
  let layers = await addIgnoreLayer(root, root, '.', [], budget, signal);
  if (relativeDirectory === '.') return { absolute, layers, depth: 0 };
  const segments = relativeDirectory.split('/');
  let relative = '';
  for (const segment of segments) {
    checkAborted(signal);
    relative = relative === '' ? segment : `${relative}/${segment}`;
    absolute = path.join(absolute, segment);
    let info: Stats | null;
    try {
      info = await statOrNull(absolute);
    } catch {
      policyError();
    }
    if (
      info === null ||
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      !isWithinRoot(root, absolute) ||
      !(await realPathIsContained(root, absolute)) ||
      shouldIgnore(root, relative, true, layers)
    ) {
      policyError();
    }
    layers = await addIgnoreLayer(
      root,
      absolute,
      relative,
      layers,
      budget,
      signal,
    );
  }
  return { absolute, layers, depth: segments.length };
}

async function collectDirectoryEntries(
  root: string,
  directory: string,
  state: SearchState,
  signal: AbortSignal,
): Promise<Dirent[] | null> {
  checkAborted(signal);
  let handle;
  try {
    handle = await opendir(directory);
    if (!(await realPathIsContained(root, directory))) {
      state.truncated = true;
      return null;
    }
    const entries: Dirent[] = [];
    let overflow = false;
    for await (const entry of handle) {
      checkAborted(signal);
      if (
        entries.length >= PROJECT_FILE_LIMITS.maxDirectoryEntries ||
        state.directoryEntries >= PROJECT_FILE_LIMITS.maxTotalDirectoryEntries
      ) {
        overflow = true;
        break;
      }
      entries.push(entry);
      state.directoryEntries += 1;
    }
    if (overflow) {
      state.truncated = true;
      if (
        state.directoryEntries >= PROJECT_FILE_LIMITS.maxTotalDirectoryEntries
      ) {
        state.stopped = true;
      }
      return null;
    }
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    return entries;
  } catch (error) {
    if (error instanceof ProviderError && error.code === 'cancelled')
      throw error;
    state.truncated = true;
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function searchDirectory(
  root: string,
  directory: string,
  relativeDirectory: string,
  layers: IgnoreLayer[],
  depth: number,
  args: SearchArguments,
  signal: AbortSignal,
  budget: ReadBudget,
  state: SearchState,
): Promise<void> {
  if (state.stopped) return;
  checkAborted(signal);
  if (depth > PROJECT_FILE_LIMITS.maxDepth) {
    state.truncated = true;
    return;
  }
  if (state.scannedFiles >= PROJECT_FILE_LIMITS.maxFiles) {
    state.truncated = true;
    state.stopped = true;
    return;
  }
  if (state.directoryEntries >= PROJECT_FILE_LIMITS.maxTotalDirectoryEntries) {
    state.truncated = true;
    state.stopped = true;
    return;
  }
  if (state.directoriesVisited >= PROJECT_FILE_LIMITS.maxDirectories) {
    state.truncated = true;
    state.stopped = true;
    return;
  }
  state.directoriesVisited += 1;
  if (!(await realPathIsContained(root, directory))) {
    state.truncated = true;
    return;
  }
  const info = await statOrNull(directory).catch(() => null);
  if (info === null || info.isSymbolicLink() || !info.isDirectory()) {
    state.truncated = true;
    return;
  }
  const entries = await collectDirectoryEntries(root, directory, state, signal);
  if (entries === null) return;

  for (const entry of entries) {
    if (state.stopped) return;
    checkAborted(signal);
    const relativePath =
      relativeDirectory === '.'
        ? entry.name
        : `${relativeDirectory}/${entry.name}`;
    if (isStaticBlocked(relativePath)) continue;
    if (
      !safeRelativePath(relativePath, {
        allowRoot: false,
        rejectBlockedNames: true,
      })
    ) {
      state.skippedFiles += 1;
      state.truncated = true;
      continue;
    }
    const absolutePath = path.join(directory, entry.name);
    const entryInfo = await statOrNull(absolutePath).catch(() => null);
    if (entryInfo === null) {
      state.skippedFiles += 1;
      state.truncated = true;
      continue;
    }
    if (entryInfo.isSymbolicLink()) {
      state.skippedFiles += 1;
      state.truncated = true;
      continue;
    }
    if (entryInfo.isDirectory()) {
      if (shouldIgnore(root, relativePath, true, layers)) continue;
      if (depth >= PROJECT_FILE_LIMITS.maxDepth) {
        state.truncated = true;
        continue;
      }
      if (!(await realPathIsContained(root, absolutePath))) {
        state.skippedFiles += 1;
        state.truncated = true;
        continue;
      }
      const childLayers = await addIgnoreLayer(
        root,
        absolutePath,
        relativePath,
        layers,
        budget,
        signal,
      );
      if (
        state.directoriesVisited >= PROJECT_FILE_LIMITS.maxDirectories ||
        state.stopped
      ) {
        state.truncated = true;
        state.stopped = true;
        return;
      }
      await searchDirectory(
        root,
        absolutePath,
        relativePath,
        childLayers,
        depth + 1,
        args,
        signal,
        budget,
        state,
      );
      continue;
    }
    if (!entryInfo.isFile()) {
      state.skippedFiles += 1;
      state.truncated = true;
      continue;
    }
    if (shouldIgnore(root, relativePath, false, layers)) continue;
    if (state.scannedFiles >= PROJECT_FILE_LIMITS.maxFiles) {
      state.truncated = true;
      state.stopped = true;
      return;
    }
    state.scannedFiles += 1;
    if (args.mode === 'path') {
      if (!(await realPathIsContained(root, absolutePath))) {
        state.skippedFiles += 1;
        state.truncated = true;
        continue;
      }
      if (relativePath.includes(args.query)) {
        addSearchMatch(
          state,
          { path: relativePath, line: null, text: null },
          args.maxResults,
        );
      }
      continue;
    }
    if (
      entryInfo.size > PROJECT_FILE_LIMITS.maxFileBytes ||
      entryInfo.nlink > 1 ||
      entryInfo.size > PROJECT_FILE_LIMITS.maxTotalReadBytes - budget.bytesRead
    ) {
      state.skippedFiles += 1;
      state.truncated = true;
      continue;
    }
    let contents: Buffer;
    try {
      contents = await readVerifiedFile(
        root,
        relativePath,
        entryInfo,
        PROJECT_FILE_LIMITS.maxFileBytes,
        budget,
        signal,
        true,
      );
    } catch (error) {
      if (error instanceof ProviderError && error.code === 'cancelled')
        throw error;
      state.skippedFiles += 1;
      state.truncated = true;
      continue;
    }
    const text = decodeText(contents);
    if (text === null) {
      state.skippedFiles += 1;
      state.truncated = true;
      continue;
    }
    const lines = splitTextLines(text);
    for (let index = 0; index < lines.length; index += 1) {
      checkAborted(signal);
      const line = lines[index] ?? '';
      if (line.includes(args.query)) {
        addSearchMatch(
          state,
          {
            path: relativePath,
            line: index + 1,
            text: safeUtf8Prefix(
              line,
              PROJECT_FILE_LIMITS.maxSearchPreviewBytes,
            ),
          },
          args.maxResults,
        );
        if (
          Buffer.byteLength(line, 'utf8') >
          PROJECT_FILE_LIMITS.maxSearchPreviewBytes
        )
          state.truncated = true;
      }
      if (state.stopped) return;
    }
  }
}

export async function searchProjectFiles(
  root: string,
  args: SearchArguments,
  signal: AbortSignal,
): Promise<ProjectFileSearchResult> {
  const checkedArgs = parseSearchArguments(
    args as unknown as Record<string, unknown>,
  );
  checkAborted(signal);
  const rootPath = await resolveRoot(root);
  const budget: ReadBudget = { bytesRead: 0 };
  const scope = await resolveSearchDirectory(
    rootPath,
    checkedArgs.directory,
    budget,
    signal,
  );
  const state: SearchState = {
    matches: [],
    truncated: false,
    scannedFiles: 0,
    skippedFiles: 0,
    stopped: false,
    directoryEntries: 0,
    directoriesVisited: 0,
  };
  if (scope.depth > PROJECT_FILE_LIMITS.maxDepth) {
    state.truncated = true;
  } else {
    await searchDirectory(
      rootPath,
      scope.absolute,
      checkedArgs.directory,
      scope.layers,
      scope.depth,
      checkedArgs,
      signal,
      budget,
      state,
    );
  }
  checkAborted(signal);
  return {
    matches: state.matches,
    truncated: state.truncated,
    scannedFiles: state.scannedFiles,
    skippedFiles: state.skippedFiles,
  };
}

async function resolveReadTarget(
  root: string,
  relativePath: string,
  budget: ReadBudget,
  signal: AbortSignal,
): Promise<{ absolute: string; info: Stats }> {
  const segments = relativePath.split('/');
  let directory = root;
  let relativeDirectory = '.';
  let layers = await addIgnoreLayer(root, root, '.', [], budget, signal);
  for (const segment of segments.slice(0, -1)) {
    checkAborted(signal);
    relativeDirectory =
      relativeDirectory === '.' ? segment : `${relativeDirectory}/${segment}`;
    directory = path.join(directory, segment);
    let info: Stats | null;
    try {
      info = await statOrNull(directory);
    } catch {
      unavailableFileError();
    }
    if (
      info === null ||
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      !isWithinRoot(root, directory) ||
      !(await realPathIsContained(root, directory)) ||
      shouldIgnore(root, relativeDirectory, true, layers)
    ) {
      unavailableFileError();
    }
    layers = await addIgnoreLayer(
      root,
      directory,
      relativeDirectory,
      layers,
      budget,
      signal,
    );
  }
  const name = segments.at(-1);
  if (name === undefined) unavailableFileError();
  const absolute = path.join(directory, name);
  let info: Stats | null;
  try {
    info = await statOrNull(absolute);
  } catch {
    unavailableFileError();
  }
  if (
    info === null ||
    info.isSymbolicLink() ||
    !info.isFile() ||
    !isWithinRoot(root, absolute) ||
    !(await realPathIsContained(root, absolute)) ||
    shouldIgnore(root, relativePath, false, layers)
  ) {
    unavailableFileError();
  }
  return { absolute, info };
}

function readResultFits(value: ProjectFileReadResult): boolean {
  return resultFits(value);
}

function makeReadLine(number: number, text: string): ProjectFileLine {
  const shortened = safeUtf8Prefix(text, PROJECT_FILE_LIMITS.maxReadLineBytes);
  return {
    number,
    text: shortened,
    truncated: shortened.length < text.length,
  };
}

export async function readProjectFile(
  root: string,
  args: ReadArguments,
  signal: AbortSignal,
): Promise<ProjectFileReadResult> {
  const checkedArgs = parseReadArguments(
    args as unknown as Record<string, unknown>,
  );
  checkAborted(signal);
  const rootPath = await resolveRoot(root);
  const budget: ReadBudget = { bytesRead: 0 };
  const target = await resolveReadTarget(
    rootPath,
    checkedArgs.path,
    budget,
    signal,
  );
  let contents: Buffer;
  try {
    contents = await readVerifiedFile(
      rootPath,
      checkedArgs.path,
      target.info,
      PROJECT_FILE_LIMITS.maxFileBytes,
      budget,
      signal,
      true,
    );
  } catch {
    checkAborted(signal);
    unavailableFileError();
  }
  const text = decodeText(contents);
  if (text === null) unavailableFileError();
  const sourceLines = splitTextLines(text);
  const firstIndex = checkedArgs.startLine - 1;
  const lastExclusive = Math.min(
    sourceLines.length,
    firstIndex + checkedArgs.lineCount,
  );
  const result: ProjectFileReadResult = {
    path: checkedArgs.path,
    startLine: checkedArgs.startLine,
    lines: [],
    truncated: lastExclusive < sourceLines.length,
  };
  for (let index = firstIndex; index < lastExclusive; index += 1) {
    checkAborted(signal);
    const textLine = sourceLines[index] ?? '';
    const line = makeReadLine(index + 1, textLine);
    if (line.truncated) result.truncated = true;
    const candidate = { ...result, lines: [...result.lines, line] };
    if (readResultFits(candidate)) {
      result.lines.push(line);
      continue;
    }
    const fullText = line.text;
    let low = 0;
    let high = Buffer.byteLength(fullText, 'utf8');
    let best = '';
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const clipped = safeUtf8Prefix(fullText, middle);
      const clippedLine = { ...line, text: clipped, truncated: true };
      const tryResult = {
        ...result,
        lines: [...result.lines, clippedLine],
        truncated: true,
      };
      if (readResultFits(tryResult)) {
        best = clipped;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (best.length > 0) {
      result.lines.push({ ...line, text: best, truncated: true });
    }
    result.truncated = true;
    break;
  }
  checkAborted(signal);
  return result;
}

function snapshotIdentity(info: Stats): ProjectFileIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    mode: info.mode,
  };
}

function sameSnapshotIdentity(
  left: ProjectFileIdentity,
  right: ProjectFileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode
  );
}

/**
 * Read a complete, bounded UTF-8 file without line clipping while retaining
 * its original bytes, BOM, and line endings for an approved edit preview.
 */
export async function readProjectFileSnapshot(
  root: string,
  relativePath: string,
  signal: AbortSignal,
): Promise<ProjectFileSnapshot> {
  const checkedArgs = parseReadArguments({
    path: relativePath,
    startLine: 1,
    lineCount: 1,
  });
  checkAborted(signal);
  const rootPath = await resolveRoot(root);
  const rootInfo = await statOrNull(rootPath);
  if (rootInfo === null || !rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    policyError();

  const budget: ReadBudget = { bytesRead: 0 };
  const target = await resolveReadTarget(
    rootPath,
    checkedArgs.path,
    budget,
    signal,
  );
  const beforeIdentity = snapshotIdentity(target.info);
  let content: Buffer;
  try {
    content = await readVerifiedFile(
      rootPath,
      checkedArgs.path,
      target.info,
      PROJECT_FILE_LIMITS.maxFileBytes,
      budget,
      signal,
      true,
    );
  } catch (error) {
    if (error instanceof ProviderError && error.code === 'cancelled')
      throw error;
    unavailableFileError();
  }
  if (decodeText(content) === null) unavailableFileError();

  const afterInfo = await statOrNull(target.absolute).catch(() => null);
  const afterRootInfo = await statOrNull(rootPath).catch(() => null);
  checkAborted(signal);
  if (
    afterInfo === null ||
    afterRootInfo === null ||
    !afterInfo.isFile() ||
    !afterRootInfo.isDirectory() ||
    !sameSnapshotIdentity(beforeIdentity, snapshotIdentity(afterInfo)) ||
    rootInfo.dev !== afterRootInfo.dev ||
    rootInfo.ino !== afterRootInfo.ino ||
    !(await realPathIsContained(rootPath, target.absolute))
  ) {
    unavailableFileError();
  }

  return {
    path: checkedArgs.path,
    root: rootPath,
    rootIdentity: { dev: rootInfo.dev, ino: rootInfo.ino },
    content,
    identity: beforeIdentity,
  };
}
