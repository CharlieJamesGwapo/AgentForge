import { ProviderError } from '../adapters/errors.js';
import type { RegisteredTool } from './tools.js';
import {
  createProjectEditSession,
  parseProjectEditRequest,
} from './project-edit.js';

const CAPABILITY_SCHEMA = {
  type: 'object',
  properties: {
    backend: { type: 'string', enum: ['node'] },
    atomicConflictSafeReplace: { type: 'boolean' },
    status: { type: 'string', enum: ['unavailable'] },
    reason: { type: 'string' },
  },
  required: ['backend', 'atomicConflictSafeReplace', 'status', 'reason'],
  additionalProperties: false,
};

const PREVIEW_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['preview'] },
    operation: { type: 'string', enum: ['replace', 'patch'] },
    path: { type: 'string' },
    proposalId: { type: 'string' },
    beforeHash: { type: 'string' },
    afterHash: { type: 'string' },
    diff: { type: 'string' },
    capability: CAPABILITY_SCHEMA,
  },
  required: [
    'status',
    'operation',
    'path',
    'proposalId',
    'beforeHash',
    'afterHash',
    'diff',
    'capability',
  ],
  additionalProperties: false,
};

const APPLY_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['conflict', 'unavailable'] },
    proposalId: { type: 'string' },
    path: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['status', 'proposalId', 'path', 'reason'],
  additionalProperties: false,
};

const REPLACE_PARAMETERS = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description:
        'Existing, safe project-relative UTF-8 file; excludes credentials, ignored files, links, generated paths, agentforge.config.json and .gitignore.',
    },
    oldText: {
      type: 'string',
      description:
        'Nonempty literal section that must occur exactly once in the file.',
    },
    newText: {
      type: 'string',
      description: 'Exact replacement text; no code is executed.',
    },
  },
  required: ['path', 'oldText', 'newText'],
  additionalProperties: false,
};

const PATCH_PARAMETERS = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      description:
        'Existing, safe project-relative UTF-8 file; excludes credentials, ignored files, links, generated paths, agentforge.config.json and .gitignore.',
    },
    patch: {
      type: 'string',
      description:
        'At most 32 KiB: a strict single-file unified patch with exact a/<path> and b/<path> headers and matching context.',
    },
  },
  required: ['path', 'patch'],
  additionalProperties: false,
};

const APPLY_PARAMETERS = {
  type: 'object',
  properties: {
    proposalId: {
      type: 'string',
      description:
        'ID returned by a previously approved edit preview in this same tool registry session.',
    },
  },
  required: ['proposalId'],
  additionalProperties: false,
};

function proposalRequest(
  operation: 'replace' | 'patch',
  args: Record<string, unknown>,
) {
  return parseProjectEditRequest({ operation, ...args });
}

function checkedProposalId(args: Record<string, unknown>): string {
  const keys = Reflect.ownKeys(args);
  if (
    keys.length !== 1 ||
    keys[0] !== 'proposalId' ||
    typeof args.proposalId !== 'string'
  )
    throw new ProviderError(
      'validation',
      'Project edit arguments are invalid.',
    );
  return args.proposalId;
}

/** Fixed host tools. Each registry owns its own short-lived proposal session. */
export function projectEditTools(
  root: string,
  options: { allowWrite: boolean },
): RegisteredTool[] {
  const session = createProjectEditSession(root);
  const tools: RegisteredTool[] = [
    {
      definition: {
        name: 'project_edit_replace',
        description:
          'After exact batch approval, read one allowed project text file and preview a uniquely matched literal replacement. This does not edit the file; apply needs a separate fresh approval and may be unavailable on this platform.',
        parameters: REPLACE_PARAMETERS,
        resultSchema: PREVIEW_RESULT_SCHEMA,
      },
      review: (args) => {
        const request = proposalRequest('replace', args);
        if (request.operation !== 'replace')
          throw new ProviderError(
            'validation',
            'Project edit arguments are invalid.',
          );
        return {
          action: 'read and preview a literal replacement',
          path: request.path,
          oldText: request.oldText,
          newText: request.newText,
          fileBytes: 256 * 1024,
          diffBytes: 32 * 1024,
          shareWithProvider: true,
          contentIsUntrusted: true,
        };
      },
      execute: (args, signal) =>
        session.propose(proposalRequest('replace', args), signal),
    },
    {
      definition: {
        name: 'project_edit_patch',
        description:
          'After exact batch approval, read one allowed project text file and preview a bounded strict single-file unified patch with exact context. This does not edit the file; apply needs a separate fresh approval and may be unavailable on this platform.',
        parameters: PATCH_PARAMETERS,
        resultSchema: PREVIEW_RESULT_SCHEMA,
      },
      review: (args) => {
        const request = proposalRequest('patch', args);
        if (request.operation !== 'patch')
          throw new ProviderError(
            'validation',
            'Project edit arguments are invalid.',
          );
        return {
          action: 'read and preview a unified patch',
          path: request.path,
          patch: request.patch,
          fileBytes: 256 * 1024,
          patchBytes: 32 * 1024,
          diffBytes: 32 * 1024,
          shareWithProvider: true,
          contentIsUntrusted: true,
        };
      },
      execute: (args, signal) =>
        session.propose(proposalRequest('patch', args), signal),
    },
  ];

  if (options.allowWrite) {
    tools.push({
      definition: {
        name: 'project_edit_apply',
        description:
          'After a fresh exact batch approval, recheck a previously previewed proposal and apply only if the file identity and bytes are unchanged. The built-in Node backend reports its replacement limitation without writing.',
        parameters: APPLY_PARAMETERS,
        resultSchema: APPLY_RESULT_SCHEMA,
      },
      review: (args) => session.inspectProposal(checkedProposalId(args)),
      execute: (args, signal) => session.apply(checkedProposalId(args), signal),
    });
  }

  return tools;
}
