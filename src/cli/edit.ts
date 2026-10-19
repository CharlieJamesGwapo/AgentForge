import type { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../core/config.js';
import { ProviderError } from '../adapters/errors.js';
import { readProjectFileSnapshot } from '../engines/project-files.js';
import {
  getProjectEditCapabilities,
  type ProjectEditOperation,
} from '../engines/project-edit.js';
import { projectEditTools } from '../engines/project-edit-tools.js';
import { prepareToolBatch } from '../engines/tools.js';
import { redactValue } from '../shared/safety.js';
import type { ToolResult } from '../adapters/types.js';

type RootValue = string | (() => Promise<string>);
type EditArguments = {
  path: string;
  old?: string;
  new?: string;
  patchFile?: string;
  execute?: boolean;
  apply?: boolean;
};

function toToolArgs(
  operation: ProjectEditOperation,
  options: EditArguments,
  patch?: string,
): Record<string, unknown> {
  if (operation === 'replace')
    return {
      path: options.path,
      oldText: options.old,
      newText: options.new,
    };
  return { path: options.path, patch };
}

function toolName(operation: ProjectEditOperation): string {
  return `project_edit_${operation}`;
}

function parseToolOutput(result: ToolResult | undefined): unknown {
  if (result === undefined) return null;
  try {
    return JSON.parse(result.output) as unknown;
  } catch {
    return null;
  }
}

function emit(value: unknown): void {
  console.log(JSON.stringify(redactValue(value), null, 2));
}

async function askExactApproval(
  approvalId: string,
  signal: AbortSignal,
  purpose: string,
): Promise<'approved' | 'declined' | 'unavailable' | 'cancelled'> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return 'unavailable';
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await terminal.question(
      `Type approve ${approvalId} to ${purpose}, or press Enter to decline: `,
      { signal },
    );
    return answer === `approve ${approvalId}` ? 'approved' : 'declined';
  } catch (error) {
    if (
      signal.aborted ||
      (error instanceof Error && error.name === 'AbortError')
    )
      return 'cancelled';
    throw error;
  } finally {
    terminal.close();
  }
}

function setFailureExitCode(status: unknown): void {
  if (status === 'unavailable') process.exitCode = 3;
  else if (status === 'conflict') process.exitCode = 4;
  else if (status === 'cancelled') process.exitCode = 5;
  else process.exitCode = 6;
}

/** Offline edit preview and exact, per-batch terminal approval commands. */
export function registerEditCommands(
  program: Command,
  root: RootValue,
  signal: AbortSignal,
): void {
  const edit = program
    .command('edit')
    .description(
      'Preview a bounded project-file edit and require fresh approval for each stage',
    );

  edit
    .command('capabilities')
    .description('Report whether this platform can apply conflict-safe edits')
    .action(() => emit(getProjectEditCapabilities()));

  const run = async (
    operation: ProjectEditOperation,
    options: EditArguments,
  ): Promise<void> => {
    if (options.apply && !options.execute) {
      emit({
        operation,
        path: options.path,
        executed: false,
        blocked: '--apply requires --execute and two fresh terminal approvals.',
      });
      process.exitCode = 6;
      return;
    }

    const directory = typeof root === 'string' ? root : await root();
    const config = await loadConfig(directory);
    let patch: string | undefined;
    if (operation === 'patch') {
      if (options.patchFile === undefined)
        throw new ProviderError(
          'validation',
          'The --patch-file option is required for edit patch.',
        );
      const patchSnapshot = await readProjectFileSnapshot(
        directory,
        options.patchFile,
        signal,
      );
      try {
        patch = new TextDecoder('utf-8', {
          fatal: true,
          ignoreBOM: true,
        }).decode(patchSnapshot.content);
      } catch {
        throw new ProviderError(
          'validation',
          'The patch file must contain valid UTF-8 text.',
        );
      }
    }

    const registry = projectEditTools(directory, {
      allowWrite: config.permissions.allowWrite,
    });
    const name = toolName(operation);
    const selectedTool = registry.find(
      (candidate) => candidate.definition.name === name,
    );
    if (!selectedTool)
      throw new ProviderError('unavailable', 'Project edit is unavailable.');
    const args = toToolArgs(operation, options, patch);
    const firstBatch = prepareToolBatch(registry, [
      { id: `edit-${operation}`, name, arguments: args },
    ]);
    const preview = {
      operation,
      path: options.path,
      executed: false,
      approvalId: firstBatch.approvalId,
      calls: firstBatch.calls,
      review: firstBatch.review,
      localOnly: true,
    };

    if (!options.execute) {
      emit(preview);
      return;
    }
    if (!config.permissions.allowTools) {
      emit({
        ...preview,
        blocked: 'Enable permissions.allowTools before reading the file.',
      });
      process.exitCode = 6;
      return;
    }
    if (options.apply && !config.permissions.allowWrite) {
      emit({
        ...preview,
        blocked: 'Enable permissions.allowWrite before requesting application.',
      });
      process.exitCode = 6;
      return;
    }
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
      emit({
        ...preview,
        approvalRequired: true,
        required:
          'Run --execute from a terminal and type the exact displayed approval ID.',
      });
      process.exitCode = 6;
      return;
    }

    emit({ ...preview, approvalRequired: true });
    const firstApproval = await askExactApproval(
      firstBatch.approvalId,
      signal,
      'read this file and prepare the preview',
    );
    if (firstApproval !== 'approved') {
      const status = firstApproval === 'cancelled' ? 'cancelled' : 'denied';
      emit({ operation, path: options.path, executed: false, status });
      setFailureExitCode(status);
      return;
    }

    const firstResults = await firstBatch.execute({
      approved: true,
      approvalId: firstBatch.approvalId,
      signal,
      timeoutMs: config.verification.timeoutMs,
    });
    const firstResult = firstResults[0];
    const proposed = parseToolOutput(firstResult);
    if (
      firstResult?.isError === true ||
      !proposed ||
      typeof proposed !== 'object' ||
      (proposed as { status?: string }).status !== 'preview'
    ) {
      emit({
        operation,
        path: options.path,
        executed: true,
        status: 'failed',
        message: 'The file could not be safely previewed.',
      });
      process.exitCode = 6;
      return;
    }
    emit({ operation, executed: true, ...(proposed as object) });
    if (!options.apply) return;

    const proposalId = (proposed as { proposalId: string }).proposalId;
    const applyBatch = prepareToolBatch(registry, [
      {
        id: 'edit-apply',
        name: 'project_edit_apply',
        arguments: { proposalId },
      },
    ]);
    emit({
      operation: 'apply',
      executed: false,
      proposalId,
      approvalId: applyBatch.approvalId,
      review: applyBatch.review,
      localOnly: true,
    });
    const applyApproval = await askExactApproval(
      applyBatch.approvalId,
      signal,
      'recheck and apply this exact edit proposal',
    );
    if (applyApproval !== 'approved') {
      const status = applyApproval === 'cancelled' ? 'cancelled' : 'denied';
      emit({ operation: 'apply', proposalId, executed: false, status });
      setFailureExitCode(status);
      return;
    }
    const applyResults = await applyBatch.execute({
      approved: true,
      approvalId: applyBatch.approvalId,
      signal,
      timeoutMs: config.verification.timeoutMs,
    });
    const applied = parseToolOutput(applyResults[0]);
    if (!applied || typeof applied !== 'object') {
      emit({
        operation: 'apply',
        executed: true,
        proposalId,
        status: 'failed',
        message: 'The edit could not be safely applied.',
      });
      process.exitCode = 4;
      return;
    }
    emit({ operation: 'apply', executed: true, ...(applied as object) });
    setFailureExitCode((applied as { status?: unknown }).status);
  };

  edit
    .command('replace')
    .description('Preview one uniquely matched literal replacement in a file')
    .requiredOption('--path <path>', 'existing safe project-relative file path')
    .requiredOption('--old <text>', 'nonempty literal text that occurs once')
    .requiredOption('--new <text>', 'replacement text')
    .option(
      '--execute',
      'request terminal approval to read and preview the edit',
    )
    .option('--apply', 'request a second fresh approval to apply the preview')
    .action((options: EditArguments) => run('replace', options));

  edit
    .command('patch')
    .description('Preview a strict bounded patch from a project-relative file')
    .requiredOption('--path <path>', 'existing safe project-relative file path')
    .requiredOption('--patch-file <path>', 'UTF-8 single-file unified patch')
    .option(
      '--execute',
      'request terminal approval to read and preview the edit',
    )
    .option('--apply', 'request a second fresh approval to apply the preview')
    .action((options: EditArguments) => run('patch', options));
}
