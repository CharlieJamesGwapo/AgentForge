import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { ProviderError } from '../adapters/errors.js';
import {
  parseReadArguments,
  PROJECT_FILE_LIMITS,
  readProjectFileSnapshot,
} from './project-files.js';
import type {
  ProjectFileIdentity,
  ProjectFileSnapshot,
} from './project-files.js';
import { redact } from '../shared/safety.js';

const MAX_EDIT_TEXT_BYTES = 32 * 1024;
const MAX_PATCH_BYTES = 32 * 1024;
const MAX_DIFF_BYTES = 32 * 1024;
const MAX_PATCH_LINES = 2000;
const MAX_PATCH_HUNKS = 32;
const MAX_PROPOSALS = 8;
const PROPOSAL_TTL_MS = 5 * 60 * 1000;
const PROPOSAL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPABILITY_REASON =
  'The built-in Node backend cannot guarantee atomic conflict-safe replacement.';

export type ProjectEditOperation = 'replace' | 'patch';

export type ProjectEditRequest =
  | {
      operation: 'replace';
      path: string;
      oldText: string;
      newText: string;
    }
  | { operation: 'patch'; path: string; patch: string };

export type ProjectEditCapabilities = {
  backend: 'node';
  atomicConflictSafeReplace: false;
  status: 'unavailable';
  reason: string;
};

export type ProjectEditPreview = {
  status: 'preview';
  operation: ProjectEditOperation;
  path: string;
  proposalId: string;
  beforeHash: string;
  afterHash: string;
  diff: string;
  capability: ProjectEditCapabilities;
};

export type ProjectEditApplyResult = {
  status: 'conflict' | 'unavailable';
  proposalId: string;
  path: string;
  reason: string;
};

export type ProjectEditSession = {
  propose(
    request: ProjectEditRequest,
    signal: AbortSignal,
  ): Promise<ProjectEditPreview>;
  inspectProposal(proposalId: string): {
    action: string;
    proposalId: string;
    operation: ProjectEditOperation;
    path: string;
    beforeHash: string;
    afterHash: string;
    diff: string;
    capability: ProjectEditCapabilities;
  };
  apply(
    proposalId: string,
    signal: AbortSignal,
  ): Promise<ProjectEditApplyResult>;
};

type ParsedHunkLine = { kind: 'context' | 'remove' | 'add'; text: string };
type ParsedHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ParsedHunkLine[];
};
type ParsedPatch = { hunks: ParsedHunk[] };

type StoredProposal = {
  proposalId: string;
  operation: ProjectEditOperation;
  path: string;
  root: string;
  rootIdentity: { dev: number; ino: number };
  identity: ProjectFileIdentity;
  beforeHash: string;
  afterHash: string;
  diff: string;
  expiresAt: number;
};

function validationError(): never {
  throw new ProviderError('validation', 'Project edit arguments are invalid.');
}

function policyError(): never {
  throw new ProviderError(
    'policy',
    'The requested edit is unavailable under project file policy.',
  );
}

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

function containsTextControls(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 && ![0x09, 0x0a, 0x0d].includes(codePoint))
      return true;
    if (codePoint >= 0x7f && codePoint <= 0x9f) return true;
  }
  return false;
}

function validateEditPath(value: unknown): asserts value is string {
  if (typeof value !== 'string') validationError();
  // Reuse the same lexical and project-file path boundary as approved reads.
  const { path: relativePath } = parseReadPath(value);
  if (
    relativePath
      .split('/')
      .some(
        (segment) =>
          segment.toLowerCase() === '.gitignore' ||
          segment.toLowerCase() === 'agentforge.config.json',
      )
  )
    policyError();
}

function parseReadPath(relativePath: string): { path: string } {
  return parseReadArguments({ path: relativePath, startLine: 1, lineCount: 1 });
}

function normalizePatchEol(patch: string): string {
  if (/(^|[^\r])\r(?!\n)/.test(patch)) validationError();
  const crlfCount = (patch.match(/\r\n/g) ?? []).length;
  const bareLfCount = (patch.match(/(?<!\r)\n/g) ?? []).length;
  if (crlfCount > 0 && bareLfCount > 0) validationError();
  return patch.replace(/\r\n/g, '\n');
}

function parseUnifiedPatch(relativePath: string, patch: string): ParsedPatch {
  if (
    Buffer.byteLength(patch, 'utf8') < 1 ||
    Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES ||
    containsTextControls(patch)
  )
    validationError();
  const lines = normalizePatchEol(patch).split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (
    lines.length < 4 ||
    lines.length > MAX_PATCH_LINES ||
    lines[0] !== `--- a/${relativePath}` ||
    lines[1] !== `+++ b/${relativePath}`
  )
    validationError();

  const hunks: ParsedHunk[] = [];
  let index = 2;
  let sawChange = false;
  while (index < lines.length) {
    const header = lines[index];
    if (header === undefined) validationError();
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(
      header,
    );
    if (!match) validationError();
    const oldStart = Number(match[1]);
    const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]);
    const newCount = match[4] === undefined ? 1 : Number(match[4]);
    if (
      ![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger) ||
      oldStart < 0 ||
      oldCount < 0 ||
      newStart < 0 ||
      newCount < 0
    )
      validationError();
    index += 1;
    const body: ParsedHunkLine[] = [];
    let consumedOld = 0;
    let consumedNew = 0;
    while (index < lines.length && !lines[index]!.startsWith('@@ ')) {
      const line = lines[index]!;
      if (line === '\\ No newline at end of file') validationError();
      const prefix = line[0];
      const text = line.slice(1);
      if (prefix === ' ') {
        body.push({ kind: 'context', text });
        consumedOld += 1;
        consumedNew += 1;
      } else if (prefix === '-') {
        body.push({ kind: 'remove', text });
        consumedOld += 1;
        sawChange = true;
      } else if (prefix === '+') {
        body.push({ kind: 'add', text });
        consumedNew += 1;
        sawChange = true;
      } else {
        validationError();
      }
      index += 1;
    }
    if (
      body.length === 0 ||
      consumedOld !== oldCount ||
      consumedNew !== newCount
    )
      validationError();
    hunks.push({ oldStart, oldCount, newStart, newCount, lines: body });
    if (hunks.length > MAX_PATCH_HUNKS) validationError();
  }
  if (!sawChange || hunks.length === 0) validationError();
  return { hunks };
}

/** Validate and normalize an exact, single-file edit request before approval. */
export function parseProjectEditRequest(value: unknown): ProjectEditRequest {
  if (!isRecord(value) || typeof value.operation !== 'string')
    validationError();
  if (value.operation === 'replace') {
    if (!hasExactKeys(value, ['operation', 'path', 'oldText', 'newText']))
      validationError();
    validateEditPath(value.path);
    if (
      typeof value.oldText !== 'string' ||
      typeof value.newText !== 'string' ||
      value.oldText.length === 0 ||
      value.oldText === value.newText ||
      Buffer.byteLength(value.oldText, 'utf8') > MAX_EDIT_TEXT_BYTES ||
      Buffer.byteLength(value.newText, 'utf8') > MAX_EDIT_TEXT_BYTES ||
      containsTextControls(value.oldText) ||
      containsTextControls(value.newText)
    )
      validationError();
    return {
      operation: 'replace',
      path: value.path,
      oldText: value.oldText,
      newText: value.newText,
    };
  }
  if (value.operation === 'patch') {
    if (!hasExactKeys(value, ['operation', 'path', 'patch'])) validationError();
    validateEditPath(value.path);
    if (typeof value.patch !== 'string') validationError();
    parseUnifiedPatch(value.path, value.patch);
    return { operation: 'patch', path: value.path, patch: value.patch };
  }
  return validationError();
}

export function getProjectEditCapabilities(): ProjectEditCapabilities {
  return {
    backend: 'node',
    atomicConflictSafeReplace: false,
    status: 'unavailable',
    reason: CAPABILITY_REASON,
  };
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function decodeUtf8PreservingBom(content: Buffer): string {
  try {
    const decoded = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(content);
    if (containsTextControls(decoded)) policyError();
    return decoded;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    policyError();
  }
}

function detectLineEnding(text: string): '\n' | '\r\n' {
  if (/(^|[^\r])\r(?!\n)/.test(text)) policyError();
  const crlfCount = (text.match(/\r\n/g) ?? []).length;
  const bareLfCount = (text.match(/(?<!\r)\n/g) ?? []).length;
  if (crlfCount > 0 && bareLfCount > 0) policyError();
  return crlfCount > 0 ? '\r\n' : '\n';
}

function normalizeLineEndings(
  value: string,
  lineEnding: '\n' | '\r\n',
): string {
  return value.replace(/\r\n|\n|\r/g, lineEnding);
}

type DiffLine = { text: string; terminated: boolean };

function splitDiffLines(text: string, lineEnding: '\n' | '\r\n'): DiffLine[] {
  if (text.length === 0) return [];
  const terminated = text.endsWith(lineEnding);
  const lines = text.split(lineEnding);
  if (terminated) lines.pop();
  return lines.map((line, index) => ({
    text: line,
    terminated: index < lines.length - 1 || terminated,
  }));
}

function sameDiffLine(left: DiffLine, right: DiffLine): boolean {
  return left.text === right.text && left.terminated === right.terminated;
}

function formatDiffLine(prefix: string, line: DiffLine): string[] {
  return [
    `${prefix}${line.text}`,
    ...(line.terminated ? [] : ['\\ No newline at end of file']),
  ];
}

function createUnifiedDiff(
  relativePath: string,
  beforeText: string,
  afterText: string,
  lineEnding: '\n' | '\r\n',
): string {
  const before = splitDiffLines(beforeText, lineEnding);
  const after = splitDiffLines(afterText, lineEnding);
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    sameDiffLine(before[prefix]!, after[prefix]!)
  )
    prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    sameDiffLine(
      before[before.length - suffix - 1]!,
      after[after.length - suffix - 1]!,
    )
  )
    suffix += 1;

  const contextStart = Math.max(0, prefix - 3);
  const beforeChangedEnd = before.length - suffix;
  const afterChangedEnd = after.length - suffix;
  const contextEnd = Math.min(before.length, beforeChangedEnd + 3);
  const oldCount = contextEnd - contextStart;
  const newCount = Math.min(after.length, afterChangedEnd + 3) - contextStart;
  const oldStart = oldCount === 0 ? contextStart : contextStart + 1;
  const newStart = newCount === 0 ? contextStart : contextStart + 1;
  const body: string[] = [];

  for (let index = contextStart; index < prefix; index += 1)
    body.push(...formatDiffLine(' ', before[index]!));
  for (let index = prefix; index < beforeChangedEnd; index += 1)
    body.push(...formatDiffLine('-', before[index]!));
  for (let index = prefix; index < afterChangedEnd; index += 1)
    body.push(...formatDiffLine('+', after[index]!));
  for (let index = beforeChangedEnd; index < contextEnd; index += 1)
    body.push(...formatDiffLine(' ', before[index]!));

  return [
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...body,
    '',
  ].join('\n');
}

function replaceUnique(
  source: string,
  oldText: string,
  newText: string,
  lineEnding: '\n' | '\r\n',
): string {
  const oldValue = normalizeLineEndings(oldText, lineEnding);
  const newValue = normalizeLineEndings(newText, lineEnding);
  let matches = 0;
  let offset = 0;
  let foundAt = -1;
  while (offset <= source.length - oldValue.length) {
    const match = source.indexOf(oldValue, offset);
    if (match < 0) break;
    matches += 1;
    foundAt = match;
    if (matches > 1) break;
    offset = match + 1;
  }
  if (matches !== 1 || foundAt < 0) policyError();
  return `${source.slice(0, foundAt)}${newValue}${source.slice(foundAt + oldValue.length)}`;
}

function applyPatch(
  source: string,
  patch: string,
  relativePath: string,
  lineEnding: '\n' | '\r\n',
): string {
  const parsed = parseUnifiedPatch(relativePath, patch);
  if (source.length > 0 && !source.endsWith(lineEnding)) policyError();
  const sourceLines = source.length === 0 ? [] : source.split(lineEnding);
  if (sourceLines.at(-1) === '') sourceLines.pop();
  const output: string[] = [];
  const appendLines = (lines: readonly string[]) => {
    for (const line of lines) output.push(line);
  };
  let sourceIndex = 0;
  for (const hunk of parsed.hunks) {
    const oldIndex = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    const newIndex = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
    if (oldIndex < sourceIndex || oldIndex > sourceLines.length || newIndex < 0)
      policyError();
    appendLines(sourceLines.slice(sourceIndex, oldIndex));
    sourceIndex = oldIndex;
    if (output.length !== newIndex) policyError();
    for (const line of hunk.lines) {
      if (line.kind === 'add') {
        output.push(line.text);
        continue;
      }
      if (sourceLines[sourceIndex] !== line.text) policyError();
      if (line.kind === 'context') output.push(line.text);
      sourceIndex += 1;
    }
  }
  appendLines(sourceLines.slice(sourceIndex));
  return output.length === 0 ? '' : `${output.join(lineEnding)}${lineEnding}`;
}

function equalIdentity(
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

function safePreviewText(beforeText: string, afterText: string, diff: string) {
  if (
    redact(beforeText) !== beforeText ||
    redact(afterText) !== afterText ||
    redact(diff) !== diff
  )
    throw new ProviderError(
      'policy',
      'The proposed edit contains sensitive-looking text and cannot be safely previewed.',
    );
}

function validateProposalId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !PROPOSAL_ID_PATTERN.test(value))
    validationError();
}

/** Each returned session owns its proposal cache; proposals cannot cross registries. */
export function createProjectEditSession(root: string): ProjectEditSession {
  const proposals = new Map<string, StoredProposal>();

  const pruneExpired = (now = Date.now()) => {
    for (const [proposalId, proposal] of proposals) {
      if (proposal.expiresAt <= now) proposals.delete(proposalId);
    }
  };

  const getProposal = (proposalId: string): StoredProposal => {
    validateProposalId(proposalId);
    pruneExpired();
    const proposal = proposals.get(proposalId);
    if (!proposal)
      throw new ProviderError(
        'policy',
        'The edit proposal is unknown, expired or already consumed.',
      );
    return proposal;
  };

  return {
    async propose(request, signal) {
      const checkedRequest = parseProjectEditRequest(request);
      if (signal.aborted)
        throw new ProviderError('cancelled', 'Project edit cancelled.');
      const snapshot = await readProjectFileSnapshot(
        root,
        checkedRequest.path,
        signal,
      );
      const beforeText = decodeUtf8PreservingBom(snapshot.content);
      const lineEnding = detectLineEnding(beforeText);
      const afterText =
        checkedRequest.operation === 'replace'
          ? replaceUnique(
              beforeText,
              checkedRequest.oldText,
              checkedRequest.newText,
              lineEnding,
            )
          : applyPatch(
              beforeText,
              checkedRequest.patch,
              checkedRequest.path,
              lineEnding,
            );
      const afterContent = Buffer.from(afterText, 'utf8');
      if (
        afterContent.byteLength > PROJECT_FILE_LIMITS.maxFileBytes ||
        sha256(snapshot.content) === sha256(afterContent)
      )
        policyError();
      const diff = createUnifiedDiff(
        checkedRequest.path,
        beforeText,
        afterText,
        lineEnding,
      );
      if (Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES)
        throw new ProviderError(
          'response-limit',
          'The complete edit preview exceeds the supported diff limit.',
        );
      safePreviewText(beforeText, afterText, diff);

      const now = Date.now();
      pruneExpired(now);
      const proposalId = randomUUID();
      const proposal: StoredProposal = Object.freeze({
        proposalId,
        operation: checkedRequest.operation,
        path: checkedRequest.path,
        root: snapshot.root,
        rootIdentity: Object.freeze({ ...snapshot.rootIdentity }),
        identity: Object.freeze({ ...snapshot.identity }),
        beforeHash: sha256(snapshot.content),
        afterHash: sha256(afterContent),
        diff,
        expiresAt: now + PROPOSAL_TTL_MS,
      });
      const preview: ProjectEditPreview = {
        status: 'preview',
        operation: proposal.operation,
        path: proposal.path,
        proposalId,
        beforeHash: proposal.beforeHash,
        afterHash: proposal.afterHash,
        diff: proposal.diff,
        capability: getProjectEditCapabilities(),
      };
      if (Buffer.byteLength(JSON.stringify(preview), 'utf8') > 65_536)
        throw new ProviderError(
          'response-limit',
          'The complete serialized edit preview exceeds the supported result limit.',
        );
      while (proposals.size >= MAX_PROPOSALS) {
        const oldest = proposals.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        proposals.delete(oldest);
      }
      proposals.set(proposalId, proposal);
      return preview;
    },

    inspectProposal(proposalId) {
      const proposal = getProposal(proposalId);
      return {
        action: 'apply this exact project edit proposal',
        proposalId: proposal.proposalId,
        operation: proposal.operation,
        path: proposal.path,
        beforeHash: proposal.beforeHash,
        afterHash: proposal.afterHash,
        diff: proposal.diff,
        capability: getProjectEditCapabilities(),
      };
    },

    async apply(proposalId, signal) {
      const proposal = getProposal(proposalId);
      // Any approved attempt consumes the proposal, including stale and cancelled attempts.
      proposals.delete(proposalId);
      if (signal.aborted)
        throw new ProviderError('cancelled', 'Project edit cancelled.');
      let current: ProjectFileSnapshot;
      try {
        current = await readProjectFileSnapshot(root, proposal.path, signal);
      } catch (error) {
        if (error instanceof ProviderError && error.code === 'cancelled')
          throw error;
        return {
          status: 'conflict',
          proposalId,
          path: proposal.path,
          reason: 'The file changed or became unavailable after the preview.',
        };
      }
      if (
        current.root !== proposal.root ||
        current.rootIdentity.dev !== proposal.rootIdentity.dev ||
        current.rootIdentity.ino !== proposal.rootIdentity.ino ||
        !equalIdentity(current.identity, proposal.identity) ||
        sha256(current.content) !== proposal.beforeHash
      )
        return {
          status: 'conflict',
          proposalId,
          path: proposal.path,
          reason:
            'The file changed after the preview; create a fresh proposal.',
        };
      return {
        status: 'unavailable',
        proposalId,
        path: proposal.path,
        reason: CAPABILITY_REASON,
      };
    },
  };
}
