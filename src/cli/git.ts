import type { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../core/config.js';
import { gitTools } from '../engines/git-tools.js';
import { prepareToolBatch } from '../engines/tools.js';
import { AgentForgeError } from '../shared/errors.js';
import { redactValue } from '../shared/safety.js';
import type { GitOperation } from '../engines/git-inspection.js';

type GitCliArguments = {
  path?: string;
  staged?: boolean;
  limit?: string;
  execute?: boolean;
};

type RootValue = string | (() => Promise<string>);

function cliArgs(
  operation: GitOperation,
  options: GitCliArguments,
): Record<string, unknown> {
  if (operation === 'diff')
    return { path: options.path, staged: options.staged === true };
  if (operation === 'log') return { limit: Number(options.limit ?? '10') };
  return {};
}

function toolName(operation: GitOperation): string {
  return `git_${operation}`;
}

export function registerGitCommands(
  program: Command,
  root: RootValue,
  signal: AbortSignal,
): void {
  const git = program
    .command('git')
    .description(
      'Preview and locally inspect Git status, diffs, history and branches',
    );

  const run = async (
    operation: GitOperation,
    options: GitCliArguments,
  ): Promise<void> => {
    const directory = typeof root === 'string' ? root : await root();
    const config = await loadConfig(directory);
    const registry = gitTools(directory);
    const selectedTool = registry.find(
      (candidate) => candidate.definition.name === toolName(operation),
    );
    if (!selectedTool)
      throw new AgentForgeError('Git inspection is unavailable.');
    const batch = prepareToolBatch(registry, [
      {
        id: `git-${operation}`,
        name: selectedTool.definition.name,
        arguments: cliArgs(operation, options),
      },
    ]);
    const preview = {
      operation,
      executed: false,
      approvalId: batch.approvalId,
      calls: batch.calls,
      review: batch.review,
      localOnly: true,
    };
    const emit = (value: unknown) =>
      console.log(JSON.stringify(redactValue(value), null, 2));

    if (!options.execute) {
      emit(preview);
      return;
    }
    if (!config.permissions.allowProcess || !config.permissions.allowTools) {
      const missing = [
        ...(!config.permissions.allowProcess
          ? ['permissions.allowProcess']
          : []),
        ...(!config.permissions.allowTools ? ['permissions.allowTools'] : []),
      ];
      emit({
        ...preview,
        blocked: `Enable ${missing.join(' and ')} before executing Git inspection.`,
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
    const terminal = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    let answer: string;
    try {
      answer = await terminal.question(
        `Type approve ${batch.approvalId} to execute this batch, or press Enter to decline: `,
        { signal },
      );
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        emit({ operation, executed: false, status: 'cancelled' });
        process.exitCode = 5;
        return;
      }
      throw error;
    } finally {
      terminal.close();
    }
    const approved = answer === `approve ${batch.approvalId}`;
    if (!approved) {
      emit({ ...preview, declined: true });
      process.exitCode = 6;
      return;
    }

    const results = await batch.execute({
      approved: true,
      approvalId: batch.approvalId,
      signal,
      timeoutMs: config.verification.timeoutMs,
    });
    const output = results[0]?.output;
    let result: unknown;
    try {
      result = JSON.parse(output ?? 'null') as unknown;
    } catch {
      result = null;
    }
    emit({ operation, executed: true, ...(result as object | null) });
    if (
      !result ||
      typeof result !== 'object' ||
      (result as { status?: string }).status !== 'ok'
    )
      process.exitCode = 4;
  };

  git
    .command('status')
    .description('Preview or read branch and working-tree status')
    .option('--execute', 'request exact terminal approval for this Git read')
    .action((options: GitCliArguments) => run('status', options));
  git
    .command('diff')
    .description('Preview or read a diff for one safe project file')
    .requiredOption('--path <path>', 'one safe project-relative file path')
    .option('--staged', 'read the index diff')
    .option('--execute', 'request exact terminal approval for this Git read')
    .action((options: GitCliArguments) => run('diff', options));
  git
    .command('log')
    .description('Preview or read up to 50 commits from local HEAD')
    .option('--limit <count>', 'number of commits to read, 1–50', '10')
    .option('--execute', 'request exact terminal approval for this Git read')
    .action((options: GitCliArguments) => run('log', options));
  git
    .command('branch')
    .description('Preview or read local branches')
    .option('--execute', 'request exact terminal approval for this Git read')
    .action((options: GitCliArguments) => run('branch', options));
}
