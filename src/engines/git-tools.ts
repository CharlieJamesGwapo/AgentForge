import type { RegisteredTool } from './tools.js';
import { inspectGit, parseGitRequest } from './git-inspection.js';

const RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: [
        'ok',
        'missing-git',
        'not-repository',
        'unsupported-worktree',
        'unsafe-root',
        'unsafe-configuration',
        'path-unavailable',
        'failed',
        'timed-out',
        'cancelled',
        'output-limit',
      ],
    },
    operation: { type: 'string', enum: ['status', 'diff', 'log', 'branch'] },
    branch: { type: ['string', 'null'] },
    headState: {
      type: 'string',
      enum: ['attached', 'detached', 'unborn', 'unknown'],
    },
    staged: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, status: { type: 'string' } },
        required: ['path', 'status'],
        additionalProperties: false,
      },
    },
    unstaged: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, status: { type: 'string' } },
        required: ['path', 'status'],
        additionalProperties: false,
      },
    },
    untracked: { type: 'array', items: { type: 'string' } },
    diff: { type: 'string' },
    commits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          hash: { type: 'string' },
          date: { type: 'string' },
          subject: { type: 'string' },
        },
        required: ['hash', 'date', 'subject'],
        additionalProperties: false,
      },
    },
    branches: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, current: { type: 'boolean' } },
        required: ['name', 'current'],
        additionalProperties: false,
      },
    },
    truncated: { type: 'boolean' },
    message: { type: ['string', 'null'] },
  },
  required: [
    'status',
    'operation',
    'branch',
    'headState',
    'staged',
    'unstaged',
    'untracked',
    'diff',
    'commits',
    'branches',
    'truncated',
    'message',
  ],
  additionalProperties: false,
};

const EMPTY_ARGUMENTS = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
};

const EXECUTION_BOUNDS = {
  timeoutMs: 30_000,
  processOutputBytes: 256 * 1024,
  resultBytes: 48 * 1024,
};

/** Fixed, side-effect-free declarations; actual Git reads run only after batch approval. */
export function gitTools(root: string): RegisteredTool[] {
  return [
    {
      definition: {
        name: 'git_status',
        description:
          'Read branch and working-tree status for the configured project root. Uses a fixed, read-only Git command, excludes credential and generated paths, and requires exact batch approval before execution.',
        parameters: EMPTY_ARGUMENTS,
        resultSchema: RESULT_SCHEMA,
      },
      review: (args) => {
        parseGitRequest({ operation: 'status', ...args });
        return {
          action: 'read Git status',
          scope: 'configured project root',
          command:
            'git status --porcelain=v2 --branch --untracked-files=all --no-renames --ignore-submodules=all',
          limits: EXECUTION_BOUNDS,
          readOnly: true,
          shareWithProvider: true,
        };
      },
      execute: (_args, signal) =>
        inspectGit(root, { operation: 'status' }, { approved: true, signal }),
    },
    {
      definition: {
        name: 'git_diff',
        description:
          'Read a bounded diff for one safe, existing project file. Whole-tree diffs, credentials, generated paths, ignored files and symlinks are unavailable. Requires exact batch approval before execution.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description:
                'One safe project-relative regular-file path; no absolute paths, traversal, blocked credentials or generated directories.',
            },
            staged: {
              type: 'boolean',
              description: 'Read the index diff when true.',
            },
          },
          required: ['path', 'staged'],
          additionalProperties: false,
        },
        resultSchema: RESULT_SCHEMA,
      },
      review: (args) => {
        const request = parseGitRequest({ operation: 'diff', ...args });
        if (request.operation !== 'diff')
          throw new TypeError('Git diff arguments are invalid.');
        return {
          action: 'read Git diff',
          scope: 'configured project root',
          path: request.path,
          staged: request.staged,
          command:
            'git diff --no-ext-diff --no-textconv --no-color --unified=3',
          limits: EXECUTION_BOUNDS,
          excludes: [
            'credentials',
            'generated directories',
            'ignored files',
            'symlink paths',
          ],
          readOnly: true,
          shareWithProvider: true,
        };
      },
      execute: (args, signal) =>
        inspectGit(
          root,
          { operation: 'diff', ...args },
          { approved: true, signal },
        ),
    },
    {
      definition: {
        name: 'git_log',
        description:
          'Read up to 50 commits reachable from the current local HEAD. Does not accept a revision or access remote branches; requires exact batch approval before execution.',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'integer', description: '1–50 commits.' },
          },
          required: ['limit'],
          additionalProperties: false,
        },
        resultSchema: RESULT_SCHEMA,
      },
      review: (args) => {
        const request = parseGitRequest({ operation: 'log', ...args });
        if (request.operation !== 'log')
          throw new TypeError('Git log arguments are invalid.');
        return {
          action: 'read local Git history',
          scope: 'current local HEAD',
          limit: request.limit,
          command: 'git log --no-decorate --no-show-signature --no-notes',
          limits: EXECUTION_BOUNDS,
          readOnly: true,
          shareWithProvider: true,
        };
      },
      execute: (args, signal) =>
        inspectGit(
          root,
          { operation: 'log', ...args },
          { approved: true, signal },
        ),
    },
    {
      definition: {
        name: 'git_branch',
        description:
          'List local branches and identify the current branch. Does not list remote branches or contact a remote; requires exact batch approval before execution.',
        parameters: EMPTY_ARGUMENTS,
        resultSchema: RESULT_SCHEMA,
      },
      review: (args) => {
        parseGitRequest({ operation: 'branch', ...args });
        return {
          action: 'read local Git branches',
          scope: 'configured project root',
          command: 'git for-each-ref refs/heads',
          limits: EXECUTION_BOUNDS,
          readOnly: true,
          shareWithProvider: true,
        };
      },
      execute: (_args, signal) =>
        inspectGit(root, { operation: 'branch' }, { approved: true, signal }),
    },
  ];
}
