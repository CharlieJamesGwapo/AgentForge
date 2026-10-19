import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { ProviderError } from '../adapters/errors.js';
import { prepareSchema } from '../adapters/output.js';
import { loadConfig } from '../core/config.js';
import { readJson } from '../core/storage.js';
import { projectTools } from '../engines/project-tools.js';
import type { RegisteredTool } from '../engines/tools.js';
import {
  runTaskRuntime,
  type TaskRuntimeEvent,
} from '../engines/task-runtime.js';
import { applyResultSchemas } from './tool-result-schemas.js';

export function registerTaskCommand(
  program: Command,
  root: () => Promise<string>,
  signal: AbortSignal,
): void {
  program
    .command('task')
    .description(
      'Run a bounded provider conversation for a task with opt-in network and per-batch tool approval',
    )
    .requiredOption('--task <text>', 'task to refine and send to the provider')
    .requiredOption('--provider <id>', 'explicitly configured provider id')
    .option('--model <id>', 'override the configured model for this invocation')
    .option(
      '--approve-network',
      'approve sending the task and approved tool results to this provider',
    )
    .option(
      '--execute',
      'ask for exact interactive approval before each tool batch',
    )
    .option(
      '--with-context',
      'include the current checkpoint as untrusted JSON reference data',
    )
    .option(
      '--stream',
      'emit sanitized provisional text while tool calls remain inert until validation',
    )
    .option('--schema <relative-file>', 'validate the final answer locally')
    .option(
      '--result-schemas <relative-file>',
      'apply local tool-name to result-schema overrides before requesting tools',
    )
    .option('--max-turns <count>', 'maximum network turns, 1–10', '6')
    .option(
      '--timeout-ms <ms>',
      'deadline per provider request, 1–300000',
      '60000',
    )
    .option('--max-duration-ms <ms>', 'total task deadline, 1–600000', '120000')
    .action(
      async (options: {
        task: string;
        provider: string;
        model?: string;
        approveNetwork?: boolean;
        execute?: boolean;
        withContext?: boolean;
        stream?: boolean;
        schema?: string;
        resultSchemas?: string;
        maxTurns: string;
        timeoutMs: string;
        maxDurationMs: string;
      }) => {
        const directory = await root();
        let responseSchema: Record<string, unknown> | undefined;
        if (options.schema !== undefined) {
          const value = await readJson(directory, options.schema);
          if (value === undefined)
            throw new ProviderError('configuration', 'Schema file not found.');
          responseSchema = prepareSchema(value);
        }
        let tools: RegisteredTool[] | undefined;
        if (options.resultSchemas !== undefined) {
          const config = await loadConfig(directory);
          const available = projectTools(directory, config);
          const schemas = await readJson(directory, options.resultSchemas);
          tools = applyResultSchemas(available, schemas);
        }
        const emit = (event: TaskRuntimeEvent) =>
          console.log(JSON.stringify(event));
        const result = await runTaskRuntime({
          root: directory,
          task: options.task,
          provider: options.provider,
          ...(options.model === undefined ? {} : { model: options.model }),
          approveNetwork: options.approveNetwork === true,
          withContext: options.withContext === true,
          stream: options.stream === true,
          maxTurns: Number(options.maxTurns),
          timeoutMs: Number(options.timeoutMs),
          maxDurationMs: Number(options.maxDurationMs),
          ...(responseSchema === undefined ? {} : { responseSchema }),
          ...(tools === undefined ? {} : { tools }),
          executeTools: options.execute === true,
          signal,
          onEvent: emit,
          approveToolBatch: async (batch, approvalSignal) => {
            if (
              !options.execute ||
              !process.stdin.isTTY ||
              !process.stderr.isTTY
            )
              return false;
            const terminal = createInterface({
              input: process.stdin,
              output: process.stderr,
            });
            try {
              return (
                (await terminal.question(
                  `Type approve ${batch.approvalId} to execute this batch and share its results, or press Enter to decline: `,
                  { signal: approvalSignal },
                )) === `approve ${batch.approvalId}`
              );
            } catch (error) {
              if (
                approvalSignal.aborted ||
                (error instanceof Error && error.name === 'AbortError')
              )
                throw new ProviderError(
                  'cancelled',
                  'Tool approval cancelled.',
                );
              throw error;
            } finally {
              terminal.close();
            }
          },
        });
        console.log(JSON.stringify({ type: 'task-result', ...result }));
        if (result.status === 'approval-required') process.exitCode = 6;
        else if (result.status === 'failed')
          process.exitCode = result.error?.exitCode ?? 1;
        else if (result.finishReason !== 'completed') process.exitCode = 4;
      },
    );
}
