import { constants as fsConstants, type Dirent, type Stats } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';

export type RepositoryEdge = { from: string; to: string; specifier: string };
export type RepositoryScan = {
  files: string[];
  edges: RepositoryEdge[];
  truncated: boolean;
  limitations: string[];
};

export type ScanOptions = { maxFiles?: number };

const DEFAULT_MAX_FILES = 5_000;
const MAX_ALLOWED_FILES = 50_000;
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_GITIGNORE_BYTES = 64 * 1024;
const MAX_TOTAL_READ_BYTES = 32 * 1024 * 1024;
const MAX_DIRECTORIES = 10_000;
const MAX_DIRECTORY_DEPTH = 100;
const MAX_DIRECTORY_ENTRIES = 20_000;
const SOURCE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
];
const IGNORED_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.agentforge',
  'work',
  'outputs',
]);

type IgnoreLayer = { base: string; matcher: Ignore };
type Token = {
  value: string;
  kind: 'word' | 'string' | 'punctuation';
  line: number;
};
type ReadBudget = { bytesRead: number; truncated: boolean };

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
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

async function readBoundedFile(
  filePath: string,
  maximumBytes: number,
): Promise<Buffer | null> {
  let handle;
  try {
    const flags =
      fsConstants.O_RDONLY |
      (fsConstants.O_NOFOLLOW ?? 0) |
      (fsConstants.O_NONBLOCK ?? 0);
    handle = await open(filePath, flags);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink > 1 || info.size > maximumBytes)
      return null;
    const buffer = Buffer.alloc(info.size);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead,
      );
      if (result.bytesRead === 0) return null;
      bytesRead += result.bytesRead;
    }
    const after = await handle.stat();
    if (!sameReadIdentity(info, after) || bytesRead !== info.size) {
      return null;
    }
    return buffer;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function sameReadIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode &&
    left.nlink === right.nlink
  );
}

function isSecretFileName(name: string): boolean {
  return name === '.env' || name.startsWith('.env.');
}

function shouldIgnore(
  root: string,
  relativePath: string,
  isDirectory: boolean,
  layers: IgnoreLayer[],
): boolean {
  const absolutePath = path.resolve(root, relativePath);
  let ignored = false;
  for (const layer of layers) {
    const localPath = toPosixPath(path.relative(layer.base, absolutePath));
    const result = layer.matcher.test(
      isDirectory ? `${localPath}/` : localPath,
    );
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

async function addGitIgnoreLayer(
  directory: string,
  layers: IgnoreLayer[],
  limitations: string[],
  readBudget: ReadBudget,
): Promise<IgnoreLayer[]> {
  const remainingReadBytes = MAX_TOTAL_READ_BYTES - readBudget.bytesRead;
  if (remainingReadBytes <= 0) {
    readBudget.truncated = true;
    limitations.push(
      'Ignore-rule reading stopped after reaching the total byte limit.',
    );
    return layers;
  }
  const filePath = path.join(directory, '.gitignore');
  const info = await lstat(filePath).catch(() => null);
  if (info === null) return layers;
  const perFileLimit = Math.min(MAX_GITIGNORE_BYTES, remainingReadBytes);
  if (!info.isFile() || info.size > perFileLimit) {
    readBudget.truncated = true;
    limitations.push(
      `Skipped ignore rules outside the byte limit in ${toPosixPath(path.relative(directory, filePath)) || '.gitignore'}.`,
    );
    return layers;
  }
  const contents = await readBoundedFile(filePath, perFileLimit);
  if (contents === null) {
    readBudget.truncated = true;
    limitations.push(
      `Could not read ignore rules in ${toPosixPath(path.relative(directory, filePath)) || '.gitignore'}.`,
    );
    return layers;
  }
  readBudget.bytesRead += contents.length;
  const matcher = ignore();
  try {
    matcher.add(contents.toString('utf8'));
  } catch {
    limitations.push(
      `Could not parse ignore rules in ${toPosixPath(path.relative(directory, filePath)) || '.gitignore'}.`,
    );
    return layers;
  }
  return [...layers, { base: directory, matcher }];
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  while (index < source.length) {
    const character = source[index] ?? '';
    if (/\s/.test(character)) {
      if (character === '\n') line += 1;
      index += 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === '*' && source[index + 1] === '/')
      ) {
        if (source[index] === '\n') line += 1;
        index += 1;
      }
      index = Math.min(source.length, index + 2);
      continue;
    }
    if (character === '`') {
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === '`') {
          index += 1;
          break;
        }
        if (source[index] === '\n') line += 1;
        index += 1;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      const startLine = line;
      const quote = character;
      index += 1;
      let value = '';
      while (index < source.length && source[index] !== quote) {
        const next = source[index] ?? '';
        if (next === '\\' && index + 1 < source.length) {
          value += source[index + 1] ?? '';
          index += 2;
          continue;
        }
        if (next === '\n') line += 1;
        value += next;
        index += 1;
      }
      index = Math.min(source.length, index + 1);
      tokens.push({ value, kind: 'string', line: startLine });
      continue;
    }
    if (/[A-Za-z_$]/.test(character)) {
      const start = index;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index] ?? ''))
        index += 1;
      tokens.push({ value: source.slice(start, index), kind: 'word', line });
      continue;
    }
    tokens.push({ value: character, kind: 'punctuation', line });
    index += 1;
  }
  return tokens;
}

function staticModuleSpecifiers(source: string): string[] {
  const tokens = tokenize(source);
  const specifiers: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index];
    if (
      current?.kind !== 'word' ||
      (current.value !== 'import' && current.value !== 'export')
    )
      continue;
    const next = tokens[index + 1];
    if (
      current.value === 'import' &&
      (next?.value === '(' || next?.value === '.')
    )
      continue;
    if (current.value === 'import' && next?.kind === 'string') {
      specifiers.push(next.value);
      continue;
    }

    let curlyDepth = 0;
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor];
      if (token === undefined || token.value === ';') break;
      if (
        cursor > index + 1 &&
        token.kind === 'word' &&
        (token.value === 'import' || token.value === 'export')
      )
        break;
      if (token.value === '{') curlyDepth += 1;
      if (token.value === '}') curlyDepth = Math.max(0, curlyDepth - 1);
      if (token.kind === 'word' && token.value === 'from' && curlyDepth === 0) {
        const specifier = tokens[cursor + 1];
        if (specifier?.kind === 'string') specifiers.push(specifier.value);
        break;
      }
    }
  }
  return specifiers;
}

function resolveLocalImport(
  root: string,
  from: string,
  specifier: string,
  knownFiles: Set<string>,
): string | null {
  if (
    specifier.length === 0 ||
    specifier.length > 256 ||
    !(specifier.startsWith('./') || specifier.startsWith('../')) ||
    /[?#%\\\0\r\n]/.test(specifier)
  ) {
    return null;
  }
  const base = path.resolve(root, path.dirname(from), specifier);
  if (!isWithinRoot(root, base)) return null;

  const candidates = [base];
  const extension = path.extname(base);
  if (extension.length === 0) {
    for (const candidateExtension of SOURCE_EXTENSIONS)
      candidates.push(`${base}${candidateExtension}`);
    for (const candidateExtension of SOURCE_EXTENSIONS)
      candidates.push(path.join(base, `index${candidateExtension}`));
  } else {
    // TypeScript source commonly imports the emitted JavaScript extension.
    if (['.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
      const stem = base.slice(0, -extension.length);
      for (const candidateExtension of ['.ts', '.tsx', '.mts', '.cts'])
        candidates.push(`${stem}${candidateExtension}`);
    }
  }

  for (const candidate of candidates) {
    if (!knownFiles.has(candidate)) continue;
    return toPosixPath(path.relative(root, candidate));
  }
  return null;
}

/** Scan a repository without following symlinks or returning source contents. */
export async function scanRepository(
  root: string,
  options: ScanOptions = {},
): Promise<RepositoryScan> {
  if (typeof root !== 'string' || root.trim().length === 0)
    throw new TypeError('Repository root must be a non-empty path.');
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options)
  ) {
    throw new TypeError('Scan options must be an object.');
  }
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  if (
    !Number.isInteger(maxFiles) ||
    maxFiles < 1 ||
    maxFiles > MAX_ALLOWED_FILES
  ) {
    throw new RangeError(
      `maxFiles must be an integer between 1 and ${MAX_ALLOWED_FILES}.`,
    );
  }

  const rootPath = await realpath(path.resolve(root));
  const rootStat = await stat(rootPath).catch(() => null);
  if (rootStat === null || !rootStat.isDirectory())
    throw new Error('Repository root must be an accessible directory.');

  const files: string[] = [];
  const sourceContents = new Map<string, Buffer>();
  const readBudget: ReadBudget = { bytesRead: 0, truncated: false };
  const limitations = [
    'Import edges use a lightweight syntax scan and may miss complex or malformed JavaScript and TypeScript.',
    'Scan results are not cached.',
  ];
  let truncated = false;
  let scannedDirectories = 0;
  let stop = false;

  const visit = async (
    directory: string,
    parentLayers: IgnoreLayer[],
    depth: number,
  ): Promise<void> => {
    if (stop) return;
    if (scannedDirectories >= MAX_DIRECTORIES || depth > MAX_DIRECTORY_DEPTH) {
      truncated = true;
      limitations.push(
        'Scan stopped after reaching the directory count or depth limit.',
      );
      stop = true;
      return;
    }
    scannedDirectories += 1;
    const layers = await addGitIgnoreLayer(
      directory,
      parentLayers,
      limitations,
      readBudget,
    );
    let entries: Dirent[];
    try {
      const handle = await opendir(directory);
      entries = [];
      for await (const entry of handle) {
        entries.push(entry);
        if (entries.length > MAX_DIRECTORY_ENTRIES) {
          entries.pop();
          truncated = true;
          limitations.push(
            `Directory entry limit reached in ${toPosixPath(path.relative(rootPath, directory)) || '.'}.`,
          );
          break;
        }
      }
      entries.sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      limitations.push(
        `Could not read directory ${toPosixPath(path.relative(rootPath, directory)) || '.'}.`,
      );
      return;
    }

    for (const entry of entries) {
      if (stop) return;
      const name = entry.name;
      if (IGNORED_NAMES.has(name) || isSecretFileName(name)) continue;
      const absolute = path.join(directory, name);
      const relative = toPosixPath(path.relative(rootPath, absolute));
      if (entry.isSymbolicLink()) continue;
      const isDirectory = entry.isDirectory();
      if (shouldIgnore(rootPath, relative, isDirectory, layers)) continue;

      if (isDirectory) {
        await visit(absolute, layers, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        stop = true;
        limitations.push(`Scan stopped after reaching maxFiles (${maxFiles}).`);
        return;
      }
      files.push(relative);

      const extension = path.extname(name).toLowerCase();
      if (!SOURCE_EXTENSIONS.includes(extension)) continue;
      if (readBudget.bytesRead >= MAX_TOTAL_READ_BYTES) {
        truncated = true;
        limitations.push(
          'Source reading stopped after reaching the total byte limit.',
        );
        continue;
      }
      const readLimit = Math.min(
        MAX_SOURCE_BYTES,
        MAX_TOTAL_READ_BYTES - readBudget.bytesRead,
      );
      const contents = await readBoundedFile(absolute, readLimit);
      if (contents === null) {
        truncated = true;
        limitations.push(
          `Skipped source that was unreadable or larger than the per-file byte limit: ${relative}.`,
        );
        continue;
      }
      readBudget.bytesRead += contents.length;
      sourceContents.set(relative, contents);
    }
  };

  await visit(rootPath, [], 0);
  truncated ||= readBudget.truncated;
  files.sort((left, right) => left.localeCompare(right));
  const knownFiles = new Set(
    files.map((relative) => path.resolve(rootPath, relative)),
  );
  const edges: RepositoryEdge[] = [];
  for (const [from, contents] of sourceContents) {
    for (const specifier of staticModuleSpecifiers(contents.toString('utf8'))) {
      const to = resolveLocalImport(rootPath, from, specifier, knownFiles);
      if (to !== null) edges.push({ from, to, specifier });
    }
  }
  edges.sort(
    (left, right) =>
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to) ||
      left.specifier.localeCompare(right.specifier),
  );

  return { files, edges, truncated, limitations: [...new Set(limitations)] };
}
