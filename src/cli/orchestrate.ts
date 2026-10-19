import type { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { ProviderError } from '../adapters/errors.js';
import { loadConfig } from '../core/config.js';
import { configuredProviderCredentials } from '../adapters/registry.js';
import {
  runOrchestration,
  type OrchestrationResult,
} from '../engines/orchestration.js';
import { redactValue } from '../shared/safety.js';

type RootValue = string | (() => Promise<string>);

type OrchestrationCliOptions = {
  task: string;
  approveNetwork?: boolean;
  planner?: string;
  executor?: string;
  plannerModel?: string;
  executorModel?: string;
  subagents?: boolean;
  execute?: boolean;
};

function emit(value: unknown, sensitiveValues: readonly string[] = []): void {
  console.log(JSON.stringify(redactValue(value, sensitiveValues)));
}

function setResultExitCode(result: OrchestrationResult): void {
  if (result.status === 'completed' || result.status === 'planned') return;
  if (result.status === 'approval-required') {
    process.exitCode = 6;
    return;
  }
  if (result.status === 'cancelled') {
    process.exitCode = 5;
    return;
  }
  if (result.status === 'partial') {
    process.exitCode = 4;
    return;
  }
  process.exitCode = result.error?.exitCode ?? 1;
}

export function registerOrchestrationCommands(
  program: Command,
  root: RootValue,
  signal: AbortSignal,
): void {
  const command = program
    .command('orchestrate')
    .description(
      'Plan and run bounded provider-neutral repository subtasks with central approval',
    );

  command
    .command('status')
    .description(
      'Show orchestration roles, permissions and configured limits offline',
    )
    .action(async () => {
      const directory = typeof root === 'string' ? root : await root();
      const config = await loadConfig(directory);
      const orchestration = config.orchestration;
      const selectedProviders = [
        orchestration.planner?.provider,
        orchestration.executor?.provider,
      ].filter((provider): provider is string => provider !== undefined);
      emit(
        {
          type: 'orchestration-status',
          enabled: orchestration.enabled,
          planner: orchestration.planner,
          executor: orchestration.executor,
          maxConcurrency: orchestration.maxConcurrency,
          maxDepth: orchestration.maxDepth,
          maxSubtasks: orchestration.maxSubtasks,
          maxContextBytes: orchestration.maxContextBytes,
          maxOutputBytes: orchestration.maxOutputBytes,
          timeoutMs: orchestration.timeoutMs,
          maxDurationMs: orchestration.maxDurationMs,
          permissions: {
            allowNetwork: config.permissions.allowNetwork,
            allowTools: config.permissions.allowTools,
          },
        },
        configuredProviderCredentials(config, selectedProviders),
      );
    });

  const registerRun = (name: 'plan' | 'run') => {
    const runner = command
      .command(name)
      .description(
        name === 'plan'
          ? 'Request and validate a bounded plan without starting workers'
          : 'Request a bounded plan and run its approved worker tasks',
      )
      .requiredOption('--task <text>', 'task to send to the configured planner')
      .option(
        '--approve-network',
        'approve sending the task to configured providers',
      )
      .option(
        '--planner <provider>',
        'use this configured provider for planning',
      )
      .option(
        '--executor <provider>',
        'use this configured provider for workers',
      )
      .option(
        '--planner-model <model>',
        'override the configured planner model',
      )
      .option(
        '--executor-model <model>',
        'override the configured executor model',
      );
    if (name === 'run') {
      runner
        .option('--no-subagents', 'request a plan only; do not start workers')
        .option(
          '--execute',
          'request exact interactive approval before each scoped tool batch',
        );
    }
    runner.action(async (options: OrchestrationCliOptions) => {
      const directory = typeof root === 'string' ? root : await root();
      const approvalCancellation = new AbortController();
      const invocationSignal = AbortSignal.any([
        signal,
        approvalCancellation.signal,
      ]);
      const result = await runOrchestration({
        root: directory,
        task: options.task,
        approveNetwork: options.approveNetwork === true,
        ...(options.planner === undefined ? {} : { planner: options.planner }),
        ...(options.executor === undefined
          ? {}
          : { executor: options.executor }),
        ...(options.plannerModel === undefined
          ? {}
          : { plannerModel: options.plannerModel }),
        ...(options.executorModel === undefined
          ? {}
          : { executorModel: options.executorModel }),
        subagents: name === 'plan' ? false : options.subagents !== false,
        executeTools: options.execute === true,
        signal: invocationSignal,
        onEvent: (event) => emit(event),
        approveToolBatch: async (batch, approvalSignal) => {
          if (
            options.execute !== true ||
            !process.stdin.isTTY ||
            !process.stderr.isTTY
          )
            return false;
          const disclosure = {
            type: 'orchestration-approval-review',
            subtaskId: batch.subtaskId,
            provider: batch.provider,
            model: batch.model,
            approvalId: batch.approvalId,
            calls: batch.calls,
            review: batch.review,
          };
          process.stderr.write(`${JSON.stringify(redactValue(disclosure))}\n`);
          const terminal = createInterface({
            input: process.stdin,
            output: process.stderr,
          });
          try {
            const answer = await terminal.question(
              `Type approve ${batch.approvalId} to execute this exact batch and share results with ${batch.provider}/${batch.model}, or press Enter to decline: `,
              { signal: approvalSignal },
            );
            return answer === `approve ${batch.approvalId}`;
          } catch (error) {
            if (
              approvalSignal.aborted ||
              (error instanceof Error && error.name === 'AbortError')
            ) {
              approvalCancellation.abort();
              throw new ProviderError('cancelled', 'Tool approval cancelled.');
            }
            throw error;
          } finally {
            terminal.close();
          }
        },
      });
      emit({ type: 'orchestration-result', result });
      setResultExitCode(result);
    });
  };

  registerRun('plan');
  registerRun('run');
}
